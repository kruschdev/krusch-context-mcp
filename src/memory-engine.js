/**
 * @module memory-engine
 * Universal Memory & Steering Engine for AI Agents.
 * Implements:
 * 1. Safe episodic memory CRUD with strict closed taxonomy
 * 2. Temporal superseding with lineage tracking
 * 3. Explicit invalidation requiring mandatory reason
 * 4. Near-duplicate detection (threshold 0.85) proposing supersede
 * 5. Full provenance recording (author, file, commit, pr, confidence)
 * 6. 30-day TTL decay review
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pool } from '../db/pool.js';
import { getEmbedding, calibrateQuerySimilarity } from './embedding-helper.js';
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { getProjectDb, cosineSimilarity, getParsedEmbedding, encodeEmbeddingBlob, pushProjectMemory, resolveProjectPath, withTransaction } from './sqlite-engine.js';
import { checkNearDuplicateMemory, getStorageMode } from './storage-adapter.js';
import { generateTagsFromLLM, extractHeuristicTags } from './llm-tags.js';
import { detectCurrentProject, getWorktreeStatus } from './project-helper.js';
import { ensureEpisodeRollups } from './episode-rollup.js';

export const CLOSED_CATEGORIES = new Set(['decision', 'bug', 'invariant', 'lesson', 'blocker']);
const DECAY_RATE = 0.01;
const AUTO_TAG = true;

const SECRET_PATTERNS = [
    { label: 'OpenRouter API Key', regex: /\bsk-or-v1-[A-Za-z0-9_-]{20,}\b/ },
    { label: 'OpenAI/Anthropic API Key', regex: /\bsk-(?:proj-|ant-|live-|svcacct-)?[A-Za-z0-9_-]{20,}\b/ },
    { label: 'GitHub Personal Access Token', regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{35,}\b/ },
    { label: 'Google API Key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
    { label: 'AWS Access Key ID', regex: /\bAKIA[0-9A-Z]{16}\b/ },
    { label: 'Slack Token', regex: /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/ },
    { label: 'Database Connection URL Secret', regex: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^:\s/]+:(?!(?:password|REDACTED|pass|postgres|\*+)@)[^@\s]{6,}@[^\s/]+/i },
    { label: 'Private Key Block', regex: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ }
];

/**
 * Checks whether a candidate file path points to a sensitive secret dotfile or key file.
 */
function isSensitiveAnchorFile(filePath) {
    if (!filePath || typeof filePath !== 'string') return true;
    const base = path.basename(filePath).toLowerCase();
    if (base === '.env' || base.startsWith('.env.')) return true;
    if (base === 'id_rsa' || base === 'id_ed25519' || base === 'id_ecdsa' || base === 'id_dsa') return true;
    if (base.endsWith('.pem') || base.endsWith('.key')) return true;
    return false;
}

/**
 * Scans text for raw credentials/secrets before persistence (FlowState secrets_scan parity).
 * Returns null if clean, or the matched secret pattern label if a leak is detected.
 */
export function scanForSecretLeak(text) {
    if (!text || typeof text !== 'string') return null;
    for (const { label, regex } of SECRET_PATTERNS) {
        if (regex.test(text)) return label;
    }
    return null;
}

/**
 * Computes normalized SHA-256 hash of a text span or file page (KruschNexus INV-12 parity).
 */
export function computeNormalizedSpanHash(text) {
    const normalized = String(text || '').replace(/\r\n/g, '\n').trim();
    return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/**
 * Concurrency contract: single-writer, multiple-reader bounded cache for anchored files (BUG-01).
 * Asynchronous writes/reads acquire anchoredCacheMutex to prevent interleaved state corruption.
 */
const anchoredFileCache = new Map();
const MAX_ANCHORED_FILE_CACHE = 128;
let _anchoredCacheLock = Promise.resolve();

export async function withAnchoredCacheLock(fn) {
    const next = _anchoredCacheLock.then(fn, fn);
    _anchoredCacheLock = next.catch((err) => {
        console.error('[AnchoredCacheLock] Lock task error:', err?.message || err);
    });
    return next;
}

/**
 * Reads an anchored file and computes its normalized SHA-256 hash with (mtimeMs, size) memoization.
 */
export function readAnchoredFileCached(absPath, { fsImpl = fs, throwOnError = false } = {}) {
    try {
        const st = fsImpl.statSync(absPath);
        if (!st.isFile() || st.size > 5 * 1024 * 1024) return null;
        const cached = anchoredFileCache.get(absPath);
        if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
            return cached;
        }
        const fileText = fsImpl.readFileSync(absPath, 'utf8');
        const currentHash = computeNormalizedSpanHash(fileText);
        const entry = Object.freeze({ mtimeMs: st.mtimeMs, size: st.size, fileText, currentHash });
        if (anchoredFileCache.size >= MAX_ANCHORED_FILE_CACHE) {
            const oldestKey = anchoredFileCache.keys().next().value;
            anchoredFileCache.delete(oldestKey);
        }
        anchoredFileCache.set(absPath, entry);
        return entry;
    } catch (err) {
        console.error(JSON.stringify({
            module: 'memory-engine',
            operation: 'readAnchoredFileCached',
            path: absPath,
            error: err.message
        }));
        if (throwOnError || (err && err.code && err.code !== 'ENOENT')) {
            throw err;
        }
        return null;
    }
}

export async function readAnchoredFileCachedAsync(absPath, options = {}) {
    return withAnchoredCacheLock(async () => readAnchoredFileCached(absPath, options));
}

/**
 * Safely resolves a provenance file path within a project workspace root (strict path-traversal & symlink guard).
 */
export function resolveAnchoredFilePath(fileRef, targetProject) {
    if (!fileRef || typeof fileRef !== 'string') return null;
    const cleaned = fileRef.trim();
    if (!cleaned || cleaned.includes('\0') || cleaned.includes('..')) return null;
    if (isSensitiveAnchorFile(cleaned)) return null;

    const projectRoot = resolveProjectPath(targetProject);
    const candidateRoots = [projectRoot, process.cwd()];
    for (const baseRoot of [projectRoot, process.cwd()]) {
        if (baseRoot && path.basename(path.dirname(baseRoot)) === 'projects') {
            candidateRoots.push(path.resolve(baseRoot, '../..'));
        }
    }

    for (const rootDir of candidateRoots) {
        if (!rootDir) continue;
        const resolvedRoot = path.resolve(rootDir);
        let realRoot = resolvedRoot;
        try {
            if (fs.existsSync(resolvedRoot)) {
                realRoot = fs.realpathSync(resolvedRoot);
            }
        } catch (err) {
            console.error(JSON.stringify({
                module: 'memory-engine',
                operation: 'resolveAnchorRoot',
                target: resolvedRoot,
                error: err.message
            }));
            continue;
        }
        const candidates = path.isAbsolute(cleaned)
            ? [path.resolve(cleaned), path.resolve(resolvedRoot, cleaned.replace(/^[/\\]+/, ''))]
            : [path.resolve(resolvedRoot, cleaned)];

        for (const resolvedTarget of candidates) {
            if (isSensitiveAnchorFile(resolvedTarget)) continue;
            const rel = path.relative(resolvedRoot, resolvedTarget);
            if (!rel.startsWith('..') && !path.isAbsolute(rel) && rel !== '') {
                if (fs.existsSync(resolvedTarget)) {
                    try {
                        const realTarget = fs.realpathSync(resolvedTarget);
                        if (isSensitiveAnchorFile(realTarget)) continue;
                        const realRel = path.relative(realRoot, realTarget);
                        if (realRel.startsWith('..') || path.isAbsolute(realRel) || realRel === '') {
                            continue;
                        }
                        const st = fs.statSync(realTarget);
                        if (st.isFile() && st.size <= 5 * 1024 * 1024) {
                            return realTarget;
                        }
                    } catch (err) {
                        console.error(JSON.stringify({
                            module: 'memory-engine',
                            operation: 'resolveAnchorTarget',
                            target: resolvedTarget,
                            error: err.message,
                            stack: err.stack
                        }));
                    }
                }
            }
        }
    }
    // Return expected path inside projectRoot ONLY if the target does not exist on disk (for missing-file drift check)
    if (path.isAbsolute(cleaned)) {
        const relAbs = path.relative(projectRoot, path.resolve(cleaned));
        if (relAbs.startsWith('..') || path.isAbsolute(relAbs) || relAbs === '') {
            return null;
        }
    }
    const defaultTarget = path.resolve(projectRoot, cleaned.replace(/^[/\\]+/, ''));
    if (isSensitiveAnchorFile(defaultTarget)) return null;
    const relDefault = path.relative(projectRoot, defaultTarget);
    if (!relDefault.startsWith('..') && !path.isAbsolute(relDefault) && relDefault !== '') {
        try {
            // If the path or symlink exists on disk here, it failed validation above -> reject!
            fs.lstatSync(defaultTarget);
            return null;
        } catch {
            return defaultTarget;
        }
    }
    return null;
}

/**
 * Computes 1-based line numbers for a character span [charStart, charEnd] in text.
 */
function getSpanLineRange(text, charStart, charEnd) {
    const prefix = text.slice(0, Math.max(0, charStart));
    const span = text.slice(Math.max(0, charStart), Math.max(charStart, charEnd));
    const startLine = prefix.split('\n').length;
    const endLine = startLine + Math.max(0, span.split('\n').length - 1);
    return { startLine, endLine };
}

function sanitizeProvenanceToken(val, pattern = /^[a-zA-Z0-9._:@/-]+$/, maxLen = 128) {
    if (typeof val !== 'string') return null;
    const trimmed = val.trim();
    if (!trimmed || trimmed.length > maxLen) return null;
    return pattern.test(trimmed) ? trimmed : null;
}

/**
 * Enriches provenance metadata with KruschNexus-style citation spine coordinates,
 * SHA-256 anchor_hash, and multi-agent fleet attribution (host_node, client, model).
 */
export function anchorProvenanceToFile(provenance, targetProject) {
    const base = {
        file: provenance?.file || null,
        commit: provenance?.commit || null,
        pr: provenance?.pr || null,
        author: provenance?.author || 'agent',
        host_node:
            sanitizeProvenanceToken(provenance?.host_node, /^[a-zA-Z0-9._-]+$/) ||
            sanitizeProvenanceToken(process.env.KRUSCH_NODE, /^[a-zA-Z0-9._-]+$/) ||
            os.hostname(),
        client:
            sanitizeProvenanceToken(provenance?.client) ||
            sanitizeProvenanceToken(process.env.MCP_CLIENT_NAME) ||
            null,
        model:
            sanitizeProvenanceToken(provenance?.model) ||
            sanitizeProvenanceToken(process.env.KRUSCH_MODEL) ||
            null,
        confidence: provenance?.confidence ?? 1.0,
        locator: provenance?.locator || null,
        quoted_sentence: provenance?.quoted_sentence || null,
        start_line: provenance?.start_line || null,
        end_line: provenance?.end_line || null,
        char_start: provenance?.char_start ?? null,
        char_end: provenance?.char_end ?? null,
        anchor_hash: provenance?.anchor_hash || null,
        citation: provenance?.citation || null,
        is_drifted: Boolean(provenance?.is_drifted),
        drift_reason: provenance?.drift_reason || null,
        recorded_at: new Date().toISOString()
    };

    if (!base.file) return base;

    const absPath = resolveAnchoredFilePath(base.file, targetProject);
    if (absPath) {
        const cachedFile = readAnchoredFileCached(absPath);
        if (cachedFile) {
            const { fileText, currentHash } = cachedFile;
            const normalizedFileText = fileText.replace(/\r\n/g, '\n');
            if (!base.anchor_hash) {
                base.anchor_hash = currentHash;
            }
            if (base.quoted_sentence && typeof base.quoted_sentence === 'string') {
                const normalizedQuote = base.quoted_sentence.replace(/\r\n/g, '\n');
                const pos = normalizedFileText.indexOf(normalizedQuote);
                if (pos !== -1) {
                    base.char_start = pos;
                    base.char_end = pos + normalizedQuote.length;
                    const { startLine, endLine } = getSpanLineRange(normalizedFileText, base.char_start, base.char_end);
                    base.start_line = startLine;
                    base.end_line = endLine;
                    base.is_drifted = false;
                    base.drift_reason = null;
                } else {
                    base.is_drifted = true;
                    base.drift_reason = 'quoted_span_not_found';
                }
            }
            if (!base.citation) {
                const lineSuffix = base.start_line
                    ? `#L${base.start_line}${base.end_line && base.end_line !== base.start_line ? `-L${base.end_line}` : ''}`
                    : '';
                const locSuffix = base.locator ? ` [${base.locator}]` : '';
                base.citation = `${base.file}${lineSuffix}${locSuffix}`;
            }
        }
    }
    return base;
}

/**
 * Evaluates live KruschNexus INV-12 span drift for a memory record.
 * - If the file hash matches anchor_hash -> VALID (is_drifted = false).
 * - If the file mutated but quoted_sentence still exists verbatim -> Auto-heals offsets & anchor_hash!
 * - If the file is missing or quoted_sentence was mutated/removed -> Flags is_drifted = true (STALE_DRIFT).
 */
export function evaluateMemorySpanDrift(row, targetProject, db = null) {
    if (!row || !row.provenance) {
        return { anchored: false, is_drifted: false, provenance: null };
    }
    let prov;
    try {
        prov = typeof row.provenance === 'string' ? JSON.parse(row.provenance) : { ...row.provenance };
    } catch {
        return { anchored: false, is_drifted: false, provenance: null };
    }

    if (!prov || (!prov.file && !prov.anchor_hash)) {
        return { anchored: false, is_drifted: false, provenance: prov };
    }

    const absPath = resolveAnchoredFilePath(prov.file, targetProject);
    if (!absPath || !fs.existsSync(absPath)) {
        const driftedProv = { ...prov, is_drifted: true, drift_reason: 'file_missing' };
        if (db && row.id && !prov.is_drifted) {
            try {
                db.prepare(`UPDATE ide_agent_memory SET provenance = ?, pg_synced = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(JSON.stringify(driftedProv), row.id);
            } catch (err) {
                console.error('[memory-engine] Failed to update provenance:', err);
                throw err;
            }
        }
        return { anchored: true, is_drifted: true, drift_reason: 'file_missing', provenance: driftedProv };
    }

    const cachedFile = readAnchoredFileCached(absPath);
    if (!cachedFile) {
        return { anchored: true, is_drifted: Boolean(prov.is_drifted), provenance: prov };
    }

    const { fileText, currentHash } = cachedFile;
    if (prov.anchor_hash && currentHash === prov.anchor_hash && !prov.is_drifted) {
        return { anchored: true, is_drifted: false, current_hash: currentHash, provenance: prov };
    }

    // File hash changed or needs verification against verbatim quoted_sentence (INV-12)
    if (prov.quoted_sentence && typeof prov.quoted_sentence === 'string') {
        const normalizedFileText = fileText.replace(/\r\n/g, '\n');
        const normalizedQuote = prov.quoted_sentence.replace(/\r\n/g, '\n');
        const pos = normalizedFileText.indexOf(normalizedQuote);
        if (pos !== -1) {
            const charStart = pos;
            const charEnd = pos + normalizedQuote.length;
            const { startLine, endLine } = getSpanLineRange(normalizedFileText, charStart, charEnd);
            const lineSuffix = `#L${startLine}${endLine !== startLine ? `-L${endLine}` : ''}`;
            const locSuffix = prov.locator ? ` [${prov.locator}]` : '';
            const healedProv = {
                ...prov,
                char_start: charStart,
                char_end: charEnd,
                start_line: startLine,
                end_line: endLine,
                citation: `${prov.file}${lineSuffix}${locSuffix}`,
                anchor_hash: currentHash,
                is_drifted: false,
                drift_reason: null
            };
            if (db && row.id) {
                try {
                    db.prepare(`UPDATE ide_agent_memory SET provenance = ?, pg_synced = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(JSON.stringify(healedProv), row.id);
                } catch (err) {
                    console.error('[memory-engine] Failed to update provenance:', err);
                    throw err;
                }
            }
            return { anchored: true, is_drifted: false, healed: true, current_hash: currentHash, provenance: healedProv };
        } else {
            const reason = prov.drift_reason === 'quoted_span_not_found' ? 'quoted_span_not_found' : 'quoted_span_mutated';
            const driftedProv = {
                ...prov,
                current_hash: currentHash,
                is_drifted: true,
                drift_reason: reason
            };
            if (db && row.id && !prov.is_drifted) {
                try {
                    db.prepare(`UPDATE ide_agent_memory SET provenance = ?, pg_synced = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(JSON.stringify(driftedProv), row.id);
                } catch (err) {
                    console.error('[memory-engine] Failed to update provenance:', err);
                    throw err;
                }
            }
            return { anchored: true, is_drifted: true, drift_reason: reason, current_hash: currentHash, provenance: driftedProv };
        }
    }

    // Whole-file hash anchor without quoted_sentence
    if (prov.anchor_hash && currentHash !== prov.anchor_hash) {
        const driftedProv = {
            ...prov,
            current_hash: currentHash,
            is_drifted: true,
            drift_reason: 'file_hash_mutated'
        };
        if (db && row.id && !prov.is_drifted) {
            try {
                db.prepare(`UPDATE ide_agent_memory SET provenance = ?, pg_synced = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(JSON.stringify(driftedProv), row.id);
            } catch (err) {
                console.error('Failed to update memory provenance:', err);
                throw err;
            }
        }
        return { anchored: true, is_drifted: true, drift_reason: 'file_hash_mutated', current_hash: currentHash, provenance: driftedProv };
    }

    if (!prov.anchor_hash || prov.is_drifted) {
        const healedProv = {
            ...prov,
            anchor_hash: prov.anchor_hash || currentHash,
            is_drifted: false,
            drift_reason: null
        };
        if (db && row.id) {
            try {
                db.prepare(`UPDATE ide_agent_memory SET provenance = ?, pg_synced = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(JSON.stringify(healedProv), row.id);
            } catch (err) {
                console.error('Failed to update memory provenance:', err);
                throw err;
            }
        }
        return { anchored: true, is_drifted: false, healed: true, current_hash: currentHash, provenance: healedProv };
    }

    return { anchored: true, is_drifted: false, current_hash: currentHash, provenance: prov };
}

/**
 * Normalizes user-supplied category to the strict closed set.
 */
export function normalizeCategory(category) {
    if (!category) return 'lesson';
    const lower = category.toLowerCase().trim();
    if (CLOSED_CATEGORIES.has(lower)) return lower;
    
    // Map legacy terms gracefully
    if (lower === 'priorities' || lower === 'priority') return 'decision';
    if (lower === 'outcomes' || lower === 'outcome') return 'lesson';
    if (lower === 'activity' || lower === 'activities') return 'lesson';
    if (lower === 'lessons') return 'lesson';
    if (lower === 'bugs') return 'bug';
    if (lower === 'invariants') return 'invariant';
    if (lower === 'blockers') return 'blocker';
    if (lower === 'decisions') return 'decision';

    throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid category '${category}'. Permitted closed set: ${[...CLOSED_CATEGORIES].join(', ')}.`
    );
}

/**
 * Filter memories to return only active, non-superseded, non-invalidated records.
 */
export function filterActiveMemories(memories = []) {
    if (!Array.isArray(memories)) return [];
    return memories.filter(m => m.status === 'ACTIVE' || (!m.status && !m.superseded_by && !m.supersedes_id));
}

/**
 * Adds or remembers a memory with duplicate check and KruschNexus span-grounded provenance.
 */
export async function addMemory({
    category,
    content,
    tags,
    project,
    active_project,
    supersedes_id,
    provenance,
    force = false,
    _embedding
}) {
    if (!content || typeof content !== 'string' || !content.trim()) {
        throw new McpError(ErrorCode.InvalidParams, "Parameter 'content' must be non-empty text");
    }

    const leakedSecretType =
        scanForSecretLeak(content) ||
        (provenance ? scanForSecretLeak(JSON.stringify(provenance)) : null) ||
        (tags ? scanForSecretLeak(JSON.stringify(tags)) : null);
    if (leakedSecretType) {
        throw new McpError(
            ErrorCode.InvalidParams,
            `Secret refusal: write rejected because payload appears to contain a raw credential (${leakedSecretType}). Redact secrets as [REDACTED] before calling krusch_context_remember.`
        );
    }

    const targetProject = project || active_project || detectCurrentProject();
    const db = await getProjectDb(targetProject);

    let resolvedCategory = category;
    if (supersedes_id && db) {
        const targetRow = db.prepare(`SELECT id, category FROM ide_agent_memory WHERE id = ?`).get(supersedes_id);
        if (!targetRow) {
            throw new McpError(
                ErrorCode.InvalidParams,
                `Target memory #${supersedes_id} not found in project '${targetProject}'.`
            );
        }
        if (!resolvedCategory) {
            resolvedCategory = targetRow.category;
        }
    }

    const normCat = normalizeCategory(resolvedCategory);
    
    // 1. Compute embedding (gracefully null in Zero-GPU offline mode when no provider is configured/reachable)
    const embeddingArray = _embedding || await getEmbedding(content);

    // 2. Near-duplicate detection (non-blocking: proposes revise with candidate id & similarity, does not reject write)
    let nearDup = null;
    if (!force && !supersedes_id) {
        if (embeddingArray) {
            nearDup = await checkNearDuplicateMemory({
                project: targetProject,
                category: normCat,
                embedding: embeddingArray,
                threshold: 0.85
            });
        } else if (db) {
            nearDup = checkOfflineLexicalDuplicate(db, content, 0.82);
        }
    }

    // 3. Process tags (fast deterministic heuristic by default; opt-in LLM tag generation via LLM_AUTO_TAG=true)
    let finalTags = tags ? JSON.stringify(tags) : null;
    if (!finalTags && AUTO_TAG) {
        if (process.env.LLM_AUTO_TAG === 'true' || process.env.LLM_AUTO_TAG === '1') {
            finalTags = await generateTagsFromLLM(content, { asJson: true });
        } else {
            const heuristic = extractHeuristicTags(content, 5);
            finalTags = heuristic.length > 0 ? JSON.stringify(heuristic) : null;
        }
    }

    // 4. Provenance with KruschNexus INV-11/INV-12 Span & Hash Grounding
    const anchoredProv = anchorProvenanceToFile(provenance, targetProject);
    const provPayload = JSON.stringify(anchoredProv);

    const embeddingStr = embeddingArray ? `[${embeddingArray.join(',')}]` : null;
    const embeddingBlob = embeddingArray ? encodeEmbeddingBlob(embeddingArray) : null;

    // 5. Insert into SQLite project DB atomically
    if (db) {
        const newId = withTransaction(db, () => {
            const info = db.prepare(`
                INSERT INTO ide_agent_memory (category, content, tags, embedding, embedding_blob, status, supersedes_id, provenance, pg_synced)
                VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?, 0)
            `).run(normCat, content, finalTags, embeddingStr, embeddingBlob, supersedes_id || null, provPayload);

            const insertedId = info.lastInsertRowid;
            if (supersedes_id) {
                const upd = db.prepare(`
                    UPDATE ide_agent_memory
                    SET status = 'SUPERSEDED', superseded_by = ?, pg_synced = 0, updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                `).run(insertedId, supersedes_id);
                if (upd.changes === 0) {
                    throw new McpError(
                        ErrorCode.InvalidParams,
                        `Target memory #${supersedes_id} not found in project '${targetProject}'.`
                    );
                }
            }
            return insertedId;
        });

        // Push behind if postgres available
        pushProjectMemory(targetProject, db).catch(() => {});

        const supersedeNote = supersedes_id ? ` (supersedes ID ${supersedes_id})` : '';
        const offlineNote = !embeddingArray ? ' [offline lexical mode]' : '';
        const nearDupNote = nearDup 
            ? `\n\n⚠️ Near-duplicate memory detected (${(nearDup.similarity * 100).toFixed(1)}% match with Memory #${nearDup.id} [${nearDup.category}]: "${nearDup.content}").\n` +
              `If this memory supersedes or contradicts #${nearDup.id}, call 'revise' with action: 'supersede', target_id: ${nearDup.id}.`
            : '';

        const response = {
            content: [{
                type: "text",
                text: `[krusch-context] ✅ Successfully saved memory to SQLite project DB: ${targetProject} (${normCat}) #${newId}${supersedeNote}${offlineNote}${nearDupNote}`
            }],
            id: newId,
            offline: !embeddingArray
        };

        if (nearDup) {
            response.warning = 'near_duplicate';
            response.candidate_id = nearDup.id;
            response.candidate_content = nearDup.content;
            response.similarity = nearDup.similarity;
            response.suggested_action = {
                tool: 'krusch_context_revise',
                action: 'supersede',
                target_id: nearDup.id
            };
        }

        return response;
    }

    throw new McpError(ErrorCode.InternalError, "Failed to access local database");
}

/**
 * Deterministic token-Jaccard near-duplicate detector for Zero-GPU offline writes.
 */
function checkOfflineLexicalDuplicate(db, content, threshold = 0.82) {
    const tokenize = (str) => new Set(
        String(str || '').toLowerCase().split(/[^a-z0-9_]+/).filter(w => w.length >= 3)
    );
    const targetTokens = tokenize(content);
    if (targetTokens.size === 0) return null;

    const rows = db.prepare(`
        SELECT id, category, content
        FROM ide_agent_memory
        WHERE status = 'ACTIVE'
        ORDER BY id DESC
        LIMIT 300
    `).all();

    let best = null;
    let maxSim = 0;
    for (const r of rows) {
        const candTokens = tokenize(r.content);
        if (candTokens.size === 0) continue;
        let inter = 0;
        for (const t of targetTokens) {
            if (candTokens.has(t)) inter++;
        }
        const union = targetTokens.size + candTokens.size - inter;
        const sim = union > 0 ? inter / union : 0;
        if (sim > maxSim) {
            maxSim = sim;
            best = { id: r.id, category: r.category, content: r.content, similarity: sim };
        }
    }
    return maxSim >= threshold ? best : null;
}

/**
 * Lazily backfills NULL embeddings for active memories saved while in Zero-GPU offline mode.
 */
export async function backfillMissingEmbeddings({ project, active_project, limit = 25, _embedFn = getEmbedding } = {}) {
    const targetProject = project || active_project || detectCurrentProject();
    const db = await getProjectDb(targetProject);
    if (!db) return { backfilledCount: 0, remainingNullCount: 0 };

    const nullRows = db.prepare(`
        SELECT id, content
        FROM ide_agent_memory
        WHERE status = 'ACTIVE' AND embedding IS NULL
        ORDER BY id DESC
        LIMIT ?
    `).all(Math.max(1, Number(limit) || 25));

    let backfilledCount = 0;
    const updStmt = db.prepare(`
        UPDATE ide_agent_memory
        SET embedding = ?, embedding_blob = ?, pg_synced = 0, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `);

    for (const row of nullRows) {
        const vec = await _embedFn(row.content);
        if (Array.isArray(vec) && vec.length > 0) {
            updStmt.run(`[${vec.join(',')}]`, encodeEmbeddingBlob(vec), row.id);
            backfilledCount++;
        } else {
            break; // Provider still offline; fail fast
        }
    }

    if (backfilledCount > 0) {
        pushProjectMemory(targetProject, db).catch(() => {});
    }

    const remRow = db.prepare(`
        SELECT count(*) as count
        FROM ide_agent_memory
        WHERE status = 'ACTIVE' AND embedding IS NULL
    `).get();

    const remCount = remRow ? remRow.count : 0;
    return {
        backfilledCount,
        remainingNullCount: remCount,
        updated: backfilledCount,
        remaining: remCount
    };
}


/**
 * Supersedes an outdated memory with updated knowledge.
 */
export async function supersedeMemory({ id, target_id, category, content, project, active_project, tags, provenance, _embedding }) {
    const resolvedTargetId = target_id ?? id;
    if (!resolvedTargetId) throw new McpError(ErrorCode.InvalidParams, "Missing parameter 'id'");
    if (!content) throw new McpError(ErrorCode.InvalidParams, "Missing parameter 'content'");

    const targetProject = project || active_project || detectCurrentProject();
    const db = await getProjectDb(targetProject);
    if (!db) throw new McpError(ErrorCode.InternalError, "Failed to access local database");

    const targetRow = db.prepare(`SELECT id, category FROM ide_agent_memory WHERE id = ?`).get(resolvedTargetId);
    if (!targetRow) {
        throw new McpError(
            ErrorCode.InvalidParams,
            `Target memory #${resolvedTargetId} not found in project '${targetProject}'.`
        );
    }

    return await addMemory({
        category: category || targetRow.category,
        content,
        tags,
        project: targetProject,
        supersedes_id: resolvedTargetId,
        provenance,
        force: true,
        _embedding
    });
}

/**
 * Explicitly invalidates a memory with a mandatory reason.
 */
export async function invalidateMemory({ id, target_id, reason, project, active_project }) {
    const resolvedId = target_id ?? id;
    if (!resolvedId) throw new McpError(ErrorCode.InvalidParams, "Missing parameter 'id'");
    if (!reason || typeof reason !== 'string' || !reason.trim()) {
        throw new McpError(
            ErrorCode.InvalidParams,
            "Invalidation requires a non-empty 'reason' describing why this memory is obsolete/deprecated."
        );
    }

    const leakedSecretType = scanForSecretLeak(reason);
    if (leakedSecretType) {
        throw new McpError(
            ErrorCode.InvalidParams,
            `Secret refusal: invalidation rejected because reason appears to contain a raw credential (${leakedSecretType}). Redact secrets as [REDACTED] before calling krusch_context_revise.`
        );
    }

    const targetProject = project || active_project || detectCurrentProject();
    const db = await getProjectDb(targetProject);
    if (db) {
        const info = db.prepare(`
            UPDATE ide_agent_memory 
            SET status = 'INVALIDATED', invalidated_reason = ?, pg_synced = 0, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(reason.trim(), resolvedId);

        if (info.changes === 0) {
            throw new McpError(
                ErrorCode.InvalidParams,
                `Target memory #${resolvedId} not found in project '${targetProject}'.`
            );
        }

        pushProjectMemory(targetProject, db).catch(() => {});

        return {
            content: [{
                type: "text",
                text: `[krusch-context] 🗑️ Memory #${resolvedId} marked as INVALIDATED.\nReason: "${reason.trim()}"`
            }]
        };
    }

    throw new McpError(ErrorCode.InternalError, "Failed to access local database");
}

/**
 * Searches memories using semantic and keyword matching.
 */
export async function searchMemory({
    category,
    query,
    limit = 5,
    project,
    active_project,
    include_superseded = false,
    _embedding
}) {
    if (!query) throw new McpError(ErrorCode.InvalidParams, "Missing parameter 'query'");
    const targetProject = project || active_project || detectCurrentProject();
    const normCat = category ? normalizeCategory(category) : null;

    const db = await getProjectDb(targetProject);
    if (!db) return { content: [{ type: "text", text: "No memories found (database unavailable)." }] };

    let sql = `SELECT id, category, content, tags, status, supersedes_id, superseded_by, created_at, embedding, embedding_blob FROM ide_agent_memory`;
    const conditions = [];
    const params = [];

    if (!include_superseded) {
        conditions.push(`status = 'ACTIVE'`);
    }
    if (normCat) {
        conditions.push(`category = ?`);
        params.push(normCat);
    }
    if (conditions.length > 0) {
        sql += ` WHERE ` + conditions.join(' AND ');
    }
    sql += ` ORDER BY created_at DESC LIMIT 250`;

    const rows = db.prepare(sql).all(...params);
    const embeddingArray = _embedding || await getEmbedding(query, { mode: 'query', domain: 'memory' });
    const lowerQuery = query.toLowerCase();

    const scored = rows.map(r => {
        let score = 0.5;
        if (embeddingArray && (r.embedding || r.embedding_blob)) {
            const vec = getParsedEmbedding(r.embedding, r.embedding_blob);
            if (vec) {
                score = calibrateQuerySimilarity(cosineSimilarity(embeddingArray, vec), { queryVec: embeddingArray });
            }
        }
        if (r.content.toLowerCase().includes(lowerQuery)) {
            score = Math.max(score, 0.8);
        }
        return { ...r, score };
    }).sort((a, b) => b.score - a.score).slice(0, limit);

    if (scored.length === 0) {
        return { content: [{ type: "text", text: `=== 🧠 Memory Retrieval: "${query}" (0 results) ===\n\nNo memories found matching "${query}".` }] };
    }


    let output = `=== 🧠 Memory Retrieval: "${query}" (${scored.length} results) ===\n\n`;
    for (const s of scored) {
        const badge = s.status === 'SUPERSEDED' ? ' [SUPERSEDED]' : '';
        output += `* **#${s.id}** [${s.category}]${badge} (Score: ${(s.score * 100).toFixed(1)}%): ${s.content}\n`;
    }

    return { content: [{ type: "text", text: output }] };

}

/**
 * Returns memories unreferenced or older than 30 days for decay review, prioritizing non-invariant records.
 */
function hasMemoryColumn(db, colName) {
    try {
        const cols = db.prepare(`PRAGMA table_info(ide_agent_memory)`).all();
        return Array.isArray(cols) && cols.some(c => c.name === colName);
    } catch {
        return false;
    }
}

function computeProjectAffinity(row, targetProject) {
    if (!targetProject || targetProject === 'default' || targetProject === 'homelab' || /^(test_|smoke_)/i.test(String(targetProject))) {
        return 1;
    }
    const projLower = String(targetProject).toLowerCase();
    let provFile = row?._drift?.provenance?.file || null;
    if (!provFile && row?.provenance) {
        try {
            const parsed = typeof row.provenance === 'string' ? JSON.parse(row.provenance) : row.provenance;
            provFile = parsed?.file || null;
        } catch {}
    }
    if (provFile && typeof provFile === 'string') {
        const normFile = provFile.replace(/\\/g, '/').replace(/^\.\//, '');
        const sibMatch = normFile.match(/^projects\/([^/]+)\//i);
        if (sibMatch) {
            return sibMatch[1].toLowerCase() === projLower ? 3 : 0;
        }
        if (/^(src|bin|tests|benchmarks|db|docs|templates|scripts)\//i.test(normFile)) {
            return 3;
        }
    }
    const lowerContent = String(row?.content || '').toLowerCase();
    if (lowerContent.includes(projLower)) {
        return 2;
    }
    const otherProjRefs = [...lowerContent.matchAll(/\bprojects\/([a-z0-9_-]+)/gi)].map(m => m[1].toLowerCase());
    if (otherProjRefs.length > 0 && otherProjRefs.every(p => p !== projLower)) {
        return 0;
    }
    return 1;
}

function sortByProjectAffinity(items, targetProject) {
    if (!items || items.length <= 1) return items;
    return items
        .map((item, idx) => ({ item, idx, aff: computeProjectAffinity(item, targetProject) }))
        .sort((a, b) => (b.aff - a.aff) || (a.idx - b.idx))
        .map(x => x.item);
}

function compactStateText(raw, maxChars) {
    if (!maxChars || typeof raw !== 'string' || raw.length <= maxChars) return raw;
    const flat = raw.replace(/\s+/g, ' ').trim();
    if (flat.length <= maxChars) return flat;
    const limit = Math.max(40, maxChars - 3);
    const slice = flat.slice(0, limit);
    const lastSpace = slice.lastIndexOf(' ');
    const clean = lastSpace > limit * 0.65 ? slice.slice(0, lastSpace) : slice;
    return `${clean.replace(/[,;:\s]+$/, '')}...`;
}

/**
 * Re-affirms an active memory as verified/referenced, refreshing its 30-day decay window without rewriting content.
 */
export async function touchMemory({ id, target_id, project, active_project } = {}) {
    const resolvedId = target_id ?? id;
    if (!resolvedId) {
        throw new McpError(ErrorCode.InvalidParams, "Missing parameter 'id' or 'target_id'");
    }
    const targetProject = project || active_project || detectCurrentProject();
    const db = await getProjectDb(targetProject);
    if (!db) throw new McpError(ErrorCode.InternalError, "Database unavailable");

    const hasLastAcc = hasMemoryColumn(db, 'last_accessed_at');
    const sql = hasLastAcc
        ? `UPDATE ide_agent_memory SET last_accessed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP, pg_synced = 0 WHERE id = ? AND status = 'ACTIVE'`
        : `UPDATE ide_agent_memory SET updated_at = CURRENT_TIMESTAMP, pg_synced = 0 WHERE id = ? AND status = 'ACTIVE'`;
    const info = db.prepare(sql).run(resolvedId);
    if (info.changes === 0) {
        throw new McpError(
            ErrorCode.InvalidParams,
            `Active memory #${resolvedId} not found in project '${targetProject}'.`
        );
    }
    return {
        content: [{
            type: "text",
            text: `[krusch-context] ✅ Verified & refreshed freshness window for Memory #${resolvedId}.`
        }],
        id: Number(resolvedId),
        touched: true
    };
}

/**
 * Returns memories unreferenced or older than 30 days for decay review, prioritizing non-invariant records.
 */
export async function getStaleMemories({ project, days = 30, limit = 10 } = {}) {
    const targetProject = project || detectCurrentProject();
    const db = await getProjectDb(targetProject);
    if (!db) return [];

    const hasLastAcc = hasMemoryColumn(db, 'last_accessed_at');
    const tsExpr = hasLastAcc
        ? `COALESCE(last_accessed_at, updated_at, created_at)`
        : `COALESCE(updated_at, created_at)`;
    const fetchPool = Math.max(limit, 30);

    const rows = db.prepare(`
        SELECT id, category, content, provenance, created_at, updated_at
        FROM ide_agent_memory
        WHERE status = 'ACTIVE'
          AND ${tsExpr} < datetime('now', '-' || ? || ' days')
        ORDER BY CASE WHEN category = 'invariant' THEN 1 ELSE 0 END ASC,
                 ${tsExpr} ASC
        LIMIT ?
    `).all(days, fetchPool);

    if (!targetProject || targetProject === 'default' || targetProject === 'homelab' || /^(test_|smoke_)/i.test(String(targetProject))) {
        return rows.slice(0, limit);
    }

    return rows
        .map((r, idx) => ({
            r,
            idx,
            isInv: r.category === 'invariant' ? 1 : 0,
            aff: computeProjectAffinity(r, targetProject)
        }))
        .sort((a, b) => (a.isInv - b.isInv) || (b.aff - a.aff) || (a.idx - b.idx))
        .slice(0, limit)
        .map(x => x.r);
}

/**
 * Compiles a consolidated project state briefing with KruschNexus INV-12 span drift verification
 * and bounded token-budget compaction.
 */
export async function compileProjectState({ project, active_project, max_tokens } = {}) {
    const targetProject = project || active_project || detectCurrentProject();
    const db = await getProjectDb(targetProject);
    const maxStateTokens = Math.max(300, Number(max_tokens) || Number(process.env.KRUSCH_STATE_MAX_TOKENS) || 2400);
    const maxCharsBudget = maxStateTokens * 4;

    let decisions = [];
    let invariants = [];
    let blockers = [];
    let bugs = [];
    let lessons = [];
    const handoffs = [];
    let nuggets = [];
    const invalidated = [];
    const drifted = [];

    if (db) {
        const rows = db.prepare(`
            SELECT id, category, content, status, invalidated_reason, provenance, created_at
            FROM ide_agent_memory
            ORDER BY created_at DESC, id DESC
            LIMIT 250
        `).all();
        const seenContents = new Set();

        for (const r of rows) {
            const normStatus = String(r.status || 'ACTIVE').toUpperCase();
            if (normStatus === 'INVALIDATED') {
                if (invalidated.length < 5) invalidated.push(r);
                continue;
            }
            if (normStatus !== 'ACTIVE') continue;
            seenContents.add(String(r.content || '').trim());

            const driftCheck = evaluateMemorySpanDrift(r, targetProject, db);
            r._drift = driftCheck;
            if (driftCheck.is_drifted) {
                drifted.push({ ...r, provenance: driftCheck.provenance, drift_reason: driftCheck.drift_reason });
            }

            if (r.category === 'decision') decisions.push(r);
            else if (r.category === 'invariant') invariants.push(r);
            else if (r.category === 'blocker') blockers.push(r);
            else if (r.category === 'bug') bugs.push(r);
            else lessons.push(r);
        }

        // Also surface [targetProject]-tagged active audit memories from jean-sre if present
        if (targetProject !== 'jean-sre' && !/^(test_|smoke_)/i.test(String(targetProject || ''))) {
            try {
                const jeanDbPath = path.join(resolveProjectPath('jean-sre'), '.agent', 'context.db');
                if (fs.existsSync(jeanDbPath)) {
                    const jeanDb = await getProjectDb('jean-sre');
                    if (jeanDb) {
                        const prefixPattern = `[${String(targetProject).toLowerCase()}]%`;
                        const jeanRows = jeanDb.prepare(`
                            SELECT id, category, content, status, provenance, created_at
                            FROM ide_agent_memory
                            WHERE status = 'ACTIVE' AND LOWER(content) LIKE ?
                            ORDER BY created_at DESC, id DESC
                            LIMIT 10
                        `).all(prefixPattern);
                        for (const jr of jeanRows) {
                            const normContent = String(jr.content || '').trim();
                            if (seenContents.has(normContent)) continue;
                            seenContents.add(normContent);
                            if (jr.category === 'decision') decisions.push(jr);
                            else if (jr.category === 'invariant') invariants.push(jr);
                            else if (jr.category === 'blocker') blockers.push(jr);
                            else if (jr.category === 'bug') bugs.push(jr);
                            else lessons.push(jr);
                        }
                    }
                }
            } catch {}
        }

        decisions = sortByProjectAffinity(decisions, targetProject);
        invariants = sortByProjectAffinity(invariants, targetProject);
        blockers = sortByProjectAffinity(blockers, targetProject);
        bugs = sortByProjectAffinity(bugs, targetProject);
        lessons = sortByProjectAffinity(lessons, targetProject);

        const nugRows = db.prepare(`SELECT key, value, kind FROM ide_agent_nuggets ORDER BY updated_at ASC`).all();
        const nugMap = new Map();
        for (const n of nugRows) nugMap.set(n.key, n);
        for (const n of nugMap.values()) {
            const lowerKey = String(n.key || '').toLowerCase();
            if (lowerKey === 'handoff' || lowerKey.startsWith('handoff:')) {
                handoffs.push(n);
            } else {
                nuggets.push(n);
            }
        }
        if (targetProject && targetProject !== 'default' && targetProject !== 'homelab' && !/^(test_|smoke_)/i.test(String(targetProject))) {
            const projLower = String(targetProject).toLowerCase();
            nuggets = nuggets
                .map((n, idx) => {
                    const hay = `${n.key || ''} ${n.value || ''}`.toLowerCase();
                    const aff = hay.includes(projLower) ? 2 : 1;
                    return { n, idx, aff };
                })
                .sort((a, b) => (b.aff - a.aff) || (b.idx - a.idx))
                .map(x => x.n);
        }
    }

    const stale = await getStaleMemories({ project: targetProject, days: 30 });
    const formatSpanBadge = (r) => {
        if (!r._drift?.anchored) return '';
        const cit = r._drift.provenance?.citation || r._drift.provenance?.file || 'file';
        return r._drift.is_drifted ? ` ⚠️ *[DRIFTED: ${cit}]*` : ` *[Anchor: ${cit}]*`;
    };

    const renderState = (cfg = null) => {
        const packedIds = [];
        const packedNuggetKeys = [];
        let out = `# 🧠 Compiled Project State: ${targetProject}\n\n`;

        if (handoffs.length > 0) {
            out += `## 🤝 Active Session Handoff (${handoffs.length})\n`;
            for (const h of handoffs) {
                packedNuggetKeys.push(h.key);
                out += `- **${h.key}**: ${compactStateText(h.value, cfg?.handoffChars)}\n`;
            }
            out += `\n`;
        }

        const decLimit = cfg?.decisionCount ?? 5;
        out += `## 🎯 Decisions & Priorities (${decisions.length})\n`;
        if (decisions.length === 0) out += `- No active decisions or priorities recorded.\n`;
        for (const d of decisions.slice(0, decLimit)) {
            packedIds.push(d.id);
            out += `- **#${d.id}**: ${compactStateText(d.content, cfg?.decisionChars)}${formatSpanBadge(d)}\n`;
        }
        out += `\n`;

        const invLimit = cfg?.invariantCount ?? 5;
        out += `## 🛡️ Project Invariants (${invariants.length})\n`;
        if (invariants.length === 0) out += `- No invariants recorded.\n`;
        for (const inv of invariants.slice(0, invLimit)) {
            packedIds.push(inv.id);
            out += `- **#${inv.id}**: ${compactStateText(inv.content, cfg?.invariantChars)}${formatSpanBadge(inv)}\n`;
        }
        out += `\n`;

        // Active blockers always surface ahead of resolved historical bug postmortems
        const bugsAndBlockers = [...blockers, ...bugs];
        const bugLimit = cfg?.bugCount ?? 5;
        out += `## 🐛 Known Bugs & Blockers (${bugsAndBlockers.length})\n`;
        if (bugsAndBlockers.length === 0) out += `- Zero active blockers.\n`;
        for (const b of bugsAndBlockers.slice(0, bugLimit)) {
            packedIds.push(b.id);
            const charCap = b.category === 'blocker' ? cfg?.blockerChars : cfg?.bugChars;
            out += `- **#${b.id}** [${b.category}]: ${compactStateText(b.content, charCap)}${formatSpanBadge(b)}\n`;
        }
        out += `\n`;

        const lesLimit = cfg?.lessonCount ?? 5;
        out += `## 📖 Core Lessons (${lessons.length})\n`;
        if (lessons.length === 0) out += `- No lessons recorded yet.\n`;
        for (const l of lessons.slice(0, lesLimit)) {
            packedIds.push(l.id);
            out += `- **#${l.id}**: ${compactStateText(l.content, cfg?.lessonChars)}${formatSpanBadge(l)}\n`;
        }
        out += `\n`;

        if (nuggets.length > 0) {
            const nugSlice = cfg?.maxNuggets ? nuggets.slice(0, cfg.maxNuggets) : nuggets;
            out += `## ⚡ Steering Nuggets (${nuggets.length})\n`;
            for (const n of nugSlice) {
                packedNuggetKeys.push(n.key);
                out += `- **${n.key}**: ${compactStateText(n.value, cfg?.nuggetChars)}\n`;
            }
            out += `\n`;
        }

        if (drifted.length > 0) {
            const driftSlice = cfg?.maxDrifted ? drifted.slice(0, cfg.maxDrifted) : drifted;
            out += `## ⚠️ Span-Grounded Drift Review (${drifted.length} drifted)\n`;
            for (const dr of driftSlice) {
                const cit = dr.provenance?.citation || dr.provenance?.file || 'anchored file';
                out += `- Memory #${dr.id} [${dr.category}] (${cit} — ${dr.drift_reason}): "${dr.content.substring(0, 80)}..."\n`;
            }
            out += `\n`;
        }

        if (invalidated.length > 0) {
            const invRuleSlice = cfg?.maxInvalidated ? invalidated.slice(0, cfg.maxInvalidated) : invalidated;
            out += `## 🚫 Recently Invalidated Rules (${invalidated.length})\n`;
            for (const inv of invRuleSlice) {
                out += `- ~~#${inv.id} (${inv.category})~~ — *Revocation Reason*: ${compactStateText(inv.invalidated_reason || 'Deprecated', cfg?.invalidatedChars)}\n`;
            }
            out += `\n`;
        }

        if (stale.length > 0) {
            const staleSlice = cfg?.maxStale ? stale.slice(0, cfg.maxStale) : stale;
            out += `## ⏳ Decay Review (${stale.length} items >30 days old)\n`;
            for (const s of staleSlice) {
                out += `- Memory #${s.id} [${s.category}]: "${s.content.substring(0, 80)}..." (Review if still valid)\n`;
            }
            out += `\n`;
        }

        return { out, packedIds, packedNuggetKeys };
    };

    // Pass 1: Un-compacted rendering (preserves 100% verbatim text on small/medium stores)
    let rendered = renderState(null);

    // Pass 2: Progressive entry compaction when mature repositories exceed state token budget
    if (rendered.out.length > maxCharsBudget) {
        rendered = renderState({
            handoffChars: 480,
            invariantChars: 420,
            blockerChars: 420,
            decisionChars: 300,
            lessonChars: 280,
            bugChars: 210,
            nuggetChars: 200,
            maxNuggets: 6,
            maxDrifted: 5,
            maxInvalidated: 3,
            invalidatedChars: 150,
            maxStale: 5
        });
    }

    // Pass 3: Tight budget compaction when caller supplies a small max_tokens ceiling
    if (rendered.out.length > maxCharsBudget) {
        rendered = renderState({
            decisionCount: 3,
            invariantCount: 4,
            bugCount: 3,
            lessonCount: 3,
            handoffChars: 240,
            invariantChars: 220,
            blockerChars: 220,
            decisionChars: 160,
            lessonChars: 150,
            bugChars: 130,
            nuggetChars: 120,
            maxNuggets: 3,
            maxDrifted: 3,
            maxInvalidated: 2,
            invalidatedChars: 100,
            maxStale: 3
        });
        if (rendered.out.length > maxCharsBudget) {
            rendered.out = rendered.out.slice(0, Math.max(200, maxCharsBudget - 4)).trimEnd() + '\n';
        }
    }

    return {
        content: [{ type: "text", text: rendered.out }],
        packedIds: rendered.packedIds,
        packedNuggetKeys: rendered.packedNuggetKeys
    };
}

/**
 * Returns health diagnostic statistics including KruschNexus INV-12 span drift metrics.
 */
export async function getHealthStats({ project } = {}) {
    const targetProject = project || detectCurrentProject();
    const mode = getStorageMode();
    const db = await getProjectDb(targetProject);

    let activeCount = 0;
    let supersededCount = 0;
    let invalidatedCount = 0;
    let nuggetCount = 0;
    let rollupCount = 0;
    let anchoredCount = 0;
    let driftedCount = 0;
    let staleCount = 0;
    let unembeddedCount = 0;
    const categoryCounts = {};

    if (db) {
        const memRows = db.prepare(`SELECT id, category, status, provenance, embedding FROM ide_agent_memory`).all();
        for (const r of memRows) {
            const normStatus = String(r.status || 'ACTIVE').toUpperCase();
            if (normStatus === 'ACTIVE') {
                activeCount++;
                if (!r.embedding) unembeddedCount++;
                let normCat = 'lesson';
                try { normCat = normalizeCategory(r.category); } catch { normCat = 'lesson'; }
                categoryCounts[normCat] = (categoryCounts[normCat] || 0) + 1;
                const driftCheck = evaluateMemorySpanDrift(r, targetProject, db);
                if (driftCheck.anchored) {
                    anchoredCount++;
                    if (driftCheck.is_drifted) driftedCount++;
                }
            } else if (normStatus === 'SUPERSEDED') {
                supersededCount++;
            } else if (normStatus === 'INVALIDATED') {
                invalidatedCount++;
            }
        }
        const nugRow = db.prepare(`SELECT count(*) as count FROM ide_agent_nuggets`).get();
        nuggetCount = nugRow ? nugRow.count : 0;

        try {
            const rollupRow = db.prepare(`SELECT count(*) as count FROM ide_episode_rollups`).get();
            rollupCount = rollupRow ? rollupRow.count : 0;
        } catch {}

        const hasLastAcc = hasMemoryColumn(db, 'last_accessed_at');
        const tsExpr = hasLastAcc
            ? `COALESCE(last_accessed_at, updated_at, created_at)`
            : `COALESCE(updated_at, created_at)`;
        const staleRow = db.prepare(`
            SELECT count(*) as count
            FROM ide_agent_memory
            WHERE status = 'ACTIVE'
              AND ${tsExpr} < datetime('now', '-30 days')
        `).get();
        staleCount = staleRow ? staleRow.count : 0;
    }

    const worktree = getWorktreeStatus();

    let output = `# 🩺 Krusch Context Health Status\n\n`;
    output += `* **Storage Mode**: \`${mode}\` (${mode === 'sqlite' ? '.agent/context.db' : 'PostgreSQL'})\n`;
    output += `* **Active Project**: \`${targetProject}\`\n`;
    output += `* **Worktree Dirty**: ${worktree.isDirty ? `⚠️ Yes (${worktree.modifiedCount} uncommitted files)` : `✅ Clean`}\n`;
    output += `* **Active Memories**: ${activeCount}\n`;
    for (const cat of CLOSED_CATEGORIES) {
        output += `  - ${cat}: ${categoryCounts[cat] || 0}\n`;
    }
    output += `* **Span-Anchored Memories (INV-12)**: ${anchoredCount} (${driftedCount > 0 ? `⚠️ ${driftedCount} drifted` : '✅ 0 drifted'})\n`;
    if (unembeddedCount > 0) {
        output += `* **Offline / Unembedded Memories**: ${unembeddedCount} (lexical-indexed)\n`;
    }
    output += `* **Superseded Lineage**: ${supersededCount}\n`;
    output += `* **Invalidated Records**: ${invalidatedCount}\n`;
    output += `* **Steering Nuggets**: ${nuggetCount}\n`;
    if (rollupCount > 0) {
        output += `* **Episode Rollups**: ${rollupCount}\n`;
    }
    if (staleCount > 0) {
        output += `* **Decay Review**: ⏳ ${staleCount} memories have not been referenced in >30 days.\n`;
    } else {
        output += `* **Decay Review**: ✅ All active memories fresh (<30 days).\n`;
    }

    return {
        content: [{ type: "text", text: output }],
        stats: {
            storageMode: mode,
            project: targetProject,
            activeCount,
            anchoredCount,
            driftedCount,
            unembeddedCount,
            supersededCount,
            invalidatedCount,
            nuggetCount,
            rollupCount,
            staleCount
        }
    };
}

/**
 * Lists memories chronologically (Admin tool for extended profile).
 */
export async function listMemories({ category, project, active_project, limit = 10 } = {}) {
    const targetProject = project || active_project || detectCurrentProject();
    const db = await getProjectDb(targetProject);
    if (!db) return { content: [{ type: "text", text: "Database not available." }] };

    let sql = `SELECT id, category, content, tags, status, created_at FROM ide_agent_memory`;
    const params = [];
    if (category) {
        sql += ` WHERE category = ?`;
        params.push(normalizeCategory(category));
    }
    sql += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);

    const rows = db.prepare(sql).all(...params);
    if (rows.length === 0) {
        return { content: [{ type: "text", text: `No memories found${category ? ` in category ${category}` : ''}.` }] };
    }

    let output = `=== 📋 Memory List (${rows.length} records) ===\n\n`;
    for (const r of rows) {
        output += `* **#${r.id}** [${r.category}] (${r.status}): ${r.content}\n`;
    }
    return { content: [{ type: "text", text: output }] };
}

/**
 * Hard-deletes a memory record (Admin tool for extended profile).
 */
export async function deleteMemory({ id, project, active_project } = {}) {
    if (!id) throw new McpError(ErrorCode.InvalidParams, "Missing parameter 'id'");
    const targetProject = project || active_project || detectCurrentProject();
    const db = await getProjectDb(targetProject);
    if (db) {
        db.prepare(`DELETE FROM ide_agent_memory WHERE id = ?`).run(id);
        return { content: [{ type: "text", text: `[krusch-context] 🗑️ Deleted memory record #${id}` }] };
    }
    throw new McpError(ErrorCode.InternalError, "Database unavailable");
}

/**
 * Updates a memory record's content and tags (Admin tool for extended profile).
 */
export async function updateMemory({ id, content, tags, project, active_project, _embedding } = {}) {
    if (!id || !content) throw new McpError(ErrorCode.InvalidParams, "Missing id or content");
    const leakedSecretType =
        scanForSecretLeak(String(content)) ||
        (tags ? scanForSecretLeak(JSON.stringify(tags)) : null);
    if (leakedSecretType) {
        throw new McpError(
            ErrorCode.InvalidParams,
            `Secret refusal: update rejected because payload appears to contain a raw credential (${leakedSecretType}). Redact secrets as [REDACTED] before updating.`
        );
    }
    const targetProject = project || active_project || detectCurrentProject();
    const db = await getProjectDb(targetProject);
    if (db) {
        const emb = _embedding || await getEmbedding(content);
        const embStr = emb ? `[${emb.join(',')}]` : null;
        const embBlob = emb ? encodeEmbeddingBlob(emb) : null;
        const tagStr = tags ? JSON.stringify(tags) : null;
        db.prepare(`UPDATE ide_agent_memory SET content = ?, tags = ?, embedding = ?, embedding_blob = ?, pg_synced = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(content, tagStr, embStr, embBlob, id);
        pushProjectMemory(targetProject, db).catch(() => {});
        return { content: [{ type: "text", text: `[krusch-context] ✅ Updated memory record #${id}` }] };
    }
    throw new McpError(ErrorCode.InternalError, "Database unavailable");
}

/**
 * Consolidates duplicate memories within a category (Admin tool for extended profile).
 */
export async function consolidateMemories({ category, project, active_project, threshold = 0.15, dry_run = false } = {}) {
    if (!category) throw new McpError(ErrorCode.InvalidParams, "Missing category");
    const targetProject = project || active_project || detectCurrentProject();
    const normCat = normalizeCategory(category);
    const db = await getProjectDb(targetProject);
    if (!db) return { content: [{ type: "text", text: "Database unavailable" }] };

    const rows = db.prepare(`SELECT id, content, embedding, embedding_blob FROM ide_agent_memory WHERE category = ? AND status = 'ACTIVE'`).all(normCat);
    const pairs = [];

    for (let i = 0; i < rows.length; i++) {
        const vecA = getParsedEmbedding(rows[i].embedding, rows[i].embedding_blob);
        if (!vecA) continue;
        for (let j = i + 1; j < rows.length; j++) {
            const vecB = getParsedEmbedding(rows[j].embedding, rows[j].embedding_blob);
            if (!vecB) continue;
            const sim = cosineSimilarity(vecA, vecB);
            const dist = 1 - sim;
            if (dist <= threshold) {
                pairs.push({ a: rows[i], b: rows[j], dist });
            }
        }
    }

    if (pairs.length === 0) {
        return { content: [{ type: "text", text: `✅ No duplicate memories found in category '${normCat}' (threshold: ${threshold})` }] };
    }

    if (dry_run) {
        let output = `=== 🔍 Consolidation Preview (${pairs.length} duplicate pairs) ===\n\n`;
        for (const p of pairs) {
            output += `* Distance: ${p.dist.toFixed(3)}\n  - #${p.a.id}: "${p.a.content.substring(0, 60)}..."\n  - #${p.b.id}: "${p.b.content.substring(0, 60)}..."\n`;
        }
        return { content: [{ type: "text", text: output }] };
    }

    let mergedCount = 0;
    const updStmt = db.prepare(`UPDATE ide_agent_memory SET status = 'SUPERSEDED', superseded_by = ?, pg_synced = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`);
    withTransaction(db, () => {
        for (const p of pairs) {
            // Mark the newer one as superseded by the older one
            updStmt.run(p.a.id, p.b.id);
            mergedCount++;
        }
    });

    try {
        const existingRollups = db.prepare(`SELECT count(*) as count FROM ide_episode_rollups`).get()?.count || 0;
        if (existingRollups > 0) {
            const rebuilt = ensureEpisodeRollups(db, { project: targetProject, forceRebuild: true });
            if (!rebuilt.active) {
                db.prepare(`DELETE FROM ide_episode_rollups`).run();
            }
        }
    } catch {}

    pushProjectMemory(targetProject, db).catch(() => {});

    return { content: [{ type: "text", text: `🔗 Consolidated ${mergedCount} duplicate pairs in category '${normCat}'.` }] };
}


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
import { getEmbedding } from './embedding-helper.js';
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { getProjectDb, cosineSimilarity, getParsedEmbedding, pushProjectMemory, resolveProjectPath } from './sqlite-engine.js';
import { checkNearDuplicateMemory, getStorageMode } from './storage-adapter.js';
import { generateTagsFromLLM, extractHeuristicTags } from './llm-tags.js';
import { detectCurrentProject, getWorktreeStatus } from './project-helper.js';

export const CLOSED_CATEGORIES = new Set(['decision', 'bug', 'invariant', 'lesson', 'blocker']);
const DECAY_RATE = 0.01;
const AUTO_TAG = true;

const SECRET_PATTERNS = [
    { label: 'OpenRouter API Key', regex: /\bsk-or-v1-[A-Za-z0-9_-]{20,}\b/ },
    { label: 'OpenAI/Anthropic API Key', regex: /\bsk-(?:proj|ant|live)-[A-Za-z0-9_-]{20,}\b/ },
    { label: 'GitHub Personal Access Token', regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{35,}\b/ },
    { label: 'Google API Key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
    { label: 'AWS Access Key ID', regex: /\bAKIA[0-9A-Z]{16}\b/ },
    { label: 'Slack Token', regex: /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/ },
    { label: 'Database Connection URL Secret', regex: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^:\s/]+:(?!(?:password|REDACTED|pass|postgres|\*+)@)[^@\s]{6,}@[^\s/]+/i },
    { label: 'Private Key Block', regex: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ }
];

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

const anchoredFileCache = new Map();
const MAX_ANCHORED_FILE_CACHE = 128;

/**
 * Reads an anchored file and computes its normalized SHA-256 hash with (mtimeMs, size) memoization.
 */
function readAnchoredFileCached(absPath) {
    try {
        const st = fs.statSync(absPath);
        if (!st.isFile() || st.size > 5 * 1024 * 1024) return null;
        const cached = anchoredFileCache.get(absPath);
        if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
            return cached;
        }
        const fileText = fs.readFileSync(absPath, 'utf8');
        const currentHash = computeNormalizedSpanHash(fileText);
        const entry = { mtimeMs: st.mtimeMs, size: st.size, fileText, currentHash };
        if (anchoredFileCache.size >= MAX_ANCHORED_FILE_CACHE) {
            const oldestKey = anchoredFileCache.keys().next().value;
            anchoredFileCache.delete(oldestKey);
        }
        anchoredFileCache.set(absPath, entry);
        return entry;
    } catch {
        return null;
    }
}

/**
 * Safely resolves a provenance file path within a project workspace root (strict path-traversal guard).
 */
export function resolveAnchoredFilePath(fileRef, targetProject) {
    if (!fileRef || typeof fileRef !== 'string') return null;
    const cleaned = fileRef.trim();
    if (!cleaned || cleaned.includes('\0') || cleaned.includes('..')) return null;

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
        const candidates = path.isAbsolute(cleaned)
            ? [path.resolve(cleaned), path.resolve(resolvedRoot, cleaned.replace(/^[/\\]+/, ''))]
            : [path.resolve(resolvedRoot, cleaned)];

        for (const resolvedTarget of candidates) {
            const rel = path.relative(resolvedRoot, resolvedTarget);
            if (!rel.startsWith('..') && !path.isAbsolute(rel) && rel !== '') {
                if (fs.existsSync(resolvedTarget)) {
                    try {
                        const st = fs.statSync(resolvedTarget);
                        if (st.isFile() && st.size <= 5 * 1024 * 1024) {
                            return resolvedTarget;
                        }
                    } catch {}
                }
            }
        }
    }
    // Return expected path inside projectRoot even if missing (for missing-file drift check)
    const defaultTarget = path.resolve(projectRoot, cleaned.replace(/^[/\\]+/, ''));
    const relDefault = path.relative(projectRoot, defaultTarget);
    if (!relDefault.startsWith('..') && !path.isAbsolute(relDefault) && relDefault !== '') {
        return defaultTarget;
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
        host_node: provenance?.host_node || process.env.KRUSCH_NODE || os.hostname(),
        client: provenance?.client || process.env.MCP_CLIENT_NAME || null,
        model: provenance?.model || process.env.KRUSCH_MODEL || null,
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
        recorded_at: new Date().toISOString()
    };

    if (!base.file) return base;

    const absPath = resolveAnchoredFilePath(base.file, targetProject);
    if (absPath) {
        const cachedFile = readAnchoredFileCached(absPath);
        if (cachedFile) {
            const { fileText, currentHash } = cachedFile;
            if (!base.anchor_hash) {
                base.anchor_hash = currentHash;
            }
            if (base.quoted_sentence && typeof base.quoted_sentence === 'string') {
                const pos = fileText.indexOf(base.quoted_sentence);
                if (pos !== -1) {
                    base.char_start = pos;
                    base.char_end = pos + base.quoted_sentence.length;
                    const { startLine, endLine } = getSpanLineRange(fileText, base.char_start, base.char_end);
                    base.start_line = startLine;
                    base.end_line = endLine;
                    base.is_drifted = false;
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
                db.prepare(`UPDATE ide_agent_memory SET provenance = ? WHERE id = ?`).run(JSON.stringify(driftedProv), row.id);
            } catch {}
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
        const pos = fileText.indexOf(prov.quoted_sentence);
        if (pos !== -1) {
            const charStart = pos;
            const charEnd = pos + prov.quoted_sentence.length;
            const { startLine, endLine } = getSpanLineRange(fileText, charStart, charEnd);
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
                    db.prepare(`UPDATE ide_agent_memory SET provenance = ? WHERE id = ?`).run(JSON.stringify(healedProv), row.id);
                } catch {}
            }
            return { anchored: true, is_drifted: false, healed: true, current_hash: currentHash, provenance: healedProv };
        } else {
            const driftedProv = {
                ...prov,
                current_hash: currentHash,
                is_drifted: true,
                drift_reason: 'quoted_span_mutated'
            };
            if (db && row.id && !prov.is_drifted) {
                try {
                    db.prepare(`UPDATE ide_agent_memory SET provenance = ? WHERE id = ?`).run(JSON.stringify(driftedProv), row.id);
                } catch {}
            }
            return { anchored: true, is_drifted: true, drift_reason: 'quoted_span_mutated', current_hash: currentHash, provenance: driftedProv };
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
                db.prepare(`UPDATE ide_agent_memory SET provenance = ? WHERE id = ?`).run(JSON.stringify(driftedProv), row.id);
            } catch {}
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
                db.prepare(`UPDATE ide_agent_memory SET provenance = ? WHERE id = ?`).run(JSON.stringify(healedProv), row.id);
            } catch {}
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

    const leakedSecretType = scanForSecretLeak(content);
    if (leakedSecretType) {
        throw new McpError(
            ErrorCode.InvalidParams,
            `Secret refusal: write rejected because content appears to contain a raw credential (${leakedSecretType}). Redact secrets as [REDACTED] before calling krusch_context_remember.`
        );
    }

    const normCat = normalizeCategory(category);
    const targetProject = project || active_project || detectCurrentProject();
    
    // 1. Compute embedding
    const embeddingArray = _embedding || await getEmbedding(content);
    if (!embeddingArray) {
        throw new McpError(ErrorCode.InternalError, "Failed to generate embedding");
    }

    // 2. Near-duplicate detection (non-blocking: proposes revise with candidate id & cosine, does not reject write)
    let nearDup = null;
    if (!force && !supersedes_id) {
        nearDup = await checkNearDuplicateMemory({
            project: targetProject,
            category: normCat,
            embedding: embeddingArray,
            threshold: 0.85
        });
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

    const embeddingStr = `[${embeddingArray.join(',')}]`;

    // 5. Insert into SQLite project DB
    const db = await getProjectDb(targetProject);
    if (db) {
        const info = db.prepare(`
            INSERT INTO ide_agent_memory (category, content, tags, embedding, status, supersedes_id, provenance)
            VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?)
        `).run(normCat, content, finalTags, embeddingStr, supersedes_id || null, provPayload);

        const newId = info.lastInsertRowid;
        if (supersedes_id) {
            try {
                db.prepare(`UPDATE ide_agent_memory SET status = 'SUPERSEDED', superseded_by = ? WHERE id = ?`).run(newId, supersedes_id);
            } catch (err) {
                console.warn(`[memory-engine] SQLite supersede update warning: ${err.message}`);
            }
        }

        // Push behind if postgres available
        pushProjectMemory(targetProject, db).catch(() => {});

        const supersedeNote = supersedes_id ? ` (supersedes ID ${supersedes_id})` : '';
        const nearDupNote = nearDup 
            ? `\n\n⚠️ Near-duplicate memory detected (${(nearDup.similarity * 100).toFixed(1)}% match with Memory #${nearDup.id} [${nearDup.category}]: "${nearDup.content}").\n` +
              `If this memory supersedes or contradicts #${nearDup.id}, call 'revise' with action: 'supersede', target_id: ${nearDup.id}.`
            : '';

        const response = {
            content: [{
                type: "text",
                text: `[krusch-context] ✅ Successfully saved memory to SQLite project DB: ${targetProject} (${normCat}) #${newId}${supersedeNote}${nearDupNote}`
            }],
            id: newId
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
 * Supersedes an outdated memory with updated knowledge.
 */
export async function supersedeMemory({ id, category, content, project, active_project, tags, provenance }) {
    if (!id) throw new McpError(ErrorCode.InvalidParams, "Missing parameter 'id'");
    if (!content) throw new McpError(ErrorCode.InvalidParams, "Missing parameter 'content'");
    return await addMemory({
        category,
        content,
        tags,
        project: project || active_project,
        supersedes_id: id,
        provenance,
        force: true
    });
}

/**
 * Explicitly invalidates a memory with a mandatory reason.
 */
export async function invalidateMemory({ id, reason, project, active_project }) {
    if (!id) throw new McpError(ErrorCode.InvalidParams, "Missing parameter 'id'");
    if (!reason || typeof reason !== 'string' || !reason.trim()) {
        throw new McpError(
            ErrorCode.InvalidParams,
            "Invalidation requires a non-empty 'reason' describing why this memory is obsolete/deprecated."
        );
    }

    const targetProject = project || active_project || detectCurrentProject();
    const db = await getProjectDb(targetProject);
    if (db) {
        db.prepare(`
            UPDATE ide_agent_memory 
            SET status = 'INVALIDATED', invalidated_reason = ? 
            WHERE id = ?
        `).run(reason.trim(), id);

        return {
            content: [{
                type: "text",
                text: `[krusch-context] 🗑️ Memory #${id} marked as INVALIDATED.\nReason: "${reason.trim()}"`
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

    let sql = `SELECT id, category, content, tags, status, supersedes_id, superseded_by, created_at, embedding FROM ide_agent_memory`;
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
    sql += ` ORDER BY created_at DESC`;

    const rows = db.prepare(sql).all(...params);
    const embeddingArray = _embedding || await getEmbedding(query);
    const lowerQuery = query.toLowerCase();

    const scored = rows.map(r => {
        let score = 0.5;
        if (embeddingArray && r.embedding) {
            const vec = getParsedEmbedding(r.embedding);
            if (vec) {
                score = cosineSimilarity(embeddingArray, vec);
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
 * Returns memories unreferenced or older than 30 days for decay review.
 */
export async function getStaleMemories({ project, days = 30 } = {}) {
    const targetProject = project || detectCurrentProject();
    const db = await getProjectDb(targetProject);
    if (!db) return [];

    const rows = db.prepare(`
        SELECT id, category, content, created_at
        FROM ide_agent_memory
        WHERE status = 'ACTIVE'
          AND created_at < datetime('now', '-' || ? || ' days')
        ORDER BY created_at ASC
        LIMIT 10
    `).all(days);

    return rows;
}

/**
 * Compiles a consolidated project state briefing with KruschNexus INV-12 span drift verification.
 */
export async function compileProjectState({ project, active_project } = {}) {
    const targetProject = project || active_project || detectCurrentProject();
    const db = await getProjectDb(targetProject);

    const decisions = [];
    const invariants = [];
    const blockers = [];
    const bugs = [];
    const lessons = [];
    const handoffs = [];
    const nuggets = [];
    const invalidated = [];
    const drifted = [];
    const packedIds = [];
    const packedNuggetKeys = [];

    if (db) {
        const rows = db.prepare(`
            SELECT id, category, content, status, invalidated_reason, provenance, created_at
            FROM ide_agent_memory
            ORDER BY created_at DESC, id DESC
        `).all();

        for (const r of rows) {
            if (r.status === 'INVALIDATED') {
                if (invalidated.length < 5) invalidated.push(r);
                continue;
            }
            if (r.status !== 'ACTIVE') continue;

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
    }

    const stale = await getStaleMemories({ project: targetProject, days: 30 });
    const formatSpanBadge = (r) => {
        if (!r._drift?.anchored) return '';
        const cit = r._drift.provenance?.citation || r._drift.provenance?.file || 'file';
        return r._drift.is_drifted ? ` ⚠️ *[DRIFTED: ${cit}]*` : ` *[Anchor: ${cit}]*`;
    };

    let output = `# 🧠 Compiled Project State: ${targetProject}\n\n`;

    if (handoffs.length > 0) {
        output += `## 🤝 Active Session Handoff (${handoffs.length})\n`;
        for (const h of handoffs) {
            packedNuggetKeys.push(h.key);
            output += `- **${h.key}**: ${h.value}\n`;
        }
        output += `\n`;
    }

    output += `## 🎯 Decisions & Priorities (${decisions.length})\n`;
    if (decisions.length === 0) output += `- No active decisions or priorities recorded.\n`;
    for (const d of decisions.slice(0, 5)) {
        packedIds.push(d.id);
        output += `- **#${d.id}**: ${d.content}${formatSpanBadge(d)}\n`;
    }
    output += `\n`;


    output += `## 🛡️ Project Invariants (${invariants.length})\n`;
    if (invariants.length === 0) output += `- No invariants recorded.\n`;
    for (const inv of invariants.slice(0, 5)) {
        packedIds.push(inv.id);
        output += `- **#${inv.id}**: ${inv.content}${formatSpanBadge(inv)}\n`;
    }
    output += `\n`;

    // Active blockers always surface ahead of resolved historical bug postmortems
    const bugsAndBlockers = [...blockers, ...bugs];
    output += `## 🐛 Known Bugs & Blockers (${bugsAndBlockers.length})\n`;
    if (bugsAndBlockers.length === 0) output += `- Zero active blockers.\n`;
    for (const b of bugsAndBlockers.slice(0, 5)) {
        packedIds.push(b.id);
        output += `- **#${b.id}** [${b.category}]: ${b.content}${formatSpanBadge(b)}\n`;
    }
    output += `\n`;

    output += `## 📖 Core Lessons (${lessons.length})\n`;
    if (lessons.length === 0) output += `- No lessons recorded yet.\n`;
    for (const l of lessons.slice(0, 5)) {
        packedIds.push(l.id);
        output += `- **#${l.id}**: ${l.content}${formatSpanBadge(l)}\n`;
    }
    output += `\n`;

    if (nuggets.length > 0) {
        output += `## ⚡ Steering Nuggets (${nuggets.length})\n`;
        for (const n of nuggets) {
            packedNuggetKeys.push(n.key);
            output += `- **${n.key}**: ${n.value}\n`;
        }
        output += `\n`;
    }

    if (drifted.length > 0) {
        output += `## ⚠️ Span-Grounded Drift Review (${drifted.length} drifted)\n`;
        for (const dr of drifted) {
            const cit = dr.provenance?.citation || dr.provenance?.file || 'anchored file';
            output += `- Memory #${dr.id} [${dr.category}] (${cit} — ${dr.drift_reason}): "${dr.content.substring(0, 80)}..."\n`;
        }
        output += `\n`;
    }

    if (invalidated.length > 0) {
        output += `## 🚫 Recently Invalidated Rules (${invalidated.length})\n`;
        for (const inv of invalidated) {
            output += `- ~~#${inv.id} (${inv.category})~~ — *Revocation Reason*: ${inv.invalidated_reason || 'Deprecated'}\n`;
        }
        output += `\n`;
    }

    if (stale.length > 0) {
        output += `## ⏳ Decay Review (${stale.length} items >30 days old)\n`;
        for (const s of stale) {
            output += `- Memory #${s.id} [${s.category}]: "${s.content.substring(0, 80)}..." (Review if still valid)\n`;
        }
        output += `\n`;
    }

    return {
        content: [{ type: "text", text: output }],
        packedIds,
        packedNuggetKeys
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
    let anchoredCount = 0;
    let driftedCount = 0;
    const categoryCounts = {};

    if (db) {
        const memRows = db.prepare(`SELECT id, category, status, provenance FROM ide_agent_memory`).all();
        for (const r of memRows) {
            if (r.status === 'ACTIVE') {
                activeCount++;
                let normCat = 'lesson';
                try { normCat = normalizeCategory(r.category); } catch { normCat = 'lesson'; }
                categoryCounts[normCat] = (categoryCounts[normCat] || 0) + 1;
                const driftCheck = evaluateMemorySpanDrift(r, targetProject, db);
                if (driftCheck.anchored) {
                    anchoredCount++;
                    if (driftCheck.is_drifted) driftedCount++;
                }
            } else if (r.status === 'SUPERSEDED') {
                supersededCount++;
            } else if (r.status === 'INVALIDATED') {
                invalidatedCount++;
            }
        }
        const nugRow = db.prepare(`SELECT count(*) as count FROM ide_agent_nuggets`).get();
        nuggetCount = nugRow ? nugRow.count : 0;
    }

    const stale = await getStaleMemories({ project: targetProject, days: 30 });
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
    output += `* **Superseded Lineage**: ${supersededCount}\n`;
    output += `* **Invalidated Records**: ${invalidatedCount}\n`;
    output += `* **Steering Nuggets**: ${nuggetCount}\n`;
    if (stale.length > 0) {
        output += `* **Decay Review**: ⏳ ${stale.length} memories have not been referenced in >30 days.\n`;
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
            supersededCount,
            invalidatedCount,
            nuggetCount,
            staleCount: stale.length
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
    const leakedSecretType = scanForSecretLeak(String(content));
    if (leakedSecretType) {
        throw new McpError(
            ErrorCode.InvalidParams,
            `Secret refusal: update rejected because content appears to contain a raw credential (${leakedSecretType}). Redact secrets as [REDACTED] before updating.`
        );
    }
    const targetProject = project || active_project || detectCurrentProject();
    const db = await getProjectDb(targetProject);
    if (db) {
        const emb = _embedding || await getEmbedding(content);
        const embStr = emb ? `[${emb.join(',')}]` : null;
        const tagStr = tags ? JSON.stringify(tags) : null;
        db.prepare(`UPDATE ide_agent_memory SET content = ?, tags = ?, embedding = ? WHERE id = ?`).run(content, tagStr, embStr, id);
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

    const rows = db.prepare(`SELECT id, content, embedding FROM ide_agent_memory WHERE category = ? AND status = 'ACTIVE'`).all(normCat);
    const pairs = [];

    for (let i = 0; i < rows.length; i++) {
        const vecA = getParsedEmbedding(rows[i].embedding);
        if (!vecA) continue;
        for (let j = i + 1; j < rows.length; j++) {
            const vecB = getParsedEmbedding(rows[j].embedding);
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
    for (const p of pairs) {
        // Mark the newer one as superseded by the older one
        db.prepare(`UPDATE ide_agent_memory SET status = 'SUPERSEDED', superseded_by = ? WHERE id = ?`).run(p.a.id, p.b.id);
        mergedCount++;
    }

    return { content: [{ type: "text", text: `🔗 Consolidated ${mergedCount} duplicate pairs in category '${normCat}'.` }] };
}


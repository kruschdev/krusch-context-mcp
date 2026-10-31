import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { evaluateMemorySpanDrift } from './memory-engine.js';
import { getEmbedding, isEmbeddingProviderConfigured, calibrateQuerySimilarity } from './embedding-helper.js';
import {
    STOP_WORDS,
    GENERIC_INFRA_WORDS,
    META_QUERY_WORDS,
    stemToken,
    isSyntheticConstantVector
} from './retrieval-lexical.js';
import { getProjectDb, getParsedEmbedding, cosineSimilarity } from './sqlite-engine.js';
import { detectCurrentProject } from './project-helper.js';
import { detectHandRolledBoilerplate } from './lego-boilerplate-guard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

const EXTRA_NUDGE_NOISE_WORDS = [
    'should', 'always', 'never', 'before', 'after',
    'error', 'errors', 'files', 'file', 'table', 'tables',
    'check', 'checks', 'string', 'strings', 'number', 'numbers',
    'object', 'objects', 'array', 'arrays', 'return', 'returns',
    'async', 'await', 'const', 'let', 'var', 'import', 'imports',
    'export', 'exports', 'function', 'functions', 'class', 'classes',
    'method', 'methods', 'module', 'modules', 'update', 'updated', 'updates',
    'added', 'local', 'active', 'memory', 'memories',
    'agent', 'agents', 'record', 'records', 'valid', 'value', 'values',
    'must', 'without', 'within', 'also', 'then', 'else',
    'true', 'false', 'null', 'undefined', 'none', 'some', 'such', 'same',
    'other', 'others', 'both', 'either', 'neither', 'because', 'since',
    'while', 'during', 'against', 'instead', 'rather', 'ensure', 'ensures',
    'invariant', 'invariants', 'blocker', 'blockers', 'code', 'type', 'types'
];

export const NUDGE_NOISE_WORDS = new Set([
    ...STOP_WORDS,
    ...GENERIC_INFRA_WORDS,
    ...META_QUERY_WORDS,
    ...EXTRA_NUDGE_NOISE_WORDS
]);

const NUDGE_NOISE_STEMS = new Set(
    Array.from(NUDGE_NOISE_WORDS, (w) => stemToken(w))
);

const PROSE_PROPER_NOUNS = new Set([
    'javascript', 'typescript', 'postgresql', 'sqlite', 'github', 'gitlab',
    'openai', 'openrouter', 'cloudflare', 'kruschnexus', 'antigravity',
    'tailscale', 'youtube', 'linkedin', 'wordpress', 'macbook'
]);

const ENGLISH_HYPHEN_PREFIX_RE = /^(?:non|multi|pre|post|sub|self|cross|auto|high|low|long|short|real|built|up|end|in|on|one|two|three|four|five|near|well|hard|soft|full|part|read|write|open|closed|time|step|line|zero|single|double|dual|first|second|third|top|bottom|left|right|back|front|side|over|under|out|off|co|re|de|un|anti|inter|intra|semi|pseudo|ultra|micro|macro|meta|para)-/i;
const ENGLISH_HYPHEN_SUFFIX_RE = /-(?:based|only|first|aware|safe|free|ready|like|wise|wide|side|time|term|level|scale|style|driven|oriented|specific|agnostic|friendly|compatible)$/i;

const CATEGORY_PRIORITY = {
    blocker: 0.08,
    invariant: 0.05,
    nugget: 0.02,
    bug: 0
};

function isNoiseToken(tok) {
    if (!tok) return true;
    const lower = String(tok).toLowerCase();
    if (NUDGE_NOISE_WORDS.has(lower)) return true;
    if (!/[_:/.-]/.test(lower)) {
        const stem = stemToken(lower);
        if (NUDGE_NOISE_STEMS.has(stem)) return true;
    }
    return false;
}

function parseRuleTags(tagsField) {
    if (!tagsField) return [];
    if (Array.isArray(tagsField)) return tagsField.map(String).filter(Boolean);
    if (typeof tagsField === 'string') {
        const trimmed = tagsField.trim();
        if (!trimmed) return [];
        if (trimmed.startsWith('[')) {
            try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
            } catch {
                // Fall through to delimiter split
            }
        }
        return trimmed.split(/[,;]+/).map(s => s.trim()).filter(Boolean);
    }
    return [];
}

function extractNonNoiseStems(text) {
    const stems = new Set();
    if (!text || typeof text !== 'string') return stems;
    const expanded = text
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .toLowerCase();
    const rawTokens = expanded.split(/[^a-z0-9]+/);
    for (const tok of rawTokens) {
        if (tok.length < 4 || /^\d+$/.test(tok)) continue;
        if (NUDGE_NOISE_WORDS.has(tok)) continue;
        const stem = stemToken(tok);
        if (stem.length < 4 || NUDGE_NOISE_STEMS.has(stem)) continue;
        stems.add(stem);
    }
    return stems;
}

function extractQueryIdentifiers(queryText) {
    const identifiers = new Set();
    if (!queryText || typeof queryText !== 'string') return identifiers;

    const compoundMatches = queryText.match(/(?:(?<![A-Za-z0-9_-])@[A-Za-z0-9_-]+\/[A-Za-z0-9_./-]+|(?<![A-Za-z0-9_-])--[A-Za-z0-9][A-Za-z0-9_-]*|(?<![A-Za-z0-9_])[A-Za-z0-9_]+(?:[:./-][A-Za-z0-9_]+)+)/g);
    if (compoundMatches) {
        for (const raw of compoundMatches) {
            const cleaned = raw.replace(/^[./:]+|[./:]+$/g, '').toLowerCase();
            if (cleaned.length >= 4 && !isNoiseToken(cleaned)) {
                identifiers.add(cleaned);
            }
        }
    }

    const wordMatches = queryText.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g);
    if (wordMatches) {
        for (const raw of wordMatches) {
            const hasCamel = /[a-z][A-Z]|[A-Z][a-z0-9]+[A-Z]/.test(raw);
            const hasUnderscore = raw.includes('_');
            const lower = raw.toLowerCase();
            if ((hasCamel || hasUnderscore || lower.length >= 5) && lower.length >= 4 && !isNoiseToken(lower)) {
                identifiers.add(lower);
            }
        }
    }

    return identifiers;
}

export function buildQueryNudgeContext(queryText, queryEmbedding = null) {
    const safeText = typeof queryText === 'string' ? queryText : '';
    return {
        lowerQuery: safeText.toLowerCase(),
        queryIdentifiers: extractQueryIdentifiers(safeText),
        queryStems: extractNonNoiseStems(safeText),
        queryEmbedding
    };
}

function addCleanSymbol(symbolSet, rawCandidate) {
    if (!rawCandidate || typeof rawCandidate !== 'string') return;
    const norm = rawCandidate
        .trim()
        .replace(/^['"`]+|['"`]+$/g, '')
        .replace(/\(\s*\)\s*;?$/, '')
        .replace(/;$/, '')
        .replace(/^\.\//, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();

    if (norm.length < 4 || norm.length > 64) return;
    if (norm.includes('<') || norm.includes('>')) return;
    if (/^\d+(?:[:.-]\d+)*$/.test(norm)) return;
    if (isNoiseToken(norm)) return;
    symbolSet.add(norm);
}

function extractTechnicalSymbolsFromSource(text, symbolSet, { allowBackticks = false } = {}) {
    if (!text || typeof text !== 'string') return;

    if (allowBackticks) {
        const inlineBacktickRe = /`([^`\n]{2,80})`/g;
        let match;
        while ((match = inlineBacktickRe.exec(text)) !== null) {
            const inner = match[1].trim();
            if (!inner) continue;
            const parenIdx = inner.indexOf('(');
            if (parenIdx > 0) {
                const callee = inner.slice(0, parenIdx).trim();
                if (!/\s/.test(callee)) {
                    addCleanSymbol(symbolSet, callee);
                }
            }
            const wordCount = inner.split(/\s+/).length;
            if (wordCount <= 4) {
                addCleanSymbol(symbolSet, inner);
            }
        }
    }

    // CamelCase and multi-hump PascalCase identifiers (e.g. verifyAuth, readOnlyHint, DatabaseSync)
    const camelMatches = text.match(/\b(?:[a-z]+[A-Z][A-Za-z0-9]*|[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*)\b/g);
    if (camelMatches) {
        for (const raw of camelMatches) {
            const lower = raw.toLowerCase();
            if (!PROSE_PROPER_NOUNS.has(lower)) {
                addCleanSymbol(symbolSet, lower);
            }
        }
    }

    // Snake_case identifiers (e.g. ide_agent_memory, max_pool_size)
    const snakeMatches = text.match(/\b[A-Za-z0-9]+_[A-Za-z0-9_]+\b/g);
    if (snakeMatches) {
        for (const raw of snakeMatches) {
            addCleanSymbol(symbolSet, raw);
        }
    }

    // Colon-namespaced modules / models (e.g. node:sqlite, gemma4:e4b)
    const colonMatches = text.match(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]+:[A-Za-z0-9_.-]+\b/g);
    if (colonMatches) {
        for (const raw of colonMatches) {
            const lower = raw.toLowerCase();
            if (!lower.startsWith('http:') && !lower.startsWith('https:') && !lower.startsWith('file:')) {
                addCleanSymbol(symbolSet, lower);
            }
        }
    }

    // CLI long flags (e.g. --delete, --no-sandbox)
    const flagMatches = text.match(/(?:^|\s)(--[A-Za-z0-9][A-Za-z0-9_-]{2,})\b/g);
    if (flagMatches) {
        for (const raw of flagMatches) {
            addCleanSymbol(symbolSet, raw.trim());
        }
    }

    // Explicit source/config filenames with known code extensions (.js, .py, .sql, .ts, etc.)
    const fileExtMatches = text.match(/(?<![A-Za-z0-9_./-])[A-Za-z0-9_./-]+\.(?:js|mjs|cjs|ts|tsx|jsx|py|sql|sh|json|ya?ml|toml|env|html|css|vue|svelte|graphql|proto)\b/gi);
    if (fileExtMatches) {
        for (const raw of fileExtMatches) {
            addCleanSymbol(symbolSet, raw);
        }
    }

    // Scoped npm packages & multi-segment or code-directory slash paths
    const pathMatches = text.match(/(?<![A-Za-z0-9_-])@[A-Za-z0-9_-]+\/[A-Za-z0-9_./-]+|(?:^|[\s('"\[])((?:\/(?:etc|mnt|var|opt|usr)\/[A-Za-z0-9_./-]+|(?:src|lib|bin|db|tests?|scripts|client|server|packages|assert|fs)\/[A-Za-z0-9_./-]+))/g);
    if (pathMatches) {
        for (const raw of pathMatches) {
            const cleaned = raw.trim().replace(/^['"(\[]+/, '');
            addCleanSymbol(symbolSet, cleaned);
        }
    }

    // Hyphenated package/service identifiers (excluding common English compound modifiers and numeric ranges)
    const hyphenMatches = text.match(/(?<![A-Za-z0-9_-])[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+\b/g);
    if (hyphenMatches) {
        for (const raw of hyphenMatches) {
            const lower = raw.toLowerCase();
            if (/^l\d+-l\d+$/i.test(lower)) continue;
            if (ENGLISH_HYPHEN_PREFIX_RE.test(lower) || ENGLISH_HYPHEN_SUFFIX_RE.test(lower)) continue;
            addCleanSymbol(symbolSet, lower);
        }
    }
}

function extractRuleFeatures(rule) {
    const content = String(rule.content || '');
    const tagsList = parseRuleTags(rule.tags);
    const backtickSymbols = new Set();

    extractTechnicalSymbolsFromSource(content, backtickSymbols, { allowBackticks: true });
    for (const tag of tagsList) {
        extractTechnicalSymbolsFromSource(tag, backtickSymbols, { allowBackticks: true });
    }

    const combinedText = tagsList.length > 0 ? `${content} ${tagsList.join(' ')}` : content;
    const ruleStems = extractNonNoiseStems(combinedText);

    return {
        backtickSymbols,
        ruleStems
    };
}

function isWordChar(ch) {
    if (!ch) return false;
    const code = ch.charCodeAt(0);
    return (
        (code >= 97 && code <= 122) ||
        (code >= 65 && code <= 90) ||
        (code >= 48 && code <= 57) ||
        code === 95
    );
}

function containsSymbolWithBoundary(lowerQuery, sym, queryIdentifiers) {
    if (!sym || sym.length < 4 || !lowerQuery) return false;
    if (queryIdentifiers && queryIdentifiers.has(sym)) return true;

    const hasSpace = sym.includes(' ');
    const target = hasSpace ? sym.replace(/\s+/g, ' ') : sym;
    const haystack = hasSpace ? lowerQuery.replace(/\s+/g, ' ') : lowerQuery;
    if (haystack.length < target.length) return false;

    const startsWord = isWordChar(target[0]);
    const endsWord = isWordChar(target[target.length - 1]);
    const isDottedFilename = /^[a-z0-9_-]+\.[a-z0-9]+$/.test(target);

    let fromIdx = 0;
    while (fromIdx <= haystack.length - target.length) {
        const idx = haystack.indexOf(target, fromIdx);
        if (idx === -1) return false;

        const prev = idx > 0 ? haystack[idx - 1] : '';
        const next = idx + target.length < haystack.length ? haystack[idx + target.length] : '';

        let leftOk = true;
        if (startsWord && isWordChar(prev)) {
            leftOk = false;
        } else if (isDottedFilename && prev === '-') {
            leftOk = false;
        } else if (target.startsWith('--') && (isWordChar(prev) || prev === '-')) {
            leftOk = false;
        }

        let rightOk = true;
        if (endsWord && isWordChar(next)) {
            rightOk = false;
        } else if (isDottedFilename && (next === '.' || next === '-')) {
            rightOk = false;
        }

        if (leftOk && rightOk) return true;
        fromIdx = idx + 1;
    }
    return false;
}

export function computeRuleIdfMap(candidateRules) {
    const idfMap = new Map();
    const N = Array.isArray(candidateRules) ? candidateRules.length : 0;
    if (N === 0) return idfMap;

    const dfMap = new Map();
    for (const rule of candidateRules) {
        const features = rule._features || extractRuleFeatures(rule);
        rule._features = features;
        for (const stem of features.ruleStems) {
            dfMap.set(stem, (dfMap.get(stem) || 0) + 1);
        }
    }

    for (const [stem, df] of dfMap.entries()) {
        idfMap.set(stem, Math.log(1 + N / (1 + df)));
    }
    return idfMap;
}

/**
 * Hybrid IDF-Stem + Technical Identifier + Cached Embedding Relevance Scorer.
 */
export function scoreRuleRelevance(rule, queryCtx, idfMap = new Map()) {
    const ctx = typeof queryCtx === 'string'
        ? buildQueryNudgeContext(queryCtx)
        : (queryCtx || buildQueryNudgeContext(''));

    const features = rule._features || extractRuleFeatures(rule);
    rule._features = features;

    const matchedSymbols = [];
    for (const sym of features.backtickSymbols) {
        if (containsSymbolWithBoundary(ctx.lowerQuery, sym, ctx.queryIdentifiers)) {
            matchedSymbols.push(sym);
        }
    }

    const matchedStems = [];
    let matchedIdfSum = 0;
    const stemIdfs = [];

    for (const stem of features.ruleStems) {
        const idf = idfMap.get(stem) ?? 1.0;
        stemIdfs.push(idf);
        if (ctx.queryStems && ctx.queryStems.has(stem)) {
            matchedStems.push(stem);
            matchedIdfSum += idf;
        }
    }

    let stemOverlapScore = 0;
    if (matchedStems.length > 0 && stemIdfs.length > 0) {
        stemIdfs.sort((a, b) => b - a);
        const topK = Math.min(stemIdfs.length, 6);
        let denomIdf = 0;
        for (let i = 0; i < topK; i++) {
            denomIdf += stemIdfs[i];
        }
        const rawOverlap = denomIdf > 0 ? Math.min(1.0, matchedIdfSum / denomIdf) : 0;
        const queryStemCount = ctx.queryStems ? ctx.queryStems.size : 0;
        const breadthFactor = queryStemCount > 25
            ? (1 / (1 + 0.12 * Math.log2(queryStemCount / 25)))
            : 1.0;
        stemOverlapScore = rawOverlap * breadthFactor;
    }

    let semanticScore = 0;
    if (ctx.queryEmbedding && !isSyntheticConstantVector(ctx.queryEmbedding) && (rule.embedding || rule.embedding_blob)) {
        const ruleVec = getParsedEmbedding(rule.embedding, rule.embedding_blob);
        if (ruleVec && !isSyntheticConstantVector(ruleVec)) {
            semanticScore = calibrateQuerySimilarity(cosineSimilarity(ruleVec, ctx.queryEmbedding), { queryVec: ctx.queryEmbedding });
        }
    }

    const symbolQualified = matchedSymbols.length >= 1;
    const stemQualified = matchedStems.length >= 2 && stemOverlapScore >= 0.28;
    const semanticQualified = semanticScore >= 0.72;
    const qualifies = symbolQualified || stemQualified || semanticQualified;

    let relevanceScore = 0;
    if (qualifies) {
        const symbolScore = symbolQualified
            ? Math.min(1.0, 0.75 + 0.10 * (matchedSymbols.length - 1))
            : 0;
        const lexScore = stemQualified ? stemOverlapScore : 0;
        const semScore = semanticQualified ? semanticScore : 0;
        const primary = Math.max(symbolScore, lexScore, semScore);
        const activeSignals = (symbolQualified ? 1 : 0) + (stemQualified ? 1 : 0) + (semanticQualified ? 1 : 0);
        const bonus = activeSignals > 1 ? 0.08 * (activeSignals - 1) : 0;
        relevanceScore = Math.min(1.0, primary + bonus);
    }

    const weight = typeof rule.weight === 'number' ? rule.weight : 1.0;
    const categoryPriority = CATEGORY_PRIORITY[rule.category] ?? 0;
    const effectiveScore = qualifies ? (relevanceScore * weight + categoryPriority) : 0;

    return {
        qualifies,
        relevanceScore,
        effectiveScore,
        matchedSymbols,
        matchedStems,
        stemOverlapScore,
        semanticScore
    };
}

/**
 * Record developer feedback on an auditor nudge.
 * Feedback adjusts rule weights to prevent repeated false positives.
 */
export async function recordNudgeFeedback({ rule_id, feedback, project }) {
    if (!rule_id || !feedback) {
        throw new McpError(ErrorCode.InvalidParams, "Missing rule_id or feedback");
    }
    const targetProject = project || detectCurrentProject();
    let weightDelta = 0.0;
    if (feedback === 'helpful') weightDelta = 0.2;
    else if (feedback === 'unhelpful') weightDelta = -0.3;
    else if (feedback === 'false_positive') weightDelta = -0.6;

    // Record in SQLite
    if (targetProject) {
        try {
            const db = await getProjectDb(targetProject);
            if (db) {
                const existing = db.prepare(`SELECT weight FROM auditor_feedback WHERE project = ? AND rule_id = ? ORDER BY id DESC LIMIT 1`).get(targetProject, String(rule_id));
                const newWeight = existing ? Math.max(0.0, existing.weight + weightDelta) : Math.max(0.0, 1.0 + weightDelta);
                db.prepare(`
                    INSERT INTO auditor_feedback (project, rule_id, feedback, weight)
                    VALUES (?, ?, ?, ?)
                `).run(targetProject, String(rule_id), feedback, newWeight);
            }
        } catch (e) {
            console.warn(`[proactive-engine] SQLite feedback warning: ${e.message}`);
        }
    }

    return {
        content: [{
            type: "text",
            text: `[krusch-context] ✅ Recorded '${feedback}' feedback for rule #${rule_id}. Weight updated.`
        }]
    };
}

/**
 * Checks whether two file paths refer to the same file respecting '/' path boundaries.
 */
function matchesFilePathBoundary(pathA, pathB) {
    if (!pathA || !pathB) return false;
    const normA = pathA.replace(/\\/g, '/').replace(/^(?:\.\/|\/)+/, '');
    const normB = pathB.replace(/\\/g, '/').replace(/^(?:\.\/|\/)+/, '');
    if (!normA || !normB) return false;
    if (normA === normB) return true;
    if (normA.endsWith('/' + normB)) return true;
    if (normB.endsWith('/' + normA)) return true;
    return false;
}

/**
 * Get active rule weights for a project.
 */
async function getRuleWeights(project) {
    const weights = new Map();
    if (!project) return weights;
    try {
        const db = await getProjectDb(project);
        if (db) {
            const rows = db.prepare(`SELECT rule_id, weight FROM auditor_feedback WHERE project = ? ORDER BY id DESC`).all(project);
            for (const r of rows) {
                if (!weights.has(r.rule_id)) {
                    weights.set(r.rule_id, r.weight);
                }
            }
        }
    } catch (e) {
        console.error('[krusch-context-mcp] getRuleWeights warning:', e.message);
    }
    return weights;
}

/**
 * Lightweight, focused invariant auditor.
 * Checks proposed diffs or actions against active project invariants and blockers.
 * Capped to 1-3 findings with concrete evidence.
 */
export async function handleProactiveNudge({
    action = 'audit',
    history,
    code,
    file_path,
    hook,
    trigger = 'manual',
    rule_id,
    feedback,
    project,
    _embedding
} = {}) {
    const targetProject = project || detectCurrentProject();
    const effectiveTrigger = (trigger || hook || 'manual').toLowerCase();

    // 1. If action is feedback, record and return
    if (action === 'feedback' || (rule_id && feedback)) {
        return await recordNudgeFeedback({ rule_id, feedback, project: targetProject });
    }

    // 2. Reject/no-op on every_turn to avoid tool call explosion & audit fatigue
    if (effectiveTrigger === 'every_turn') {
        return { 
            content: [{ 
                type: "text", 
                text: "NO_NUDGES_REQUIRED (auditing disabled on every_turn to avoid spam; run on pre_commit or manual)" 
            }] 
        };
    }

    // 2. Parse candidate text to audit
    let queryText = code || "";
    if (!queryText && history) {
        if (Array.isArray(history)) {
            const lastUser = history.slice().reverse().find(m => m.role === 'user');
            queryText = lastUser ? (typeof lastUser.content === 'string' ? lastUser.content : JSON.stringify(lastUser.content)) : "";
        } else if (typeof history === 'string') {
            queryText = history;
        }
    }

    if (!queryText.trim()) {
        return { content: [{ type: "text", text: "NO_NUDGES_REQUIRED" }] };
    }

    // Bound maximum text to prevent regex DoS on massive diff dumps
    if (queryText.length > 50000) {
        queryText = queryText.slice(0, 50000);
    }

    // 3. Retrieve active project invariants & blockers
    const ruleWeights = await getRuleWeights(targetProject);
    const candidateRules = [];
    let projectDb = null;

    if (targetProject) {
        try {
            projectDb = await getProjectDb(targetProject);
            if (projectDb) {
                const rows = projectDb.prepare(`
                    SELECT id, category, content, tags, embedding, provenance
                    FROM ide_agent_memory
                    WHERE status = 'ACTIVE' AND category IN ('invariant', 'blocker', 'bug')
                `).all();

                for (const r of rows) {
                    const weight = ruleWeights.has(String(r.id)) ? ruleWeights.get(String(r.id)) : 1.0;
                    if (weight > 0.2) {
                        const driftCheck = evaluateMemorySpanDrift(r, targetProject, projectDb);
                        candidateRules.push({
                            id: r.id,
                            category: r.category,
                            content: r.content,
                            tags: r.tags || null,
                            embedding: r.embedding || null,
                            weight,
                            provenance: driftCheck.provenance,
                            is_drifted: driftCheck.is_drifted
                        });
                    }
                }

                // Add active nuggets
                const nugs = projectDb.prepare(`SELECT key, value, embedding FROM ide_agent_nuggets`).all();
                for (const n of nugs) {
                    const weight = ruleWeights.has(n.key) ? ruleWeights.get(n.key) : 1.0;
                    if (weight > 0.2) {
                        candidateRules.push({
                            id: n.key,
                            category: 'nugget',
                            content: `${n.key}: ${n.value}`,
                            tags: null,
                            embedding: n.embedding || null,
                            weight
                        });
                    }
                }
            }
        } catch (e) {
            console.warn(`[proactive-engine] SQLite rules query error: ${e.message}`);
        }
    }

    // 3b. Deterministic Lego Toolkit boilerplate-reinvention guard (INV-LEGO-01)
    const legoFindings = detectHandRolledBoilerplate(queryText, file_path || '').filter((finding) => {
        const w = ruleWeights.has(String(finding.id)) ? ruleWeights.get(String(finding.id)) : 1.0;
        return w > 0.2;
    });

    if (candidateRules.length === 0 && legoFindings.length === 0) {
        return { content: [{ type: "text", text: "NO_NUDGES_REQUIRED" }] };
    }

    // 4. Deterministic KruschNexus span/file matching first, then hybrid IDF-stem + symbol + embedding scorer
    const activeViolations = [];
    const seenIds = new Set();
    for (const lf of legoFindings) {
        if (activeViolations.length >= 3) break;
        activeViolations.push({ ...lf, is_drifted: false });
        seenIds.add(lf.id);
    }
    const lowerQuery = queryText.toLowerCase();
    const lowerFilePath = (file_path || '').toLowerCase();

    for (const rule of candidateRules) {
        if (activeViolations.length >= 3) break;
        const prov = rule.provenance;
        if (!prov) continue;
        const provFile = (prov.file || '').toLowerCase();
        const movedProvFile = (prov.moved_candidate?.file || '').toLowerCase();
        const quotedSpan = (prov.quoted_sentence || '').toLowerCase();
        const fileMatched = Boolean(
            (provFile && (
                matchesFilePathBoundary(lowerFilePath, provFile) ||
                lowerQuery.includes(provFile)
            )) ||
            (movedProvFile && (
                matchesFilePathBoundary(lowerFilePath, movedProvFile) ||
                lowerQuery.includes(movedProvFile)
            ))
        );
        const quoteMatched = quotedSpan && lowerQuery.includes(quotedSpan);
        if (fileMatched || quoteMatched) {
            activeViolations.push({ ...rule, spanMatched: true });
            seenIds.add(rule.id);
        }
        if (activeViolations.length >= 3) break;
    }

    if (activeViolations.length < 3) {
        const remainingRules = candidateRules.filter(r => !seenIds.has(r.id));
        if (remainingRules.length > 0) {
            const idfMap = computeRuleIdfMap(candidateRules);

            let queryEmbedding = null;
            if (_embedding && !isSyntheticConstantVector(_embedding)) {
                queryEmbedding = _embedding;
            } else if (isEmbeddingProviderConfigured()) {
                const hasRealRuleVector = remainingRules.some(r => {
                    if (!r.embedding) return false;
                    const vec = getParsedEmbedding(r.embedding);
                    return Boolean(vec && !isSyntheticConstantVector(vec));
                });
                if (hasRealRuleVector) {
                    try {
                        const computed = await getEmbedding(queryText.slice(0, 2000), { mode: 'query', domain: 'memory' });
                        if (computed && !isSyntheticConstantVector(computed)) {
                            queryEmbedding = computed;
                        }
                    } catch {
                        queryEmbedding = null;
                    }
                }
            }

            const queryCtx = buildQueryNudgeContext(queryText, queryEmbedding);
            const scoredCandidates = [];

            for (const rule of remainingRules) {
                const scored = scoreRuleRelevance(rule, queryCtx, idfMap);
                if (scored.qualifies) {
                    scoredCandidates.push({
                        rule,
                        effectiveScore: scored.effectiveScore,
                        relevanceScore: scored.relevanceScore
                    });
                }
            }

            scoredCandidates.sort((a, b) => {
                if (b.effectiveScore !== a.effectiveScore) {
                    return b.effectiveScore - a.effectiveScore;
                }
                if (b.relevanceScore !== a.relevanceScore) {
                    return b.relevanceScore - a.relevanceScore;
                }
                return String(a.rule.id).localeCompare(String(b.rule.id));
            });

            const slotsRemaining = 3 - activeViolations.length;
            for (let i = 0; i < Math.min(slotsRemaining, scoredCandidates.length); i++) {
                const picked = scoredCandidates[i].rule;
                activeViolations.push(picked);
                seenIds.add(picked.id);
            }
        }
    }

    if (activeViolations.length === 0) {
        return { content: [{ type: "text", text: "NO_NUDGES_REQUIRED" }] };
    }

    // 5. Format concise Markdown findings (capped to 1-3)
    const triggerLabel = file_path || hook || trigger || 'manual';
    let output = `### 🛡️ Invariant Check (${triggerLabel})\n\n`;
    output += `Found ${activeViolations.length} relevant active invariant(s) for this action:\n\n`;

    for (const v of activeViolations) {
        const cit = v.provenance?.citation || v.provenance?.file;
        const movedCit = v.provenance?.moved_candidate?.citation;
        const driftedBadge = movedCit
            ? ` ⚠️ *[DRIFTED: ${cit} -> moved_candidate: ${movedCit}]*`
            : ` ⚠️ *[DRIFTED: ${cit}]*`;
        const badge = cit
            ? (v.is_drifted ? driftedBadge : ` *[Anchor: ${cit}]*`)
            : '';
        output += `* **Rule #${v.id}** [${v.category}]${badge}: ${v.content}\n`;
    }
    output += `\n*If this nudge is unhelpful or a false positive, call 'nudge' with action: 'feedback', rule_id: '<id>', feedback: 'false_positive'.*`;

    return {
        content: [{ type: "text", text: output }]
    };
}

export const runProactiveNudge = handleProactiveNudge;

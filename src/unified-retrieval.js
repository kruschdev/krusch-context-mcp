/**
 * @module unified-retrieval
 * Unified Context Retrieval Engine for krusch-context-mcp.
 * Implements:
 * 1. Hybrid Semantic + Lexical Retrieval over Project Memories & Steering Nuggets
 * 2. State Briefing Integration
 * 3. Token Budget Accumulator (limit_tokens) with Strict Pruning
 * 4. Structured Citations Manifest
 */

import { getEmbedding } from './embedding-helper.js';
import { prunePreRetrieval, prunePostRetrieval, prunePreSynthesis } from './prune-helper.js';
import { detectCurrentProject } from './project-helper.js';
import { compileProjectState, normalizeCategory } from './memory-engine.js';
import { getProjectDb, cosineSimilarity, getParsedEmbedding, searchMemoryFts } from './sqlite-engine.js';
import {
    CHARS_PER_ESTIMATED_TOKEN,
    fnv1a32,
    STOP_WORDS,
    TEMPORAL_CUE_WORDS,
    GENERIC_INFRA_WORDS,
    META_QUERY_WORDS,
    DIRECTIVE_REGEX,
    STATE_TRANSITION_REGEX,
    stemToken,
    isTemporalOrLineageQuery,
    isSequenceOrderQuery,
    isKnowledgeUpdateQuery,
    isGenerativeOrAdvisoryQuery,
    isSyntheticConstantVector,
    extractQueryTokens,
    estimateTokens
} from './retrieval-lexical.js';
import {
    buildMemoryLineageChain,
    detectActiveConflicts,
    detectTemporalUpdates,
    computeUnattestedQueryTerms,
    computeCorpusUnattestedTerms
} from './retrieval-epistemic.js';

export {
    CHARS_PER_ESTIMATED_TOKEN,
    stemToken,
    isTemporalOrLineageQuery,
    isSequenceOrderQuery,
    extractQueryTokens,
    estimateTokens,
    buildMemoryLineageChain,
    detectActiveConflicts,
    detectTemporalUpdates
};

const DECAY_RATE = 0.01;
const MAX_FEAT_CACHE_ENTRIES = 10000;
const dbRowFeatureCache = new WeakMap();

/**
 * Formats a compact single-line milestone entry for the Chronological Event Sequence index,
 * preserving Session/Date metadata and USER/ASSISTANT substance while stripping raw `[... | Turn #X/Y]`
 * headers so summary blocks never duplicate primary turn-ID citations.
 * @param {string} rawContent
 * @param {number} maxChars
 * @returns {{ metaBadge: string, summary: string }}
 */
function formatCompactTimelineEntry(rawContent, maxChars = 190) {
    const str = String(rawContent || '');
    const headerMatch = str.match(/^\[([^\]]+)\]\s*/);
    let metaBadge = '';
    let body = str;
    if (headerMatch) {
        body = str.slice(headerMatch[0].length);
        const rawHeader = headerMatch[1];
        const sessMatch = rawHeader.match(/\bSession\s+(\d+)\b/i);
        const dateMatch = rawHeader.match(/\bDate:\s*([^|]+?)(?:\s*\||$)/i);
        const parts = [];
        if (sessMatch) parts.push(`Session ${sessMatch[1]}`);
        if (dateMatch) parts.push(dateMatch[1].trim());
        if (parts.length > 0) metaBadge = ` (${parts.join(' · ')})`;
    }
    const condensed = prunePreSynthesis(body, { maxChars })
        .replace(/\[[^\]]*\bTurn\s*#\d+(?:\/\d+)?[^\]]*\]\s*/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
    return { metaBadge, summary: condensed };
}

/**
 * Packs ranked context items into a single Markdown payload respecting limit_tokens.
 * Uses greedy submodular query-facet coverage when queryTerms are supplied so multi-session
 * queries cover every distinct sub-question before packing redundant items on a single facet.
 * Returns both formatted Markdown and a structured citations manifest.
 * @param {Array<{type: string, id: any, title: string, content: string, score: number, category?: string, key?: string, status?: string, lineage?: Array}>} items 
 * @param {number} limitTokens 
 * @param {string[]} [queryTerms=[]]
 * @returns {{contextText: string, packedCount: number, totalTokens: number, citations: Array, packedItems: Array, conflicts: Array}}
 */
export function packTokenBudget(items, limitTokens = 4000, queryTerms = []) {
    const sorted = [...items].sort((a, b) => {
        const sDiff = b.score - a.score;
        if (Math.abs(sDiff) > 1e-6) return sDiff;
        const uDiff = (b._unclampedScore ?? b.score) - (a._unclampedScore ?? a.score);
        if (Math.abs(uDiff) > 1e-6) return uDiff;
        return Number(b.id || 0) - Number(a.id || 0);
    });
    const maxCandidates = Math.min(sorted.length, Math.max(160, Math.ceil(limitTokens / 20)));

    // Ensure multi-arm recall: union of top hybrid-scored, top semantic, top user-IDF, and top full-IDF candidates
    const poolSet = new Set(sorted.slice(0, maxCandidates));
    if (sorted.length > maxCandidates) {
        const bySem = [...sorted].sort((a, b) => (b.semanticScore || 0) - (a.semanticScore || 0));
        const byIdf = [...sorted].sort((a, b) => (b.idfOverlap || 0) - (a.idfOverlap || 0));
        const byUserIdf = [...sorted].sort((a, b) => (b.userOverlap || 0) - (a.userOverlap || 0));
        for (const it of bySem.slice(0, 24)) poolSet.add(it);
        for (const it of byIdf.slice(0, 24)) poolSet.add(it);
        for (const it of byUserIdf.slice(0, 28)) poolSet.add(it);
    }
    const topSlice = [...poolSet];

    // Ensure items involved in active value/polarity conflicts are never collapsed as duplicates by prunePostRetrieval
    const conflictPairs = detectActiveConflicts(topSlice, queryTerms);
    const conflictedIds = new Set();
    for (const c of conflictPairs) {
        for (const cid of c.memory_ids) conflictedIds.add(Number(cid));
    }

    const nonConflicted = topSlice.filter(
        cand => !(cand.type === 'memory' && conflictedIds.has(Number(cand.id)))
    );
    const keptNonConflicted = new Set(
        prunePostRetrieval(nonConflicted, { similarityThreshold: 0.92 })
    );
    const deduped = topSlice.filter(
        cand => (cand.type === 'memory' && conflictedIds.has(Number(cand.id))) || keptNonConflicted.has(cand)
    );

    // Multi-round submodular facet-coverage & session-stratified diversity ordering for multi-term queries
    let orderedCandidates = deduped;
    if (Array.isArray(queryTerms) && queryTerms.length >= 2 && deduped.length > 1) {
        const queryStems = [...new Set(queryTerms.map(t => stemToken(t)))];
        const remaining = [...deduped];
        const reordered = [];

        // Perform up to 2 submodular facet-coverage rounds across distinct sessions (gated at score >= 0.50)
        for (let round = 0; round < 2 && remaining.length > 0; round++) {
            const uncovered = new Set(queryStems);
            const seenSessions = new Set();

            while (remaining.length > 0 && uncovered.size > 0) {
                let bestIdx = -1;
                let bestEffectiveScore = -Infinity;
                let bestNewCovered = [];
                let bestSessionTag = null;

                for (let i = 0; i < remaining.length; i++) {
                    const cand = remaining[i];
                    if (cand.score < 0.50) continue;
                    const textLower = `${cand.content || ''} ${cand.lineageText || ''}`.toLowerCase();
                    const candStems = cand._stems || new Set(textLower.split(/[^a-z0-9_]+/).filter(w => w.length >= 2).map(stemToken));
                    const newlyCovered = [...uncovered].filter(t => candStems.has(t) || textLower.includes(t));
                    if (newlyCovered.length === 0) continue;
                    const sessionMatch = textLower.match(/\bsession\s+(\d+)\b/);
                    const sessionTag = sessionMatch ? sessionMatch[1] : null;
                    const sessionBonus = (sessionTag && !seenSessions.has(sessionTag)) ? 0.08 : 0;
                    const coverageBonus = (newlyCovered.length / Math.max(1, uncovered.size)) * 0.32 + sessionBonus;
                    const effective = cand.score + coverageBonus;
                    if (effective > bestEffectiveScore) {
                        bestEffectiveScore = effective;
                        bestIdx = i;
                        bestNewCovered = newlyCovered;
                        bestSessionTag = sessionTag;
                    }
                }

                if (bestIdx === -1) break;
                const [picked] = remaining.splice(bestIdx, 1);
                reordered.push(picked);
                for (const t of bestNewCovered) uncovered.delete(t);
                if (bestSessionTag) seenSessions.add(bestSessionTag);
            }
        }

        if (deduped.length > 4 && limitTokens >= 2000) {
            const isBroad = deduped.some(x => x._isBroad);
            const isGenAdvisory = deduped.some(x => x._generativeAdvisoryMode);
            // Build session-stratified round-robin order for multi-session coverage
            const bySess = new Map();
            for (const x of deduped) {
                const sKey = x._sessionId ?? 0;
                if (!bySess.has(sKey)) bySess.set(sKey, []);
                bySess.get(sKey).push(x);
            }
            const sessStratified = [];
            const sessLists = [...bySess.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]);
            const maxSessLen = Math.max(0, ...sessLists.map(l => l.length));
            for (let r = 0; r < maxSessLen; r++) {
                for (const list of sessLists) {
                    if (r < list.length) sessStratified.push(list[r]);
                }
            }
            const topDirectives = [...deduped]
                .filter(x => x._isStandingDirective)
                .sort((a, b) => ((b.userOverlap || 0) * 0.55 + (b.semanticScore || 0) * 0.45) - ((a.userOverlap || 0) * 0.55 + (a.semanticScore || 0) * 0.45));
            const topSessOpeners = deduped.filter(x => x._sessionPos !== undefined && x._sessionPos <= 2);
            const topUserIdf = [...deduped].sort((a, b) => (b.userOverlap || 0) - (a.userOverlap || 0)).slice(0, 20);
            const topSemRem = [...deduped].sort((a, b) => (b.semanticScore || 0) - (a.semanticScore || 0)).slice(0, 20);
            const topIdfRem = [...deduped].sort((a, b) => (b.idfOverlap || 0) - (a.idfOverlap || 0)).slice(0, 16);
            const boundedSessStratified = sessStratified.slice(
                0,
                isBroad ? Math.max(24, sessLists.length * 4) : Math.max(15, sessLists.length * 3)
            );
            let prioritySet;
            if (isBroad) {
                prioritySet = new Set([
                    ...deduped.slice(0, 16),
                    ...reordered.slice(0, 10),
                    ...topSessOpeners.slice(0, 8),
                    ...boundedSessStratified,
                    ...topUserIdf,
                    ...topSemRem,
                    ...deduped
                ]);
            } else if (isGenAdvisory) {
                prioritySet = new Set([
                    ...deduped.slice(0, 5),
                    ...topDirectives.slice(0, 5),
                    ...deduped.slice(5, 12),
                    ...reordered.slice(0, 6),
                    ...topDirectives.slice(5, 8),
                    ...deduped.slice(12, 24),
                    ...topUserIdf,
                    ...topSemRem,
                    ...topIdfRem,
                    ...topDirectives,
                    ...boundedSessStratified,
                    ...deduped
                ]);
            } else {
                prioritySet = new Set([
                    ...deduped.slice(0, 12),
                    ...reordered.slice(0, 8),
                    ...topDirectives.slice(0, 8),
                    ...deduped.slice(12, 24),
                    ...topUserIdf,
                    ...topSemRem,
                    ...topIdfRem,
                    ...topDirectives,
                    ...boundedSessStratified,
                    ...deduped
                ]);
            }
            orderedCandidates = [...prioritySet];
        } else {
            orderedCandidates = [...reordered, ...remaining];
        }
    }

    let currentTokens = 0;
    const packed = [];
    const citations = [];
    const packedItems = [];
    const isLargeEpisodic = items.length >= 30 && limitTokens >= 4000;
    for (const item of orderedCandidates) {
        // Substantive USER + ASSISTANT dialogue turns across all tiers (no user-only header stubs):
        // Tier 1 (Top 8): 680 chars | Tier 2 (9..20): 440 chars | Tier 3 (21+): 320 chars
        const maxBodyChars = isLargeEpisodic
            ? (packed.length < 8 ? 680 : (packed.length < 20 ? 440 : 320))
            : 4000;
        let bodyText = prunePreSynthesis(item.content || '', {
            maxChars: maxBodyChars
        }).trim();
        if (item.lineage && item.lineage.length > 1) {
            const chainSummary = item.lineage
                .map(step => {
                    const stepBody = prunePreSynthesis(String(step.content || ''), { maxChars: 240 }).trim();
                    return `Step ${step.step} [#${step.id} ${step.status}${step.created_at ? ` @ ${step.created_at}` : ''}]: ${stepBody}`;
                })
                .join(' → ');
            bodyText += `\n> **Lineage History (${item.lineage.length} versions)**: ${chainSummary}`;
        }
        let entryText = `### [${item.type.toUpperCase()}] ${item.title} (Score: ${(item.score * 100).toFixed(1)}%)\n${bodyText}\n\n---\n`;
        let itemTokens = estimateTokens(entryText);

        if (currentTokens + itemTokens > limitTokens) {
            if (packed.length > 0) {
                break; // Stop packing once budget is reached
            }
            const maxAllowedChars = Math.max(80, Math.floor(Math.max(20, limitTokens - 25) * CHARS_PER_ESTIMATED_TOKEN));
            bodyText = bodyText.slice(0, maxAllowedChars);
            entryText = `### [${item.type.toUpperCase()}] ${item.title} (Score: ${(item.score * 100).toFixed(1)}%)\n${bodyText}\n\n---\n`;
            itemTokens = estimateTokens(entryText);
        }

        packed.push(entryText);
        currentTokens += itemTokens;
        packedItems.push(item);
        citations.push({
            type: item.type,
            id: item.id || null,
            category: item.category || null,
            key: item.key || null,
            title: item.title,
            score: Number(item.score.toFixed(3)),
            status: item.status || 'ACTIVE',
            ...(item.lineage && item.lineage.length > 1 ? { lineage: item.lineage } : {})
        });
    }

    const contextText = packed.join('');
    return {
        contextText,
        packedCount: packed.length,
        totalTokens: currentTokens,
        citations,
        packedItems,
        conflicts: conflictPairs
    };
}

/**
 * Unified Context Retrieval Entry Point.
 * @param {object} args
 * @param {string} args.query - Natural language query or topic
 * @param {string} [args.mode='hybrid'] - 'hybrid' | 'memory' | 'state'
 * @param {string} [args.category] - Optional closed category filter: decision, bug, invariant, lesson, blocker
 * @param {number} [args.limit_tokens=4000] - Hard upper limit on tokens returned
 * @param {string} [args.project] - Optional project context (auto-detected if omitted)
 * @param {boolean} [args.include_state=false] - Prepend compiled project state briefing
 * @param {boolean} [args.include_lineage=null] - Include superseded lineage chains (auto-enabled on temporal/ordering queries)
 * @returns {Promise<{content: Array, citations: Array, epistemic_status: string, conflicts: Array, chronological_order: Array}>}
 */
export async function unifiedRetrieve({
    query,
    mode = 'hybrid',
    category = null,
    limit_tokens = 4000,
    project = null,
    include_state = false,
    include_lineage = null,
    _embedding = null
} = {}) {
    const targetProject = project || detectCurrentProject();
    const normCategory = category ? normalizeCategory(category) : null;
    const items = [];
    const rawQuery = typeof query === 'string' ? query.trim() : (query ? String(query).trim() : '*');
    const isWildcard = !rawQuery || rawQuery === '*';
    const cleanQuery = isWildcard ? '*' : prunePreRetrieval(rawQuery);
    const lowerQuery = cleanQuery.toLowerCase();
    const { queryTerms, domainTerms, distinctiveTerms } = !isWildcard
        ? extractQueryTokens(lowerQuery)
        : { queryTerms: [], domainTerms: [], distinctiveTerms: [] };

    const temporalMode = include_lineage === true || (include_lineage !== false && !isWildcard && isTemporalOrLineageQuery(rawQuery));

    // 1. If mode === 'state' or include_state is requested, compile state briefing
    let stateHeader = "";
    let statePackedIds = new Set();
    let statePackedNuggets = new Set();
    if (mode === 'state' || include_state) {
        try {
            const stateRes = await compileProjectState({ project: targetProject });
            const stateText = stateRes?.content?.[0]?.text || "";
            if (mode === 'state') {
                return {
                    content: [{ type: "text", text: stateText }],
                    citations: [{ type: "state", project: targetProject }],
                    epistemic_status: 'SUPPORTED',
                    conflicts: [],
                    chronological_order: []
                };
            }
            stateHeader = stateText + "\n\n---\n\n";
            if (Array.isArray(stateRes?.packedIds)) {
                statePackedIds = new Set(stateRes.packedIds);
            }
            if (Array.isArray(stateRes?.packedNuggetKeys)) {
                statePackedNuggets = new Set(stateRes.packedNuggetKeys);
            }
        } catch (stateErr) {
            console.warn(`[unified-retrieval] State compilation warning: ${stateErr.message}`);
            if (mode === 'state') {
                return {
                    content: [{ type: "text", text: `# 🧠 Compiled Project State: ${targetProject}\n> ⚠️ State compilation warning: ${stateErr.message}` }],
                    citations: [{ type: "state", project: targetProject }],
                    epistemic_status: 'SUPPORTED',
                    conflicts: [],
                    chronological_order: []
                };
            }
        }
    }

    // 2. Fetch seed embedding for semantic matching (skip for universal wildcard)
    let embeddingArray = _embedding || null;
    if (!embeddingArray && !isWildcard) {
        try {
            embeddingArray = await getEmbedding(cleanQuery, { mode: 'query', domain: 'memory' });
        } catch (embErr) {
            console.warn(`[unified-retrieval] Embedding fallback warning: ${embErr.message}`);
            embeddingArray = null;
        }
    }
    const hasRealQueryEmbedding = Boolean(embeddingArray && !isSyntheticConstantVector(embeddingArray));

    // 3. Search project memories from local SQLite cache (Full-Store Hybrid Pre-Filter + Lineage Resolution)
    let allCandidateRows = [];
    let storageError = null;
    const sequenceOrderMode = !isWildcard && isSequenceOrderQuery(rawQuery);
    const knowledgeUpdateMode = !isWildcard && isKnowledgeUpdateQuery(rawQuery);
    const generativeAdvisoryMode = !isWildcard && isGenerativeOrAdvisoryQuery(rawQuery);
    const evaluatedNuggets = [];
    if (targetProject) {
        try {
            const db = await getProjectDb(targetProject);
            if (db) {
                const rowCache = new Map();
                const selectCols = (isWildcard || !embeddingArray)
                    ? `id, category, content, tags, status, supersedes_id, superseded_by, invalidated_reason, created_at, updated_at`
                    : `id, category, content, tags, status, supersedes_id, superseded_by, invalidated_reason, created_at, updated_at, embedding, embedding_blob`;

                const candidateMap = new Map();

                if (isWildcard) {
                    let memSql = `SELECT ${selectCols} FROM ide_agent_memory WHERE status = 'ACTIVE'`;
                    const params = [];
                    if (normCategory) {
                        memSql += ` AND category = ?`;
                        params.push(normCategory);
                    }
                    memSql += ` ORDER BY id DESC LIMIT 250`;
                    for (const row of db.prepare(memSql).all(...params)) {
                        candidateMap.set(Number(row.id), row);
                        rowCache.set(Number(row.id), row);
                    }
                } else {
                    // 3a. Active semantic scan pool first (up to maxActiveVecScan active rows; default 5000)
                    const maxActiveVecScan = Math.max(400, Number(process.env.KRUSCH_MAX_ACTIVE_SCAN) || 5000);
                    let vecSql = `SELECT ${selectCols} FROM ide_agent_memory WHERE status = 'ACTIVE'`;
                    const vecParams = [];
                    if (normCategory) {
                        vecSql += ` AND category = ?`;
                        vecParams.push(normCategory);
                    }
                    vecSql += ` ORDER BY id DESC LIMIT ?`;
                    vecParams.push(maxActiveVecScan);
                    const vecRows = db.prepare(vecSql).all(...vecParams);
                    let minVecId = Infinity;
                    for (const row of vecRows) {
                        const numId = Number(row.id);
                        if (numId < minVecId) minVecId = numId;
                        rowCache.set(numId, row);
                        candidateMap.set(numId, row);
                    }

                    // 3b. Full-store lexical scan across SUPERSEDED rows and any deep ACTIVE rows beyond maxActiveVecScan
                    // Uses Porter-stemmed SQLite FTS5 BM25 index first (O(log N) at 1M+ token scale), with LIKE fallback
                    const hasSuperseded = db.prepare(`SELECT 1 FROM ide_agent_memory WHERE status = 'SUPERSEDED' LIMIT 1`).get();
                    const searchTerms = domainTerms.length > 0 ? domainTerms : queryTerms;
                    if (searchTerms.length > 0 && (hasSuperseded || vecRows.length === maxActiveVecScan)) {
                        let lexRows = searchMemoryFts(db, searchTerms, {
                            includeSuperseded: Boolean(hasSuperseded),
                            includeActiveBeforeId: (vecRows.length === maxActiveVecScan && Number.isFinite(minVecId)) ? minVecId : null,
                            category: normCategory,
                            selectCols,
                            limit: 300
                        });
                        if (!lexRows || (lexRows.length === 0 && hasSuperseded)) {
                            const matchExprs = [];
                            const matchParams = [];
                            const likeClauses = [];
                            const whereParams = [];
                            for (const term of searchTerms.slice(0, 12)) {
                                const rootTerm = stemToken(term);
                                const escaped = rootTerm.replace(/[\\%_]/g, '\\$&');
                                const pat = `%${escaped}%`;
                                const clause = `(LOWER(content) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(tags, '')) LIKE ? ESCAPE '\\')`;
                                matchExprs.push(`(CASE WHEN ${clause} THEN 1 ELSE 0 END)`);
                                matchParams.push(pat, pat);
                                likeClauses.push(clause);
                                whereParams.push(pat, pat);
                            }
                            const scopeClause = (!lexRows && vecRows.length === maxActiveVecScan)
                                ? `(status = 'SUPERSEDED' OR (status = 'ACTIVE' AND id < ${Number.isFinite(minVecId) ? minVecId : 0}))`
                                : `status = 'SUPERSEDED'`;
                            let lexSql = `
                                SELECT ${selectCols}, (${matchExprs.join(' + ')}) AS _lex_hits
                                FROM ide_agent_memory
                                WHERE ${scopeClause}
                            `;
                            const sqlParams = [...matchParams];
                            if (normCategory) {
                                lexSql += ` AND category = ?`;
                                sqlParams.push(normCategory);
                            }
                            sqlParams.push(...whereParams);
                            lexSql += ` AND (${likeClauses.join(' OR ')}) ORDER BY _lex_hits DESC, id DESC LIMIT 300`;
                            lexRows = db.prepare(lexSql).all(...sqlParams);
                        }
                        for (const row of lexRows) {
                            rowCache.set(Number(row.id), row);
                            if (row.status === 'ACTIVE') {
                                const existing = candidateMap.get(Number(row.id));
                                if (!existing) candidateMap.set(Number(row.id), row);
                            } else if (row.status === 'SUPERSEDED') {
                                const { chain, terminalActiveRow } = buildMemoryLineageChain(db, row, rowCache);
                                if (terminalActiveRow && (!normCategory || terminalActiveRow.category === normCategory)) {
                                    const existing = candidateMap.get(Number(terminalActiveRow.id));
                                    const mergedTarget = existing || terminalActiveRow;
                                    mergedTarget._lineageChain = chain;
                                    candidateMap.set(Number(terminalActiveRow.id), mergedTarget);
                                } else if (temporalMode) {
                                    row._lineageChain = chain;
                                    candidateMap.set(Number(row.id), row);
                                }
                            }
                        }
                    }
                }

                allCandidateRows = [...candidateMap.values()].sort((a, b) => Number(a.id) - Number(b.id));
                const nowMs = Date.now();
                const evalTerms = domainTerms.length > 0 ? domainTerms : queryTerms;
                const evalStems = [...new Set(evalTerms.map(stemToken))];
                const distinctiveStems = [...new Set(distinctiveTerms.map(stemToken))];
                const isBroadQuery = !isWildcard && /\b(order|sequence|chronological|timeline|summary|summarize|comprehensive|throughout|across|progressed|progress)\b/i.test(rawQuery);
                const isEpisodicStore = !isWildcard && allCandidateRows.length >= 20;

                // Extract contiguous 2-word and 3-word content phrases (and stemmed equivalents) from the query
                const queryPhrases = [];
                const queryStemPhrases = [];
                if (!isWildcard && evalTerms.length >= 2) {
                    const rawWords = lowerQuery.split(/[^a-z0-9_.-]+/).filter(w => w.length >= 3 && !STOP_WORDS.has(w) && !META_QUERY_WORDS.has(w));
                    const rawStemWords = rawWords.map(stemToken);
                    for (let k = 0; k + 1 < rawWords.length; k++) {
                        queryPhrases.push(`${rawWords[k]} ${rawWords[k + 1]}`);
                        queryStemPhrases.push(`${rawStemWords[k]} ${rawStemWords[k + 1]}`);
                        if (k + 2 < rawWords.length) {
                            queryPhrases.push(`${rawWords[k]} ${rawWords[k + 1]} ${rawWords[k + 2]}`);
                            queryStemPhrases.push(`${rawStemWords[k]} ${rawStemWords[k + 1]} ${rawStemWords[k + 2]}`);
                        }
                    }
                }

                let featCache = dbRowFeatureCache.get(db);
                if (!featCache) {
                    featCache = new Map();
                    dbRowFeatureCache.set(db, featCache);
                }

                const sessionCounters = new Map();

                // Precompute stemmed token sets and corpus IDF weights across candidateMap
                const dfMap = new Map();
                for (const r of allCandidateRows) {
                    let lineage = r._lineageChain || null;
                    if (!lineage && (r.supersedes_id || r.superseded_by)) {
                        lineage = buildMemoryLineageChain(db, r, rowCache).chain;
                        r._lineageChain = lineage;
                    }
                    r._lineageText = lineage && lineage.length > 1
                        ? lineage.map(step => step.content).join(' ')
                        : '';

                    const cacheKey = `${r.id}:${r.category || ''}:${r.updated_at || ''}:${fnv1a32(`${r.content || ''}|${r.tags || ''}|${r._lineageText || ''}`)}`;
                    let cachedFeat = featCache.get(cacheKey);
                    if (!cachedFeat) {
                        const lowerContent = (r.content || '').toLowerCase();
                        const lowerTags = r.tags ? String(r.tags).toLowerCase() : '';
                        const lowerLineage = r._lineageText.toLowerCase();
                        const combinedText = `${lowerContent} ${lowerTags} ${lowerLineage}`;
                        const rowStems = new Set(
                            combinedText.split(/[^a-z0-9_]+/).filter(w => w.length >= 2).map(stemToken)
                        );
                        const userMatch = lowerContent.match(/\buser:\s*([\s\S]*?)(?:\|\s*assistant:|$)/i);
                        const hasDialogueTurn = Boolean(userMatch);
                        const userRaw = userMatch ? userMatch[1] : lowerContent;
                        const userStemsArr = userRaw.split(/[^a-z0-9_]+/).filter(w => w.length >= 2).map(stemToken);
                        const userStems = new Set(userStemsArr);
                        const userStemSeq = userStemsArr.join(' ');
                        const isStandingDirective = r.category === 'invariant' || (hasDialogueTurn && DIRECTIVE_REGEX.test(userRaw));
                        const hasStateTransition = hasDialogueTurn
                            ? STATE_TRANSITION_REGEX.test(userRaw)
                            : STATE_TRANSITION_REGEX.test(lowerContent);
                        const sessMatch = lowerContent.match(/\[[^\]]*\bsession[\s_-]+(\d+)\b/i);
                        const sessionId = sessMatch ? Number(sessMatch[1]) : null;
                        cachedFeat = {
                            lowerContent,
                            lowerTags,
                            lowerLineage,
                            combinedText,
                            rowStems,
                            userStems,
                            userStemSeq,
                            userRaw,
                            hasDialogueTurn,
                            isStandingDirective,
                            hasStateTransition,
                            sessionId
                        };
                        if (featCache.size >= MAX_FEAT_CACHE_ENTRIES) {
                            const oldestKey = featCache.keys().next().value;
                            if (oldestKey !== undefined) featCache.delete(oldestKey);
                        }
                        featCache.set(cacheKey, cachedFeat);
                    }

                    r._stems = cachedFeat.rowStems;
                    r._userStems = cachedFeat.userStems;
                    r._userStemSeq = cachedFeat.userStemSeq;
                    r._userRaw = cachedFeat.userRaw;
                    r._hasDialogueTurn = cachedFeat.hasDialogueTurn;
                    r._lowerContent = cachedFeat.lowerContent;
                    r._lowerTags = cachedFeat.lowerTags;
                    r._combinedText = cachedFeat.combinedText;
                    r._isStandingDirective = cachedFeat.isStandingDirective;
                    r._hasStateTransition = Boolean(cachedFeat.hasStateTransition);
                    r._sessionId = cachedFeat.sessionId;
                    if (r._sessionId !== null) {
                        const sPos = sessionCounters.get(r._sessionId) || 0;
                        r._sessionPos = sPos;
                        sessionCounters.set(r._sessionId, sPos + 1);
                    } else {
                        r._sessionPos = 999;
                    }

                    for (const s of evalStems) {
                        if (cachedFeat.rowStems.has(s) || cachedFeat.combinedText.includes(s)) {
                            dfMap.set(s, (dfMap.get(s) || 0) + 1);
                        }
                    }
                }

                let totalQueryIdf = 0;
                const idfWeights = new Map();
                const corpusN = Math.max(1, allCandidateRows.length);
                for (const s of evalStems) {
                    const w = Math.log(1 + corpusN / (1 + (dfMap.get(s) || 0)));
                    idfWeights.set(s, w);
                    totalQueryIdf += w;
                }

                const skipStatePacked = include_state && (isWildcard || allCandidateRows.length < 30);
                const rawScoredMemoryItems = [];

                for (let rowIdx = 0; rowIdx < allCandidateRows.length; rowIdx++) {
                    const r = allCandidateRows[rowIdx];
                    if (skipStatePacked && statePackedIds.has(r.id)) {
                        continue; // Avoid re-packing memories already rendered in compileProjectState on small stores
                    }

                    const lineage = r._lineageChain || null;
                    const lineageText = r._lineageText || '';

                    let score = 0;
                    let semanticScore = 0;
                    let idfOverlap = 0;
                    let userOverlap = 0;
                    let unclampedScore = 0;

                    if (isWildcard) {
                        score = 0.85;
                        unclampedScore = 0.85;
                    } else {
                        if (hasRealQueryEmbedding) {
                            const rowsToScore = [r];
                            if (lineage && lineage.length > 1) {
                                for (const step of lineage) {
                                    const cachedStepRow = rowCache.get(Number(step.id));
                                    if (cachedStepRow && cachedStepRow !== r) rowsToScore.push(cachedStepRow);
                                }
                            }
                            for (const scoreRow of rowsToScore) {
                                if (scoreRow.embedding || scoreRow.embedding_blob) {
                                    const vec = getParsedEmbedding(scoreRow.embedding, scoreRow.embedding_blob);
                                    if (vec && !isSyntheticConstantVector(vec)) {
                                        const sim = cosineSimilarity(embeddingArray, vec);
                                        if (sim > semanticScore) semanticScore = sim;
                                    }
                                }
                            }
                        }

                        const lowerContent = r._lowerContent;
                        const lowerTags = r._lowerTags;
                        const combinedHaystack = r._combinedText;
                        const rowStems = r._stems;
                        const userStems = r._userStems;

                        const matchesTerm = (term, stem) =>
                            rowStems.has(stem) || combinedHaystack.includes(term);

                        let directMatches = evalTerms.filter((t, idx) =>
                            rowStems.has(evalStems[idx]) || lowerContent.includes(t) || lowerTags.includes(t)
                        ).length;
                        if (lineage && lineage.length > 1) {
                            for (const step of lineage) {
                                const stepLower = String(step.content || '').toLowerCase();
                                const stepMatches = evalTerms.filter((t, idx) => stepLower.includes(t) || stepLower.includes(evalStems[idx])).length;
                                if (stepMatches > directMatches) directMatches = stepMatches;
                            }
                        }
                        const totalMatches = evalTerms.filter((t, idx) => matchesTerm(t, evalStems[idx])).length;
                        const distinctiveMatches = distinctiveTerms.filter((t, idx) => matchesTerm(t, distinctiveStems[idx])).length;

                        let matchedIdf = 0;
                        let matchedUserIdf = 0;
                        for (const s of evalStems) {
                            const w = idfWeights.get(s) || 0;
                            if (rowStems.has(s) || combinedHaystack.includes(s)) {
                                matchedIdf += w;
                            }
                            if (userStems && userStems.has(s)) {
                                matchedUserIdf += w;
                            }
                        }
                        const fullOverlap = totalQueryIdf > 0 ? matchedIdf / totalQueryIdf : 0;
                        userOverlap = totalQueryIdf > 0 ? matchedUserIdf / totalQueryIdf : 0;
                        idfOverlap = (isEpisodicStore && r._hasDialogueTurn)
                            ? (0.68 * userOverlap + 0.32 * fullOverlap)
                            : fullOverlap;

                        if (lowerContent.includes(lowerQuery)) {
                            score = Math.max(semanticScore, 0.92);
                        } else if (totalMatches > 0 && evalTerms.length > 0) {
                            const directOverlap = directMatches / evalTerms.length;
                            const totalOverlap = totalMatches / evalTerms.length;
                            const blendedOverlap = Math.max(0.65 * directOverlap + 0.35 * totalOverlap, idfOverlap);

                            // Guard against single-word coincidence on unrecorded topics (Abstention precision)
                            if (distinctiveTerms.length > 0 && distinctiveMatches === 0 && semanticScore < 0.68) {
                                score = Math.min(0.35, semanticScore * 0.5);
                            } else if (distinctiveTerms.length >= 4 && distinctiveMatches === 1 && semanticScore < 0.66) {
                                score = Math.min(0.38, semanticScore * 0.55);
                            } else if (evalTerms.length >= 4 && totalMatches === 1 && totalOverlap < 0.25 && semanticScore < 0.66) {
                                score = Math.min(0.38, semanticScore * 0.55);
                            } else {
                                const lexicalScore = 0.50 + blendedOverlap * 0.42;
                                const hybridScore = semanticScore > 0
                                    ? semanticScore * 0.48 + idfOverlap * 0.52 + 0.16 * Math.min(semanticScore, idfOverlap)
                                    : lexicalScore;
                                unclampedScore = Math.max(semanticScore, lexicalScore, hybridScore);
                                score = Math.min(0.99, unclampedScore);
                            }
                        } else {
                            // Zero lexical term overlap: require strong genuine semantic similarity (>= 0.68) on atomic rules,
                            // or preserve direct BGE cosine similarity on external dialogue turns
                            score = r._hasDialogueTurn
                                ? semanticScore
                                : (semanticScore >= 0.68 ? semanticScore : semanticScore * 0.45);
                        }

                        if (r._hasDialogueTurn && semanticScore > score) {
                            score = semanticScore;
                        }
                        if (score > unclampedScore) {
                            unclampedScore = score;
                        }

                        // Exact and stem-normalized multi-word query phrase match boost
                        if (queryPhrases.length > 0 && score > 0.42) {
                            const phraseHits = queryPhrases.filter(p => lowerContent.includes(p)).length;
                            const stemPhraseHits = r._userStemSeq
                                ? queryStemPhrases.filter(sp => r._userStemSeq.includes(sp)).length
                                : 0;
                            const bestPhraseHits = Math.max(phraseHits, stemPhraseHits);
                            if (bestPhraseHits > 0) {
                                const phraseBoost = Math.min(0.12, bestPhraseHits * 0.05);
                                unclampedScore += phraseBoost;
                                score = Math.min(0.99, score + phraseBoost);
                            }
                        }

                        // Boost explicit user state transitions and chronological progression on Knowledge Update queries
                        if (!isBroadQuery && !sequenceOrderMode && score > 0.46) {
                            if (knowledgeUpdateMode) {
                                if (r._hasStateTransition && (idfOverlap >= 0.16 || userOverlap >= 0.16 || semanticScore >= 0.56)) {
                                    unclampedScore += 0.07;
                                    score = Math.min(0.99, score + 0.07);
                                }
                                if ((idfOverlap >= 0.20 || semanticScore >= 0.58) && corpusN > 1) {
                                    const progBoost = 0.035 * (rowIdx / (corpusN - 1));
                                    unclampedScore += progBoost;
                                    score = Math.min(0.99, score + progBoost);
                                }
                            } else if (r._hasStateTransition && (userOverlap >= 0.24 || (idfOverlap >= 0.24 && semanticScore >= 0.58))) {
                                unclampedScore += 0.04;
                                score = Math.min(0.99, score + 0.04);
                            }
                        }

                        // Boost standing invariants/preferences when semantic embeddings are active on non-temporal or generative/advisory queries
                        if (hasRealQueryEmbedding && !isBroadQuery && (!temporalMode || generativeAdvisoryMode) && r._isStandingDirective) {
                            if ((r.category === 'invariant' || r._isStandingDirective) && score > 0.42) {
                                const invBoost = (allCandidateRows.length < 30 || idfOverlap >= 0.25 || semanticScore >= 0.66) ? 0.14 : 0.06;
                                unclampedScore += invBoost;
                                score = Math.min(0.98, score + invBoost);
                            }
                            if (isEpisodicStore && r._hasDialogueTurn && semanticScore >= 0.38) {
                                const dirFloor = Math.max(semanticScore + 0.22, 0.66);
                                score = Math.max(score, dirFloor);
                                unclampedScore = Math.max(unclampedScore, dirFloor);
                            }
                        }

                        // Boost session-opening turns (pos <= 2) which anchor persona, context, and session transitions
                        if (r._hasDialogueTurn && r._sessionPos <= 2 && score > 0.30) {
                            const openerBoost = isBroadQuery
                                ? (r._sessionPos === 0 ? 0.14 : 0.11)
                                : 0.06;
                            unclampedScore += openerBoost;
                            score = Math.min(0.99, score + openerBoost);
                        }

                        // Boost items with multi-step lineage on explicit temporal/ordering queries
                        if (temporalMode && lineage && lineage.length > 1 && score > 0.45) {
                            unclampedScore += 0.06;
                            score = Math.min(0.99, score + 0.06);
                        }

                        // Gentle temporal recency factor (up to +0.02 for fresh records; state-transition updates allow +0.005 tie-break headroom)
                        const maxCeiling = (knowledgeUpdateMode && r._hasStateTransition) ? 1.0 : 0.995;
                        if (score > 0.4 && r.created_at) {
                            const ageDays = Math.max(0, (nowMs - new Date(r.created_at).getTime()) / 86_400_000);
                            if (Number.isFinite(ageDays)) {
                                const recencyBoost = 0.02 * Math.exp(-DECAY_RATE * ageDays);
                                unclampedScore += recencyBoost;
                                score = Math.min(maxCeiling, score + recencyBoost);
                            }
                        } else if (score > maxCeiling) {
                            score = maxCeiling;
                        }
                    }

                    const statusBadge = r.status && r.status !== 'ACTIVE' ? ` [${r.status}]` : '';
                    rawScoredMemoryItems.push({
                        type: 'memory',
                        id: r.id,
                        category: r.category,
                        status: r.status || 'ACTIVE',
                        title: `Memory #${r.id} (${r.category})${statusBadge}`,
                        content: r.content,
                        lineage: lineage && lineage.length > 1 ? lineage : null,
                        lineageText,
                        created_at: r.created_at || null,
                        rawScore: score,
                        score,
                        _unclampedScore: unclampedScore,
                        semanticScore,
                        idfOverlap,
                        userOverlap,
                        _stems: r._stems,
                        _userStems: r._userStems,
                        _userRaw: r._userRaw,
                        _hasDialogueTurn: r._hasDialogueTurn,
                        _isStandingDirective: r._isStandingDirective,
                        _hasStateTransition: r._hasStateTransition,
                        _sessionId: r._sessionId,
                        _sessionPos: r._sessionPos,
                        _isBroad: isBroadQuery,
                        _temporalMode: temporalMode,
                        _sequenceOrderMode: sequenceOrderMode,
                        _generativeAdvisoryMode: generativeAdvisoryMode
                    });
                }

                // RM3 / Rocchio Pseudo-Relevance Feedback (PRF) over top first-pass episodic turns:
                // Discovers conversation-specific entity/synonym stems (e.g. "stephen", "michael", "2fa") that co-occur
                // across >= 2 of the top-8 first-pass turns and applies a bounded second-pass relevance boost.
                if (isEpisodicStore && rawScoredMemoryItems.length >= 20 && evalStems.length > 0) {
                    const evalStemSet = new Set(evalStems);
                    const topSeeds = [...rawScoredMemoryItems]
                        .sort((a, b) => (b._unclampedScore - a._unclampedScore) || (b.rawScore - a.rawScore))
                        .slice(0, 8)
                        .filter(x => x.rawScore >= 0.52);

                    if (topSeeds.length >= 2) {
                        const seedFreq = new Map();
                        for (const seed of topSeeds) {
                            const stems = seed._userStems || seed._stems;
                            if (!stems) continue;
                            for (const st of stems) {
                                if (st.length < 3 || evalStemSet.has(st) || STOP_WORDS.has(st) || TEMPORAL_CUE_WORDS.has(st) || GENERIC_INFRA_WORDS.has(st) || META_QUERY_WORDS.has(st)) {
                                    continue;
                                }
                                seedFreq.set(st, (seedFreq.get(st) || 0) + 1);
                            }
                        }

                        const prfCandidates = [];
                        for (const [st, sCount] of seedFreq.entries()) {
                            if (sCount < 2) continue;
                            let docFreq = 0;
                            for (const r of allCandidateRows) {
                                if (r._stems && r._stems.has(st)) docFreq++;
                            }
                            if (docFreq > corpusN * 0.50) continue;
                            const idf = Math.log(1 + corpusN / (1 + docFreq));
                            prfCandidates.push({ stem: st, weight: sCount * idf });
                        }

                        prfCandidates.sort((a, b) => b.weight - a.weight);
                        const topPrf = prfCandidates.slice(0, 6);
                        const totalPrfWeight = topPrf.reduce((acc, x) => acc + x.weight, 0);

                        if (totalPrfWeight > 0) {
                            for (const item of rawScoredMemoryItems) {
                                let matchedPrf = 0;
                                for (const { stem, weight } of topPrf) {
                                    if ((item._userStems && item._userStems.has(stem)) || (item._stems && item._stems.has(stem))) {
                                        matchedPrf += weight;
                                    }
                                }
                                if (matchedPrf > 0) {
                                    const prfOverlap = matchedPrf / totalPrfWeight;
                                    const itemCeiling = (knowledgeUpdateMode && item._hasStateTransition) ? 1.0 : 0.995;
                                    item._unclampedScore += 0.14 * prfOverlap;
                                    item.rawScore = Math.min(itemCeiling, item.rawScore + 0.14 * prfOverlap);
                                    item.score = item.rawScore;
                                }
                            }
                        }
                    }
                }

                // In-session Episode Kernel Smoothing for multi-turn episodic stores with explicit session tags
                if (isEpisodicStore && rawScoredMemoryItems.length >= 20) {
                    const radius = isBroadQuery ? 8 : 2;
                    const CONTINUATION_CUE = /^(?:thanks|thank\s+you|sounds\s+good|got\s+it|yeah|yes|no,\s*i\s*think|sure|hmm|that\s+(?:plan|sounds|makes)|these\s+exercises|okay|ok\b|great|perfect|i\s+see|makes\s+sense|no\s+further)/i;
                    for (let i = 0; i < rawScoredMemoryItems.length; i++) {
                        const curr = rawScoredMemoryItems[i];
                        if (curr._sessionId === null) continue;
                        const isContinuationTurn = Boolean(curr._userRaw && CONTINUATION_CUE.test(curr._userRaw.trim()));
                        let neighborMax = 0;
                        let forwardAnchorMax = 0;
                        let neighborSum = 0;
                        let neighborCount = 0;
                        for (let d = -radius; d <= radius; d++) {
                            if (d === 0) continue;
                            const j = i + d;
                            if (j >= 0 && j < rawScoredMemoryItems.length && rawScoredMemoryItems[j]._sessionId === curr._sessionId) {
                                const dist = Math.abs(d);
                                const decay = Math.max(0.68, 0.94 - dist * 0.035);
                                const candRaw = rawScoredMemoryItems[j].rawScore;
                                if (candRaw * decay > neighborMax) neighborMax = candRaw * decay;
                                if (d < 0 && dist <= 2 && candRaw >= 0.62 && isContinuationTurn) {
                                    const contScore = candRaw * (dist === 1 ? 0.91 : 0.87);
                                    if (contScore > forwardAnchorMax) forwardAnchorMax = contScore;
                                }
                                neighborSum += candRaw;
                                neighborCount++;
                            }
                        }
                        const localAvg = neighborCount > 0 ? neighborSum / neighborCount : 0;
                        curr.score = Math.max(
                            curr.rawScore,
                            forwardAnchorMax,
                            0.50 * curr.rawScore + 0.50 * neighborMax,
                            0.58 * curr.rawScore + 0.42 * localAvg
                        );
                    }
                }

                for (const mItem of rawScoredMemoryItems) {
                    if (mItem.score > (mItem._hasDialogueTurn ? 0.25 : 0.4)) {
                        items.push(mItem);
                    }
                }

                // Search steering nuggets (deduplicated by key) only when not restricted to episodic memory or a specific category
                if (mode !== 'memory' && !normCategory) {
                    const nugRows = db.prepare(`SELECT key, value, kind FROM ide_agent_nuggets ORDER BY updated_at ASC`).all();
                    const nugMap = new Map();
                    for (const n of nugRows) nugMap.set(n.key, n);
                    for (const n of nugMap.values()) {
                        evaluatedNuggets.push(n);
                        if (include_state && statePackedNuggets.has(n.key)) {
                            continue; // Avoid re-packing nuggets already rendered in compileProjectState
                        }
                        let score = isWildcard ? 0.85 : 0;
                        if (!isWildcard) {
                            const nugHaystack = `${n.key} ${n.value}`.toLowerCase();
                            const nugStems = new Set(nugHaystack.split(/[^a-z0-9_]+/).filter(w => w.length >= 2).map(stemToken));
                            const evalTerms = domainTerms.length > 0 ? domainTerms : queryTerms;
                            const nugMatches = evalTerms.filter(t => nugStems.has(stemToken(t)) || nugHaystack.includes(t)).length;
                            if (nugHaystack.includes(lowerQuery)) {
                                score = 0.88;
                            } else if (nugMatches > 0 && evalTerms.length > 0) {
                                const overlap = nugMatches / evalTerms.length;
                                if (evalTerms.length < 4 || nugMatches >= 2 || overlap >= 0.25) {
                                    score = 0.52 + overlap * 0.36;
                                }
                            } else if (hasRealQueryEmbedding && n.kind === 'preference') {
                                score = 0.62;
                            }
                        }
                        if (score > 0.4) {
                            items.push({
                                type: 'nugget',
                                key: n.key,
                                status: 'ACTIVE',
                                title: `Nugget: ${n.key} (${n.kind})`,
                                content: n.value,
                                score
                            });
                        }
                    }
                }
            }
        } catch (e) {
            storageError = e;
            console.warn(`[unified-retrieval] SQLite retrieval warning: ${e.message}`);
        }
    }

    // 4. Pack token budget strictly within bounded limits using submodular query-facet coverage
    const safeLimitTokens = Math.min(Math.max(100, Number(limit_tokens) || 4000), 32000);
    const isPureDialogueTranscript = !isWildcard
        && allCandidateRows.length >= 30
        && allCandidateRows.every(r => r._hasDialogueTurn);
    if (isPureDialogueTranscript && stateHeader) {
        stateHeader = `# 🧠 Compiled Project State: ${targetProject} (Active Invariants & Preferences inline below)\n`;
    }
    const stateDeduction = estimateTokens(stateHeader);
    let headerAndTimelineReserve = 0;
    if (!isWildcard && safeLimitTokens >= 2000 && allCandidateRows.length >= 30) {
        headerAndTimelineReserve = Math.max(0, (temporalMode ? 980 : 280) - stateDeduction);
    } else if (!isWildcard && safeLimitTokens >= 400 && safeLimitTokens < 2000) {
        const targetReserve = temporalMode
            ? Math.min(450, Math.floor(safeLimitTokens * 0.28))
            : Math.min(120, Math.floor(safeLimitTokens * 0.12));
        headerAndTimelineReserve = Math.max(0, targetReserve - stateDeduction);
    }
    const availableTokens = Math.max(100, safeLimitTokens - stateDeduction - headerAndTimelineReserve);
    const packed = packTokenBudget(items, availableTokens, domainTerms.length > 0 ? domainTerms : queryTerms);

    // 5. Evaluate Epistemic Status (SUPPORTED | CONFLICTED | NO_KNOWN_SUPPORT | STORAGE_ERROR) & Contradictions
    const packedIdSet = new Set(packed.packedItems.filter(it => it.type === 'memory').map(it => Number(it.id)));
    const conflicts = !isWildcard
        ? (packed.conflicts || []).filter(c => c.memory_ids.every(id => packedIdSet.has(Number(id))))
        : [];
    const maxScore = packed.packedItems.length > 0
        ? Math.max(...packed.packedItems.map(it => it.score))
        : 0;

    let epistemicStatus = 'SUPPORTED';
    if (storageError && packed.packedCount === 0) {
        epistemicStatus = 'STORAGE_ERROR';
    } else if (!isWildcard && (packed.packedCount === 0 || maxScore < 0.50)) {
        epistemicStatus = 'NO_KNOWN_SUPPORT';
    } else if (conflicts.length > 0) {
        epistemicStatus = 'CONFLICTED';
    }

    const unattestedQueryTerms = !isWildcard
        ? computeUnattestedQueryTerms(distinctiveTerms, packed.packedItems, allCandidateRows)
        : [];

    // 6. Build Chronological Event Ordering strictly from packed items
    const chronologicalEvents = [];
    if (packed.packedItems.length > 0) {
        const seenIds = new Set();
        for (const it of packed.packedItems) {
            if (it.lineage && it.lineage.length > 1) {
                for (const step of it.lineage) {
                    if (!seenIds.has(step.id)) {
                        seenIds.add(step.id);
                        chronologicalEvents.push({
                            id: step.id,
                            status: step.status,
                            category: step.category,
                            created_at: step.created_at,
                            content: step.content,
                            score: it.score || 0,
                            idfOverlap: it.idfOverlap || 0,
                            semanticScore: it.semanticScore || 0,
                            sessionId: it._sessionId || 1,
                            sessionPos: it._sessionPos ?? 999,
                            hasLineage: true
                        });
                    }
                }
            } else if (it.type === 'memory' && !seenIds.has(Number(it.id))) {
                seenIds.add(Number(it.id));
                chronologicalEvents.push({
                    id: Number(it.id),
                    status: it.status || 'ACTIVE',
                    category: it.category,
                    created_at: it.created_at || null,
                    content: it.content,
                    score: it.score || 0,
                    idfOverlap: it.idfOverlap || 0,
                    semanticScore: it.semanticScore || 0,
                    sessionId: it._sessionId || 1,
                    sessionPos: it._sessionPos ?? 999,
                    hasLineage: false
                });
            }
        }
        chronologicalEvents.sort((a, b) => a.id - b.id);
    }

    const unattestedBadge = unattestedQueryTerms.length > 0
        ? ` | **Unattested Query Terms**: \`${unattestedQueryTerms.join(', ')}\``
        : '';
    const stateBadge = (mode === 'state' || include_state) ? ' (State Included)' : '';
    const fixedHeaderSample = `# 🔍 Unified Context Retrieval: "${rawQuery}"${stateBadge}\n` +
        `**Epistemic Status**: ${epistemicStatus} | **Tokens**: ~9999 / Budget: ${safeLimitTokens} | ` +
        `**Items Packed**: ${packed.packedCount} / ${items.length} candidates${unattestedBadge}\n\n`;

    let statusSection = '';
    if (storageError) {
        statusSection += `> ⚠️ **STORAGE WARNING**: SQLite retrieval encountered an error (\`${storageError.message}\`). Results may be incomplete.\n\n`;
    }
    if (epistemicStatus === 'NO_KNOWN_SUPPORT' && !isWildcard && !storageError) {
        statusSection += `> 🛑 **ABSTENTION (` + `NO_KNOWN_SUPPORT` + `)**: No grounded memory in project \`${targetProject}\` supports this query. Do not guess or fabricate unrecorded facts.\n\n`;
    } else if (epistemicStatus === 'CONFLICTED') {
        const conflictLines = conflicts.slice(0, 5).map(
            c => `- **Conflict between Memory #${c.older_id} and Memory #${c.newer_id}** (subject: \`${c.shared_subject.join(', ')}\`): ${c.resolution_hint}`
        ).join('\n');
        statusSection += `### ⚠️ Contradiction Resolution Alert (\`CONFLICTED\`)\n${conflictLines}\n\n`;
    }

    const getRemainingAuxTokens = () => safeLimitTokens - (
        packed.totalTokens +
        estimateTokens(stateHeader) +
        estimateTokens(statusSection) +
        estimateTokens(fixedHeaderSample) +
        4
    );

    let temporalUpdates = [];
    if (epistemicStatus === 'SUPPORTED' && !isWildcard && safeLimitTokens >= 1200) {
        if (!sequenceOrderMode) {
            temporalUpdates = detectTemporalUpdates(
                packed.packedItems,
                domainTerms.length > 0 ? domainTerms : queryTerms
            );
            if (temporalUpdates.length > 0) {
                const evoLines = temporalUpdates.slice(0, 3).map(
                    u => `- **#${u.older_id} → #${u.newer_id} (Latest)** [\`${u.shared_subject.join(', ')}\`]: Earlier *"${u.older_excerpt}"* → Updated *"${u.newer_excerpt}"*`
                ).join('\n');
                const evoBlock = `### 🔄 Chronological State Evolution (Earlier → Latest)\n${evoLines}\n\n`;
                if (estimateTokens(evoBlock) <= getRemainingAuxTokens()) {
                    statusSection += evoBlock;
                }
            }
        }

        const corpusUnattestedTerms = computeCorpusUnattestedTerms(
            distinctiveTerms,
            allCandidateRows,
            evaluatedNuggets
        );
        if (corpusUnattestedTerms.length > 0) {
            const groundingBlock = `> ℹ️ **Lexical Grounding Note**: Query term(s) \`${corpusUnattestedTerms.slice(0, 6).join(', ')}\` have zero exact or stemmed occurrences anywhere in this project's memory store. Verify whether the exact queried detail is explicitly attested in the turns below before asserting it as recorded fact.\n\n`;
            if (estimateTokens(groundingBlock) <= getRemainingAuxTokens()) {
                statusSection += groundingBlock;
            }
        }
    }

    const remainingTimelineTokens = getRemainingAuxTokens();

    let timelineSection = '';
    if (temporalMode && chronologicalEvents.length > 1 && remainingTimelineTokens >= 45) {
        // Select top-scoring events per session in round-robin fashion so all sessions are represented equally
        const bySess = new Map();
        for (const ev of chronologicalEvents) {
            const sKey = ev.sessionId || 1;
            if (!bySess.has(sKey)) bySess.set(sKey, []);
            bySess.get(sKey).push(ev);
        }
        for (const list of bySess.values()) {
            list.sort((a, b) => (b.score || 0) - (a.score || 0));
        }
        const sortedSessEntries = [...bySess.entries()].sort((a, b) => a[0] - b[0]);
        const sessLists = sortedSessEntries.map(e => e[1]);
        const selectedTimeline = [];
        for (let r = 0; r < 8 && selectedTimeline.length < 24; r++) {
            for (const list of sessLists) {
                if (r < list.length && selectedTimeline.length < 24) {
                    selectedTimeline.push(list[r]);
                }
            }
        }
        selectedTimeline.sort((a, b) => a.id - b.id);

        let macroSessionHeader = '';
        if (sortedSessEntries.length >= 2 && remainingTimelineTokens >= 320) {
            const sessionFocusLines = sortedSessEntries.map(([sKey, list]) => {
                // Prefer session-opening turns (sessionPos <= 2) with substantial implementation/feature content
                const openers = list.filter(ev => ev.sessionPos <= 2 && String(ev.content || '').length >= 320);
                const pool = openers.length > 0 ? openers : list;
                const rep = [...pool].sort((a, b) => (b.score + (b.sessionPos === 0 ? 0.04 : 0)) - (a.score + (a.sessionPos === 0 ? 0.04 : 0)))[0];
                const compactRep = formatCompactTimelineEntry(rep.content, 195);
                return `- **Session ${sKey} Primary Focus (#${rep.id})**${compactRep.metaBadge}: ${compactRep.summary}`;
            }).join('\n');
            macroSessionHeader = `#### 🧭 Session-by-Session Macro Progression\n${sessionFocusLines}\n\n`;
        }

        const lineMaxChars = remainingTimelineTokens < 320 ? 110 : 175;
        const orderedLines = selectedTimeline.map((ev, idx) => {
            const compactEv = formatCompactTimelineEntry(ev.content, lineMaxChars);
            return `${idx + 1}. **#${ev.id}** [${ev.status}]${compactEv.metaBadge}: ${compactEv.summary}`;
        });
        const candidateFull = `${macroSessionHeader}### 📅 Chronological Event Sequence (Oldest → Newest)\n${orderedLines.join('\n')}\n\n`;
        if (estimateTokens(candidateFull) <= remainingTimelineTokens) {
            timelineSection = candidateFull;
        } else {
            const keepMacro = (macroSessionHeader && estimateTokens(macroSessionHeader) <= Math.floor(remainingTimelineTokens * 0.48))
                ? macroSessionHeader
                : '';
            const seqHeader = `${keepMacro}### 📅 Chronological Event Sequence (Oldest → Newest)\n`;
            const fittedLines = [];
            for (const line of orderedLines) {
                const nextCandidate = `${seqHeader}${[...fittedLines, line].join('\n')}\n\n`;
                if (estimateTokens(nextCandidate) > remainingTimelineTokens) break;
                fittedLines.push(line);
            }
            if (fittedLines.length > 0) {
                timelineSection = `${seqHeader}${fittedLines.join('\n')}\n\n`;
            }
        }
    }

    const totalReportedTokens = packed.totalTokens
        + estimateTokens(stateHeader)
        + estimateTokens(statusSection)
        + estimateTokens(timelineSection)
        + estimateTokens(fixedHeaderSample);
    const orderedBodySection = (sequenceOrderMode && timelineSection)
        ? `${timelineSection}---\n\n${packed.contextText}`
        : `${packed.contextText}${timelineSection ? `\n---\n${timelineSection}` : ''}`;
    const retrievalBody = `# 🔍 Unified Context Retrieval: "${rawQuery}"${stateBadge}\n` +
        `**Epistemic Status**: ${epistemicStatus} | **Tokens**: ~${totalReportedTokens} / Budget: ${safeLimitTokens} | ` +
        `**Items Packed**: ${packed.packedCount} / ${items.length} candidates${unattestedBadge}\n\n` +
        statusSection +
        orderedBodySection;

    const fullPayload = (isPureDialogueTranscript && stateHeader)
        ? `${retrievalBody}\n---\n${stateHeader}`
        : `${stateHeader}${retrievalBody}`;

    return {
        content: [{ type: "text", text: fullPayload }],
        citations: packed.citations,
        epistemic_status: epistemicStatus,
        conflicts,
        temporal_updates: temporalUpdates,
        chronological_order: chronologicalEvents.map(e => e.id),
        unattested_query_terms: unattestedQueryTerms,
        ...(storageError ? { storage_error: storageError.message } : {})
    };
}

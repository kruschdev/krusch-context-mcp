/**
 * @module retrieval-bridge
 * Pillar 2 (v2.0): 2-Hop Multi-Session Bridge Expansion for krusch-context-mcp.
 * Combines disjoint-session SQLite FTS5 lexical bridge expansion (uncovered query facets +
 * high-IDF Hop-1 USER entity bridges) with damped Gram-Schmidt orthogonal residual vector
 * projection over pre-decoded 1024d Float32Array blobs (0 extra network calls).
 */

import { getParsedEmbedding, decodeEmbeddingBlob, cosineSimilarity, searchMemoryFts } from './sqlite-engine.js';
import { calibrateQuerySimilarity } from './embedding-helper.js';
import {
    STOP_WORDS,
    TEMPORAL_CUE_WORDS,
    GENERIC_INFRA_WORDS,
    META_QUERY_WORDS,
    stemToken,
    isSequenceOrderQuery,
    isSyntheticConstantVector
} from './retrieval-lexical.js';

const CONVERSATIONAL_FILLER_WORDS = new Set([
    'session', 'turn', 'date', 'user', 'assistant', 'thanks', 'thank',
    'sure', 'great', 'okay', 'really', 'very', 'just', 'know', 'think',
    'thought', 'going', 'thing', 'things', 'something', 'anything',
    'everything', 'nothing', 'someone', 'anyone', 'actually', 'basically',
    'probably', 'maybe', 'still', 'even', 'some', 'other', 'another',
    'same', 'here', 'while', 'because', 'though', 'although', 'however',
    'whether', 'either', 'neither', 'please', 'hello', 'yeah', 'awesome',
    'perfect', 'today', 'yesterday', 'tomorrow'
]);

const MULTI_SESSION_INTENT_REGEX = /\b(across|both|combined|total|together|compare|compared|difference\s+between|all\s+(?:the|my|our)|each\s+session|how\s+many)\b/i;

const BRIDGE_VECTOR_DIM = 1024;
const rowFeatureCache = new WeakMap();

function isValidBridgeVec1024(vec) {
    if (!vec || typeof vec.length !== 'number' || vec.length !== BRIDGE_VECTOR_DIM) return false;
    const first = vec[0];
    if (typeof first !== 'number' || !Number.isFinite(first)) return false;
    let allSame = true;
    for (let i = 1; i < BRIDGE_VECTOR_DIM; i++) {
        const val = vec[i];
        if (typeof val !== 'number' || !Number.isFinite(val)) return false;
        if (allSame && Math.abs(val - first) >= 1e-9) {
            allSame = false;
        }
    }
    return !allSame;
}

function resolveBridgeVector1024(rawVec) {
    if (!rawVec) return null;
    let vec = rawVec;
    if (
        rawVec instanceof Uint8Array ||
        rawVec instanceof ArrayBuffer ||
        (ArrayBuffer.isView(rawVec) && !(rawVec instanceof Float32Array) && !(rawVec instanceof Float64Array))
    ) {
        vec = decodeEmbeddingBlob(rawVec);
    } else if (typeof rawVec === 'string') {
        vec = getParsedEmbedding(rawVec, null);
    }
    if (!isValidBridgeVec1024(vec)) {
        return null;
    }
    return vec;
}

function getRankScore(item) {
    return Number(item?._unclampedScore ?? item?.rawScore ?? item?.score ?? 0);
}

function getBaseScore(item) {
    return Number(item?.rawScore ?? item?.score ?? 0);
}

/**
 * Resolves numeric session ID from precomputed `_sessionId`, bracketed `[Session N ...]` header, or `tags`.
 * @param {object} item
 * @returns {number|null}
 */
function resolveSessionId(item) {
    if (!item || typeof item !== 'object') return null;
    if (item._sessionId !== undefined && item._sessionId !== null) {
        const n = Number(item._sessionId);
        if (Number.isFinite(n)) return n;
    }
    const content = typeof item.content === 'string' ? item.content : '';
    if (content) {
        const headerMatch = content.match(/\[[^\]]*\bsession[\s_:-]+(\d+)\b/i);
        if (headerMatch) {
            const n = Number(headerMatch[1]);
            if (Number.isFinite(n)) return n;
        }
    }
    const tags = item.tags ? String(item.tags) : '';
    if (tags) {
        const tagMatch = tags.match(/\bsession[\s_:-]*(\d+)\b/i);
        if (tagMatch) {
            const n = Number(tagMatch[1]);
            if (Number.isFinite(n)) return n;
        }
    }
    return null;
}

/**
 * Extracts normalized USER clause text, stripping any leading `[Session ...]` metadata bracket
 * and any trailing `| ASSISTANT:` response segment.
 * @param {object} item
 * @returns {string}
 */
function extractUserClause(item) {
    if (!item || typeof item !== 'object') return '';
    if (typeof item._userRaw === 'string' && item._userRaw.length > 0) {
        const raw = item._userRaw.toLowerCase();
        const m = raw.match(/\buser:\s*([\s\S]*?)(?:\|\s*assistant:|$)/i);
        return (m ? m[1] : raw.replace(/^\[[^\]]*\]\s*/, '')).trim();
    }
    const lower = String(item.content || '').toLowerCase();
    const userMatch = lower.match(/\buser:\s*([\s\S]*?)(?:\|\s*assistant:|$)/i);
    if (userMatch) return userMatch[1].trim();
    return lower.replace(/^\[[^\]]*\]\s*/, '').trim();
}

/**
 * Lazily computes or reuses precomputed stem sets and lowercase text for a memory row or item.
 * @param {object} item
 * @returns {{ allStems: Set<string>, userStems: Set<string>, lowerCombined: string, sessionId: number|null }}
 */
function getItemFeatures(item) {
    if (!item || typeof item !== 'object') {
        return { allStems: new Set(), userStems: new Set(), lowerCombined: '', sessionId: null };
    }
    if (
        item._stems instanceof Set &&
        item._userStems instanceof Set &&
        typeof item._combinedText === 'string'
    ) {
        return {
            allStems: item._stems,
            userStems: item._userStems,
            lowerCombined: item._combinedText,
            sessionId: resolveSessionId(item)
        };
    }

    const cached = rowFeatureCache.get(item);
    if (cached) return cached;

    const lowerContent = typeof item._lowerContent === 'string'
        ? item._lowerContent
        : String(item.content || '').toLowerCase();
    const lowerTags = typeof item._lowerTags === 'string'
        ? item._lowerTags
        : (item.tags ? String(item.tags).toLowerCase() : '');
    const lowerLineage = typeof item._lineageText === 'string'
        ? item._lineageText.toLowerCase()
        : (typeof item.lineageText === 'string' ? item.lineageText.toLowerCase() : '');
    const lowerCombined = `${lowerContent} ${lowerTags} ${lowerLineage}`;

    const allStems = item._stems instanceof Set
        ? item._stems
        : new Set(lowerCombined.split(/[^a-z0-9_]+/).filter(w => w.length >= 2).map(stemToken));

    let userStems;
    if (item._userStems instanceof Set) {
        userStems = item._userStems;
    } else {
        const userClause = extractUserClause(item);
        userStems = new Set(userClause.split(/[^a-z0-9_]+/).filter(w => w.length >= 2).map(stemToken));
    }

    const feat = {
        allStems,
        userStems,
        lowerCombined,
        sessionId: resolveSessionId(item)
    };
    rowFeatureCache.set(item, feat);
    return feat;
}

function isFilteredBridgeWord(tok, stem) {
    return (
        STOP_WORDS.has(tok) ||
        STOP_WORDS.has(stem) ||
        TEMPORAL_CUE_WORDS.has(tok) ||
        TEMPORAL_CUE_WORDS.has(stem) ||
        GENERIC_INFRA_WORDS.has(tok) ||
        GENERIC_INFRA_WORDS.has(stem) ||
        META_QUERY_WORDS.has(tok) ||
        META_QUERY_WORDS.has(stem) ||
        CONVERSATIONAL_FILLER_WORDS.has(tok) ||
        CONVERSATIONAL_FILLER_WORDS.has(stem)
    );
}

function rowMatchesTerm(feat, rawTerm, stem) {
    if (!feat) return false;
    if (rawTerm && /[-.]/.test(rawTerm)) {
        return feat.lowerCombined.includes(rawTerm);
    }
    if (stem && /[-.]/.test(stem)) {
        return feat.lowerCombined.includes(stem);
    }
    return feat.allStems.has(stem) || (Boolean(rawTerm) && feat.lowerCombined.includes(rawTerm));
}

/**
 * Computes a damped Gram-Schmidt orthogonal residual bridge vector:
 *   r = hHat - beta * <hHat, qHat> * qHat
 * isolating semantic components present in top Hop-1 hits that were not already explained by queryVec.
 * Safely decodes Uint8Array/ArrayBuffer SQLite blobs via decodeEmbeddingBlob and enforces strict 1024d Float32Array output (INV-V2-07).
 *
 * @param {ArrayLike<number>|Uint8Array|ArrayBuffer|null} queryVec
 * @param {Array<ArrayLike<number>|Uint8Array|ArrayBuffer>} [hop1Vecs=[]]
 * @param {number} [beta=0.75]
 * @returns {Float32Array|null}
 */
export function computeResidualBridgeVector(queryVec, hop1Vecs = [], beta = 0.75) {
    const resolvedQ = resolveBridgeVector1024(queryVec);
    if (!resolvedQ) {
        return null;
    }
    if (!Array.isArray(hop1Vecs) || hop1Vecs.length === 0) {
        return null;
    }

    const dim = BRIDGE_VECTOR_DIM;
    let qNormSq = 0;
    for (let i = 0; i < dim; i++) {
        const v = resolvedQ[i];
        if (typeof v !== 'number' || !Number.isFinite(v)) return null;
        qNormSq += v * v;
    }
    if (!Number.isFinite(qNormSq) || qNormSq < 1e-12) return null;
    const invQNorm = 1 / Math.sqrt(qNormSq);

    const qHat = new Float64Array(dim);
    for (let i = 0; i < dim; i++) {
        qHat[i] = resolvedQ[i] * invQNorm;
    }

    const meanHop1 = new Float64Array(dim);
    let validCount = 0;
    for (const rawVec of hop1Vecs) {
        const vec = resolveBridgeVector1024(rawVec);
        if (!vec) continue;
        let vNormSq = 0;
        let finite = true;
        for (let i = 0; i < dim; i++) {
            const val = vec[i];
            if (typeof val !== 'number' || !Number.isFinite(val)) {
                finite = false;
                break;
            }
            vNormSq += val * val;
        }
        if (!finite || !Number.isFinite(vNormSq) || vNormSq < 1e-12) continue;

        for (let i = 0; i < dim; i++) {
            meanHop1[i] += vec[i];
        }
        validCount++;
    }

    if (validCount === 0) return null;

    const invCount = 1 / validCount;
    let hNormSq = 0;
    for (let i = 0; i < dim; i++) {
        meanHop1[i] *= invCount;
        hNormSq += meanHop1[i] * meanHop1[i];
    }
    if (!Number.isFinite(hNormSq) || hNormSq < 1e-12) return null;
    const invHNorm = 1 / Math.sqrt(hNormSq);

    const hHat = new Float64Array(dim);
    let dot = 0;
    for (let i = 0; i < dim; i++) {
        const hv = meanHop1[i] * invHNorm;
        hHat[i] = hv;
        dot += hv * qHat[i];
    }

    const safeBeta = Number.isFinite(beta) ? beta : 0.75;
    const projScale = safeBeta * dot;
    const residual = new Float64Array(dim);
    let rNormSq = 0;
    for (let i = 0; i < dim; i++) {
        const ri = hHat[i] - projScale * qHat[i];
        residual[i] = ri;
        rNormSq += ri * ri;
    }

    const norm = Math.sqrt(rNormSq);
    if (!Number.isFinite(norm) || norm < 1e-6) {
        return null;
    }

    const out = new Float32Array(dim);
    const invRNorm = 1 / norm;
    let f32NormSq = 0;
    for (let i = 0; i < dim; i++) {
        const v = residual[i] * invRNorm;
        out[i] = v;
        f32NormSq += out[i] * out[i];
    }
    const f32Norm = Math.sqrt(f32NormSq);
    if (!Number.isFinite(f32Norm) || f32Norm < 1e-6) {
        return null;
    }
    for (let i = 0; i < dim; i++) {
        out[i] = out[i] / f32Norm;
        if (!Number.isFinite(out[i])) return null;
    }

    return out;
}

/**
 * Extracts Hop-2 lexical bridge candidates from uncovered query facets and informative
 * high-IDF non-query entities found in the USER clauses of top-5 Hop-1 hits.
 *
 * @param {object} [params={}]
 * @param {string[]} [params.distinctiveTerms=[]]
 * @param {string[]} [params.distinctiveStems=[]]
 * @param {Array<object>} [params.hop1Items=[]]
 * @param {Array<object>} [params.allCandidateRows=[]]
 * @param {number} [params.maxBridgeTerms=6]
 * @returns {{ uncoveredTerms: string[], uncoveredStems: string[], entityBridgeTerms: string[], allBridgeTerms: string[] }}
 */
export function extractBridgeCandidates({
    distinctiveTerms = [],
    distinctiveStems = [],
    hop1Items = [],
    allCandidateRows = [],
    maxBridgeTerms = 6
} = {}) {
    const cap = Math.max(0, Number(maxBridgeTerms) || 0);
    if (cap === 0) {
        return { uncoveredTerms: [], uncoveredStems: [], entityBridgeTerms: [], allBridgeTerms: [] };
    }

    const topSeeds = (Array.isArray(hop1Items) ? hop1Items : [])
        .filter(it => it && getBaseScore(it) >= 0.52)
        .sort((a, b) => {
            const rDiff = getRankScore(b) - getRankScore(a);
            if (Math.abs(rDiff) > 1e-9) return rDiff;
            const bDiff = getBaseScore(b) - getBaseScore(a);
            if (Math.abs(bDiff) > 1e-9) return bDiff;
            return Number(b?.id || 0) - Number(a?.id || 0);
        })
        .slice(0, 5);

    const coveredStems = new Set();
    const seedFeatures = [];
    for (const seed of topSeeds) {
        const feat = getItemFeatures(seed);
        seedFeatures.push({ seed, feat });
        for (const st of feat.userStems) coveredStems.add(st);
        for (const st of feat.allStems) coveredStems.add(st);
    }

    const isSeedCovered = (normTerm, stem) => {
        if (coveredStems.has(stem) || (normTerm && coveredStems.has(normTerm))) return true;
        const probe = (normTerm && /[-.]/.test(normTerm)) ? normTerm : ((stem && /[-.]/.test(stem)) ? stem : null);
        if (probe) {
            return seedFeatures.some(({ feat }) => feat.lowerCombined.includes(probe));
        }
        return false;
    };

    const normDistinctiveTerms = [...new Set(
        (Array.isArray(distinctiveTerms) ? distinctiveTerms : [])
            .map(t => String(t || '').toLowerCase().trim())
            .filter(Boolean)
    )];
    const normDistinctiveStems = [...new Set(
        (Array.isArray(distinctiveStems) && distinctiveStems.length > 0
            ? distinctiveStems.map(s => String(s || '').toLowerCase().trim())
            : normDistinctiveTerms.map(stemToken)
        ).filter(Boolean)
    )];

    const uncoveredTerms = normDistinctiveTerms.filter(t => !isSeedCovered(t, stemToken(t)));
    const uncoveredStems = normDistinctiveStems.filter(st => !isSeedCovered(st, st));
    if (uncoveredTerms.length === 0 && uncoveredStems.length > 0) {
        uncoveredTerms.push(...uncoveredStems);
    }

    const queryTokenSet = new Set(normDistinctiveTerms);
    const queryStemSet = new Set([
        ...normDistinctiveStems,
        ...normDistinctiveTerms.map(stemToken)
    ]);

    // Scan USER clauses of top-5 Hop-1 items for informative non-query entity tokens
    const candidateByStem = new Map();
    for (const { seed } of seedFeatures) {
        const userClause = extractUserClause(seed);
        if (!userClause) continue;
        const rawTokens = userClause
            .split(/[^a-z0-9_-]+/)
            .map(t => t.replace(/^[-_]+|[-_]+$/g, ''))
            .filter(Boolean);

        const seenStemsInSeed = new Set();
        for (const tok of rawTokens) {
            if (tok.length < 4) continue;
            if (/^\d+$/.test(tok) || !/[a-z]/.test(tok)) continue;
            const st = stemToken(tok);
            if (!st || st.length < 3) continue;
            if (queryTokenSet.has(tok) || queryStemSet.has(st)) continue;
            if (isFilteredBridgeWord(tok, st)) continue;
            if (seenStemsInSeed.has(st)) continue;
            seenStemsInSeed.add(st);

            const existing = candidateByStem.get(st);
            if (!existing) {
                candidateByStem.set(st, { term: tok, stem: st, seedCount: 1 });
            } else {
                existing.seedCount += 1;
                if (/[0-9_-]/.test(tok) && !/[0-9_-]/.test(existing.term)) {
                    existing.term = tok;
                }
            }
        }
    }

    const corpusRows = (Array.isArray(allCandidateRows) && allCandidateRows.length > 0)
        ? allCandidateRows
        : topSeeds;
    const corpusN = Math.max(1, corpusRows.length);
    const maxAllowedDf = Math.max(4, Math.floor(corpusN * 0.15));

    const rankedEntities = [];
    for (const cand of candidateByStem.values()) {
        const { term, stem, seedCount } = cand;
        let df = 0;
        for (let i = 0; i < corpusRows.length; i++) {
            const feat = getItemFeatures(corpusRows[i]);
            if (rowMatchesTerm(feat, term, stem)) {
                df++;
                if (df > maxAllowedDf) break;
            }
        }
        if (df > maxAllowedDf) continue;

        const passesSingleSeedGate =
            seedCount === 1 && (df >= 2 || /[0-9_-]/.test(term) || term.length >= 6);
        if (seedCount < 2 && !passesSingleSeedGate) continue;

        const weight = (seedCount + 0.5) * Math.log(1 + corpusN / (1 + df));
        rankedEntities.push({ term, stem, seedCount, df, weight });
    }

    rankedEntities.sort((a, b) => {
        if (Math.abs(b.weight - a.weight) > 1e-9) return b.weight - a.weight;
        if (b.seedCount !== a.seedCount) return b.seedCount - a.seedCount;
        if (b.term.length !== a.term.length) return b.term.length - a.term.length;
        return a.term.localeCompare(b.term);
    });

    const entityBridgeTerms = rankedEntities.slice(0, cap).map(e => e.term);
    const allBridgeTerms = [...new Set([...uncoveredTerms, ...entityBridgeTerms])].slice(0, cap);

    return {
        uncoveredTerms,
        uncoveredStems,
        entityBridgeTerms,
        allBridgeTerms
    };
}

/**
 * Executes gated 2-hop multi-session bridge retrieval over SQLite FTS5 + pre-decoded Float32Array
 * residual vectors (`0` extra network calls), rescuing deep cross-session turns and boosting
 * grounded Hop-2 matches.
 *
 * @param {object} db - Synchronous node:sqlite DatabaseSync handle
 * @param {object} [options={}]
 * @returns {{
 *   ok: boolean,
 *   triggered: boolean,
 *   bridgeTerms: string[],
 *   uncoveredStems: string[],
 *   residualVector: Float32Array|null,
 *   rescuedRows: Array<object>,
 *   bridgeBoostById: Map<number, { bonus: number, bridgeScore: number, matchedBridgeStems: string[] }>
 * }}
 */
export function expandMultiHopBridges(db, options = {}) {
    const {
        rawQuery = '',
        queryEmbedding = null,
        hasRealQueryEmbedding = false,
        distinctiveTerms = [],
        distinctiveStems = [],
        hop1Items = [],
        candidateMap = new Map(),
        allCandidateRows = [],
        normCategory = null,
        selectCols = 'id, category, content, tags, status, supersedes_id, superseded_by, invalidated_reason, created_at, updated_at, embedding, embedding_blob'
    } = options || {};

    const makeNonTriggered = () => ({
        ok: true,
        triggered: false,
        bridgeTerms: [],
        uncoveredStems: [],
        residualVector: null,
        rescuedRows: [],
        bridgeBoostById: new Map()
    });

    // Gate 1: Store size, real query embedding, and sequence-order guard
    if (
        !db ||
        !Array.isArray(allCandidateRows) ||
        allCandidateRows.length < 40 ||
        hasRealQueryEmbedding !== true ||
        isSequenceOrderQuery(rawQuery) ||
        !Array.isArray(hop1Items) ||
        hop1Items.length === 0
    ) {
        return makeNonTriggered();
    }

    // Gate 2: Top Hop-1 item must have (rawScore ?? score) >= 0.56 (prevents hopping on Abstention queries)
    const sortedHop1 = [...hop1Items].sort((a, b) => {
        const rDiff = getRankScore(b) - getRankScore(a);
        if (Math.abs(rDiff) > 1e-9) return rDiff;
        const bDiff = getBaseScore(b) - getBaseScore(a);
        if (Math.abs(bDiff) > 1e-9) return bDiff;
        return Number(b?.id || 0) - Number(a?.id || 0);
    });

    if (!sortedHop1[0] || getBaseScore(sortedHop1[0]) < 0.56) {
        return makeNonTriggered();
    }

    // Gate 3: Extract lexical bridge candidates
    const {
        uncoveredTerms,
        uncoveredStems,
        entityBridgeTerms,
        allBridgeTerms
    } = extractBridgeCandidates({
        distinctiveTerms,
        distinctiveStems,
        hop1Items: sortedHop1,
        allCandidateRows,
        maxBridgeTerms: 6
    });

    if (allBridgeTerms.length === 0) {
        return makeNonTriggered();
    }

    // Gate 4: Verify multi-session bridge need (count sessions across confident Hop-1 hits >= 0.50)
    const confidentHop1 = sortedHop1.filter(it => getBaseScore(it) >= 0.50);
    const hasMultiSessionIntent = MULTI_SESSION_INTENT_REGEX.test(String(rawQuery || ''));
    const hop1Sessions = new Set();
    for (const it of confidentHop1.slice(0, 6)) {
        const sid = resolveSessionId(it);
        if (sid !== null) hop1Sessions.add(sid);
    }
    const storeSessions = new Set();
    for (let i = 0; i < allCandidateRows.length; i++) {
        const sid = resolveSessionId(allCandidateRows[i]);
        if (sid !== null) storeSessions.add(sid);
    }

    const shouldTrigger =
        uncoveredStems.length >= 1 ||
        hasMultiSessionIntent ||
        (storeSessions.size >= 5 && hop1Sessions.size <= 2 && entityBridgeTerms.length >= 2);

    if (!shouldTrigger) {
        return makeNonTriggered();
    }

    // Hop-2 Step 1: Decode query & top-3 confident Hop-1 embeddings and compute Gram-Schmidt residual
    const resolvedQueryVec = resolveBridgeVector1024(queryEmbedding);
    if (!resolvedQueryVec) {
        return makeNonTriggered();
    }

    const hop1Vecs = [];
    for (const it of confidentHop1.filter(x => getBaseScore(x) >= 0.52).slice(0, 3)) {
        const srcRow = (candidateMap instanceof Map ? candidateMap.get(Number(it.id)) : null) || it;
        const vec = getParsedEmbedding(srcRow?.embedding, srcRow?.embedding_blob);
        if (isValidBridgeVec1024(vec)) {
            hop1Vecs.push(vec);
        }
    }
    const residualVector = computeResidualBridgeVector(resolvedQueryVec, hop1Vecs, 0.75);

    // Hop-2 Step 2: Identify dominant Hop-1 session (unique plurality / majority across top-5 confident hits) and excluded top-8 Hop-1 IDs
    const top5SessionCounts = new Map();
    for (const it of confidentHop1.slice(0, 5)) {
        const sid = resolveSessionId(it);
        if (sid !== null) {
            top5SessionCounts.set(sid, (top5SessionCounts.get(sid) || 0) + 1);
        }
    }
    let dominantSessionId = null;
    if (top5SessionCounts.size > 0) {
        const rankedSessions = [...top5SessionCounts.entries()].sort((a, b) => b[1] - a[1]);
        const [topSid, topCount] = rankedSessions[0];
        const secondCount = rankedSessions[1]?.[1] ?? 0;
        if (topCount > secondCount) {
            dominantSessionId = topSid;
        }
    }

    const excludedHop1Ids = new Set(
        sortedHop1
            .slice(0, 8)
            .filter(it => getBaseScore(it) >= 0.52)
            .map(it => Number(it.id))
    );

    const uncoveredPairs = [];
    const seenUncoveredStems = new Set();
    for (const term of uncoveredTerms) {
        const st = stemToken(term);
        if (st && !seenUncoveredStems.has(st)) {
            seenUncoveredStems.add(st);
            uncoveredPairs.push({ term, stem: st });
        }
    }
    for (const st of uncoveredStems) {
        if (st && !seenUncoveredStems.has(st)) {
            seenUncoveredStems.add(st);
            uncoveredPairs.push({ term: st, stem: st });
        }
    }

    const entityPairs = [];
    const seenEntityStems = new Set();
    for (const term of entityBridgeTerms) {
        const st = stemToken(term);
        if (st && !seenEntityStems.has(st) && !seenUncoveredStems.has(st)) {
            seenEntityStems.add(st);
            entityPairs.push({ term, stem: st });
        }
    }

    // Hop-2 Step 3: Query SQLite via FTS5 (active rows only) + scan disjoint-session rows in allCandidateRows
    const hop2Pool = new Map();
    const ftsRows = searchMemoryFts(db, allBridgeTerms, {
        includeSuperseded: false,
        includeAllActive: true,
        category: normCategory,
        selectCols,
        limit: 80
    });

    if (Array.isArray(ftsRows)) {
        for (const ftsRow of ftsRows) {
            const numId = Number(ftsRow?.id);
            if (!Number.isFinite(numId) || excludedHop1Ids.has(numId)) continue;
            const mergedRow = (candidateMap instanceof Map ? candidateMap.get(numId) : null) || ftsRow;
            const rowSessionId = getItemFeatures(mergedRow).sessionId;
            if (dominantSessionId !== null && rowSessionId === dominantSessionId) continue;
            hop2Pool.set(numId, mergedRow);
        }
    } else if (ftsRows === null && allBridgeTerms.length > 0) {
        // Graceful LIKE fallback when SQLite runtime lacks FTS5 support
        try {
            const likeClauses = [];
            const likeParams = [];
            for (const term of allBridgeTerms.slice(0, 8)) {
                const escaped = stemToken(term).replace(/[\\%_]/g, '\\$&');
                if (!escaped) continue;
                const pat = `%${escaped}%`;
                likeClauses.push(`(LOWER(content) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(tags, '')) LIKE ? ESCAPE '\\')`);
                likeParams.push(pat, pat);
            }
            if (likeClauses.length > 0) {
                let sql = `SELECT ${selectCols} FROM ide_agent_memory WHERE status = 'ACTIVE'`;
                const sqlParams = [];
                if (normCategory) {
                    sql += ` AND category = ?`;
                    sqlParams.push(normCategory);
                }
                sql += ` AND (${likeClauses.join(' OR ')}) ORDER BY id DESC LIMIT 80`;
                sqlParams.push(...likeParams);
                for (const fallbackRow of db.prepare(sql).all(...sqlParams)) {
                    const numId = Number(fallbackRow?.id);
                    if (!Number.isFinite(numId) || excludedHop1Ids.has(numId)) continue;
                    const mergedRow = (candidateMap instanceof Map ? candidateMap.get(numId) : null) || fallbackRow;
                    const rowSessionId = getItemFeatures(mergedRow).sessionId;
                    if (dominantSessionId !== null && rowSessionId === dominantSessionId) continue;
                    hop2Pool.set(numId, mergedRow);
                }
            }
        } catch {}
    }

    const allBridgePairs = [...uncoveredPairs, ...entityPairs];
    for (let i = 0; i < allCandidateRows.length; i++) {
        const row = allCandidateRows[i];
        const numId = Number(row?.id);
        if (!Number.isFinite(numId) || excludedHop1Ids.has(numId) || hop2Pool.has(numId)) continue;
        if (row.status && row.status !== 'ACTIVE') continue;

        const feat = getItemFeatures(row);
        if (dominantSessionId !== null && feat.sessionId === dominantSessionId) {
            continue;
        }
        if (allBridgePairs.some(p => rowMatchesTerm(feat, p.term, p.stem))) {
            hop2Pool.set(numId, row);
        }
    }

    // Hop-2 Step 4: Score each disjoint Hop-2 candidate row
    const scoredHop2 = [];
    for (const [numId, row] of hop2Pool.entries()) {
        if (row.status && row.status !== 'ACTIVE') continue;
        const feat = getItemFeatures(row);
        const rowSessionId = feat.sessionId;

        if (dominantSessionId !== null && rowSessionId === dominantSessionId) {
            continue;
        }

        const matchedUncovered = uncoveredPairs
            .filter(p => rowMatchesTerm(feat, p.term, p.stem))
            .map(p => p.stem);

        const matchedEntity = entityPairs
            .filter(p => rowMatchesTerm(feat, p.term, p.stem))
            .map(p => p.stem);

        if (matchedUncovered.length === 0 && matchedEntity.length === 0) {
            continue;
        }

        const rawVec = getParsedEmbedding(row.embedding, row.embedding_blob);
        const rowVec = isValidBridgeVec1024(rawVec) ? rawVec : null;

        const rawResidualSim = (residualVector && rowVec)
            ? calibrateQuerySimilarity(cosineSimilarity(residualVector, rowVec), { queryVec: residualVector })
            : 0;
        const rawDirectSim = (resolvedQueryVec && rowVec)
            ? calibrateQuerySimilarity(cosineSimilarity(resolvedQueryVec, rowVec), { queryVec: resolvedQueryVec })
            : 0;
        const residualSim = Number.isFinite(rawResidualSim) ? rawResidualSim : 0;
        const directSim = Number.isFinite(rawDirectSim) ? rawDirectSim : 0;
        const bestSim = Math.max(residualSim, directSim);

        // Grounding requirement (spec.md §4.2): >= 1 uncovered stem match OR (>= 1 bridge stem match AND calibrated residual similarity >= 0.58)
        const isGrounded =
            matchedUncovered.length >= 1 ||
            (matchedEntity.length >= 1 && Boolean(residualVector) && residualSim >= 0.58);
        if (!isGrounded) continue;

        const bridgeScore = Math.min(
            0.88,
            0.44 * bestSim +
            0.36 * Math.min(1, (matchedUncovered.length * 1.5 + matchedEntity.length * 0.8) / 2) +
            0.16
        );
        const bonus = Number(
            Math.min(0.18, 0.08 + matchedUncovered.length * 0.05 + matchedEntity.length * 0.03).toFixed(10)
        );
        const matchedBridgeStems = [...new Set([...matchedUncovered, ...matchedEntity])];

        scoredHop2.push({
            id: numId,
            row,
            rowSessionId,
            bridgeScore,
            bonus,
            bestSim,
            uncoveredCount: matchedUncovered.length,
            matchedBridgeStems
        });
    }

    scoredHop2.sort((a, b) => {
        if (Math.abs(b.bridgeScore - a.bridgeScore) > 1e-9) return b.bridgeScore - a.bridgeScore;
        if (b.uncoveredCount !== a.uncoveredCount) return b.uncoveredCount - a.uncoveredCount;
        const aDisjoint = dominantSessionId !== null && a.rowSessionId !== dominantSessionId ? 1 : 0;
        const bDisjoint = dominantSessionId !== null && b.rowSessionId !== dominantSessionId ? 1 : 0;
        if (bDisjoint !== aDisjoint) return bDisjoint - aDisjoint;
        if (Math.abs(b.bestSim - a.bestSim) > 1e-9) return b.bestSim - a.bestSim;
        return b.id - a.id;
    });

    const topHop2 = scoredHop2.slice(0, 12);
    const rescuedRows = [];
    const bridgeBoostById = new Map();

    for (const hit of topHop2) {
        if (!(candidateMap instanceof Map) || !candidateMap.has(hit.id)) {
            rescuedRows.push(hit.row);
        }
        bridgeBoostById.set(hit.id, {
            bonus: hit.bonus,
            bridgeScore: hit.bridgeScore,
            matchedBridgeStems: hit.matchedBridgeStems
        });
    }

    return {
        ok: true,
        triggered: true,
        bridgeTerms: allBridgeTerms,
        uncoveredStems,
        residualVector,
        rescuedRows,
        bridgeBoostById
    };
}

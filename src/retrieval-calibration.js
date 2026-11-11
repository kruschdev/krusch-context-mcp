/**
 * @module retrieval-calibration
 * Pillar 4 (INV-V2-09): Zero-LLM Calibrated Multi-Arm Feature Fusion & Adaptive Relational Graph Probing.
 *
 * Grounded in:
 *   1. FERN ("Cross-Benchmark Retrieval with Frozen Retrievers and Learned Ranking", arXiv:2611.14477):
 *      Replaces uncalibrated raw-scale max/linear score saturation with within-query distributional
 *      z-score normalization, 4-arm Reciprocal Rank Agreement (Dense Vector, User-IDF, Full-IDF,
 *      and Minimum-Window Span Tightness), and cross-arm concordance while strictly preserving
 *      epistemic abstention thresholds (INV-V2-09A).
 *   2. SkinMind ("Agentic RAG with Human-Inspired Graph Probing", arXiv:2611.08935):
 *      Performs uncertainty-gated, multi-granularity relational graph probing across typed memory
 *      edges (provenance file anchors, INV-* rule codes, explicit #<id> cross-references, lineage
 *      links, and high-IDF structured tags) in pure CPU + SQLite (0 LLM calls, 0 network RPCs).
 */

import {
    getParsedEmbedding,
    cosineSimilarity,
    searchMemoryFts
} from './sqlite-engine.js';
import { calibrateQuerySimilarity } from './embedding-helper.js';
import {
    STOP_WORDS,
    GENERIC_INFRA_WORDS,
    META_QUERY_WORDS,
    stemToken,
    isSequenceOrderQuery
} from './retrieval-lexical.js';
import { computeResidualBridgeVector } from './retrieval-bridge.js';

const RRF_K = 60;
const MIN_STD_FLOOR = 0.04;
const EPISTEMIC_SAFE_FLOOR = 0.46;

const INLINE_FILE_PATH_RE =
    /(?:^|[\s`"'(\[])((?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.(?:m?js|cjs|tsx?|jsx?|py|sql|ya?ml|toml|rs|go|sh))(?=$|[\s`"')\].,:;!?#])/g;

const INVARIANT_CODE_RE =
    /\b((?:INV-[A-Z0-9]+(?:-[A-Z0-9.]+)*)|(?:CTX-\d{1,4})|(?:GH-EVO-\d{1,4})|(?:SEC-\d{1,4})|(?:ARCH-\d{1,4}))\b/g;

const EXPLICIT_MEMORY_ID_RE =
    /(?:\bMemory\s*#(\d{1,7})\b)|(?:(?:^|[\s(\[,])#(\d{1,7})(?!\s*\/\s*\d+)\b)/gi;

const GENERIC_TAG_RE = /^(?:session[\s_:-]*\d+|turn[\s_:-]*\d+|general|note|notes|default|misc|memory)$/i;

const relationalAnchorCache = new WeakMap();
const provenanceColumnSupportCache = new WeakMap();

/**
 * Checks once per SQLite handle whether `ide_agent_memory` exposes a `provenance` column.
 *
 * @param {object} db
 * @returns {boolean}
 */
export function hasProvenanceColumn(db) {
    if (!db || typeof db.prepare !== 'function') return false;
    if (provenanceColumnSupportCache.has(db)) {
        return provenanceColumnSupportCache.get(db);
    }
    let supported = false;
    try {
        const cols = db.prepare(`PRAGMA table_info(ide_agent_memory)`).all();
        supported = Array.isArray(cols) && cols.some(c => String(c?.name || '').toLowerCase() === 'provenance');
    } catch {
        supported = false;
    }
    provenanceColumnSupportCache.set(db, supported);
    return supported;
}

/**
 * Computes O(L) minimum-window token-span proximity for query stems inside `textLower`
 * (and optionally `userTextLower` for dialogue/structured clauses).
 *
 * @param {string} [textLower='']
 * @param {string[]} [queryStems=[]]
 * @param {string} [userTextLower='']
 * @returns {{
 *   matchedStemCount: number,
 *   coverageRatio: number,
 *   minWindowTokens: number,
 *   spanTightness: number
 * }}
 */
export function computeSpanProximityFeatures(textLower = '', queryStems = [], userTextLower = '') {
    const uniqueStems = [...new Set(
        (Array.isArray(queryStems) ? queryStems : [])
            .map(s => String(s || '').toLowerCase().trim())
            .filter(s => s.length >= 2)
    )];
    if (uniqueStems.length === 0 || (!textLower && !userTextLower)) {
        return {
            matchedStemCount: 0,
            coverageRatio: 0,
            minWindowTokens: Infinity,
            spanTightness: 0
        };
    }

    const stemSet = new Set(uniqueStems);

    const scoreSingleText = (rawText) => {
        if (!rawText || typeof rawText !== 'string') {
            return { matchedStemCount: 0, coverageRatio: 0, minWindowTokens: Infinity, spanTightness: 0 };
        }
        const bounded = rawText.length <= 6000 ? rawText : rawText.slice(0, 6000);
        const rawTokens = bounded.split(/[^a-z0-9_]+/).filter(w => w.length >= 2);
        if (rawTokens.length === 0) {
            return { matchedStemCount: 0, coverageRatio: 0, minWindowTokens: Infinity, spanTightness: 0 };
        }

        /** @type {Array<{ pos: number, stem: string }>} */
        const hits = [];
        const allMatched = new Set();
        for (let idx = 0; idx < rawTokens.length; idx++) {
            const st = stemToken(rawTokens[idx]);
            if (stemSet.has(st)) {
                hits.push({ pos: idx, stem: st });
                allMatched.add(st);
            }
        }

        const matchedStemCount = allMatched.size;
        if (matchedStemCount === 0) {
            return { matchedStemCount: 0, coverageRatio: 0, minWindowTokens: Infinity, spanTightness: 0 };
        }

        const coverageRatio = matchedStemCount / uniqueStems.length;
        if (matchedStemCount === 1) {
            const singleTightness = uniqueStems.length === 1 ? 0.85 : coverageRatio * 0.45;
            return {
                matchedStemCount: 1,
                coverageRatio,
                minWindowTokens: 1,
                spanTightness: singleTightness
            };
        }

        // Two-pointer O(H) minimum token window covering all `matchedStemCount` distinct query stems
        const counts = new Map();
        let distinctInWindow = 0;
        let left = 0;
        let minWindowTokens = Infinity;

        for (let right = 0; right < hits.length; right++) {
            const rStem = hits[right].stem;
            const prev = counts.get(rStem) || 0;
            if (prev === 0) distinctInWindow++;
            counts.set(rStem, prev + 1);

            while (distinctInWindow === matchedStemCount && left <= right) {
                const spanTokens = hits[right].pos - hits[left].pos + 1;
                if (spanTokens < minWindowTokens) {
                    minWindowTokens = spanTokens;
                }
                const lStem = hits[left].stem;
                const nextCnt = (counts.get(lStem) || 1) - 1;
                if (nextCnt === 0) {
                    counts.delete(lStem);
                    distinctInWindow--;
                } else {
                    counts.set(lStem, nextCnt);
                }
                left++;
            }
        }

        const excessSlack = Math.max(0, minWindowTokens - matchedStemCount);
        const windowTightness = coverageRatio / (1 + 0.16 * excessSlack);
        const docFocus = coverageRatio * Math.min(1, (matchedStemCount * 2.2) / Math.max(4, rawTokens.length));
        const spanTightness = Math.min(1, 0.82 * windowTightness + 0.18 * docFocus);
        return {
            matchedStemCount,
            coverageRatio,
            minWindowTokens,
            spanTightness
        };
    };

    const fullFeat = scoreSingleText(textLower);
    if (!userTextLower) {
        return fullFeat;
    }
    const userFeat = scoreSingleText(userTextLower);
    if (userFeat.spanTightness >= fullFeat.spanTightness) {
        return userFeat;
    }
    return {
        matchedStemCount: Math.max(fullFeat.matchedStemCount, userFeat.matchedStemCount),
        coverageRatio: Math.max(fullFeat.coverageRatio, userFeat.coverageRatio),
        minWindowTokens: Math.min(fullFeat.minWindowTokens, userFeat.minWindowTokens),
        spanTightness: 0.62 * userFeat.spanTightness + 0.38 * fullFeat.spanTightness
    };
}

function normalizeModuleAnchor(rawPath) {
    const clean = String(rawPath || '')
        .trim()
        .replace(/^file:\/\//i, '')
        .replace(/^\.?\//, '')
        .replace(/#L\d+(?:-L?\d+)?$/i, '')
        .toLowerCase();
    if (!clean || clean.length < 4) return [];
    const parts = clean.split('/').filter(Boolean);
    if (parts.length === 0) return [];
    const base = parts[parts.length - 1];
    // Ignore overly generic filenames when bare, unless qualified by parent dir
    const isGenericBase = /^(?:index|main|app|server|utils|helpers|config|types|schema|readme|spec|test)\.[a-z0-9]+$/i.test(base);
    const anchors = [];
    if (parts.length >= 2) {
        anchors.push(`${parts[parts.length - 2]}/${base}`);
    }
    if (!isGenericBase) {
        anchors.push(base);
    }
    return [...new Set(anchors)];
}

/**
 * Extracts typed relational graph anchors (`provenanceFiles`, `invariantCodes`,
 * `explicitMemoryIds`, `structuredTags`) from a memory row or scored item.
 *
 * @param {object} row
 * @returns {{
 *   provenanceFiles: string[],
 *   invariantCodes: string[],
 *   explicitMemoryIds: number[],
 *   structuredTags: string[]
 * }}
 */
export function extractRelationalGraphAnchors(row) {
    if (!row || typeof row !== 'object') {
        return { provenanceFiles: [], invariantCodes: [], explicitMemoryIds: [], structuredTags: [] };
    }
    const cached = relationalAnchorCache.get(row);
    if (cached) return cached;

    const rawContent = String(row.content || '');
    const selfId = Number(row.id);
    const fileSet = new Set();
    const invSet = new Set();
    const idSet = new Set();
    const tagSet = new Set();

    // 1. Provenance JSON anchor
    if (row.provenance) {
        try {
            const prov = typeof row.provenance === 'string' ? JSON.parse(row.provenance) : row.provenance;
            if (prov && typeof prov.file === 'string') {
                for (const anchor of normalizeModuleAnchor(prov.file)) {
                    fileSet.add(anchor);
                }
            }
        } catch {
            // Ignore malformed provenance JSON
        }
    }

    // 2. Inline file/module paths in content
    if (rawContent) {
        INLINE_FILE_PATH_RE.lastIndex = 0;
        let fm;
        while ((fm = INLINE_FILE_PATH_RE.exec(rawContent)) !== null) {
            for (const anchor of normalizeModuleAnchor(fm[1])) {
                fileSet.add(anchor);
            }
        }

        // 3. Invariant / rule identifiers (case-sensitive uppercase codes)
        INVARIANT_CODE_RE.lastIndex = 0;
        let im;
        while ((im = INVARIANT_CODE_RE.exec(rawContent)) !== null) {
            invSet.add(im[1].toUpperCase());
        }

        // 4. Explicit cross-memory `#<id>` / `Memory #<id>` citations
        EXPLICIT_MEMORY_ID_RE.lastIndex = 0;
        let mm;
        while ((mm = EXPLICIT_MEMORY_ID_RE.exec(rawContent)) !== null) {
            const refId = Number(mm[1] || mm[2]);
            if (Number.isFinite(refId) && refId > 0 && refId !== selfId) {
                idSet.add(refId);
            }
        }
    }

    // Direct lineage pointers
    for (const linId of [row.supersedes_id, row.superseded_by]) {
        const n = Number(linId);
        if (Number.isFinite(n) && n > 0 && n !== selfId) {
            idSet.add(n);
        }
    }

    // 5. Structured tags
    if (row.tags) {
        const rawTags = String(row.tags).trim();
        let parsedTags = [];
        if (rawTags.startsWith('[')) {
            try {
                const arr = JSON.parse(rawTags);
                if (Array.isArray(arr)) parsedTags = arr.map(x => String(x || ''));
            } catch {
                parsedTags = rawTags.split(/[,;|]+/);
            }
        } else {
            parsedTags = rawTags.split(/[,;|]+/);
        }
        for (const rawT of parsedTags) {
            const cleanT = rawT.trim().toLowerCase().replace(/^["']+|["']+$/g, '');
            if (
                cleanT.length >= 3 &&
                cleanT.length <= 48 &&
                !GENERIC_TAG_RE.test(cleanT) &&
                !STOP_WORDS.has(cleanT) &&
                !GENERIC_INFRA_WORDS.has(cleanT) &&
                !META_QUERY_WORDS.has(cleanT)
            ) {
                tagSet.add(cleanT);
            }
        }
    }

    const result = {
        provenanceFiles: [...fileSet],
        invariantCodes: [...invSet],
        explicitMemoryIds: [...idSet],
        structuredTags: [...tagSet]
    };
    relationalAnchorCache.set(row, result);
    return result;
}

function computeMeanAndStd(values) {
    if (!Array.isArray(values) || values.length === 0) {
        return { mean: 0, std: MIN_STD_FLOOR };
    }
    let sum = 0;
    for (let i = 0; i < values.length; i++) sum += values[i];
    const mean = sum / values.length;
    let sq = 0;
    for (let i = 0; i < values.length; i++) {
        const d = values[i] - mean;
        sq += d * d;
    }
    const std = Math.max(MIN_STD_FLOOR, Math.sqrt(sq / values.length));
    return { mean, std };
}

function buildPositiveArmRanks(items, getter) {
    const valid = [];
    for (let i = 0; i < items.length; i++) {
        const v = Number(getter(items[i]) || 0);
        if (Number.isFinite(v) && v > 1e-6) {
            valid.push({ idx: i, val: v, id: Number(items[i]?.id || 0) });
        }
    }
    valid.sort((a, b) => {
        const diff = b.val - a.val;
        if (Math.abs(diff) > 1e-9) return diff;
        return b.id - a.id;
    });
    const ranks = new Map();
    for (let r = 0; r < valid.length; r++) {
        ranks.set(valid[r].idx, r + 1);
    }
    return ranks;
}

/**
 * Applies Zero-LLM Calibrated Multi-Arm Feature Fusion (FERN, arXiv:2611.14477) across scored
 * memory candidates. Normalizes incompatible per-query cosine and lexical distributions via
 * bounded z-scores, 4-arm RRF consensus, and minimum-window span proximity while strictly
 * preserving epistemic abstention floors (`INV-V2-09A`).
 *
 * @param {Array<object>} [candidates=[]]
 * @param {object} [options={}]
 * @param {string[]} [options.evalStems=[]]
 * @param {string[]} [options.distinctiveStems=[]]
 * @param {boolean} [options.hasRealQueryEmbedding=false]
 * @param {boolean} [options.knowledgeUpdateMode=false]
 * @param {boolean} [options.isBroadQuery=false]
 * @returns {{
 *   calibratedCount: number,
 *   activeArms: number,
 *   topFernScore: number
 * }}
 */
export function calibrateMultiArmFusion(candidates = [], options = {}) {
    if (!Array.isArray(candidates) || candidates.length < 2) {
        return { calibratedCount: 0, activeArms: 0, topFernScore: 0 };
    }

    const {
        evalStems = [],
        distinctiveStems = [],
        hasRealQueryEmbedding = false,
        knowledgeUpdateMode = false,
        isBroadQuery = false
    } = options;

    const queryStems = distinctiveStems.length > 0 ? distinctiveStems : evalStems;

    // 1. Extract per-candidate multi-arm feature vector
    const features = candidates.map((item) => {
        const rawSem = hasRealQueryEmbedding
            ? Number(item.rawSemanticScore ?? item.semanticScore ?? 0)
            : 0;
        const calSem = hasRealQueryEmbedding
            ? Number(item.semanticScore ?? 0)
            : 0;
        const userOverlap = Number(item.userOverlap ?? 0);
        const idfOverlap = Number(item.idfOverlap ?? 0);

        const lowerContent = typeof item._lowerContent === 'string'
            ? item._lowerContent
            : String(item.content || '').toLowerCase();
        const userRaw = typeof item._userRaw === 'string' ? item._userRaw : '';

        const span = computeSpanProximityFeatures(lowerContent, queryStems, userRaw);
        item._spanTightness = span.spanTightness;
        item._minSpanTokens = span.minWindowTokens;

        let distHits = 0;
        if (distinctiveStems.length > 0) {
            const stems = item._stems instanceof Set ? item._stems : null;
            for (const ds of distinctiveStems) {
                if ((stems && stems.has(ds)) || lowerContent.includes(ds)) {
                    distHits++;
                }
            }
        }
        const distinctiveCoverage = distinctiveStems.length > 0
            ? distHits / distinctiveStems.length
            : span.coverageRatio;

        let structuralPrior = 0;
        if (item.category === 'invariant' || item._isStandingDirective) {
            structuralPrior += 0.35;
        }
        if (knowledgeUpdateMode && item._hasStateTransition) {
            structuralPrior += 0.40;
        }
        if (Array.isArray(item.lineage) && item.lineage.length > 1) {
            structuralPrior += 0.25;
        }

        return {
            rawSem,
            calSem,
            userOverlap,
            idfOverlap,
            spanTightness: span.spanTightness,
            distinctiveCoverage,
            structuralPrior: Math.min(1, structuralPrior)
        };
    });

    // 2. Compute within-query distributional statistics over active candidate pool
    const semStats = computeMeanAndStd(features.map(f => f.rawSem));
    const idfStats = computeMeanAndStd(features.map(f => f.idfOverlap));
    const spanStats = computeMeanAndStd(features.map(f => f.spanTightness));

    // 3. Build 4-arm Reciprocal Rank maps (only positive non-zero signals participate)
    const semRanks = hasRealQueryEmbedding
        ? buildPositiveArmRanks(features, f => f.rawSem)
        : new Map();
    const userRanks = buildPositiveArmRanks(features, f => f.userOverlap);
    const idfRanks = buildPositiveArmRanks(features, f => f.idfOverlap);
    const spanRanks = buildPositiveArmRanks(features, f => f.spanTightness);

    const activeArms =
        (semRanks.size > 0 ? 1 : 0) +
        (userRanks.size > 0 ? 1 : 0) +
        (idfRanks.size > 0 ? 1 : 0) +
        (spanRanks.size > 0 ? 1 : 0);

    if (activeArms === 0) {
        return { calibratedCount: 0, activeArms: 0, topFernScore: 0 };
    }

    const maxPossibleRrf = activeArms / (RRF_K + 1);
    let calibratedCount = 0;
    let topFernScore = 0;

    const fernScores = new Float64Array(candidates.length);
    for (let i = 0; i < candidates.length; i++) {
        const item = candidates[i];
        const f = features[i];

        let rrfRaw = 0;
        if (semRanks.has(i)) rrfRaw += 1 / (RRF_K + semRanks.get(i));
        if (userRanks.has(i)) rrfRaw += 1 / (RRF_K + userRanks.get(i));
        if (idfRanks.has(i)) rrfRaw += 1 / (RRF_K + idfRanks.get(i));
        if (spanRanks.has(i)) rrfRaw += 1 / (RRF_K + spanRanks.get(i));
        const rrfNorm = maxPossibleRrf > 0 ? Math.min(1, rrfRaw / maxPossibleRrf) : 0;

        const zSemUnit = hasRealQueryEmbedding
            ? 0.5 * (Math.tanh((f.rawSem - semStats.mean) / (2 * semStats.std)) + 1)
            : 0.5;
        const zIdfUnit = 0.5 * (Math.tanh((f.idfOverlap - idfStats.mean) / (2 * idfStats.std)) + 1);
        const zSpanUnit = 0.5 * (Math.tanh((f.spanTightness - spanStats.mean) / (2 * spanStats.std)) + 1);

        const lexicalStrength = Math.max(f.idfOverlap, f.spanTightness, f.userOverlap);
        const concordance = hasRealQueryEmbedding
            ? Math.sqrt(Math.max(0, f.calSem) * Math.max(0, lexicalStrength))
            : lexicalStrength;

        const fernScore = hasRealQueryEmbedding
            ? (
                0.26 * rrfNorm +
                0.22 * zSemUnit +
                0.16 * zIdfUnit +
                0.20 * (0.68 * f.spanTightness + 0.32 * zSpanUnit) +
                0.12 * concordance +
                0.04 * f.structuralPrior
            )
            : (
                0.32 * rrfNorm +
                0.26 * zIdfUnit +
                0.32 * (0.68 * f.spanTightness + 0.32 * zSpanUnit) +
                0.10 * f.structuralPrior
            );

        fernScores[i] = fernScore;
        item._fernScore = fernScore;
        const baseRaw = Number(item.rawScore ?? item.score ?? 0);
        if (baseRaw >= EPISTEMIC_SAFE_FLOOR && !item._isEntityOnlyIsotropicNeighbor && fernScore > topFernScore) {
            topFernScore = fernScore;
        }
    }

    for (let i = 0; i < candidates.length; i++) {
        const item = candidates[i];
        const fernScore = fernScores[i];
        const baseRaw = Number(item.rawScore ?? item.score ?? 0);
        // INV-V2-09A: Never lift ungrounded / low-support candidates across epistemic abstention gates
        if (baseRaw < EPISTEMIC_SAFE_FLOOR || item._isEntityOnlyIsotropicNeighbor) {
            continue;
        }

        // Centered bounded rank adjustment + frontier-relative de-saturation for ceiling-clamped top ties
        const centeredSignal = fernScore - (isBroadQuery ? 0.44 : 0.46);
        const rawDelta = centeredSignal * 0.16;
        const boundedDelta = Math.max(-0.022, Math.min(0.082, rawDelta));
        const itemCeiling = (knowledgeUpdateMode && item._hasStateTransition) ? 1.0 : 0.995;
        const frontierGap = Math.max(0, topFernScore - fernScore);
        const frontierRelief = baseRaw >= 0.85 ? Math.min(0.045, frontierGap * 0.11) : 0;

        item._unclampedScore =
            Number(item._unclampedScore ?? baseRaw) +
            boundedDelta +
            0.22 * fernScore -
            0.14 * frontierGap;
        const rawTarget = Math.min(itemCeiling, Number(item.score ?? baseRaw) + boundedDelta) - frontierRelief;
        const adjusted = Math.max(EPISTEMIC_SAFE_FLOOR, rawTarget);
        item.score = adjusted;
        if (adjusted > item.rawScore) {
            item.rawScore = adjusted;
        }
        calibratedCount++;
    }

    return {
        calibratedCount,
        activeArms,
        topFernScore: Number(topFernScore.toFixed(4))
    };
}

/**
 * Uncertainty-Gated Multi-Granularity Relational Graph Probe (SkinMind, arXiv:2611.08935).
 * Traverses typed engineering & episodic graph edges (`EXPLICIT_ID_REF`, `INVARIANT_CODE_EDGE`,
 * `PROVENANCE_FILE_EDGE`, `STRUCTURED_TAG_EDGE`) from grounded Hop-1 seeds in SQLite + CPU,
 * rescuing linked rules/root-causes even when stores lack `[Session N]` dialogue brackets.
 *
 * @param {object} db - Synchronous node:sqlite DatabaseSync handle
 * @param {object} [options={}]
 * @returns {{
 *   ok: boolean,
 *   triggered: boolean,
 *   uncertaintyScore: number,
 *   probedEdgeCount: number,
 *   rescuedRows: Array<object>,
 *   relationalBoostById: Map<number, { bonus: number, probeScore: number, edgeTypes: string[], matchedUncoveredStems: string[] }>
 * }}
 */
export function probeRelationalMemoryGraph(db, options = {}) {
    const {
        rawQuery = '',
        queryEmbedding = null,
        hasRealQueryEmbedding = false,
        distinctiveTerms = [],
        distinctiveStems = [],
        evalStems = [],
        hop1Items = [],
        candidateMap = new Map(),
        allCandidateRows = [],
        normCategory = null,
        selectCols = 'id, category, content, tags, status, supersedes_id, superseded_by, invalidated_reason, created_at, updated_at'
    } = options || {};

    const emptyResult = () => ({
        ok: true,
        triggered: false,
        uncertaintyScore: 0,
        probedEdgeCount: 0,
        rescuedRows: [],
        relationalBoostById: new Map()
    });

    if (
        !db ||
        !Array.isArray(hop1Items) ||
        hop1Items.length === 0 ||
        isSequenceOrderQuery(rawQuery)
    ) {
        return emptyResult();
    }

    const sortedHop1 = [...hop1Items].sort((a, b) => {
        const uDiff = Number(b?._unclampedScore ?? b?.score ?? 0) - Number(a?._unclampedScore ?? a?.score ?? 0);
        if (Math.abs(uDiff) > 1e-9) return uDiff;
        return Number(b?.id || 0) - Number(a?.id || 0);
    });

    const top1 = sortedHop1[0];
    const top1Base = Number(top1?.rawScore ?? top1?.score ?? 0);
    // Epistemic Abstention Gate: never probe graph edges if Hop-1 itself lacks grounded support
    if (!top1 || top1Base < 0.52) {
        return emptyResult();
    }

    const topSeeds = sortedHop1
        .filter(it => Number(it?.rawScore ?? it?.score ?? 0) >= 0.50)
        .slice(0, 5);
    if (topSeeds.length === 0) {
        return emptyResult();
    }

    // 1. Compute Hop-1 Uncertainty & Uncovered Query Stems
    const coveredByTopSeeds = new Set();
    for (const seed of topSeeds.slice(0, 3)) {
        const srcRow = (candidateMap instanceof Map ? candidateMap.get(Number(seed.id)) : null) || seed;
        const stems = seed._stems instanceof Set
            ? seed._stems
            : new Set(String(srcRow?.content || '').toLowerCase().split(/[^a-z0-9_]+/).filter(w => w.length >= 2).map(stemToken));
        for (const st of stems) coveredByTopSeeds.add(st);
    }

    const targetStems = distinctiveStems.length > 0 ? distinctiveStems : evalStems;
    const uncoveredStems = targetStems.filter(st => st && !coveredByTopSeeds.has(st));
    const uncoveredRatio = targetStems.length > 0 ? uncoveredStems.length / targetStems.length : 0;

    const top4Score = sortedHop1.length >= 4
        ? Number(sortedHop1[3]?.score ?? 0)
        : 0;
    const scoreDispersion = top4Score > 0 ? Math.max(0, 1 - Math.min(1, (top1.score - top4Score) / 0.18)) : 0.25;

    // 2. Harvest Typed Relational Graph Edges from Top Seeds
    const seedIdSet = new Set(topSeeds.map(s => Number(s.id)));
    const explicitTargetIds = new Map(); // targetId -> seedWeight
    const invariantEdgeWeights = new Map(); // invCode -> seedWeight
    const fileEdgeWeights = new Map(); // fileAnchor -> seedWeight
    const tagEdgeWeights = new Map(); // tag -> seedWeight

    // Compute document frequencies of files/tags across candidate pool so overly common tags don't fan out noisily
    const corpusN = Math.max(1, allCandidateRows.length);
    const fileDf = new Map();
    const tagDf = new Map();
    for (let i = 0; i < allCandidateRows.length; i++) {
        const anchors = extractRelationalGraphAnchors(allCandidateRows[i]);
        for (const f of anchors.provenanceFiles) fileDf.set(f, (fileDf.get(f) || 0) + 1);
        for (const t of anchors.structuredTags) tagDf.set(t, (tagDf.get(t) || 0) + 1);
    }
    const maxFileDf = Math.max(5, Math.floor(corpusN * 0.18));
    const maxTagDf = Math.max(4, Math.floor(corpusN * 0.12));

    for (let sIdx = 0; sIdx < topSeeds.length; sIdx++) {
        const seed = topSeeds[sIdx];
        const srcRow = (candidateMap instanceof Map ? candidateMap.get(Number(seed.id)) : null) || seed;
        const rankDecay = Math.max(0.55, 1 - sIdx * 0.12);
        const seedWeight = Number(seed.score || 0.6) * rankDecay;
        const anchors = extractRelationalGraphAnchors(srcRow);

        if (sIdx < 3) {
            for (const targetId of anchors.explicitMemoryIds) {
                if (!seedIdSet.has(targetId)) {
                    explicitTargetIds.set(targetId, Math.max(explicitTargetIds.get(targetId) || 0, seedWeight));
                }
            }
            for (const inv of anchors.invariantCodes) {
                invariantEdgeWeights.set(inv, Math.max(invariantEdgeWeights.get(inv) || 0, seedWeight));
            }
            for (const fileAnchor of anchors.provenanceFiles) {
                if ((fileDf.get(fileAnchor) || 0) <= maxFileDf) {
                    fileEdgeWeights.set(fileAnchor, Math.max(fileEdgeWeights.get(fileAnchor) || 0, seedWeight));
                }
            }
        }
        if (uncoveredStems.length > 0) {
            for (const tag of anchors.structuredTags) {
                if ((tagDf.get(tag) || 0) <= maxTagDf) {
                    tagEdgeWeights.set(tag, Math.max(tagEdgeWeights.get(tag) || 0, seedWeight * 0.85));
                }
            }
        }
    }

    const probedEdgeCount =
        explicitTargetIds.size +
        invariantEdgeWeights.size +
        fileEdgeWeights.size +
        tagEdgeWeights.size;

    const uncertaintyScore = Number(
        Math.min(1, 0.55 * uncoveredRatio + 0.25 * scoreDispersion + (probedEdgeCount > 0 ? 0.20 : 0)).toFixed(4)
    );

    if (probedEdgeCount === 0) {
        return emptyResult();
    }

    // Trigger only when direct structural edges exist OR Hop-1 leaves query facets uncovered
    const hasHighPrecisionStructuralEdge =
        explicitTargetIds.size > 0 ||
        invariantEdgeWeights.size > 0 ||
        fileEdgeWeights.size > 0;
    if (!hasHighPrecisionStructuralEdge && uncoveredStems.length === 0) {
        return emptyResult();
    }

    // 3. Off-Scan SQLite Graph Rescue (explicit IDs + FTS5 lookup on invariant/file/uncovered tokens)
    const rescuedRows = [];
    const seenRescueIds = new Set();

    const missingExplicitIds = [...explicitTargetIds.keys()].filter(
        id => !(candidateMap instanceof Map && candidateMap.has(id))
    );
    if (missingExplicitIds.length > 0) {
        try {
            const boundedIds = missingExplicitIds.slice(0, 16);
            const placeholders = boundedIds.map(() => '?').join(',');
            let idSql = `SELECT ${selectCols} FROM ide_agent_memory WHERE id IN (${placeholders}) AND status = 'ACTIVE'`;
            const idParams = [...boundedIds];
            if (normCategory) {
                idSql += ` AND category = ?`;
                idParams.push(normCategory);
            }
            for (const row of db.prepare(idSql).all(...idParams)) {
                const numId = Number(row.id);
                if (!candidateMap.has(numId) && !seenRescueIds.has(numId)) {
                    seenRescueIds.add(numId);
                    rescuedRows.push(row);
                }
            }
        } catch {
            // Gracefully continue on custom/minimal schemas
        }
    }

    if (fileEdgeWeights.size > 0 && hasProvenanceColumn(db) && allCandidateRows.length >= 25) {
        try {
            const fileBasenames = [...new Set(
                [...fileEdgeWeights.keys()].map(f => f.split('/').pop()).filter(Boolean)
            )].slice(0, 6);
            if (fileBasenames.length > 0) {
                const likeClauses = fileBasenames.map(() => `LOWER(provenance) LIKE ? ESCAPE '\\'`);
                const likeParams = fileBasenames.map(fn => `%${fn.replace(/[\\%_]/g, '\\$&')}%`);
                let provSql = `SELECT ${selectCols} FROM ide_agent_memory WHERE status = 'ACTIVE' AND provenance IS NOT NULL AND (${likeClauses.join(' OR ')})`;
                if (normCategory) {
                    provSql += ` AND category = ?`;
                    likeParams.push(normCategory);
                }
                provSql += ` ORDER BY id DESC LIMIT 24`;
                for (const row of db.prepare(provSql).all(...likeParams)) {
                    const numId = Number(row.id);
                    if (!candidateMap.has(numId) && !seenRescueIds.has(numId)) {
                        seenRescueIds.add(numId);
                        rescuedRows.push(row);
                    }
                }
            }
        } catch {
            // Gracefully continue if provenance lookup fails
        }
    }

    const ftsProbeTerms = [
        ...invariantEdgeWeights.keys(),
        ...[...fileEdgeWeights.keys()].map(f => f.split('/').pop()),
        ...distinctiveTerms.filter(t => uncoveredStems.includes(stemToken(t)))
    ].filter(Boolean).slice(0, 8);

    if (ftsProbeTerms.length > 0 && allCandidateRows.length >= 25) {
        try {
            const ftsRows = searchMemoryFts(db, ftsProbeTerms, {
                includeSuperseded: false,
                includeAllActive: true,
                category: normCategory,
                selectCols,
                limit: 36
            });
            if (Array.isArray(ftsRows)) {
                for (const row of ftsRows) {
                    const numId = Number(row.id);
                    if (!candidateMap.has(numId) && !seenRescueIds.has(numId)) {
                        seenRescueIds.add(numId);
                        rescuedRows.push(row);
                    }
                }
            }
        } catch {
            // Ignore FTS unavailability
        }
    }

    // Compute optional Gram-Schmidt residual vector for semantic verification of probed graph neighbors
    let residualVector = null;
    if (hasRealQueryEmbedding && queryEmbedding) {
        const seedVecs = [];
        for (const seed of topSeeds.slice(0, 3)) {
            const srcRow = (candidateMap instanceof Map ? candidateMap.get(Number(seed.id)) : null) || seed;
            const vec = getParsedEmbedding(srcRow?.embedding, srcRow?.embedding_blob);
            if (vec) seedVecs.push(vec);
        }
        residualVector = computeResidualBridgeVector(queryEmbedding, seedVecs, 0.72);
    }

    // 4. Fine-Grained Relational Evidence Verification across candidate pool + rescued rows
    const evalPool = [...allCandidateRows, ...rescuedRows];
    const uncoveredSet = new Set(uncoveredStems);
    const evalStemSet = new Set(targetStems);
    const relationalBoostById = new Map();

    for (const row of evalPool) {
        const numId = Number(row?.id);
        if (!Number.isFinite(numId) || seedIdSet.has(numId)) continue;

        const anchors = extractRelationalGraphAnchors(row);
        const edgeTypes = [];
        let edgeStrength = 0;

        if (explicitTargetIds.has(numId)) {
            edgeTypes.push('EXPLICIT_ID_REF');
            edgeStrength = Math.max(edgeStrength, 0.92 * explicitTargetIds.get(numId));
        }

        // Reverse check: does this candidate explicitly cite one of our top-2 Hop-1 seed IDs?
        for (const refId of anchors.explicitMemoryIds) {
            if (refId === Number(topSeeds[0]?.id) || refId === Number(topSeeds[1]?.id)) {
                edgeTypes.push('REVERSE_ID_REF');
                edgeStrength = Math.max(edgeStrength, 0.84 * Number(topSeeds[0]?.score || 0.7));
            }
        }

        for (const inv of anchors.invariantCodes) {
            if (invariantEdgeWeights.has(inv)) {
                edgeTypes.push('INVARIANT_CODE_EDGE');
                edgeStrength = Math.max(edgeStrength, 0.88 * invariantEdgeWeights.get(inv));
            }
        }

        for (const f of anchors.provenanceFiles) {
            if (fileEdgeWeights.has(f)) {
                edgeTypes.push('PROVENANCE_FILE_EDGE');
                edgeStrength = Math.max(edgeStrength, 0.80 * fileEdgeWeights.get(f));
            }
        }

        for (const t of anchors.structuredTags) {
            if (tagEdgeWeights.has(t)) {
                edgeTypes.push('STRUCTURED_TAG_EDGE');
                edgeStrength = Math.max(edgeStrength, 0.68 * tagEdgeWeights.get(t));
            }
        }

        if (edgeTypes.length === 0 || edgeStrength <= 0) continue;

        const lowerContent = typeof row._lowerContent === 'string'
            ? row._lowerContent
            : String(row.content || '').toLowerCase();
        const rowStems = row._stems instanceof Set
            ? row._stems
            : new Set(lowerContent.split(/[^a-z0-9_]+/).filter(w => w.length >= 2).map(stemToken));

        const matchedUncoveredStems = [];
        let matchedAnyQueryStem = 0;
        for (const st of evalStemSet) {
            if (rowStems.has(st) || lowerContent.includes(st)) {
                matchedAnyQueryStem++;
                if (uncoveredSet.has(st)) {
                    matchedUncoveredStems.push(st);
                }
            }
        }

        let directCalSim = 0;
        let residualCalSim = 0;
        if (hasRealQueryEmbedding && (row.embedding || row.embedding_blob)) {
            const vec = getParsedEmbedding(row.embedding, row.embedding_blob);
            if (vec && queryEmbedding) {
                const rawCos = cosineSimilarity(queryEmbedding, vec);
                directCalSim = calibrateQuerySimilarity(rawCos, { queryVec: queryEmbedding });
                if (residualVector) {
                    const resCos = cosineSimilarity(residualVector, vec);
                    residualCalSim = calibrateQuerySimilarity(resCos, { queryVec: residualVector });
                }
            }
        }

        const isDirectCitationOrInvariant =
            edgeTypes.includes('EXPLICIT_ID_REF') ||
            edgeTypes.includes('REVERSE_ID_REF') ||
            edgeTypes.includes('INVARIANT_CODE_EDGE');
        const isAuthoritativeRule =
            row.category === 'invariant' ||
            row.category === 'bug' ||
            Boolean(row._isStandingDirective);

        // Verification Gate: prevent noisy co-file chatter from rising without semantic, facet, or rule grounding
        const passesEvidenceGate =
            matchedUncoveredStems.length >= 1 ||
            (isDirectCitationOrInvariant && (matchedAnyQueryStem >= 1 || directCalSim >= 0.42 || residualCalSim >= 0.45 || isAuthoritativeRule)) ||
            (edgeTypes.includes('PROVENANCE_FILE_EDGE') && (
                (isAuthoritativeRule && (directCalSim >= 0.38 || residualCalSim >= 0.42 || matchedAnyQueryStem >= 1)) ||
                residualCalSim >= 0.55 ||
                (matchedAnyQueryStem >= 1 && (directCalSim >= 0.48 || residualCalSim >= 0.50))
            ));

        if (!passesEvidenceGate) continue;

        const uniqueEdges = [...new Set(edgeTypes)];
        const multiEdgeBonus = Math.min(0.10, Math.max(0, uniqueEdges.length - 1) * 0.06);
        const uncoveredBonus = uncoveredSet.size > 0
            ? (matchedUncoveredStems.length / uncoveredSet.size) * 0.16
            : 0;
        const semSupport = Math.max(directCalSim, residualCalSim * 0.95);
        const ruleBonus = isAuthoritativeRule ? 0.06 : 0;

        const probeScore = Math.min(
            0.94,
            0.52 * edgeStrength +
            0.30 * (semSupport > 0 ? semSupport : 0.58) +
            multiEdgeBonus +
            uncoveredBonus +
            ruleBonus
        );

        if (probeScore >= 0.52) {
            const bonus = Math.min(
                0.16,
                0.05 + multiEdgeBonus * 0.5 + uncoveredBonus * 0.5 + (isDirectCitationOrInvariant ? 0.04 : 0.015) + (isAuthoritativeRule ? 0.02 : 0)
            );
            relationalBoostById.set(numId, {
                bonus,
                probeScore: Number(probeScore.toFixed(4)),
                edgeTypes: uniqueEdges,
                matchedUncoveredStems
            });
        }
    }

    const rescuedVerifiedRows = rescuedRows.filter(r => relationalBoostById.has(Number(r.id)));

    return {
        ok: true,
        triggered: relationalBoostById.size > 0,
        uncertaintyScore,
        probedEdgeCount,
        rescuedRows: rescuedVerifiedRows,
        relationalBoostById
    };
}

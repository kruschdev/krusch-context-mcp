/**
 * @module retrieval-lexical
 * Domain-agnostic lexical tokenization, Porter Rule 5a stemming, FNV-1a hashing,
 * and token budget estimation helpers for krusch-context-mcp.
 */

export const CHARS_PER_ESTIMATED_TOKEN = 4;

export function fnv1a32(str = '') {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
}

export const STOP_WORDS = new Set([
    'what', 'where', 'when', 'which', 'who', 'whom', 'whose', 'why', 'how',
    'does', 'did', 'the', 'and', 'for', 'with', 'from', 'that', 'this',
    'these', 'those', 'are', 'was', 'were', 'been', 'being', 'have', 'has',
    'had', 'you', 'your', 'yours', 'yourself', 'myself', 'ourselves',
    'our', 'their', 'there', 'they', 'them', 'him', 'her', 'its',
    'about', 'into', 'onto', 'upon',
    'can', 'could', 'would', 'should', 'will', 'shall', 'may', 'might',
    'tell', 'show', 'give', 'find', 'get', 'list'
]);

export const TEMPORAL_CUE_WORDS = new Set([
    'before', 'prior', 'previous', 'previously', 'original', 'originally',
    'initial', 'initially', 'first', 'history', 'historical', 'timeline',
    'chronological', 'chronologically', 'order', 'ordered', 'sequence',
    'evolution', 'supersede', 'superseded', 'formerly', 'migrated',
    'changed', 'current', 'currently', 'now', 'latest', 'today', 'active',
    'across', 'sessions', 'session', 'step', 'steps', 'after', 'since'
]);

export const GENERIC_INFRA_WORDS = new Set([
    'policy', 'rule', 'rules', 'system', 'service', 'project', 'server',
    'node', 'nodes', 'port', 'version', 'config', 'configuration', 'setting',
    'settings', 'status', 'mode', 'default', 'cluster', 'data', 'use',
    'used', 'using', 'uses', 'run', 'running', 'runs', 'set', 'value',
    'exactly', 'strictly', 'only', 'just', 'about', 'around', 'roughly',
    'approximately', 'nearly', 'almost', 'least', 'most', 'more', 'less',
    'over', 'under', 'than', 'remain', 'remains', 'each', 'every'
]);

export const TECH_TWO_CHAR_TOKENS = new Set([
    'db', 'ip', 'ui', 'ci', 'cd', 'os', 'ha', 'io', 'vm', 'gc', 'pr', 'qa', 'ai', 'ml', 'id'
]);

export const META_QUERY_WORDS = new Set([
    'many', 'much', 'want', 'wanted', 'trying', 'try', 'tried', 'make', 'made',
    'sure', 'need', 'needed', 'help', 'helped', 'implement', 'implemented',
    'implementing', 'feature', 'features', 'aspect', 'aspects', 'conversation',
    'conversations', 'discussion', 'discussions', 'throughout', 'mention',
    'mentioned', 'items', 'item', 'summary', 'summarize', 'comprehensive',
    'progressed', 'progress', 'handled', 'handle', 'handling', 'suggest',
    'suggested', 'take', 'taken', 'looking', 'planning', 'plan', 'planned',
    'bring', 'brought', 'different', 'various', 'overall', 'consider',
    'considering', 'based', 'specific', 'specifically', 'provide', 'provided',
    'walk', 'through', 'explain', 'explained', 'approach', 'approached',
    'work', 'worked', 'working', 'develop', 'developing', 'development',
    'developed', 'far', 'time', 'times', 'recommend', 'recommended', 'passed',
    'between', 'ever'
]);

export const DIRECTIVE_REGEX = /\b(always|never|make sure to|please remember to|from now on|every time|whenever you|be sure to|don't ever|do not ever|remember that i want you to|i prefer|my preference|i like to|i'd rather|i would rather|i always use|i usually prefer|i'm a fan of|i tend to prefer|keep .* lightweight|minimal dependencies|favor .* over)\b/i;

export const STATE_TRANSITION_REGEX = /\b(switched\s+(?:from|to|my|our|the)|changed\s+(?:from|to|my|our|the)|moved\s+(?:from|to|my|our)|migrated\s+(?:from|to)|updated\s+(?:from|to|my|our|the)|upgraded\s+(?:from|to|my|our)|downgraded\s+(?:from|to)|instead\s+of\s+using|decided\s+to\s+(?:go\s+with|switch|use|change)|ended\s+up\s+(?:going\s+with|choosing|using|picking|switching)|no\s+longer\s+(?:use|using|work|working|live|living|need|want)|actually\s+(?:(?:i|we)\s+)?(?:now|switched|changed|moved|updated|decided)|(?:increased|decreased|raised|lowered|bumped|reduced|cut|doubled)\s+[^.|]{1,45}\s+to\b|now\s+(?:i'm|i\s+am|we're|we\s+are)\s+(?:using|working|living|running|going\s+with))\b/i;

const STEM_CACHE = new Map();

/**
 * Normalizes a lowercase token to its morphological stem so singular/plural and verb inflections match.
 * @param {string} word
 * @returns {string}
 */
export function stemToken(word) {
    const w = String(word || '').toLowerCase();
    if (w.length <= 3) return w;
    const cached = STEM_CACHE.get(w);
    if (cached !== undefined) return cached;
    let res = w;
    if (w.endsWith('ies') && w.length > 4) res = w.slice(0, -3) + 'y';
    else if (w.endsWith('ing') && w.length > 5) res = w.slice(0, -3).replace(/(.)\1$/, '$1');
    else if (w.endsWith('ed') && w.length > 4) res = w.slice(0, -2).replace(/(.)\1$/, '$1');
    else if (w.endsWith('es') && w.length > 4 && !w.endsWith('tes') && !w.endsWith('les') && !w.endsWith('res') && !w.endsWith('ves')) {
        res = w.slice(0, -2);
    } else if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) {
        res = w.slice(0, -1);
    }
    if (res.length > 4 && res.endsWith('e') && !res.endsWith('ee')) {
        res = res.slice(0, -1);
    }
    if (STEM_CACHE.size < 30000) STEM_CACHE.set(w, res);
    return res;
}

/**
 * Detects whether a query asks about temporal history, superseded states, chronological event ordering, or multi-session progression.
 * @param {string} query
 * @returns {boolean}
 */
export function isTemporalOrLineageQuery(query) {
    if (!query || typeof query !== 'string') return false;
    return /\b(before|prior|previous|previously|original|originally|initial|initially|first|history|historical|timeline|chronological|chronologically|order|sequence|evolution|supersede|superseded|used\s+to|formerly|migrated\s+from|changed\s+from|when\s+did|what\s+was|over\s+time|across\s+sessions|across\s+my|throughout\s+our|summary|summarize|progressed|evolved)\b/i.test(query);
}

/**
 * Detects whether a query explicitly asks to reconstruct the chronological order or sequence of events.
 * @param {string} query
 * @returns {boolean}
 */
export function isSequenceOrderQuery(query) {
    if (!query || typeof query !== 'string') return false;
    return /\b(chronological|chronologically|in\s+what\s+order|what\s+order|order\s+of|sequence\s+of|from\s+first\s+to\s+last|from\s+earliest\s+to\s+latest|exact\s+order|correct\s+order|order\s+did)\b/i.test(query);
}

/**
 * Detects whether a query asks for the current, latest, or updated value of an evolving fact.
 * @param {string} query
 * @returns {boolean}
 */
export function isKnowledgeUpdateQuery(query) {
    if (!query || typeof query !== 'string') return false;
    return /\b(current|currently|latest|most\s+recent|updated|changed\s+to|switched\s+to|ended\s+up|now)\b/i.test(query);
}

/**
 * Detects whether a query is a generative, task-execution, or advisory request (where standing user
 * formatting instructions and preferences apply directly) vs a retrospective past-fact recall question.
 * @param {string} query
 * @returns {boolean}
 */
export function isGenerativeOrAdvisoryQuery(query) {
    if (!query || typeof query !== 'string') return false;
    const trimmed = query.trim();
    if (isKnowledgeUpdateQuery(trimmed) || isSequenceOrderQuery(trimmed)) return false;
    if (/\b(tell\s+me|let\s+me\s+know|remind\s+me|recall|remember\s+when|remember\s+what|confirm|verify|check\s+whether|what\s+did\s+(?:i|we)|when\s+did\s+(?:i|we)|where\s+did\s+(?:i|we)|which\s+[a-z0-9_\s]{1,25}\s+did\s+(?:i|we)|have\s+(?:i|we)\s+ever|did\s+(?:i|we)\s+ever|how\s+many|how\s+long|how\s+much|summary\s+of\s+our|summarize\s+our|across\s+(?:all\s+)?(?:our\s+|my\s+)?sessions|throughout\s+our)\b/i.test(trimmed)) {
        return false;
    }
    return /^(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:help\s+me\s+)?(?:write|draft|create|generate|build|implement|design|refactor|suggest|recommend|outline|plan|propose|advise|brainstorm|come\s+up\s+with|put\s+together)\b|(?:help\s+me\s+)?(?:write|draft|create|generate|build|implement|design|refactor|suggest|recommend|outline|plan|propose|brainstorm)\b|(?:give|provide)\s+me\s+(?:a|an|some)\b|what\s+(?:should\s+i|would\s+you\s+recommend|are\s+some\s+good|ideas)|how\s+(?:should\s+i|can\s+i)\b)/i.test(trimmed);
}

/**
 * Checks if an embedding vector is a synthetic constant vector (e.g. new Array(1024).fill(0.05) in unit tests).
 * @param {Array<number>|Float64Array|null} vec
 * @returns {boolean}
 */
export function isSyntheticConstantVector(vec) {
    if (!vec || vec.length < 4) return false;
    const first = vec[0];
    return Math.abs(first - vec[1]) < 1e-9 &&
           Math.abs(first - vec[Math.floor(vec.length / 2)]) < 1e-9 &&
           Math.abs(first - vec[vec.length - 1]) < 1e-9;
}

/**
 * Extracts normalized query terms and distinctive domain terms from a cleaned query.
 * @param {string} lowerQuery
 * @returns {{ queryTerms: string[], domainTerms: string[], distinctiveTerms: string[] }}
 */
export function extractQueryTokens(lowerQuery) {
    const rawTokens = String(lowerQuery || '')
        .toLowerCase()
        .split(/[^a-z0-9_.-]+/)
        .map(t => t.replace(/^[.-]+|[.-]+$/g, ''))
        .filter(t => t.length > 2 || /^\d+$/.test(t) || /^[a-z]\d+|\d+[a-z]$/i.test(t) || TECH_TWO_CHAR_TOKENS.has(t));

    const uniqueTokens = [...new Set(rawTokens)];
    const queryTerms = uniqueTokens.filter(t => !STOP_WORDS.has(t));
    const nonTemporal = queryTerms.filter(t => !TEMPORAL_CUE_WORDS.has(t));
    const nonMeta = nonTemporal.filter(t => !META_QUERY_WORDS.has(t));
    const domainTerms = nonMeta.length > 0 ? nonMeta : (nonTemporal.length > 0 ? nonTemporal : queryTerms);
    const distinctive = domainTerms.filter(t => !GENERIC_INFRA_WORDS.has(t));
    const distinctiveTerms = distinctive.length > 0 ? distinctive : domainTerms;

    return { queryTerms, domainTerms, distinctiveTerms };
}

/**
 * Estimates token count for a text string (~4 characters per token; disclosed alongside BPE ratios).
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / CHARS_PER_ESTIMATED_TOKEN);
}

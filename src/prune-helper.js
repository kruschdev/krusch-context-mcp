/**
 * @module prune-helper
 * Stage-Aware Context Pruning Middleware (arXiv: 2608.08389).
 * Self-contained implementation for standalone public portability.
 */

/**
 * Pre-Retrieval Pruning: Cleans queries and removes conversational filler before search.
 * @param {string} query - Raw search query
 * @returns {string} Cleaned search query
 */
export function prunePreRetrieval(query) {
    if (!query || typeof query !== 'string') return query;
    let pruned = query
        .replace(/^(?:hey|hello|hi|greetings|dear|please)[,.\s]+/i, '')
        .replace(/^(?:could you please|can you please|would you kindly|would you please|i want you to|i need you to|tell me|show me)[,.\s]+/i, '')
        .replace(/\b(?:as we discussed earlier|like i mentioned before|as you know)\b/gi, '')
        .replace(/\b(?:thanks in advance|thank you very much|thank you|thanks|let me know what you think)[.!?\s]*$/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
    return pruned || query;
}

/**
 * Computes word Jaccard similarity.
 * @private
 */
function computeSimilarity(textA = '', textB = '') {
    if (!textA || !textB) return 0;
    const setA = new Set(textA.toLowerCase().split(/\W+/).filter(w => w.length > 2));
    const setB = new Set(textB.toLowerCase().split(/\W+/).filter(w => w.length > 2));
    if (setA.size === 0 || setB.size === 0) return 0;
    let inter = 0;
    for (const w of setA) {
        if (setB.has(w)) inter++;
    }
    const union = setA.size + setB.size - inter;
    return union === 0 ? 0 : inter / union;
}

/**
 * Post-Retrieval Pruning: Suppresses near-duplicate context items.
 * @param {Array<object>} items - Retrieved context chunks
 * @param {object} [options={}]
 * @param {number} [options.similarityThreshold=0.88]
 * @returns {Array<object>} Filtered items
 */
export function prunePostRetrieval(items = [], options = {}) {
    if (!Array.isArray(items) || items.length === 0) return [];
    const threshold = options.similarityThreshold || options.redundancyThreshold || 0.88;
    const result = [];

    for (const item of items) {
        const itemText = item.content || item.text || JSON.stringify(item);
        let isDuplicate = false;
        for (const existing of result) {
            const existingText = existing.content || existing.text || JSON.stringify(existing);
            if (computeSimilarity(itemText, existingText) > threshold) {
                isDuplicate = true;
                break;
            }
        }
        if (!isDuplicate) {
            result.push(item);
        }
    }
    return result;
}

/**
 * Pre-Synthesis Pruning: Strips boilerplate and comments before final synthesis.
 * @param {string} text - Raw content text
 * @returns {string} Condensed text
 */
export function prunePreSynthesis(text = '') {
    if (typeof text !== 'string') return '';
    const boilerplatePatterns = [
        /Copyright\s+(?:\(c\)|©)?\s*\d{4}.*$/gim,
        /All\s+rights\s+reserved\.?/gim,
        /<!--[\s\S]*?-->/g
    ];
    let cleaned = text;
    for (const pat of boilerplatePatterns) {
        cleaned = cleaned.replace(pat, '');
    }
    return cleaned;
}

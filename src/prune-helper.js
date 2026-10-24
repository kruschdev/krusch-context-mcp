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
 * Extracts a lowercase word set (words > 2 chars) for Jaccard similarity.
 * @private
 */
function tokenizeWordSet(text = '') {
    if (!text) return new Set();
    return new Set(String(text).toLowerCase().split(/\W+/).filter(w => w.length > 2));
}

function jaccardSimilaritySets(setA, setB) {
    if (!setA || !setB || setA.size === 0 || setB.size === 0) return 0;
    let inter = 0;
    for (const w of setA) {
        if (setB.has(w)) inter++;
    }
    const union = setA.size + setB.size - inter;
    return union === 0 ? 0 : inter / union;
}

/**
 * Computes word Jaccard similarity.
 * @private
 */
function computeSimilarity(textA = '', textB = '') {
    if (!textA || !textB) return 0;
    return jaccardSimilaritySets(tokenizeWordSet(textA), tokenizeWordSet(textB));
}

/**
 * Post-Retrieval Pruning: Suppresses near-duplicate context items.
 * Precomputes word sets in O(K * L) to avoid repeated regex splitting in the pair loop.
 * @param {Array<object>} items - Retrieved context chunks
 * @param {object} [options={}]
 * @param {number} [options.similarityThreshold=0.88]
 * @returns {Array<object>} Filtered items
 */
export function prunePostRetrieval(items = [], options = {}) {
    if (!Array.isArray(items) || items.length === 0) return [];
    const threshold = options.similarityThreshold ?? options.redundancyThreshold ?? 0.88;
    const result = [];
    const resultSets = [];

    for (const item of items) {
        const itemText = String(item.content || item.text || JSON.stringify(item));
        const userMatch = itemText.match(/\bUSER:\s*([\s\S]*?)(?:\|\s*ASSISTANT:|$)/i);
        const primaryText = userMatch ? userMatch[1] : itemText;
        const setA = tokenizeWordSet(primaryText);
        let isDuplicate = false;
        if (setA.size >= (userMatch ? 6 : 1)) {
            for (let i = 0; i < resultSets.length; i++) {
                if (jaccardSimilaritySets(setA, resultSets[i]) > threshold) {
                    isDuplicate = true;
                    break;
                }
            }
        }
        if (!isDuplicate) {
            result.push(item);
            resultSets.push(setA);
        }
    }
    return result;
}

function condenseCodeBlocks(raw, maxKeep = 5) {
    if (!raw) return '';
    return String(raw).replace(/```([\w-]*)\n([\s\S]*?)```/g, (_, lang, code) => {
        const label = lang ? `${lang} code` : 'code';
        const keep = code
            .split('\n')
            .map(l => l.trim())
            .filter(l => /^(CREATE|ALTER|ADD COLUMN|DROP|INSERT|SELECT|def |class |@app\.|revision|op\.|git |const |function |export )/i.test(l))
            .slice(0, maxKeep);
        return keep.length > 0 ? `[${label}: ${keep.join('; ')}]` : `[${label} block]`;
    });
}

/**
 * Pre-Synthesis Pruning: Strips boilerplate, condenses verbose code blocks, and balances
 * dialogue segments when a character budget (`options.maxChars`) is provided.
 * @param {string} text - Raw content text
 * @param {object} [options={}]
 * @param {number} [options.maxChars] - Optional maximum character budget
 * @returns {string} Condensed text
 */
export function prunePreSynthesis(text = '', options = {}) {
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

    const maxChars = Number(options?.maxChars) || 0;
    if (!maxChars || cleaned.length <= maxChars) {
        return cleaned;
    }

    // Check if the memory is a structured USER / ASSISTANT turn
    const turnMatch = cleaned.match(/^([\s\S]*?\bUSER:\s*)([\s\S]*?)\s*\|\s*ASSISTANT:\s*([\s\S]*)$/i);
    if (turnMatch) {
        const prefix = turnMatch[1];
        const uRaw = turnMatch[2];
        const aRaw = turnMatch[3];
        const avail = Math.max(80, maxChars - prefix.length - 15);
        const uRatio = maxChars <= 260 ? 0.68 : 0.62;
        const uBudget = Math.floor(avail * uRatio);
        const aBudget = Math.max(30, avail - uBudget);

        const uCondText = maxChars <= 360
            ? String(uRaw).replace(/```[\s\S]*?```/g, ' ')
            : condenseCodeBlocks(uRaw, 5);
        const uCondensed = uCondText.replace(/\s+/g, ' ').trim();
        let uFinal;
        if (uCondensed.length <= uBudget) {
            uFinal = uCondensed;
        } else {
            const uDateLines = uCondText
                .split('\n')
                .map(l => l.trim().replace(/^[-*]\s*/, '').replace(/\*\*/g, '').replace(/\s*\([^)]*\)/g, ''))
                .filter(l => /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}/i.test(l));
            if (uDateLines.length >= 2 && uBudget >= 220) {
                const dateSummary = uDateLines.join(' | ');
                const remHead = uBudget - dateSummary.length - 3;
                if (remHead >= 16) {
                    uFinal = `${uCondensed.slice(0, remHead)} | ${dateSummary}`;
                } else {
                    uFinal = dateSummary.slice(-uBudget);
                }
            } else {
                uFinal = `${uCondensed.slice(0, Math.floor(uBudget * 0.78))} ... ${uCondensed.slice(-Math.floor(uBudget * 0.18))}`;
            }
        }

        const aCondText = condenseCodeBlocks(aRaw, 4);
        const aLines = aCondText.split('\n').map(l => l.trim()).filter(Boolean);
        const headingsAndDates = [];
        const priority = [];
        const secondary = [];
        for (const l of aLines) {
            const cleanLine = l.replace(/^#{1,6}\s*/, '').replace(/\*\*/g, '');
            if (/\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}/i.test(l) || /^#{1,6}\s/.test(l)) {
                headingsAndDates.push(cleanLine);
            } else if (/^(\d+\.\s+|-\s+[A-Z])/i.test(l)) {
                priority.push(cleanLine);
            } else {
                secondary.push(cleanLine);
            }
        }
        const aCombined = [...headingsAndDates.slice(0, 14), ...priority.slice(0, 12), ...secondary.slice(0, 3)].join(' | ')
            .replace(/\s{2,}/g, ' ')
            .trim();
        const aFinal = aCombined.slice(0, aBudget);
        return `${prefix}${uFinal} | ASSISTANT: ${aFinal}`;
    }

    return cleaned.slice(0, maxChars);
}

/**
 * Minimal non-redundant set cover selection for context packing.
 * @param {Array<{id: string, title?: string, content: string, score: number}>} candidates 
 * @param {string} query 
 * @param {number} [targetCount=5] 
 * @param {number} [redundancyThreshold=0.6] 
 * @returns {Array} Minimal covering set of candidates
 */
export function selectMinimalCoveringSet(candidates, query, targetCount = 5, redundancyThreshold = 0.6) {
    if (!candidates || candidates.length === 0) return [];
    const sorted = [...candidates].sort((a, b) => (b.score || 0) - (a.score || 0));
    const selected = [];

    for (const item of sorted) {
        if (selected.length >= targetCount) break;
        let isRedundant = false;
        for (const sel of selected) {
            if (computeSimilarity(item.content, sel.content) >= redundancyThreshold) {
                isRedundant = true;
                break;
            }
        }
        if (!isRedundant) {
            selected.push(item);
        }
    }

    if (selected.length < targetCount && sorted.length > selected.length) {
        for (const item of sorted) {
            if (!selected.includes(item)) {
                selected.push(item);
                if (selected.length >= targetCount) break;
            }
        }
    }
    return selected;
}

/**
 * @module setwise-engine
 * Rubric4Setwise / SetwiseEvalKit Rubric-Oriented Document-Set Selection Engine.
 * Based on HF Paper 2607.19238.
 */

/**
 * Calculates string similarity between two text snippets (Jaccard token overlap).
 * @param {string} textA 
 * @param {string} textB 
 * @returns {number} Overlap coefficient (0..1)
 */
function tokenJaccardSimilarity(textA, textB) {
    if (!textA || !textB) return 0;
    const tokensA = new Set(textA.toLowerCase().split(/\W+/).filter(t => t.length > 2));
    const tokensB = new Set(textB.toLowerCase().split(/\W+/).filter(t => t.length > 2));
    if (tokensA.size === 0 || tokensB.size === 0) return 0;

    let intersection = 0;
    for (const t of tokensA) {
        if (tokensB.has(t)) intersection++;
    }
    const union = tokensA.size + tokensB.size - intersection;
    return union > 0 ? intersection / union : 0;
}

/**
 * Selects a minimal non-redundant covering set of candidates evaluating Setwise Rubrics.
 * @param {Array<{id: string, title?: string, content: string, score: number}>} candidates 
 * @param {string} query 
 * @param {number} [targetCount=5] 
 * @param {number} [redundancyThreshold=0.6] 
 * @returns {Array} Minimal covering set of candidates
 */
export function selectMinimalCoveringSet(candidates, query, targetCount = 5, redundancyThreshold = 0.6) {
    if (!candidates || candidates.length === 0) return [];

    // Sort by initial relevance score descending
    const sorted = [...candidates].sort((a, b) => (b.score || 0) - (a.score || 0));
    const selected = [];

    for (const item of sorted) {
        if (selected.length >= targetCount) break;

        // Check redundancy against already selected setwise elements
        let isRedundant = false;
        for (const sel of selected) {
            const sim = tokenJaccardSimilarity(item.content, sel.content);
            if (sim >= redundancyThreshold) {
                isRedundant = true;
                break;
            }
        }

        if (!isRedundant) {
            selected.push(item);
        }
    }

    // If target count not reached, fill with top remaining candidates to prevent dropping essential items
    if (selected.length < targetCount && sorted.length > selected.length) {
        const selectedIds = new Set(selected.map(s => s.id));
        for (const item of sorted) {
            if (selected.length >= targetCount) break;
            if (!selectedIds.has(item.id)) {
                selected.push(item);
            }
        }
    }

    return selected;
}

/**
 * Standalone MCP tool handler for setwise rubric reranking.
 * @param {object} params
 * @param {Array} params.candidates
 * @param {string} params.query
 * @param {number} [params.target_count=5]
 * @returns {Promise<{content: Array}>}
 */
export async function setwiseRerank({ candidates, query, target_count = 5 }) {
    if (!candidates || !Array.isArray(candidates)) {
        return { content: [{ type: "text", text: "Error: candidates array is required." }] };
    }

    const filtered = selectMinimalCoveringSet(candidates, query, target_count);

    const textOutput = `## 📊 Rubric4Setwise Selection Results\n` +
        `**Original Candidates**: ${candidates.length} | **Filtered Cover Set**: ${filtered.length}\n\n` +
        filtered.map((item, idx) => `${idx + 1}. **[${item.type || 'item'}] ${item.title || item.id}** (Score: ${(item.score * 100).toFixed(1)}%)\n${item.content.trim().slice(0, 300)}...`).join('\n\n---\n\n');

    return {
        content: [{
            type: "text",
            text: textOutput
        }]
    };
}

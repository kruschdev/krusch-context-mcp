/**
 * @module llm-tags
 * Shared LLM-based tag generation for episodic memory (v1) and Company Brain (v2).
 * Extracted from generateTags (memory-engine) and generateOntologyTags (v2-engine)
 * to eliminate ARCH/01 duplication.
 */

import { ollamaQueue, PRIORITY } from './embedding-helper.js';
import { chat } from './llm.js';


/**
 * Deterministic heuristic fallback keyword extractor when no LLM (Ollama/OpenRouter) is available.
 * Extracts code identifiers, capitalized acronyms, and significant technical terms.
 * @param {string} text - The input text content.
 * @param {number} [maxTags=5] - Maximum tags to return.
 * @returns {string[]} Array of extracted tags.
 */
export function extractHeuristicTags(text, maxTags = 5) {
    if (!text || typeof text !== 'string') return [];

    const stopWords = new Set([
        'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'were', 'been',
        'what', 'when', 'where', 'which', 'will', 'would', 'there', 'their', 'about',
        'into', 'some', 'could', 'them', 'other', 'than', 'then', 'also', 'only',
        'just', 'more', 'should', 'each', 'make', 'made', 'like', 'time', 'user',
        'very', 'after', 'before', 'must', 'need', 'using', 'used', 'does', 'done',
        'true', 'false', 'null', 'undefined', 'http', 'https', 'file'
    ]);

    const tags = new Set();

    // 1. Code identifiers: camelCase, PascalCase, snake_case, kebab-case (min 3 chars)
    const codeMatches = text.match(/\b([a-z]+[A-Z][a-zA-Z0-9]*|[A-Z][a-z0-9]+[A-Z][a-zA-Z0-9]*|[a-z0-9]+_[a-z0-9_]+|[a-z0-9]+-[a-z0-9-]+)\b/g);
    if (codeMatches) {
        for (const m of codeMatches) {
            const clean = m.toLowerCase();
            if (clean.length >= 3 && !stopWords.has(clean)) {
                tags.add(clean);
                if (tags.size >= maxTags) return Array.from(tags);
            }
        }
    }

    // 2. Technical acronyms / capitalized tokens (e.g. JWT, SQL, MCP, API, DAG, RRF)
    const acronymMatches = text.match(/\b[A-Z]{2,6}\b/g);
    if (acronymMatches) {
        for (const m of acronymMatches) {
            const clean = m.toLowerCase();
            if (!stopWords.has(clean)) {
                tags.add(clean);
                if (tags.size >= maxTags) return Array.from(tags);
            }
        }
    }

    // 3. Significant technical words (4+ chars, not in stopWords)
    const words = text.toLowerCase().match(/\b[a-z]{4,}\b/g);
    if (words) {
        for (const w of words) {
            if (!stopWords.has(w)) {
                tags.add(w);
                if (tags.size >= maxTags) return Array.from(tags);
            }
        }
    }

    return Array.from(tags);
}

/**
 * Generates semantic tags from text content using a local LLM via the shared Ollama queue,
 * OpenRouter/custom completions, or deterministic heuristic fallback.
 * @param {string} text - The text content to tag.
 * @param {object} [options]
 * @param {string} [options.prompt] - Custom prompt override. Defaults to a generic keyword extraction prompt.
 * @param {boolean} [options.lowercase=false] - Normalize tags to lowercase.
 * @param {boolean} [options.asJson=false] - Return JSON.stringify(tags) instead of a raw array.
 * @returns {Promise<string[]|string|null>} Array of tags (or JSON string if asJson), or null on failure.
 */
export async function generateTagsFromLLM(text, options = {}) {
    const {
        prompt = `Extract 3 to 5 concise keywords or tags from the following text. Respond ONLY with a comma-separated list of tags, nothing else.\n\nText: "${text}"`,
        lowercase = false,
        asJson = false
    } = options;

    const openrouterKey = process.env.OPENROUTER_API_KEY;
    if (process.env.COMPLETION_URL || openrouterKey) {
        try {
            const tagModel = process.env.TAG_MODEL || (openrouterKey ? 'meta-llama/llama-3.2-3b-instruct' : 'qwen2.5-coder:1.5b');
            const responseText = await chat(
                "You are a helpful assistant that extracts keywords/tags from text.",
                prompt,
                { model: tagModel }
            );
            if (responseText) {
                let tags = responseText.split(',').map(t => t.trim()).filter(t => t.length > 0);
                if (lowercase) tags = tags.map(t => t.toLowerCase());
                if (tags.length > 0) {
                    return asJson ? JSON.stringify(tags) : tags;
                }
            }
        } catch (err) {
            console.error(`[Custom Tag] Error: ${err.message}`);
        }
    }

    try {
        const tags = await ollamaQueue.enqueue(async (endpoint) => {
            const url = `${endpoint.replace(/\/$/, '')}/api/generate`;
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: process.env.TAG_MODEL || "qwen2.5-coder:1.5b",
                    prompt,
                    stream: false
                })
            });

            if (!res.ok) throw new Error(`Status ${res.status}`);

            const data = await res.json();
            let parsed = data.response.split(',').map(t => t.trim()).filter(t => t.length > 0);
            if (lowercase) parsed = parsed.map(t => t.toLowerCase());
            return parsed;
        }, PRIORITY.MEDIUM);

        if (tags && tags.length > 0) {
            return asJson ? JSON.stringify(tags) : tags;
        }
    } catch (err) {
        // Expected when running without local Ollama (e.g. Polygres Cloud or standalone)
    }

    // Heuristic fallback: extract technical keywords/identifiers when no LLM is running
    const fallbackTags = extractHeuristicTags(text, 5);
    if (fallbackTags.length > 0) {
        const finalTags = lowercase ? fallbackTags.map(t => t.toLowerCase()) : fallbackTags;
        return asJson ? JSON.stringify(finalTags) : finalTags;
    }

    return null;
}

/**
 * @module llm-tags
 * Shared LLM-based tag generation for episodic memory (v1) and Company Brain (v2).
 * Extracted from generateTags (memory-engine) and generateOntologyTags (v2-engine)
 * to eliminate ARCH/01 duplication.
 */

import { chat } from '../../../lib/llm.js';

/**
 * Generates semantic tags from text content using SpectralQuant via the shared toolkit.
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

    try {
        let attempt = 0;
        const maxRetries = 2;
        while (attempt <= maxRetries) {
            try {
                const responseText = await chat(
                    "You are a highly efficient assistant specializing in keyword extraction.",
                    prompt,
                    {
                        provider: 'spectralquant',
                        model: 'spectralquant:latest', // SpectralQuant proxy fallback
                        temperature: 0.1,
                        maxTokens: 50
                    },
                    { timeout: 60000 }
                );

                let tags = responseText.split(',').map(t => t.trim()).filter(t => t.length > 0);
                if (lowercase) tags = tags.map(t => t.toLowerCase());
                return asJson ? JSON.stringify(tags) : tags;
            } catch (e) {
                attempt++;
                if (attempt > maxRetries) throw e;
                console.warn(`[krusch-context] Tag generation timeout/error, retrying (${attempt}/${maxRetries}): ${e.message}`);
                await new Promise(r => setTimeout(r, 2000 * attempt));
            }
        }
    } catch (err) {
        console.error(`[krusch-context] Warning: Tag generation failed: ${err.message}`);
        return null;
    }
}

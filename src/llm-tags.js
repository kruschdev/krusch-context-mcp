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
/**
 * Parses and cleans tags from LLM response, supporting comma-separated, numbered, or bulleted lists.
 * @param {string} responseText
 * @returns {string[]} Array of cleaned tags
 */
function parseTags(responseText) {
    if (!responseText) return [];
    let tags = [];
    if (responseText.includes(',')) {
        tags = responseText.split(',').map(t => t.trim());
    } else {
        tags = responseText.split('\n').map(t => t.trim());
    }
    return tags
        .map(t => t.replace(/^(?:\d+[\.)]\s*|[-\*]\s*)/, '').trim())
        .filter(t => t.length > 0 && !t.toLowerCase().startsWith('here are') && !t.toLowerCase().startsWith('keywords:'));
}

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

                let tags = parseTags(responseText);
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
        console.warn(`[krusch-context] Warning: SpectralQuant tag generation failed: ${err.message}. Trying local Ollama fallback...`);
        try {
            const ollamaUrlEnv = process.env.OLLAMA_URL || 'http://127.0.0.1:11435';
            const ollamaUrlArray = ollamaUrlEnv.split(',').map(u => u.trim());
            const ollamaBaseUrl = ollamaUrlArray[Math.floor(Math.random() * ollamaUrlArray.length)];
            const ollamaUrl = ollamaBaseUrl.endsWith('/') 
                ? `${ollamaBaseUrl}v1/chat/completions` 
                : `${ollamaBaseUrl}/v1/chat/completions`;

            const responseText = await chat(
                "You are a highly efficient assistant specializing in keyword extraction.",
                prompt,
                {
                    provider: 'ollama',
                    model: 'llama3.2:1b', // Fast fallback model
                    apiUrl: ollamaUrl,
                    temperature: 0.1,
                    maxTokens: 50
                },
                { timeout: 30000 }
            );

            let tags = parseTags(responseText);
            if (lowercase) tags = tags.map(t => t.toLowerCase());
            return asJson ? JSON.stringify(tags) : tags;
        } catch (fallbackErr) {
            console.error(`[krusch-context] Error: Tag generation fallback failed: ${fallbackErr.message}`);
            return null;
        }
    }
}

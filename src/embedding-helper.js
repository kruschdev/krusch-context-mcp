import dotenv from 'dotenv';
import { getEmbedding as pgGitGetEmbedding, PRIORITY } from 'pg-git-mcp/lib/embedding.js';

dotenv.config();

export { PRIORITY };

/**
 * Custom local wrapper for getEmbedding to support custom embedding endpoints (e.g., OpenAI-compatible, llama.cpp, etc.)
 */
export async function getEmbedding(text, priority = PRIORITY.LOW) {
    const customUrl = process.env.EMBEDDING_URL;
    const apiKey = process.env.EMBEDDING_API_KEY || null;
    const model = process.env.EMBED_MODEL || 'bge-large';

    if (customUrl) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 60000); // 60s timeout
            
            // Determine if it's an OpenAI-compatible /v1/embeddings or custom llama.cpp /embedding
            const isStandardOpenAI = customUrl.includes('/v1/embeddings');
            const isLlamaCppRaw = customUrl.endsWith('/embedding');
            
            let bodyPayload;
            if (isStandardOpenAI) {
                bodyPayload = {
                    model,
                    input: text
                };
            } else if (isLlamaCppRaw) {
                bodyPayload = {
                    content: text
                };
            } else {
                // Fallback: try standard input
                bodyPayload = {
                    input: text
                };
            }

            const headers = { 'Content-Type': 'application/json' };
            if (apiKey) {
                headers['Authorization'] = `Bearer ${apiKey}`;
            }

            const res = await fetch(customUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify(bodyPayload),
                signal: controller.signal
            });
            
            clearTimeout(timeoutId);
            
            if (!res.ok) {
                const errText = await res.text();
                throw new Error(`Status ${res.status}: ${errText}`);
            }
            
            const data = await res.json();
            
            // Parse response based on format
            if (isStandardOpenAI) {
                // OpenAI returns { data: [ { embedding: [...] } ] }
                if (data.data && data.data[0] && data.data[0].embedding) {
                    return data.data[0].embedding;
                }
            } else if (isLlamaCppRaw) {
                // llama.cpp /embedding returns { embedding: [...] }
                if (data.embedding) {
                    return data.embedding;
                }
            } else {
                // Fallback parse: check embedding array or data.data
                if (data.embedding) return data.embedding;
                if (data.data && data.data[0] && data.data[0].embedding) return data.data[0].embedding;
            }
            
            throw new Error("Could not parse embedding array from custom response");
        } catch (e) {
            console.error(`[Custom Embed] Error: ${e.message}`);
            return null;
        }
    }

    // Fallback to standard pg-git-mcp getEmbedding
    return pgGitGetEmbedding(text, priority);
}

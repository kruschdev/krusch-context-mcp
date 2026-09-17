import dotenv from 'dotenv';
import { PRIORITY, ollamaQueue } from './llm-queue.js';

dotenv.config();

export { PRIORITY, ollamaQueue };

/**
 * Standard local Ollama embedding with queueing and retry.
 */
export async function getOllamaEmbedding(text, priority = PRIORITY.LOW) {
    try {
        return await ollamaQueue.enqueue(async (endpoint) => {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 60000);
            try {
                const model = process.env.EMBED_MODEL || 'bge-large';
                const res = await fetch(`${endpoint}/api/embeddings`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        model, 
                        prompt: text,
                        truncate: true
                    }),
                    signal: controller.signal
                });
                if (res.ok) {
                    const data = await res.json();
                    return data.embedding;
                } else {
                    const errText = await res.text();
                    throw new Error(`Status ${res.status}: ${errText}`);
                }
            } finally {
                clearTimeout(timeoutId);
            }
        }, priority);
    } catch (e) {
        console.error(`[Ollama Embed] ${e.message}`);
        return null;
    }
}


// Blocked hosts/ranges to prevent SSRF against internal services and cloud metadata endpoints.
const BLOCKED_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '169.254.169.254']);
function isPrivateHost(hostname) {
    const h = hostname.toLowerCase();
    if (BLOCKED_HOSTS.has(h)) return true;
    return /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
}
function isSafeEmbeddingUrl(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        if (!['http:', 'https:'].includes(parsed.protocol)) return false;
        if (isPrivateHost(parsed.hostname)) return false;
        return true;
    } catch {
        return false;
    }
}

/**
 * Custom local wrapper for getEmbedding to support custom embedding endpoints (e.g., OpenAI-compatible, llama.cpp, etc.)
 */
export async function getEmbedding(text, priority = PRIORITY.LOW) {
    const customUrl = process.env.EMBEDDING_URL;
    const apiKey = process.env.EMBEDDING_API_KEY || null;
    const model = process.env.EMBED_MODEL || 'bge-large';

    if (customUrl && !isSafeEmbeddingUrl(customUrl)) {
        console.error('[Custom Embed] Error: EMBEDDING_URL is invalid or points to a disallowed host, falling back to local Ollama');
        return getOllamaEmbedding(text, priority);
    }

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

    // Fallback to local Ollama getEmbedding
    return getOllamaEmbedding(text, priority);
}

const TEXT_EXTENSIONS = new Set([
    '.js', '.ts', '.jsx', '.tsx', '.json', '.md', '.txt',
    '.html', '.css', '.yml', '.yaml', '.sql', '.py', '.sh',
    '.toml', '.env', '.dockerfile', '.graphql', '.vue', '.svelte'
]);

export function isEmbeddable(ext) {
    return TEXT_EXTENSIONS.has(ext);
}

export const MAX_EMBED_CHARS = 2000;

function calculateCentroid(vectors) {
    if (!vectors || vectors.length === 0) return null;
    if (vectors.length === 1) return vectors[0];
    
    const len = vectors[0].length;
    let centroid = new Array(len).fill(0);
    
    for (const vec of vectors) {
        for (let i = 0; i < len; i++) {
            centroid[i] += vec[i];
        }
    }
    
    let sqSum = 0;
    for (let i = 0; i < len; i++) {
        sqSum += centroid[i] * centroid[i];
    }
    
    const norm = Math.sqrt(sqSum);
    if (norm === 0) return centroid;
    
    for (let i = 0; i < len; i++) {
        centroid[i] = centroid[i] / norm;
    }
    
    return centroid;
}

export async function getChunkedCentroidEmbedding(text, priority = PRIORITY.LOW) {
    const CHUNK_SIZE = 950;
    const OVERLAP = 150;
    const BATCH_SIZE = ollamaQueue.concurrency || 2;
    
    if (text.length <= CHUNK_SIZE) {
        return await getEmbedding(text, priority);
    }
    
    const chunks = [];
    let start = 0;
    while (start < text.length) {
        chunks.push(text.substring(start, start + CHUNK_SIZE));
        start += (CHUNK_SIZE - OVERLAP);
    }
    
    const maxChunks = Math.min(chunks.length, 50);
    const vectors = [];
    
    for (let i = 0; i < maxChunks; i += BATCH_SIZE) {
        const batch = chunks.slice(i, Math.min(i + BATCH_SIZE, maxChunks));
        const results = await Promise.all(
            batch.map(chunk => getEmbedding(chunk, priority))
        );
        for (const vec of results) {
            if (vec) vectors.push(vec);
        }
    }
    
    return calculateCentroid(vectors);
}



import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { PRIORITY, ollamaQueue } from './llm-queue.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

export { PRIORITY, ollamaQueue };

const embeddingCache = new Map();
const MAX_EMBED_CACHE = 256;

export function clearEmbeddingCache() {
    embeddingCache.clear();
}

function getCachedEmbedding(key) {
    if (!embeddingCache.has(key)) return null;
    const val = embeddingCache.get(key);
    // Refresh LRU order
    embeddingCache.delete(key);
    embeddingCache.set(key, val);
    return val;
}

function setCachedEmbedding(key, vec) {
    if (!vec || !Array.isArray(vec)) return;
    if (embeddingCache.size >= MAX_EMBED_CACHE) {
        const oldestKey = embeddingCache.keys().next().value;
        embeddingCache.delete(oldestKey);
    }
    embeddingCache.set(key, vec);
}

export const MAX_EMBED_CHARS = 2000;
const OLLAMA_CHUNK_CHARS = 1400;
const OLLAMA_CHUNK_OVERLAP = 200;
const OLLAMA_MAX_WINDOWS = 8;

const EMBEDDING_PROVIDER_ENV_KEYS = [
    'OPENROUTER_API_KEY',
    'EMBEDDING_URL',
    'OLLAMA_URL',
    'OLLAMA_BASE_URL',
    'OLLAMA_FLEET_URLS',
    'OLLAMA_NODES'
];

/**
 * Returns true when any cloud, custom, or local Ollama embedding provider env var is configured.
 * @param {Record<string, string | undefined>} [env=process.env]
 * @returns {boolean}
 */
export function isEmbeddingProviderConfigured(env = process.env) {
    if (!env || typeof env !== 'object') return false;
    for (const key of EMBEDDING_PROVIDER_ENV_KEYS) {
        const val = env[key];
        if (typeof val === 'string' && val.trim().length > 0) {
            return true;
        }
    }
    return false;
}

function isOllamaEnvConfigured(env = process.env) {
    if (!env || typeof env !== 'object') return false;
    return Boolean(
        (typeof env.OLLAMA_URL === 'string' && env.OLLAMA_URL.trim()) ||
        (typeof env.OLLAMA_BASE_URL === 'string' && env.OLLAMA_BASE_URL.trim()) ||
        (typeof env.OLLAMA_FLEET_URLS === 'string' && env.OLLAMA_FLEET_URLS.trim()) ||
        (typeof env.OLLAMA_NODES === 'string' && env.OLLAMA_NODES.trim())
    );
}

/**
 * Internal single-chunk Ollama embedding request with configurable abort timeout.
 */
async function _embedSingleOllamaChunk(chunkText, priority = PRIORITY.LOW) {
    if (!chunkText || typeof chunkText !== 'string' || !chunkText.trim()) {
        return null;
    }
    const timeoutMs = Math.max(500, Number(process.env.OLLAMA_EMBED_TIMEOUT_MS) || 8000);
    try {
        return await ollamaQueue.enqueue(async (endpoint) => {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const model = process.env.EMBED_MODEL || process.env.EMBEDDING_MODEL || 'bge-large';
                const res = await fetch(`${endpoint}/api/embeddings`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model,
                        prompt: chunkText,
                        truncate: true,
                        keep_alive: -1
                    }),
                    signal: controller.signal
                });
                if (res.ok) {
                    const data = await res.json();
                    return validateVectorDimension(data.embedding, 'Ollama Embed');
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

/**
 * Standard local Ollama embedding with fast offline bypass, queueing, and overlapping chunk centroiding.
 */
export async function getOllamaEmbedding(text, priority = PRIORITY.LOW) {
    if (!text || typeof text !== 'string' || !text.trim()) {
        return null;
    }
    if (!isOllamaEnvConfigured(process.env) && (!ollamaQueue.endpoints || ollamaQueue.endpoints.length === 0)) {
        return null;
    }
    if (text.length > MAX_EMBED_CHARS) {
        const step = OLLAMA_CHUNK_CHARS - OLLAMA_CHUNK_OVERLAP;
        const windows = [];
        for (let start = 0; start < text.length && windows.length < OLLAMA_MAX_WINDOWS; start += step) {
            const slice = text.slice(start, start + OLLAMA_CHUNK_CHARS);
            if (slice.trim()) {
                windows.push(slice);
            }
            if (start + OLLAMA_CHUNK_CHARS >= text.length) {
                break;
            }
        }
        const maxCoveredEnd = (OLLAMA_MAX_WINDOWS - 1) * step + OLLAMA_CHUNK_CHARS;
        if (windows.length === OLLAMA_MAX_WINDOWS && text.length > maxCoveredEnd) {
            const tailSlice = text.slice(text.length - OLLAMA_CHUNK_CHARS);
            if (tailSlice.trim()) {
                windows[OLLAMA_MAX_WINDOWS - 1] = tailSlice;
            }
        }
        if (windows.length === 0) return null;
        if (windows.length === 1) {
            return await _embedSingleOllamaChunk(windows[0], priority);
        }
        const batchSize = Math.max(1, ollamaQueue.concurrency || 2);
        const vectors = [];
        for (let i = 0; i < windows.length; i += batchSize) {
            const batch = windows.slice(i, i + batchSize);
            const results = await Promise.all(
                batch.map((chunk) => _embedSingleOllamaChunk(chunk, priority))
            );
            for (const vec of results) {
                if (vec) vectors.push(vec);
            }
        }
        if (vectors.length === 0) return null;
        const centroid = calculateCentroid(vectors);
        return validateVectorDimension(centroid, 'Ollama Chunked Embed');
    }
    return await _embedSingleOllamaChunk(text, priority);
}


/**
 * Canonical single source of truth for embedding vector dimension.
 * Defaults to 1024 (matching bge-large / baai/bge-large-en-v1.5 and sovereign db schema).
 */
export function getConfiguredEmbeddingDim() {
    if (process.env.EMBED_DIMS) {
        const parsed = parseInt(process.env.EMBED_DIMS, 10);
        if (!isNaN(parsed) && parsed > 0) return parsed;
    }
    if (process.env.EMBEDDING_DIM) {
        const parsed = parseInt(process.env.EMBEDDING_DIM, 10);
        if (!isNaN(parsed) && parsed > 0) return parsed;
    }
    return 1024;
}

/**
 * Runtime dimension assertion protecting database tables from poison rows of mismatched dimension.
 */
export function validateVectorDimension(vector, context = 'Embedding') {
    if (!vector || !Array.isArray(vector)) return null;
    const expectedDim = getConfiguredEmbeddingDim();
    if (vector.length !== expectedDim) {
        const msg = `[${context} Dimension Mismatch] Provider returned ${vector.length} dimensions, but configured EMBED_DIMS is ${expectedDim}. Rejected vector to prevent corrupting database columns. Run db/migrate_dimensions.sql or update EMBED_DIMS in .env.`;
        console.error(msg);
        throw new Error(msg);
    }
    return vector;
}

/**
 * Detect active embedding provider metadata.
 */
export function getEmbeddingProvider() {
    const dimensions = getConfiguredEmbeddingDim();
    if (!isEmbeddingProviderConfigured()) {
        return {
            provider: 'offline',
            model: 'none',
            dimensions,
            name: 'Zero-GPU Offline (Lexical + IDF)'
        };
    }
    const openrouterKey = process.env.OPENROUTER_API_KEY;
    const customUrl = process.env.EMBEDDING_URL;
    if ((typeof openrouterKey === 'string' && openrouterKey.trim()) || (customUrl && customUrl.includes('openrouter.ai'))) {
        const rawModel = process.env.EMBED_MODEL || process.env.EMBEDDING_MODEL;
        const isLocalBge = !rawModel || rawModel === 'bge-large' || rawModel === 'bge-large:latest';
        const model = (!customUrl && isLocalBge) ? 'baai/bge-large-en-v1.5' : (rawModel || 'baai/bge-large-en-v1.5');
        return { provider: 'openrouter', model, dimensions, name: `OpenRouter Cloud (${model}, ${dimensions}d)` };
    }
    if (typeof customUrl === 'string' && customUrl.trim()) {
        const model = process.env.EMBED_MODEL || process.env.EMBEDDING_MODEL || 'custom';
        return { provider: 'custom', model, dimensions, name: `Custom Endpoint (${model}, ${dimensions}d)` };
    }
    const model = process.env.EMBED_MODEL || process.env.EMBEDDING_MODEL || 'bge-large';
    return { provider: 'ollama', model, dimensions, name: `Local Ollama (${model}, ${dimensions}d)` };
}

/**
 * Custom local wrapper for getEmbedding to support custom embedding endpoints (OpenRouter, OpenAI-compatible, llama.cpp, etc.)
 */
export async function getEmbedding(text, priority = PRIORITY.LOW) {
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
        return null;
    }
    const openrouterKey = process.env.OPENROUTER_API_KEY;
    const customUrl = process.env.EMBEDDING_URL || (openrouterKey ? 'https://openrouter.ai/api/v1/embeddings' : null);
    const apiKey = process.env.EMBEDDING_API_KEY || openrouterKey || null;
    const rawModel = process.env.EMBED_MODEL || process.env.EMBEDDING_MODEL;
    const isOpenRouterUrl = customUrl && customUrl.includes('openrouter.ai');
    const isLocalBge = !rawModel || rawModel === 'bge-large' || rawModel === 'bge-large:latest';
    const model = (isOpenRouterUrl && isLocalBge) ? 'baai/bge-large-en-v1.5' : (rawModel || (openrouterKey ? 'baai/bge-large-en-v1.5' : 'bge-large'));
    const dim = getConfiguredEmbeddingDim();
    const providerConfigured = isEmbeddingProviderConfigured();
    const useDeterministicMock =
        process.env.MOCK_EMBEDDINGS === '1' ||
        (
            Boolean(process.env.CI || process.env.NODE_ENV === 'test') &&
            process.env.KRUSCH_FORCE_REAL_OFFLINE !== '1' &&
            !providerConfigured
        );
    const ollamaScope = process.env.OLLAMA_URL || process.env.OLLAMA_BASE_URL || process.env.OLLAMA_FLEET_URLS || process.env.OLLAMA_NODES || 'queue';
    const cacheScope = customUrl || (useDeterministicMock ? 'mock' : (providerConfigured ? `ollama:${ollamaScope}` : 'offline'));
    const cacheKey = `${dim}:${cacheScope}:${model}:${text}`;

    // Use LRU cache when not intercepting globalThis.fetch in custom endpoint unit tests
    if (!process.env.EMBEDDING_URL && !process.env.OPENROUTER_API_KEY) {
        const cached = getCachedEmbedding(cacheKey);
        if (cached) return cached;
    }

    if (customUrl) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout
            
            // Determine if it's an OpenAI-compatible /v1/embeddings or custom llama.cpp /embedding
            const isStandardOpenAI = customUrl.includes('/v1/embeddings') || customUrl.includes('openrouter.ai');
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
            if (customUrl && customUrl.includes('openrouter.ai')) {
                headers['HTTP-Referer'] = 'https://github.com/kruschdev/krusch-context-mcp';
                headers['X-Title'] = 'Krusch Context MCP';
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
            
            let rawVector = null;
            if (isStandardOpenAI) {
                // OpenAI returns { data: [ { embedding: [...] } ] }
                if (data.data && data.data[0] && data.data[0].embedding) {
                    rawVector = data.data[0].embedding;
                }
            } else if (isLlamaCppRaw) {
                // llama.cpp /embedding returns { embedding: [...] }
                if (data.embedding) {
                    rawVector = data.embedding;
                }
            } else {
                // Fallback parse: check embedding array or data.data
                if (data.embedding) rawVector = data.embedding;
                else if (data.data && data.data[0] && data.data[0].embedding) rawVector = data.data[0].embedding;
            }
            
            if (rawVector) {
                const validated = validateVectorDimension(rawVector, 'Custom Embed');
                setCachedEmbedding(cacheKey, validated);
                return validated;
            }
            
            throw new Error("Could not parse embedding array from custom response");
        } catch (e) {
            console.error(`[Custom Embed] Error: ${e.message} (falling back to local Ollama)`);
        }
    }

    // Headless / CI fast bypass when mock embeddings requested or running in unconfigured CI/test mode
    if (useDeterministicMock) {
        const detVec = generateDeterministicVector(text, dim);
        setCachedEmbedding(cacheKey, detVec);
        return detVec;
    }

    // Fallback to local Ollama getEmbedding (returns null cleanly if offline/unconfigured)
    const vec = await getOllamaEmbedding(text, priority);
    if (vec) {
        setCachedEmbedding(cacheKey, vec);
        return vec;
    }

    return null;
}

/**
 * Generate a deterministic unit vector from text hash for offline/CI evaluation
 * @param {string} text 
 * @param {number} dim 
 * @returns {number[]}
 */
export function generateDeterministicVector(text, dim = 1024) {
    if (!text || typeof text !== 'string') return new Array(dim).fill(0);
    const hash = crypto.createHash('sha256').update(text).digest();
    const vec = new Array(dim);
    let norm = 0;
    for (let i = 0; i < dim; i++) {
        const b1 = hash[(i * 2) % hash.length];
        const b2 = hash[(i * 2 + 1) % hash.length];
        const val = (((b1 << 8) | b2) / 65535) * 2 - 1;
        vec[i] = val;
        norm += val * val;
    }
    const magnitude = Math.sqrt(norm) || 1;
    for (let i = 0; i < dim; i++) {
        vec[i] = Number((vec[i] / magnitude).toFixed(6));
    }
    return vec;
}

const TEXT_EXTENSIONS = new Set([
    '.js', '.ts', '.jsx', '.tsx', '.json', '.md', '.txt',
    '.html', '.css', '.yml', '.yaml', '.sql', '.py', '.sh',
    '.toml', '.env', '.dockerfile', '.graphql', '.vue', '.svelte'
]);

export function isEmbeddable(ext) {
    return TEXT_EXTENSIONS.has(ext);
}

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
    const CHUNK_SIZE = 700;
    const OVERLAP = 100;
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



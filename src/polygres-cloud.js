/**
 * @module polygres-cloud
 * Polygres Cloud Runtime 0.5.0 Integration for krusch-context-mcp.
 * 
 * Provides:
 * 1. Live microcredit quota tracking (/embeddings/usage)
 * 2. Pure text-in zero-client semantic search (/context/collections/.../search)
 * 3. Discovery of in-database embedding models (/embeddings/models)
 * 4. Engine capabilities & HNSW limits (/context/capabilities)
 * 5. Watched table automated embedding pipelines (/embeddings/configurations)
 */

import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

const DEFAULT_TIMEOUT_MS = 30000;

function getConfig() {
    return {
        runtimeUrl: process.env.POLYGRES_RUNTIME_URL || null,
        apiKey: process.env.POLYGRES_API_KEY || null,
        projectId: process.env.POLYGRES_PROJECT_ID || null
    };
}

/**
 * Execute request to Polygres Cloud Runtime API
 * @param {string} endpoint 
 * @param {object} [options]
 * @returns {Promise<any>}
 */
export async function polygresCloudRequest(endpoint, { method = 'GET', body = null, headers = {} } = {}) {
    const { runtimeUrl, apiKey } = getConfig();
    if (!runtimeUrl || !apiKey) {
        throw new Error('Polygres Cloud requires POLYGRES_RUNTIME_URL and POLYGRES_API_KEY to be configured in .env');
    }

    const cleanBase = runtimeUrl.replace(/\/+$/, '');
    const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    const url = `${cleanBase}${cleanEndpoint}`;

    const reqHeaders = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        ...headers
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    try {
        const res = await fetch(url, {
            method,
            headers: reqHeaders,
            body: body ? JSON.stringify(body) : undefined,
            signal: controller.signal
        });

        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const msg = data?.error?.message || data?.detail || `HTTP ${res.status}: ${res.statusText}`;
            const err = new Error(`[Polygres Cloud] ${msg}`);
            err.status = res.status;
            err.data = data;
            throw err;
        }
        return data;
    } finally {
        clearTimeout(timeoutId);
    }
}

/**
 * Fetch active embedding microcredit quota and consumption
 * @returns {Promise<object>}
 */
export async function getCloudUsage() {
    const usage = await polygresCloudRequest('/embeddings/usage');
    const genIncluded = Number(usage.generation?.included_microcredits || 0);
    const genUsed = Number(usage.generation?.used_microcredits || 0);
    const genRemaining = Number(usage.generation?.remaining_microcredits || 0);

    const queryIncluded = Number(usage.query?.included_microcredits || 0);
    const queryUsed = Number(usage.query?.used_microcredits || 0);
    const queryRemaining = Number(usage.query?.remaining_microcredits || 0);

    const summaryText = [
        `Polygres Cloud Usage (Period: ${usage.period_start} to ${usage.period_end})`,
        `Policy: ${usage.policy_version} | Status: ${usage.period_kind.toUpperCase()}`,
        `• Generation: ${(genRemaining / 1e6).toFixed(2)}M / ${(genIncluded / 1e6).toFixed(2)}M microcredits remaining (${(genUsed / 1e6).toFixed(2)}M used)`,
        `• Query: ${(queryRemaining / 1e6).toFixed(2)}M / ${(queryIncluded / 1e6).toFixed(2)}M microcredits remaining (${(queryUsed / 1e6).toFixed(2)}M used)`
    ].join('\n');

    return {
        ...usage,
        summaryText
    };
}

/**
 * Discover in-database embedding models and dimensions
 * @returns {Promise<object>}
 */
export async function getCloudEmbeddingModels() {
    return polygresCloudRequest('/embeddings/models');
}

/**
 * Query pgContext engine limits and HNSW configuration
 * @returns {Promise<object>}
 */
export async function getCloudCapabilities() {
    return polygresCloudRequest('/context/capabilities');
}

/**
 * List automated background embedding configurations
 * @returns {Promise<object>}
 */
export async function listCloudEmbeddingConfigs() {
    return polygresCloudRequest('/embeddings/configurations');
}

/**
 * Perform pure text-in or vector search over a Polygres Cloud collection
 * @param {object} options
 * @param {string} [options.collection] - Target pgContext collection
 * @param {string} [options.text] - Raw search query (vectorized in-engine by Polygres)
 * @param {number[]} [options.embedding] - Optional precomputed float vector
 * @param {object} [options.filters] - Metadata filters
 * @param {number} [options.limit=10] - Number of ranked results
 * @param {string} [options.idempotencyKey]
 * @returns {Promise<object>}
 */
export async function searchCloudContext(options = {}) {
    const { collection, text, embedding, filters = {}, limit = 10, idempotencyKey } = options;
    const body = {
        limit,
        filters
    };
    if (text) body.text = text;
    if (embedding) body.embedding = embedding;

    const headers = idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {};
    const endpoint = collection
        ? `/context/collections/by-name/${encodeURIComponent(collection)}/search`
        : '/embeddings/search';

    return polygresCloudRequest(endpoint, {
        method: 'POST',
        body,
        headers
    });
}

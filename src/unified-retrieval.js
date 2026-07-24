/**
 * @module unified-retrieval
 * Polygres-inspired Unified Context Retrieval Engine for krusch-context-mcp.
 * Implements:
 * 1. HNSW Vector Seed Search (via pgcontext / pgvector)
 * 2. Multi-Hop Relational Graph Traversal (graph_hops = 0, 1, 2)
 * 3. Combined Recency × Relevance Scoring
 * 4. Server-Side Token Budget Accumulator (limit_tokens)
 */

import { pool } from 'pg-git-mcp/db/pool.js';
import { getEmbedding } from './embedding-helper.js';
import { isPgContextEnabled } from './pgcontext-helper.js';
import { searchBlobs } from 'pg-git-mcp/server/git-engine.js';
import { selectMinimalCoveringSet } from './setwise-engine.js';

const DECAY_RATE = 0.01; // Exponential time decay rate per day

/**
 * Estimates token count for a text string (~4 characters per token).
 * @param {string} text 
 * @returns {number} Estimated token count
 */
export function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
}

/**
 * Packs ranked context items into a single Markdown payload respecting limit_tokens.
 * @param {Array<{type: string, title: string, content: string, score: number}>} items 
 * @param {number} limitTokens 
 * @returns {{contextText: string, packedCount: number, totalTokens: number}}
 */
export function packTokenBudget(items, limitTokens = 4000) {
    const sorted = [...items].sort((a, b) => b.score - a.score);
    
    let currentTokens = 0;
    const packed = [];
    
    for (const item of sorted) {
        const header = `### [${item.type.toUpperCase()}] ${item.title} (Relevance: ${(item.score * 100).toFixed(1)}%)\n`;
        const body = item.content.trim() + '\n\n';
        const itemTokens = estimateTokens(header + body);
        
        if (currentTokens + itemTokens > limitTokens && packed.length > 0) {
            break; // Stop packing once budget is reached
        }
        
        packed.push(header + body);
        currentTokens += itemTokens;
    }

    const contextText = packed.join('---\n');
    return {
        contextText,
        packedCount: packed.length,
        totalTokens: currentTokens
    };
}

/**
 * Extracts potential file paths or entity links referenced in text content.
 * @param {string} content 
 * @returns {string[]} File paths or references
 */
function extractEntityLinks(content) {
    if (!content) return [];
    // Match unix paths like /path/to/file or relative src/file.ext
    const pathRegex = /(?:\/[\w.-]+)+|(?:[\w.-]+\/(?:[\w.-]+\/)*[\w.-]+\.[a-zA-Z0-9]+)/g;
    const matches = content.match(pathRegex) || [];
    return [...new Set(matches)].filter(m => m.length > 3);
}

/**
 * Retrieves seed episodic memories from PostgreSQL.
 * @param {number[]} embeddingArray 
 * @param {string|null} project 
 * @param {number} limit 
 * @returns {Promise<Array>}
 */
async function getSeedMemories(embeddingArray, project, limit = 10) {
    const client = await pool.connect();
    try {
        const embeddingStr = `[${embeddingArray.join(',')}]`;
        let query, params;
        
        if (project) {
            query = `
                SELECT id, category, content, project, tags, created_at,
                       (1 - (embedding <=> $1::vector)) as similarity,
                       EXTRACT(EPOCH FROM (NOW() - created_at))/86400 as age_days
                FROM ide_agent_memory
                WHERE (project = $2 OR project IS NULL)
                ORDER BY embedding <=> $1::vector ASC
                LIMIT $3
            `;
            params = [embeddingStr, project, limit];
        } else {
            query = `
                SELECT id, category, content, project, tags, created_at,
                       (1 - (embedding <=> $1::vector)) as similarity,
                       EXTRACT(EPOCH FROM (NOW() - created_at))/86400 as age_days
                FROM ide_agent_memory
                ORDER BY embedding <=> $1::vector ASC
                LIMIT $2
            `;
            params = [embeddingStr, limit];
        }

        const res = await client.query(query, params);
        return res.rows.map(row => {
            const decay = Math.exp(-DECAY_RATE * (row.age_days || 0));
            const score = (row.similarity || 0) * decay;
            return {
                id: `mem-${row.id}`,
                rawId: row.id,
                type: 'memory',
                title: `${row.category}${row.project ? ` (${row.project})` : ''}`,
                content: row.content,
                score,
                links: extractEntityLinks(row.content)
            };
        });
    } finally {
        client.release();
    }
}

/**
 * Retrieves seed project steering nuggets from PostgreSQL.
 * @param {number[]} embeddingArray 
 * @param {string|null} project 
 * @param {number} limit 
 * @returns {Promise<Array>}
 */
async function getSeedNuggets(embeddingArray, project, limit = 5) {
    const client = await pool.connect();
    try {
        const embeddingStr = `[${embeddingArray.join(',')}]`;
        let query = `
            SELECT id, key, value, kind, project,
                   (1 - (embedding <=> $1::vector)) as similarity
            FROM ide_agent_nuggets
            WHERE embedding IS NOT NULL
        `;
        const params = [embeddingStr];

        if (project) {
            query += ` AND (project = $2 OR project IS NULL OR kind = 'global')`;
            params.push(project);
        }
        query += ` ORDER BY embedding <=> $1::vector ASC LIMIT $${params.length + 1}`;
        params.push(limit);

        const res = await client.query(query, params);
        return res.rows.map(row => ({
            id: `nugget-${row.id}`,
            type: 'nugget',
            title: `Steering Nugget: ${row.key}`,
            content: row.value,
            score: (row.similarity || 0.8) * 1.1, // Small preference boost for nudges
            links: extractEntityLinks(row.value)
        }));
    } catch (_) {
        return [];
    } finally {
        client.release();
    }
}

/**
 * Performs Multi-Hop Graph Traversal to resolve linked codebase snippets and parent references.
 * @param {Array} seedItems 
 * @param {number} hops 
 * @returns {Promise<Array>} Expanded items including graph neighbors
 */
async function traverseGraphNeighbors(seedItems, hops = 1) {
    if (hops <= 0) return seedItems;

    const visitedIds = new Set(seedItems.map(i => i.id));
    const extraItems = [];

    for (const seed of seedItems) {
        if (!seed.links || seed.links.length === 0) continue;

        for (const refPath of seed.links) {
            const graphNodeId = `code-${refPath}`;
            if (visitedIds.has(graphNodeId)) continue;
            visitedIds.add(graphNodeId);

            try {
                // Hop 1: Code blob lookup via pg-git-mcp
                const blobs = await searchBlobs(refPath, 1);
                if (blobs && blobs.length > 0) {
                    const blob = blobs[0];
                    extraItems.push({
                        id: graphNodeId,
                        type: 'code_graph_neighbor',
                        title: `Graph Hop [1]: ${blob.path || refPath}`,
                        content: blob.content || blob.summary || `Referenced file: ${refPath}`,
                        score: seed.score * 0.85, // Hop 1 proximity decay factor
                        links: extractEntityLinks(blob.content)
                    });
                }
            } catch (_) {
                // Ignore missing file references
            }
        }
    }

    // Hop 2: Traversal from Hop 1 neighbors
    if (hops >= 2 && extraItems.length > 0) {
        const hop1Neighbors = [...extraItems];
        for (const neighbor of hop1Neighbors) {
            if (!neighbor.links || neighbor.links.length === 0) continue;
            for (const subRef of neighbor.links) {
                const subNodeId = `code-hop2-${subRef}`;
                if (visitedIds.has(subNodeId)) continue;
                visitedIds.add(subNodeId);

                try {
                    const subBlobs = await searchBlobs(subRef, 1);
                    if (subBlobs && subBlobs.length > 0) {
                        const blob = subBlobs[0];
                        extraItems.push({
                            id: subNodeId,
                            type: 'code_graph_neighbor_l2',
                            title: `Graph Hop [2]: ${blob.path || subRef}`,
                            content: blob.content || blob.summary || `2nd-degree referenced file: ${subRef}`,
                            score: neighbor.score * 0.80, // Hop 2 proximity decay factor
                            links: []
                        });
                    }
                } catch (_) {}
            }
        }
    }

    return [...seedItems, ...extraItems];
}

/**
 * Unified Context Retrieval Entry Point.
 * @param {object} params
 * @param {string} params.query - Search query
 * @param {string} [params.project] - Active project scope
 * @param {number} [params.graph_hops=1] - Hops for graph expansion (0..2)
 * @param {number} [params.limit_tokens=4000] - Hard token budget
 * @param {boolean} [params.include_code=true] - Whether to search code blobs
 * @returns {Promise<{content: Array}>} MCP Tool Output
 */
export async function unifiedRetrieve({ query, project, graph_hops = 1, limit_tokens = 4000, include_code = true, setwise_rerank = false }) {
    if (!query) return { content: [{ type: "text", text: "Error: Missing required query parameter." }] };

    // 1. Generate query embedding
    const queryEmbedding = await getEmbedding(query);
    if (!queryEmbedding) return { content: [{ type: "text", text: "Error: Failed to generate query embedding." }] };

    // 2. Fetch seed nodes (Memories + Steering Nuggets)
    const seedMemories = await getSeedMemories(queryEmbedding, project, 10);
    const seedNuggets = await getSeedNuggets(queryEmbedding, project, 5);
    
    let allCandidates = [...seedMemories, ...seedNuggets];

    // 3. Optional Direct Code Blob Search
    if (include_code) {
        try {
            const codeBlobs = await searchBlobs(query, 5);
            if (codeBlobs && Array.isArray(codeBlobs)) {
                const codeItems = codeBlobs.map((blob, idx) => ({
                    id: `code-direct-${idx}`,
                    type: 'code',
                    title: `Codebase: ${blob.path}`,
                    content: blob.content || blob.snippet || '',
                    score: 0.88 - (idx * 0.05),
                    links: extractEntityLinks(blob.content)
                }));
                allCandidates.push(...codeItems);
            }
        } catch (_) {}
    }

    // 4. Multi-Hop Graph Traversal
    let expandedGraphItems = await traverseGraphNeighbors(allCandidates, Math.min(graph_hops, 2));

    // 5. Optional Rubric4Setwise Minimal Cover Reranking
    if (setwise_rerank) {
        expandedGraphItems = selectMinimalCoveringSet(expandedGraphItems, query, 10);
    }

    // 6. Server-Side Token Budget Accumulator
    const { contextText, packedCount, totalTokens } = packTokenBudget(expandedGraphItems, limit_tokens);

    const summaryHeader = `## 🧠 Unified Context Retrieval\n` +
        `**Query**: "${query}" | **Project**: ${project || 'Global'} | **Graph Hops**: ${graph_hops} | **Setwise Rerank**: ${setwise_rerank} | **Packed**: ${packedCount} items (~${totalTokens} tokens / max ${limit_tokens})\n\n`;

    return {
        content: [{
            type: "text",
            text: summaryHeader + contextText
        }]
    };
}

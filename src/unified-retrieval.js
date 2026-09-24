/**
 * @module unified-retrieval
 * Unified Context Retrieval Engine for krusch-context-mcp.
 * Implements:
 * 1. Hybrid Semantic + Lexical Retrieval over Project Memories & Steering Nuggets
 * 2. State Briefing Integration
 * 3. Token Budget Accumulator (limit_tokens) with Strict Pruning
 * 4. Structured Citations Manifest
 */

import { pool } from '../db/pool.js';
import { getEmbedding } from './embedding-helper.js';
import { isPgContextEnabled } from './pgcontext-helper.js';
import { prunePreSynthesis } from './prune-helper.js';
import { detectCurrentProject } from './project-helper.js';
import { compileProjectState, searchMemory } from './memory-engine.js';
import { getProjectDb, cosineSimilarity } from './sqlite-engine.js';

const DECAY_RATE = 0.01;

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
 * Returns both formatted Markdown and a structured citations manifest.
 * @param {Array<{type: string, id: any, title: string, content: string, score: number, category?: string, key?: string}>} items 
 * @param {number} limitTokens 
 * @returns {{contextText: string, packedCount: number, totalTokens: number, citations: Array}}
 */
export function packTokenBudget(items, limitTokens = 4000) {
    const sorted = [...items].sort((a, b) => b.score - a.score);
    
    let currentTokens = 0;
    const packed = [];
    const citations = [];
    
    for (const item of sorted) {
        const header = `### [${item.type.toUpperCase()}] ${item.title} (Score: ${(item.score * 100).toFixed(1)}%)\n`;
        const cleanedBody = prunePreSynthesis(item.content || '').trim() + '\n\n';
        const itemTokens = estimateTokens(header + cleanedBody);
        
        if (currentTokens + itemTokens > limitTokens && packed.length > 0) {
            break; // Stop packing once budget is reached
        }
        
        packed.push(header + cleanedBody);
        currentTokens += itemTokens;
        citations.push({
            type: item.type,
            id: item.id || null,
            category: item.category || null,
            key: item.key || null,
            title: item.title,
            score: Number(item.score.toFixed(3))
        });
    }

    const contextText = packed.join('---\n');
    return {
        contextText,
        packedCount: packed.length,
        totalTokens: currentTokens,
        citations
    };
}

/**
 * Unified Context Retrieval Entry Point.
 * @param {object} args
 * @param {string} args.query - Natural language query or topic
 * @param {string} [args.mode='hybrid'] - 'hybrid' | 'memory' | 'state'
 * @param {string} [args.category] - Optional closed category filter: decision, bug, invariant, lesson, blocker
 * @param {number} [args.limit_tokens=4000] - Hard upper limit on tokens returned
 * @param {string} [args.project] - Optional project context (auto-detected if omitted)
 * @param {boolean} [args.include_state=false] - Prepend compiled project state briefing
 * @returns {Promise<{content: Array, citations: Array}>}
 */
export async function unifiedRetrieve({
    query,
    mode = 'hybrid',
    category = null,
    limit_tokens = 4000,
    project = null,
    include_state = false,
    _embedding = null
}) {
    const targetProject = project || detectCurrentProject();
    const items = [];

    // 1. If mode === 'state' or include_state is requested, compile state briefing
    let stateHeader = "";
    if (mode === 'state' || include_state) {
        const stateRes = await compileProjectState({ project: targetProject });
        const stateText = stateRes?.content?.[0]?.text || "";
        if (mode === 'state') {
            return {
                content: [{ type: "text", text: stateText }],
                citations: [{ type: "state", project: targetProject }]
            };
        }
        stateHeader = stateText + "\n\n---\n\n";
    }

    // 2. Fetch seed embedding for semantic matching (or use precomputed _embedding)
    const embeddingArray = _embedding || await getEmbedding(query);

    // 3. Search project memories from local SQLite cache
    if (targetProject) {
        try {
            const db = await getProjectDb(targetProject);
            if (db) {
                let memSql = `
                    SELECT id, category, content, tags, created_at, embedding
                    FROM ide_agent_memory
                    WHERE status = 'ACTIVE'
                `;
                const params = [];
                if (category) {
                    memSql += ` AND category = ?`;
                    params.push(category);
                }
                const rows = db.prepare(memSql).all(...params);
                for (const r of rows) {
                    let score = 0.5;
                    if (embeddingArray && r.embedding) {
                        try {
                            const vec = typeof r.embedding === 'string' ? JSON.parse(r.embedding) : r.embedding;
                            score = cosineSimilarity(embeddingArray, vec);
                        } catch {}
                    }
                    const lowerContent = r.content.toLowerCase();
                    const lowerQuery = query.toLowerCase();
                    if (lowerContent.includes(lowerQuery)) {
                        score = Math.max(score, 0.85);
                    } else {
                        // Multi-term keyword overlap
                        const terms = lowerQuery.split(/\s+/).filter(t => t.length > 2);
                        if (terms.length > 0) {
                            const matches = terms.filter(t => lowerContent.includes(t)).length;
                            if (matches > 0) {
                                const overlap = matches / terms.length;
                                score = Math.max(score, 0.5 + overlap * 0.35);
                            }
                        }
                    }
                    if (score > 0.4) {
                        items.push({
                            type: 'memory',
                            id: r.id,
                            category: r.category,
                            title: `Memory #${r.id} (${r.category})`,
                            content: r.content,
                            score
                        });
                    }
                }

                // Search steering nuggets (deduplicated by key)
                const nugRows = db.prepare(`SELECT key, value, kind FROM ide_agent_nuggets ORDER BY updated_at ASC`).all();
                const nugMap = new Map();
                for (const n of nugRows) nugMap.set(n.key, n);
                for (const n of nugMap.values()) {
                    let score = 0.4;
                    if (n.key.toLowerCase().includes(query.toLowerCase()) || n.value.toLowerCase().includes(query.toLowerCase())) {
                        score = 0.8;
                    }
                    items.push({
                        type: 'nugget',
                        key: n.key,
                        title: `Nugget: ${n.key} (${n.kind})`,
                        content: n.value,
                        score
                    });
                }
            }
        } catch (e) {
            console.warn(`[unified-retrieval] SQLite retrieval warning: ${e.message}`);
        }
    }

    // 4. Pack token budget strictly
    const availableTokens = Math.max(500, limit_tokens - estimateTokens(stateHeader));
    const packed = packTokenBudget(items, availableTokens);

    const stateBadge = (mode === 'state' || include_state) ? ' (State Included)' : '';
    const fullPayload = `${stateHeader}# 🔍 Unified Context Retrieval: "${query}"${stateBadge}\n` +
        `**Tokens**: ~${packed.totalTokens + estimateTokens(stateHeader)} / Budget: ${limit_tokens} | ` +
        `**Items Packed**: ${packed.packedCount} / ${items.length} candidates\n\n` +
        packed.contextText;

    return {

        content: [{ type: "text", text: fullPayload }],
        citations: packed.citations
    };
}

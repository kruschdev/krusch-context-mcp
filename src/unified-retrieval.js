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
import { prunePreRetrieval, prunePostRetrieval, prunePreSynthesis } from './prune-helper.js';
import { detectCurrentProject } from './project-helper.js';
import { compileProjectState, searchMemory, normalizeCategory } from './memory-engine.js';
import { getProjectDb, cosineSimilarity, getParsedEmbedding } from './sqlite-engine.js';

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
    const deduped = prunePostRetrieval(sorted, { similarityThreshold: 0.88 });
    
    let currentTokens = 0;
    const packed = [];
    const citations = [];
    
    for (const item of deduped) {
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
    const normCategory = category ? normalizeCategory(category) : null;
    const items = [];
    const rawQuery = typeof query === 'string' ? query.trim() : (query ? String(query).trim() : '*');
    const isWildcard = !rawQuery || rawQuery === '*';
    const cleanQuery = isWildcard ? '*' : prunePreRetrieval(rawQuery);
    const lowerQuery = cleanQuery.toLowerCase();
    const queryTerms = !isWildcard ? lowerQuery.split(/\s+/).filter(t => t.length > 2) : [];

    // 1. If mode === 'state' or include_state is requested, compile state briefing
    let stateHeader = "";
    let statePackedIds = new Set();
    let statePackedNuggets = new Set();
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
        if (Array.isArray(stateRes?.packedIds)) {
            statePackedIds = new Set(stateRes.packedIds);
        }
        if (Array.isArray(stateRes?.packedNuggetKeys)) {
            statePackedNuggets = new Set(stateRes.packedNuggetKeys);
        }
    }

    // 2. Fetch seed embedding for semantic matching (skip for universal wildcard)
    const embeddingArray = _embedding || (!isWildcard ? await getEmbedding(cleanQuery) : null);

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
                if (normCategory) {
                    memSql += ` AND category = ?`;
                    params.push(normCategory);
                }
                memSql += ` ORDER BY id DESC`;
                const rows = db.prepare(memSql).all(...params);
                const nowMs = Date.now();

                for (const r of rows) {
                    if (include_state && statePackedIds.has(r.id)) {
                        continue; // Avoid re-packing memories already rendered in compileProjectState
                    }
                    let score = 0.5;
                    if (isWildcard) {
                        score = 0.85;
                    } else {
                        if (embeddingArray && r.embedding) {
                            const vec = getParsedEmbedding(r.embedding);
                            if (vec) {
                                score = cosineSimilarity(embeddingArray, vec);
                            }
                        }
                        const lowerContent = r.content.toLowerCase();
                        const lowerTags = r.tags ? String(r.tags).toLowerCase() : '';
                        if (lowerContent.includes(lowerQuery)) {
                            score = Math.max(score, 0.85);
                        } else if (queryTerms.length > 0) {
                            const matches = queryTerms.filter(t => lowerContent.includes(t) || lowerTags.includes(t)).length;
                            if (matches > 0) {
                                const overlap = matches / queryTerms.length;
                                score = Math.max(score, 0.5 + overlap * 0.35);
                            }
                        }
                        // Gentle temporal recency factor (up to +0.02 for fresh records)
                        if (r.created_at) {
                            const ageDays = Math.max(0, (nowMs - new Date(r.created_at).getTime()) / 86_400_000);
                            if (Number.isFinite(ageDays)) {
                                const recencyBoost = 0.02 * Math.exp(-DECAY_RATE * ageDays);
                                score = Math.min(1.0, score + recencyBoost);
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

                // Search steering nuggets (deduplicated by key) only when not restricted to episodic memory or a specific category
                if (mode !== 'memory' && !normCategory) {
                    const nugRows = db.prepare(`SELECT key, value, kind FROM ide_agent_nuggets ORDER BY updated_at ASC`).all();
                    const nugMap = new Map();
                    for (const n of nugRows) nugMap.set(n.key, n);
                    for (const n of nugMap.values()) {
                        if (include_state && statePackedNuggets.has(n.key)) {
                            continue; // Avoid re-packing nuggets already rendered in compileProjectState
                        }
                        let score = isWildcard ? 0.85 : 0.4;
                        if (!isWildcard && (n.key.toLowerCase().includes(lowerQuery) || n.value.toLowerCase().includes(lowerQuery))) {
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
            }
        } catch (e) {
            console.warn(`[unified-retrieval] SQLite retrieval warning: ${e.message}`);
        }
    }

    // 4. Pack token budget strictly within bounded limits
    const safeLimitTokens = Math.min(Math.max(100, Number(limit_tokens) || 4000), 32000);
    const availableTokens = Math.max(100, safeLimitTokens - estimateTokens(stateHeader));
    const packed = packTokenBudget(items, availableTokens);

    const stateBadge = (mode === 'state' || include_state) ? ' (State Included)' : '';
    const fullPayload = `${stateHeader}# 🔍 Unified Context Retrieval: "${rawQuery}"${stateBadge}\n` +
        `**Tokens**: ~${packed.totalTokens + estimateTokens(stateHeader)} / Budget: ${safeLimitTokens} | ` +
        `**Items Packed**: ${packed.packedCount} / ${items.length} candidates\n\n` +
        packed.contextText;

    return {
        content: [{ type: "text", text: fullPayload }],
        citations: packed.citations
    };
}

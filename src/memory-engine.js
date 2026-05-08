import { pool } from 'pg-git/db/pool.js';
import { getEmbedding } from 'pg-git/lib/embedding.js';
import { config } from 'pg-git/config.js';
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { ollamaQueue, PRIORITY } from './llm-queue.js';
import { getProjectDb, cosineSimilarity } from './sqlite-engine.js';

const DECAY_RATE = 0.01;
const AUTO_TAG = true; // Hardcoded for context MCP

/**
 * Generates semantic tags for memory content using a local LLM.
 * @param {string} text - The text content to tag.
 * @returns {Promise<string|null>} JSON string array of tags or null if failed.
 */
async function generateTags(text) {
    try {
        return await ollamaQueue.enqueue(async (endpoint) => {
            const url = `${endpoint.replace(/\/$/, '')}/api/generate`;
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: "llama3.2",
                    prompt: `Extract 3 to 5 concise keywords or tags from the following text. Respond ONLY with a comma-separated list of tags, nothing else.\n\nText: "${text}"`,
                    stream: false
                })
            });
            
            if (!res.ok) throw new Error(`Status ${res.status}`);
            
            const data = await res.json();
            const tags = data.response.split(',').map(t => t.trim()).filter(t => t.length > 0);
            return JSON.stringify(tags);
        }, PRIORITY.MEDIUM);
    } catch (err) {
        console.error(`[krusch-context] Warning: Tag generation failed: ${err.message}`);
        return null;
    }
}

/**
 * Persists a memory to the local project-specific SQLite cache and queues for async sync.
 * @param {string} project - Project name.
 * @param {string} category - Category.
 * @param {string} content - Memory content.
 * @param {string|null} finalTags - JSON string array of tags.
 * @param {string} embeddingStr - Vector representation.
 * @returns {Promise<{content: Array}>}
 */
async function _addProjectMemory(project, category, content, finalTags, embeddingStr) {
    const db = await getProjectDb(project);
    if (!db) return { content: [{ type: "text", text: `[krusch-context] ⚠️ Project ${project} not found.` }] };
    db.prepare(`
        INSERT INTO ide_agent_memory (category, content, tags, embedding)
        VALUES (?, ?, ?, ?)
    `).run(category, content, finalTags, embeddingStr);
    
    import('./sqlite-engine.js').then(({ pushProjectMemory }) => {
        pushProjectMemory(project, db).catch(e => console.error(`[memory-engine] Async push failed for ${project}:`, e));
    });
    return { content: [{ type: "text", text: `[krusch-context] ✅ Successfully saved memory to SQLite project DB: ${project} (${category})` }] };
}

/**
 * Persists a memory to the global Postgres fleet memory store.
 * @param {string} category - Category.
 * @param {string} content - Memory content.
 * @param {string|null} finalTags - JSON string array of tags.
 * @param {string} embeddingStr - Vector representation.
 * @returns {Promise<{content: Array}>}
 */
async function _addGlobalMemory(category, content, finalTags, embeddingStr) {
    const client = await pool.connect();
    try {
        await client.query(`
            INSERT INTO ide_agent_memory (project, category, content, embedding, tags)
            VALUES (NULL, $1, $2, $3::vector, $4)
        `, [category, content, embeddingStr, finalTags]);
    } finally {
        client.release();
    }
    return { content: [{ type: "text", text: `[krusch-context] ✅ Successfully saved GLOBAL memory to category: ${category}` }] };
}

/**
 * Adds a new episodic memory to the persistent IDE database.
 * @param {object} params
 * @param {string} params.category - Category of memory ('priorities', 'bugs', 'outcomes', 'lessons', 'activity')
 * @param {string} params.content - Text content of the memory
 * @param {string[]} [params.tags] - Optional user-defined tags
 * @param {string} [params.project] - Optional project association (saves to local SQLite if provided)
 * @param {number[]} [params._embedding] - Optional pre-computed embedding to avoid redundant LLM calls
 * @returns {Promise<{content: Array}>} MCP tool response
 */
export async function addMemory({ category, content, tags, project, _embedding }) {
    if (!category || !content) throw new McpError(ErrorCode.InvalidParams, "Missing params");
    
    const embeddingArray = _embedding || await getEmbedding(content);
    if (!embeddingArray) throw new McpError(ErrorCode.InternalError, "Failed to generate embedding");

    let finalTags = tags ? JSON.stringify(tags) : null;
    if (!finalTags && AUTO_TAG) {
        finalTags = await generateTags(content);
    }

    const embeddingStr = `[${embeddingArray.join(',')}]`;

    if (project) {
        return await _addProjectMemory(project, category, content, finalTags, embeddingStr);
    }
    return await _addGlobalMemory(category, content, finalTags, embeddingStr);
}

/**
 * Performs semantic search on global Postgres memories.
 * @param {string} category - Category to search.
 * @param {number[]} embeddingArray - Query embedding vector.
 * @param {number} limit - Result count limit.
 * @returns {Promise<Array>} Ranked and decayed memory objects.
 */
async function _searchGlobalMemory(category, embeddingArray, limit) {
    const client = await pool.connect();
    try {
        const embeddingStr = `[${embeddingArray.join(',')}]`;
        const res = await client.query(`
            WITH semantic_matches AS (
                SELECT id, project, content, tags, created_at, embedding <=> $1::vector as distance
                FROM ide_agent_memory
                WHERE category = $2 AND project IS NULL
                ORDER BY embedding <=> $1::vector
                LIMIT 100
            )
            SELECT 
                id, project, content, tags, created_at,
                (1 - distance) * exp(-$4::float * EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - created_at))/86400) as similarity
            FROM semantic_matches
            ORDER BY similarity DESC
            LIMIT $3
        `, [embeddingStr, category, limit, DECAY_RATE]);
        return res.rows.map(r => ({ ...r, source: 'global' }));
    } finally {
        client.release();
    }
}

/**
 * Performs semantic search on local SQLite project memories.
 * @param {string} active_project - Target project string.
 * @param {string} category - Category to search.
 * @param {number[]} embeddingArray - Query embedding vector.
 * @param {number} limit - Result count limit.
 * @returns {Promise<Array>} Ranked and decayed memory objects.
 */
async function _searchProjectMemory(active_project, category, embeddingArray, limit) {
    if (!active_project) return [];
    const db = await getProjectDb(active_project);
    if (!db) return [];
    
    const rows = db.prepare(`SELECT id, category, content, tags, embedding, created_at FROM ide_agent_memory WHERE category = ?`).all(category);
    const now = Date.now();
    return rows.map(r => {
        let rowEmb = [];
        try { 
            const parsed = JSON.parse(r.embedding); 
            if (Array.isArray(parsed)) rowEmb = parsed;
        } catch(e) { 
            console.warn(`[krusch-context] Warning: Failed to parse JSON embedding for memory ID ${r.id}`); 
        }
        const sim = cosineSimilarity(embeddingArray, rowEmb);
        const date = r.created_at.includes('Z') ? new Date(r.created_at) : new Date(r.created_at + 'Z');
        const ageDays = (now - date.getTime()) / (1000 * 60 * 60 * 24);
        const decay = Math.exp(-DECAY_RATE * ageDays);
        return {
            id: r.id, project: active_project, content: r.content, tags: r.tags,
            created_at: r.created_at, similarity: (sim + 0.1) * decay, source: 'project'
        };
    }).sort((a, b) => b.similarity - a.similarity).slice(0, limit);
}

/**
 * Searches the persistent IDE database via semantic embeddings.
 * @param {object} params
 * @param {string} params.category - Category to search
 * @param {string} params.query - Semantic search query
 * @param {number} [params.limit=3] - Max results to return
 * @param {string} [params.active_project] - Project context for SQLite isolation
 * @param {number[]} [params._embedding] - Optional pre-computed embedding
 * @returns {Promise<{content: Array}>} MCP tool response
 */
export async function searchMemory({ category, query, limit = 3, active_project, _embedding }) {
    if (!category || !query) throw new McpError(ErrorCode.InvalidParams, "Missing params");

    const embeddingArray = _embedding || await getEmbedding(query, PRIORITY.HIGH);
    if (!embeddingArray) throw new McpError(ErrorCode.InternalError, "Failed to generate embedding");

    const pgResults = await _searchGlobalMemory(category, embeddingArray, limit);
    const sqliteResults = await _searchProjectMemory(active_project, category, embeddingArray, limit);

    const results = [...pgResults, ...sqliteResults]
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);

    if (results.length === 0) {
        return { content: [{ type: "text", text: `=== 🧠 Memory Retrieval: ${category} ===\n\nNo results found.` }] };
    }

    let output = `=== 🧠 Memory Retrieval: ${category} ===\n`;
    for (const r of results) {
        let tagsStr = '';
        if (r.tags) {
            try { tagsStr = ` [Tags: ${JSON.parse(r.tags).join(', ')}]`; } catch(e) { console.warn(`[krusch-context] Warning: Failed to parse JSON tags for memory ID ${r.id}`); }
        }
        const dateStr = r.created_at ? new Date(r.created_at).toISOString().split('T')[0] : 'unknown';
        const projectStr = r.source === 'project' ? ` | Project: ${r.project}` : ' | Global';
        output += `\n--- Match (Score: ${Number(r.similarity).toFixed(2)}) | ID: ${r.id} | Date: ${dateStr}${projectStr}${tagsStr} ---\n${r.content}\n`;
    }
    return { content: [{ type: "text", text: output }] };
}

/**
 * Lists memories without semantic search (chronological order).
 * @param {object} params
 * @param {string} params.category - Category to list
 * @param {string} [params.project] - Optional project filter
 * @param {number} [params.limit=10] - Max results to return
 * @returns {Promise<{content: Array}>} MCP tool response
 */
export async function listMemories({ category, project, limit = 10 }) {
    if (!category) throw new McpError(ErrorCode.InvalidParams, "Missing category");

    let results = [];
    
    if (project) {
        const db = await getProjectDb(project);
        if (db) {
            results = db.prepare(`SELECT id, content, tags, created_at FROM ide_agent_memory WHERE category = ? ORDER BY created_at DESC LIMIT ?`).all(category, limit);
            results = results.map(r => ({ ...r, project, source: 'project' }));
        }
    } else {
        const client = await pool.connect();
        try {
            const res = await client.query(`SELECT id, project, content, tags, created_at FROM ide_agent_memory WHERE category = $1 AND project IS NULL ORDER BY created_at DESC LIMIT $2`, [category, limit]);
            results = res.rows.map(r => ({ ...r, source: 'global' }));
        } finally {
            client.release();
        }
    }

    if (results.length === 0) {
        return { content: [{ type: "text", text: `=== 📋 Memory List: ${category} ===\n\nNo memories found.` }] };
    }

    let output = `=== 📋 Memory List: ${category} (${results.length} results) ===\n`;
    for (const r of results) {
        let tagsStr = '';
        if (r.tags) {
            try { tagsStr = ` [Tags: ${JSON.parse(r.tags).join(', ')}]`; } catch(e) { console.warn(`[krusch-context] Warning: Failed to parse JSON tags for memory ID ${r.id}`); }
        }
        const dateStr = r.created_at ? new Date(r.created_at).toISOString().split('T')[0] : 'unknown';
        const projectStr = r.source === 'project' ? ` | Project: ${r.project}` : ' | Global';
        output += `\n--- ID: ${r.id} | Date: ${dateStr}${projectStr}${tagsStr} ---\n${r.content}\n`;
    }
    return { content: [{ type: "text", text: output }] };
}

/**
 * Internal helper to delete a memory from the local SQLite project cache.
 * @param {number} id - Memory ID.
 * @param {string} source_project - Project name.
 * @returns {Promise<{content: Array}>}
 */
async function _deleteProjectMemory(id, source_project) {
    const db = await getProjectDb(source_project);
    if (!db) return { content: [{ type: "text", text: `[krusch-context] ⚠️ Project ${source_project} not found.` }] };
    
    const res = db.prepare(`DELETE FROM ide_agent_memory WHERE id = ?`).run(id);
    if (res.changes === 0) {
        return { content: [{ type: "text", text: `[krusch-context] ⚠️ No SQLite memory found with ID: ${id} in project: ${source_project}` }] };
    }
    return { content: [{ type: "text", text: `[krusch-context] 🗑️ Deleted SQLite memory ID: ${id}` }] };
}

/**
 * Internal helper to delete a memory from the global Postgres store.
 * @param {number} id - Memory ID.
 * @returns {Promise<{content: Array}>}
 */
async function _deleteGlobalMemory(id) {
    const client = await pool.connect();
    try {
        const res = await client.query(`DELETE FROM ide_agent_memory WHERE id = $1 AND project IS NULL RETURNING id`, [id]);
        if (res.rowCount === 0) {
            return { content: [{ type: "text", text: `[krusch-context] ⚠️ No Global PG memory found with ID: ${id}` }] };
        }
    } finally {
        client.release();
    }
    return { content: [{ type: "text", text: `[krusch-context] 🗑️ Deleted Global PG memory ID: ${id}` }] };
}

/**
 * Deletes a memory by ID.
 * @param {object} params
 * @param {number} params.id - ID of the memory to delete
 * @param {string} [params.source_project] - Project context for SQLite isolation
 * @returns {Promise<{content: Array}>} MCP tool response
 */
export async function deleteMemory({ id, source_project }) {
    if (!id) throw new McpError(ErrorCode.InvalidParams, "Missing memory ID");
    if (source_project) return await _deleteProjectMemory(id, source_project);
    return await _deleteGlobalMemory(id);
}

/**
 * Internal helper to update a memory in the local SQLite project cache.
 * @param {number} id - Memory ID.
 * @param {string} [content] - Optional new content.
 * @param {string[]} [tags] - Optional new tags.
 * @param {string} source_project - Project name.
 * @returns {Promise<{content: Array}>}
 */
async function _updateProjectMemory(id, content, tags, source_project) {
    const db = await getProjectDb(source_project);
    if (!db) return { content: [{ type: "text", text: `[krusch-context] ⚠️ Project ${source_project} not found.` }] };
    
    const setClauses = [];
    const params = [];
    
    if (content) {
        const embeddingArray = await getEmbedding(content);
        if (!embeddingArray) throw new McpError(ErrorCode.InternalError, "Failed to generate embedding");
        setClauses.push(`content = ?`);
        params.push(content);
        setClauses.push(`embedding = ?`);
        params.push(`[${embeddingArray.join(',')}]`);
    }
    if (tags) {
        setClauses.push(`tags = ?`);
        params.push(JSON.stringify(tags));
    }
    
    if (setClauses.length > 0) {
        params.push(id);
        const res = db.prepare(`UPDATE ide_agent_memory SET ${setClauses.join(', ')} WHERE id = ?`).run(...params);
        if (res.changes === 0) return { content: [{ type: "text", text: `[krusch-context] ⚠️ No memory found with ID: ${id} in project: ${source_project}` }] };
        return { content: [{ type: "text", text: `[krusch-context] ✏️ Updated SQLite memory ID: ${id}` }] };
    }
    return { content: [{ type: "text", text: `[krusch-context] ✏️ Project reassignment not supported for SQLite memories yet.` }] };
}

/**
 * Internal helper to update a memory in the global Postgres store.
 * @param {number} id - Memory ID.
 * @param {string} [content] - Optional new content.
 * @param {string[]} [tags] - Optional new tags.
 * @returns {Promise<{content: Array}>}
 */
async function _updateGlobalMemory(id, content, tags) {
    const client = await pool.connect();
    try {
        const setClauses = [];
        const params = [];
        let idx = 1;

        if (content) {
            const embeddingArray = await getEmbedding(content);
            if (!embeddingArray) throw new McpError(ErrorCode.InternalError, "Failed to generate embedding");
            setClauses.push(`content = $${idx++}`);
            params.push(content);
            setClauses.push(`embedding = $${idx++}::vector`);
            params.push(`[${embeddingArray.join(',')}]`);
        }
        if (tags) {
            setClauses.push(`tags = $${idx++}`);
            params.push(JSON.stringify(tags));
        }
        
        params.push(id);
        const res = await client.query(
            `UPDATE ide_agent_memory SET ${setClauses.join(', ')} WHERE id = $${idx} AND project IS NULL RETURNING id`,
            params
        );
        if (res.rowCount === 0) {
            return { content: [{ type: "text", text: `[krusch-context] ⚠️ No Global PG memory found with ID: ${id}` }] };
        }
    } finally {
        client.release();
    }
    return { content: [{ type: "text", text: `[krusch-context] ✏️ Updated Global PG memory ID: ${id}` }] };
}

/**
 * Updates an existing memory's content, tags, or project.
 * @param {object} params
 * @param {number} params.id - Memory ID to update
 * @param {string} [params.content] - New content (triggers re-embedding)
 * @param {string[]} [params.tags] - New tags
 * @param {string} [params.project] - New project assignment
 * @param {string} [params.source_project] - Project context for SQLite isolation
 * @returns {Promise<{content: Array}>} MCP tool response
 */
export async function updateMemory({ id, content, tags, project, source_project }) {
    if (!id) throw new McpError(ErrorCode.InvalidParams, "Missing memory ID");
    if (!content && !tags && (project === undefined)) {
        throw new McpError(ErrorCode.InvalidParams, "Must provide at least one field to update (content, tags, or project)");
    }

    if (source_project) return await _updateProjectMemory(id, content, tags, source_project);
    return await _updateGlobalMemory(id, content, tags);
}

/**
 * Calculates an L2-normalized centroid between two vector arrays for consolidation.
 * @param {string} embStrA - JSON string representation of vector A.
 * @param {string} embStrB - JSON string representation of vector B.
 * @returns {string} JSON string of the newly normalized centroid vector.
 */
function _calculateCentroidStr(embStrA, embStrB) {
    let arrA = [];
    let arrB = [];
    try {
        const parsedA = JSON.parse(embStrA);
        const parsedB = JSON.parse(embStrB);
        if (Array.isArray(parsedA)) arrA = parsedA;
        if (Array.isArray(parsedB)) arrB = parsedB;
    } catch(e) {}
    
    if (!arrA.length || !arrB.length) return `[]`;
    const len = Math.min(arrA.length, arrB.length);
    
    let centroid = [];
    for(let i=0; i<len; i++) {
        centroid.push(arrA[i] + arrB[i]);
    }
    
    const norm = Math.sqrt(centroid.reduce((sum, val) => sum + val * val, 0));
    if (norm === 0) return `[${centroid.join(',')}]`;
    return `[${centroid.map(val => val / norm).join(',')}]`;
}

/**
 * Consolidates matching semantic memories in the local SQLite project cache.
 * @param {string} category - Category to search within.
 * @param {string} project - Project name.
 * @param {number} threshold - Cosine distance threshold.
 * @param {boolean} dry_run - Preview without merging.
 * @returns {Promise<{content: Array}>}
 */
async function _consolidateSqlite(category, project, threshold, dry_run) {
    const db = await getProjectDb(project);
    if (!db) return { content: [{ type: "text", text: `[krusch-context] ⚠️ Project ${project} not found.` }] };
    
    const rows = db.prepare(`SELECT id, content, tags, embedding, created_at FROM ide_agent_memory WHERE category = ? AND embedding IS NOT NULL`).all(category);
    const pairs = [];
    for (let i = 0; i < rows.length; i++) {
        for (let j = i + 1; j < rows.length; j++) {
            let embA = [], embB = [];
            try { 
                const pa = JSON.parse(rows[i].embedding); 
                const pb = JSON.parse(rows[j].embedding); 
                if(Array.isArray(pa)) embA = pa;
                if(Array.isArray(pb)) embB = pb;
            } catch(e) { continue; }
            if(!embA.length || !embB.length) continue;
            
            const distance = 1 - cosineSimilarity(embA, embB);
            if (distance < threshold) {
                pairs.push({
                    id_a: rows[i].id, content_a: rows[i].content, created_a: rows[i].created_at, emb_a: rows[i].embedding,
                    id_b: rows[j].id, content_b: rows[j].content, created_b: rows[j].created_at, emb_b: rows[j].embedding,
                    distance
                });
            }
        }
    }
    
    pairs.sort((a, b) => a.distance - b.distance);
    if (pairs.length === 0) return { content: [{ type: "text", text: `[krusch-context] ✅ No duplicate SQLite memories found in category: ${category} (threshold: ${threshold})` }] };
    
    if (dry_run) {
        let output = `=== 🔍 Consolidation Preview (SQLite): ${category} (${pairs.length} pairs) ===\n`;
        for (const p of pairs) {
            output += `\n--- Distance: ${p.distance.toFixed(3)} ---\n  ID ${p.id_a}: ${p.content_a.substring(0, 100)}...\n  ID ${p.id_b}: ${p.content_b.substring(0, 100)}...\n`;
        }
        return { content: [{ type: "text", text: output }] };
    }
    
    const merged = new Set();
    let mergeCount = 0;
    for (const p of pairs) {
        if (merged.has(p.id_a) || merged.has(p.id_b)) continue;
        const keepId = p.created_a > p.created_b ? p.id_a : p.id_b;
        const dropId = keepId === p.id_a ? p.id_b : p.id_a;
        const keepContent = keepId === p.id_a ? p.content_a : p.content_b;
        const dropContent = keepId === p.id_a ? p.content_b : p.content_a;

        const mergedContent = `${keepContent}\n\n[Consolidated from ID ${dropId}]: ${dropContent}`;
        const embeddingStr = _calculateCentroidStr(p.emb_a, p.emb_b);
        
        db.prepare(`UPDATE ide_agent_memory SET content = ?, embedding = ? WHERE id = ?`).run(mergedContent, embeddingStr, keepId);
        db.prepare(`DELETE FROM ide_agent_memory WHERE id = ?`).run(dropId);
        merged.add(dropId);
        mergeCount++;
    }
    return { content: [{ type: "text", text: `[krusch-context] 🔗 Consolidated ${mergeCount} duplicate pairs in SQLite category: ${category}` }] };
}

/**
 * Consolidates matching semantic memories in the global Postgres store.
 * @param {string} category - Category to search within.
 * @param {number} threshold - Cosine distance threshold.
 * @param {boolean} dry_run - Preview without merging.
 * @returns {Promise<{content: Array}>}
 */
async function _consolidatePostgres(category, threshold, dry_run) {
    const client = await pool.connect();
    try {
        const sql = `
            WITH candidates AS (
                SELECT id, content, tags, project, created_at, embedding
                FROM ide_agent_memory
                WHERE category = $1 AND embedding IS NOT NULL AND project IS NULL
            )
            SELECT 
                a.id AS id_a, a.content AS content_a, a.created_at AS created_a, a.embedding AS emb_a,
                b.id AS id_b, b.content AS content_b, b.created_at AS created_b, b.embedding AS emb_b,
                a.embedding <=> b.embedding AS distance
            FROM candidates a
            JOIN candidates b ON a.id < b.id
            WHERE a.embedding <=> b.embedding < $2
            ORDER BY distance ASC
            LIMIT 20
        `;
        const res = await client.query(sql, [category, threshold]);
        const pairs = res.rows;

        if (pairs.length === 0) return { content: [{ type: "text", text: `[krusch-context] ✅ No duplicate Global PG memories found in category: ${category} (threshold: ${threshold})` }] };

        if (dry_run) {
            let output = `=== 🔍 Consolidation Preview (Global PG): ${category} (${pairs.length} pairs) ===\n`;
            for (const p of pairs) {
                output += `\n--- Distance: ${Number(p.distance).toFixed(3)} ---\n  ID ${p.id_a} (${new Date(p.created_a).toISOString().split('T')[0]}): ${p.content_a.substring(0, 100)}...\n  ID ${p.id_b} (${new Date(p.created_b).toISOString().split('T')[0]}): ${p.content_b.substring(0, 100)}...\n`;
            }
            return { content: [{ type: "text", text: output }] };
        }

        const merged = new Set();
        let mergeCount = 0;
        for (const p of pairs) {
            if (merged.has(p.id_a) || merged.has(p.id_b)) continue;
            const keepId = p.created_a > p.created_b ? p.id_a : p.id_b;
            const dropId = keepId === p.id_a ? p.id_b : p.id_a;
            const keepContent = keepId === p.id_a ? p.content_a : p.content_b;
            const dropContent = keepId === p.id_a ? p.content_b : p.content_a;

            const mergedContent = `${keepContent}\n\n[Consolidated from ID ${dropId}]: ${dropContent}`;
            const embeddingStr = _calculateCentroidStr(p.emb_a, p.emb_b);
            
            await client.query(`UPDATE ide_agent_memory SET content = $1, embedding = $2::vector WHERE id = $3`, [mergedContent, embeddingStr, keepId]);
            await client.query(`DELETE FROM ide_agent_memory WHERE id = $1`, [dropId]);
            merged.add(dropId);
            mergeCount++;
        }
        return { content: [{ type: "text", text: `[krusch-context] 🔗 Consolidated ${mergeCount} duplicate Global PG pairs in category: ${category}` }] };
    } finally {
        client.release();
    }
}

/**
 * Finds and merges semantically duplicate memories within a category.
 * @param {object} params
 * @param {string} params.category - Category to consolidate
 * @param {string} [params.project] - Optional project filter for SQLite consolidation
 * @param {number} [params.threshold=0.15] - Cosine distance threshold for duplicates
 * @param {boolean} [params.dry_run=false] - Preview matches without merging
 * @returns {Promise<{content: Array}>} MCP tool response
 */
export async function consolidateMemories({ category, project, threshold = 0.15, dry_run = false }) {
    if (!category) throw new McpError(ErrorCode.InvalidParams, "Missing category");
    if (project) {
        return await _consolidateSqlite(category, project, threshold, dry_run);
    }
    return await _consolidatePostgres(category, threshold, dry_run);
}

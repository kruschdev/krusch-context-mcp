import { pool } from 'pg-git-mcp/db/pool.js';
import { getEmbedding } from './embedding-helper.js';
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { getProjectDb, cosineSimilarity, pushProjectMemory } from './sqlite-engine.js';
import { isPgContextEnabled, syncPgContextPoints } from './pgcontext-helper.js';

const VALID_KINDS = new Set(['project', 'user', 'agent']);

/**
 * Store a short, durable nugget fact. UPSERTs by key.
 * @param {object} params
 * @param {string} params.key - Unique identifier for the nugget
 * @param {string} params.value - The fact content to store
 * @param {string} [params.kind='project'] - One of 'project', 'user', 'agent'
 * @param {string} [params.active_project] - Project context for SQLite isolation
 * @returns {Promise<{content: Array}>} MCP tool response
 */
export async function nuggetRemember({ key, value, kind = 'project', active_project }) {
    if (!key || !value) throw new McpError(ErrorCode.InvalidParams, "Missing key or value");
    if (!VALID_KINDS.has(kind)) throw new McpError(ErrorCode.InvalidParams, `Invalid kind: ${kind}. Must be one of: ${[...VALID_KINDS].join(', ')}`);

    const embeddingArray = await getEmbedding(value);
    if (!embeddingArray) throw new McpError(ErrorCode.InternalError, "Failed to generate embedding");
    const embeddingStr = `[${embeddingArray.join(',')}]`;

    if (kind === 'project' && active_project) {
        const localDb = await getProjectDb(active_project);
        if (localDb) {
            localDb.prepare(`
                INSERT INTO ide_agent_nuggets (key, value, kind, embedding, created_at, updated_at, pg_synced)
                VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 0)
                ON CONFLICT (key) DO UPDATE 
                SET value = excluded.value, kind = excluded.kind, embedding = excluded.embedding, updated_at = CURRENT_TIMESTAMP, pg_synced = 0
            `).run(key, value, kind, embeddingStr);
            
            // Asynchronous write-behind (Compute Cache -> Object Storage)
            pushProjectMemory(active_project, localDb).catch(e =>
                console.error(`[nuggets-engine] Async push failed for ${active_project}:`, e)
            );

            return { content: [{ type: "text", text: `[krusch-context] 🧠 Nugget remembered natively in SQLite (.agent/memory.db) for project '${active_project}': '${key}'` }] };
        }
    }

    const client = await pool.connect();
    try {
        const res = await client.query(`
            INSERT INTO ide_agent_nuggets (key, value, kind, embedding)
            VALUES ($1, $2, $3, $4::vector)
            ON CONFLICT (key) DO UPDATE 
            SET value = EXCLUDED.value, kind = EXCLUDED.kind, embedding = EXCLUDED.embedding, updated_at = CURRENT_TIMESTAMP
            RETURNING id
        `, [key, value, kind, embeddingStr]);
        if (res.rows.length > 0) {
            await syncPgContextPoints(pool, 'ide_agent_nuggets', [res.rows[0].id]);
        }
    } finally {
        client.release();
    }
    
    return { content: [{ type: "text", text: `[krusch-context] 🧠 Global Nugget remembered (Postgres): '${key}'` }] };
}


/**
 * Return short, relevant nugget facts to gently steer the agent.
 * @param {object} params
 * @param {string} params.query - Semantic search query
 * @param {string[]} [params.kinds] - Filter by kind ('project', 'user', 'agent')
 * @param {number} [params.limit=3] - Max results to return
 * @param {string} [params.active_project] - Project context for SQLite isolation
 * @returns {Promise<{content: Array}>} MCP tool response
 */
export async function nuggetNudges({ query, kinds, limit = 3, active_project, _embedding }) {
    if (!query && !_embedding) throw new McpError(ErrorCode.InvalidParams, "Missing query or embedding");

    const embeddingArray = _embedding || await getEmbedding(query);
    if (!embeddingArray) throw new McpError(ErrorCode.InternalError, "Failed to generate embedding");

    let combinedResults = [];

    // 1. Fetch from Global Postgres
    const client = await pool.connect();
    try {
        const embeddingStr = `[${embeddingArray.join(',')}]`;
        let sql = `
            SELECT key, value, kind, created_at, (embedding <=> $1::vector) as distance, 'global' as source
            FROM ide_agent_nuggets
            WHERE embedding IS NOT NULL
        `;
        let params = [embeddingStr];
        
        if (kinds && kinds.length > 0) {
            sql += ` AND kind = ANY($2)`;
            params.push(kinds);
        }
        
        // Fetch extra just in case we need to merge
        sql += ` ORDER BY embedding <=> $1::vector LIMIT $${params.length + 1}`;
        params.push(limit * 2);

        const res = await client.query(sql, params);
        combinedResults.push(...res.rows);
    } finally {
        client.release();
    }

    // 2. Fetch from Local SQLite if project is provided and 'project' kind is allowed
    if (active_project && (!kinds || kinds.includes('project'))) {
        const localDb = await getProjectDb(active_project);
        if (localDb) {
            let sql = `SELECT key, value, kind, created_at, embedding FROM ide_agent_nuggets WHERE embedding IS NOT NULL`;
            if (kinds && kinds.length > 0) {
                const placeholders = kinds.map(() => '?').join(',');
                sql += ` AND kind IN (${placeholders})`;
            }
            
            const stmt = localDb.prepare(sql);
            const localRows = kinds && kinds.length > 0 ? stmt.all(...kinds) : stmt.all();
            
            for (const row of localRows) {
                try {
                    const dbEmbedding = JSON.parse(row.embedding);
                    const similarity = cosineSimilarity(embeddingArray, dbEmbedding);
                    const distance = 1 - similarity;
                    combinedResults.push({
                        key: row.key,
                        value: row.value,
                        kind: row.kind,
                        created_at: row.created_at,
                        distance: distance,
                        source: `sqlite:${active_project}`
                    });
                } catch (e) {
                    console.warn(`[krusch-context] Warning: Failed to parse JSON embedding for nugget key '${row.key}'`);
                }
            }
        }
    }

    // 3. Sort and limit
    combinedResults.sort((a, b) => a.distance - b.distance);
    combinedResults = combinedResults.slice(0, limit);

    if (combinedResults.length === 0) {
        return { content: [{ type: "text", text: `=== 💎 Holographic Nudges ===\n\nNo relevant nudges found.` }] };
    }

    let output = `=== 💎 Holographic Nudges ===\n`;
    for (const r of combinedResults) {
        output += `\n[${r.kind}] ${r.key}:\n${r.value}\n`;
    }
    return { content: [{ type: "text", text: output }] };
}

/**
 * Delete a specific nugget by key.
 * @param {object} params
 * @param {string} params.key - The nugget key to delete
 * @param {string} [params.active_project] - Project context for SQLite isolation
 * @returns {Promise<{content: Array}>} MCP tool response
 */
export async function nuggetForget({ key, active_project }) {
    if (!key) throw new McpError(ErrorCode.InvalidParams, "Missing key");

    // Try SQLite first if active_project is provided
    if (active_project) {
        const localDb = await getProjectDb(active_project);
        if (localDb) {
            const res = localDb.prepare(`DELETE FROM ide_agent_nuggets WHERE key = ?`).run(key);
            if (res.changes > 0) {
                return { content: [{ type: "text", text: `[krusch-context] 🗑️ Forgot nugget natively from SQLite (.agent/memory.db): ${key}` }] };
            }
        }
    }

    // Fallback to Global Postgres
    const res = await pool.query(`DELETE FROM ide_agent_nuggets WHERE key = $1 RETURNING key`, [key]);
    if (res.rowCount === 0) {
        return { content: [{ type: "text", text: `[krusch-context] ⚠️ No nugget found with key: ${key}` }] };
    }
    return { content: [{ type: "text", text: `[krusch-context] 🗑️ Forgot global nugget (Postgres): ${key}` }] };
}

/**
 * List all saved nuggets chronologically.
 * @param {object} params
 * @param {string[]} [params.kinds] - Filter by kind ('project', 'user', 'agent')
 * @param {string} [params.active_project] - Project context for SQLite isolation
 * @returns {Promise<{content: Array}>} MCP tool response
 */
export async function nuggetList({ kinds, active_project }) {
    let combinedResults = [];

    // 1. Fetch from Global Postgres
    const client = await pool.connect();
    try {
        let sql = `SELECT key, value, kind, created_at, updated_at, 'global' as source FROM ide_agent_nuggets`;
        let params = [];
        if (kinds && kinds.length > 0) {
            sql += ` WHERE kind = ANY($1)`;
            params.push(kinds);
        }
        sql += ` ORDER BY updated_at DESC`;
        const res = await client.query(sql, params);
        combinedResults.push(...res.rows);
    } finally {
        client.release();
    }

    // 2. Fetch from Local SQLite
    if (active_project && (!kinds || kinds.includes('project'))) {
        const localDb = await getProjectDb(active_project);
        if (localDb) {
            let sql = `SELECT key, value, kind, created_at, updated_at, 'sqlite:' || ? as source FROM ide_agent_nuggets`;
            let params = [active_project];
            
            if (kinds && kinds.length > 0) {
                const placeholders = kinds.map(() => '?').join(',');
                sql += ` WHERE kind IN (${placeholders})`;
                params.push(...kinds);
            }
            
            sql += ` ORDER BY updated_at DESC`;
            
            const stmt = localDb.prepare(sql);
            const localRows = stmt.all(...params);
            combinedResults.push(...localRows);
        }
    }

    // 3. Sort chronologically
    combinedResults.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));

    if (combinedResults.length === 0) {
        return { content: [{ type: "text", text: `=== 💎 Nuggets List ===\n\nNo nuggets found.` }] };
    }

    let output = `=== 💎 Nuggets List (${combinedResults.length}) ===\n`;
    for (const r of combinedResults) {
        output += `\n- [${r.kind}] ${r.key}`;
    }
    return { content: [{ type: "text", text: output }] };
}

import { pool } from '../db/pool.js';
import { getEmbedding } from './embedding-helper.js';
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { getProjectDb, cosineSimilarity, getParsedEmbedding, pushProjectMemory } from './sqlite-engine.js';
import { getStorageMode } from './storage-adapter.js';
import { detectCurrentProject } from './project-helper.js';
import { scanForSecretLeak } from './memory-engine.js';

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
export async function nuggetRemember({ key, value, kind = 'project', active_project, project, _embedding }) {
    if (!key || !value) throw new McpError(ErrorCode.InvalidParams, "Missing key or value");
    if (!VALID_KINDS.has(kind)) throw new McpError(ErrorCode.InvalidParams, `Invalid kind: ${kind}. Must be one of: ${[...VALID_KINDS].join(', ')}`);

    const leakedSecretType = scanForSecretLeak(String(value)) || scanForSecretLeak(String(key));
    if (leakedSecretType) {
        throw new McpError(
            ErrorCode.InvalidParams,
            `Secret refusal: nugget rejected because key or value appears to contain a raw credential (${leakedSecretType}). Redact secrets as [REDACTED] before calling krusch_context_remember.`
        );
    }

    const mode = getStorageMode();
    const targetProject = active_project || project || (mode === 'sqlite' ? detectCurrentProject() : null);
    const embeddingArray = _embedding || await getEmbedding(value);
    if (!embeddingArray) throw new McpError(ErrorCode.InternalError, "Failed to generate embedding");
    const embeddingStr = `[${embeddingArray.join(',')}]`;

    if (kind === 'project' && targetProject) {
        const localDb = await getProjectDb(targetProject);
        if (localDb) {
            localDb.prepare(`
                INSERT INTO ide_agent_nuggets (key, value, kind, embedding, created_at, updated_at, pg_synced)
                VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 0)
                ON CONFLICT (key) DO UPDATE 
                SET value = excluded.value, kind = excluded.kind, embedding = excluded.embedding, updated_at = CURRENT_TIMESTAMP, pg_synced = 0
            `).run(key, value, kind, embeddingStr);
            
            // Asynchronous write-behind (Compute Cache -> Object Storage)
            pushProjectMemory(targetProject, localDb).catch(e =>
                console.error(`[nuggets-engine] Async push failed for ${targetProject}:`, e)
            );

            return { content: [{ type: "text", text: `[krusch-context] 🧠 Nugget remembered natively in SQLite (.agent/memory.db) for project '${targetProject}': '${key}'` }] };
        }
    }

    let client = null;
    try {
        client = await pool.connect();
        await client.query(`
            INSERT INTO ide_agent_nuggets (key, value, kind, embedding)
            VALUES ($1, $2, $3, $4::vector)
            ON CONFLICT (key) DO UPDATE 
            SET value = EXCLUDED.value, kind = EXCLUDED.kind, embedding = EXCLUDED.embedding, updated_at = CURRENT_TIMESTAMP
            RETURNING id
        `, [key, value, kind, embeddingStr]);
        return { content: [{ type: "text", text: `[krusch-context] 🧠 Global Nugget remembered (Postgres): '${key}'` }] };
    } catch (err) {
        console.warn(`[nuggets-engine] PostgreSQL unavailable for global nugget: ${err.message}`);
        const fallbackProject = targetProject || detectCurrentProject() || 'default';
        const localDb = await getProjectDb(fallbackProject);
        if (localDb) {
            localDb.prepare(`
                INSERT INTO ide_agent_nuggets (key, value, kind, embedding, created_at, updated_at, pg_synced)
                VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 0)
                ON CONFLICT (key) DO UPDATE 
                SET value = excluded.value, kind = excluded.kind, embedding = excluded.embedding, updated_at = CURRENT_TIMESTAMP, pg_synced = 0
            `).run(key, value, kind, embeddingStr);
            return { content: [{ type: "text", text: `[krusch-context] 🧠 Nugget remembered natively in SQLite (.agent/memory.db) [PG fallback]: '${key}'` }] };
        }
        throw err;
    } finally {
        if (client) client.release();
    }
}


/**
 * Return short, relevant nugget facts to gently steer the agent.
 * @param {object} params
 * @param {string} params.query - Semantic search query
 * @param {string[]} [params.kinds] - Filter by kind ('project', 'user', 'agent')
 * @param {number} [params.limit=3] - Max results to return
 * @param {string} [params.active_project] - Project context for SQLite isolation
 * @param {string} [params.project] - Optional alias for active_project
 * @returns {Promise<{content: Array}>} MCP tool response
 */
export async function nuggetNudges({ query, kinds, limit = 3, active_project, project, _embedding }) {
    if (!query && !_embedding) throw new McpError(ErrorCode.InvalidParams, "Missing query or embedding");

    const mode = getStorageMode();
    const targetProject = active_project || project || (mode === 'sqlite' ? detectCurrentProject() : null);
    const embeddingArray = _embedding || await getEmbedding(query);
    if (!embeddingArray) throw new McpError(ErrorCode.InternalError, "Failed to generate embedding");

    let combinedResults = [];

    // 1. Fetch from Global Postgres (only when in postgres mode or when no local project is targeted)
    if (mode === 'postgres' || !targetProject) {
        let client = null;
        try {
            client = await pool.connect();
            const embeddingStr = `[${embeddingArray.join(',')}]`;
            const fetchLimit = limit * 2;

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
            
            sql += ` ORDER BY embedding <=> $1::vector LIMIT $${params.length + 1}`;
            params.push(fetchLimit);

            const res = await client.query(sql, params);
            combinedResults.push(...res.rows);
        } catch (_) {
            // Postgres unreachable or table missing; proceed to local SQLite
        } finally {
            if (client) client.release();
        }
    }

    // 2. Fetch from Local SQLite if project is provided and 'project' kind is allowed
    if (targetProject && (!kinds || kinds.includes('project'))) {
        const localDb = await getProjectDb(targetProject);
        if (localDb) {
            let sql = `SELECT key, value, kind, created_at, embedding FROM ide_agent_nuggets WHERE embedding IS NOT NULL`;
            if (kinds && kinds.length > 0) {
                const placeholders = kinds.map(() => '?').join(',');
                sql += ` AND kind IN (${placeholders})`;
            }
            
            const stmt = localDb.prepare(sql);
            const localRows = kinds && kinds.length > 0 ? stmt.all(...kinds) : stmt.all();
            
            for (const row of localRows) {
                const dbEmbedding = getParsedEmbedding(row.embedding);
                if (!dbEmbedding) {
                    console.warn(`[krusch-context] Warning: Failed to parse JSON embedding for nugget key '${row.key}'`);
                    continue;
                }
                const similarity = cosineSimilarity(embeddingArray, dbEmbedding);
                const distance = 1 - similarity;
                combinedResults.push({
                    key: row.key,
                    value: row.value,
                    kind: row.kind,
                    created_at: row.created_at,
                    distance: distance,
                    source: `sqlite:${targetProject}`
                });
            }
        }
    }

    // 3. Sort and limit
    combinedResults.sort((a, b) => a.distance - b.distance);
    combinedResults = combinedResults.slice(0, limit);

    if (combinedResults.length === 0) {
        return { content: [{ type: "text", text: `=== 💎 Steering Nuggets ===\n\nNo relevant nudges found.` }] };
    }

    let output = `=== 💎 Steering Nuggets ===\n`;
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
 * @param {string} [params.project] - Optional alias for active_project
 * @returns {Promise<{content: Array}>} MCP tool response
 */
export async function nuggetForget({ key, active_project, project }) {
    if (!key) throw new McpError(ErrorCode.InvalidParams, "Missing key");

    const mode = getStorageMode();
    const targetProject = active_project || project || (mode === 'sqlite' ? detectCurrentProject() : null);
    let deletedSqlite = false;
    let deletedPg = false;

    // 1. Delete from SQLite if targetProject is provided
    if (targetProject) {
        const localDb = await getProjectDb(targetProject);
        if (localDb) {
            const res = localDb.prepare(`DELETE FROM ide_agent_nuggets WHERE key = ?`).run(key);
            if (res.changes > 0) {
                deletedSqlite = true;
            }
        }
    }

    // 2. Also delete from Global Postgres when configured or in postgres mode
    if (mode === 'postgres' || !targetProject || process.env.DATABASE_URL || process.env.DB_PASSWORD) {
        try {
            const res = targetProject
                ? await pool.query(`DELETE FROM ide_agent_nuggets WHERE key = $1 AND (project = $2 OR project IS NULL) RETURNING key`, [key, targetProject])
                : await pool.query(`DELETE FROM ide_agent_nuggets WHERE key = $1 RETURNING key`, [key]);
            if (res && res.rowCount > 0) {
                deletedPg = true;
            }
        } catch (_) {
            // Fall through if Postgres is unreachable
        }
    }

    if (deletedSqlite) {
        return { content: [{ type: "text", text: `[krusch-context] 🗑️ Forgot nugget natively from SQLite (.agent/memory.db): ${key}` }] };
    }
    if (deletedPg) {
        return { content: [{ type: "text", text: `[krusch-context] 🗑️ Forgot global nugget (Postgres): ${key}` }] };
    }
    return { content: [{ type: "text", text: `[krusch-context] ⚠️ No nugget found with key: ${key}` }] };
}

/**
 * List all saved nuggets chronologically.
 * @param {object} params
 * @param {string[]} [params.kinds] - Filter by kind ('project', 'user', 'agent')
 * @param {string} [params.active_project] - Project context for SQLite isolation
 * @param {string} [params.project] - Optional alias for active_project
 * @returns {Promise<{content: Array}>} MCP tool response
 */
export async function nuggetList({ kinds, active_project, project }) {
    const mode = getStorageMode();
    const targetProject = active_project || project || (mode === 'sqlite' ? detectCurrentProject() : null);
    let combinedResults = [];

    // 1. Fetch from Global Postgres (if in postgres mode or no local project)
    if (mode === 'postgres' || !targetProject) {
        let client = null;
        try {
            client = await pool.connect();
            let sql = `SELECT key, value, kind, created_at, updated_at, 'global' as source FROM ide_agent_nuggets`;
            let params = [];
            if (kinds && kinds.length > 0) {
                sql += ` WHERE kind = ANY($1)`;
                params.push(kinds);
            }
            sql += ` ORDER BY updated_at DESC`;
            const res = await client.query(sql, params);
            combinedResults.push(...res.rows);
        } catch (_) {
            // Postgres unreachable; proceed to local SQLite
        } finally {
            if (client) client.release();
        }
    }

    // 2. Fetch from Local SQLite
    if (targetProject && (!kinds || kinds.includes('project'))) {
        try {
            const localDb = await getProjectDb(targetProject);
            if (localDb) {
                let sql = `SELECT key, value, kind, created_at, updated_at, 'sqlite:' || ? as source FROM ide_agent_nuggets`;
                let params = [targetProject];
                
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
        } catch (e) {
            console.error(`[krusch-context-mcp] Local SQLite nuggetList warning (${targetProject}):`, e.message);
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

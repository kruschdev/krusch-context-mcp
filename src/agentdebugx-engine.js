/**
 * @module agentdebugx-engine
 * AgentDebugX Failure Observability, Root-Cause Attribution & Error Hub Recovery.
 * Based on HF Paper 2607.18754.
 */

import { pool } from 'pg-git-mcp/db/pool.js';
import { getEmbedding } from './embedding-helper.js';

/**
 * Initializes the AgentDebugX database table.
 */
export async function initAgentDebugXTable() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS agent_failure_bundles (
                id SERIAL PRIMARY KEY,
                agent_name VARCHAR(100) NOT NULL,
                error_symptom TEXT NOT NULL,
                trajectory JSONB NOT NULL,
                root_cause TEXT NOT NULL,
                recovery_patch JSONB,
                rerun_status VARCHAR(50) DEFAULT 'logged',
                embedding VECTOR(1024),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
    } finally {
        client.release();
    }
}

/**
 * Logs an agent failure trajectory, root cause, and recovery patch bundle into the Error Hub.
 * @param {object} params
 * @param {string} params.agent_name
 * @param {string} params.error_symptom
 * @param {object|array} params.trajectory
 * @param {string} params.root_cause
 * @param {object} [params.recovery_patch]
 * @returns {Promise<{content: Array}>}
 */
export async function logAgentFailure({ agent_name, error_symptom, trajectory, root_cause, recovery_patch = {} }) {
    if (!agent_name || !error_symptom || !root_cause) {
        return { content: [{ type: "text", text: "Error: agent_name, error_symptom, and root_cause are required." }] };
    }

    const textForEmbedding = `${agent_name} | ${error_symptom} | ${root_cause}`;
    const embedding = await getEmbedding(textForEmbedding);
    const embeddingStr = embedding ? `[${embedding.join(',')}]` : null;

    const client = await pool.connect();
    try {
        const res = await client.query(`
            INSERT INTO agent_failure_bundles (agent_name, error_symptom, trajectory, root_cause, recovery_patch, embedding)
            VALUES ($1, $2, $3::jsonb, $4, $5::jsonb, $6::vector)
            RETURNING id, created_at
        `, [
            agent_name,
            error_symptom,
            JSON.stringify(trajectory || []),
            root_cause,
            JSON.stringify(recovery_patch || {}),
            embeddingStr
        ]);

        const bundleId = res.rows[0].id;
        return {
            content: [{
                type: "text",
                text: `[AgentDebugX] ✅ Failure bundle #${bundleId} successfully logged to Error Hub.\nAgent: ${agent_name}\nSymptom: ${error_symptom}\nRoot Cause: ${root_cause}`
            }]
        };
    } catch (e) {
        return { content: [{ type: "text", text: `[AgentDebugX] Error logging failure bundle: ${e.message}` }] };
    } finally {
        client.release();
    }
}

/**
 * Searches the Error Hub for similar agent failure bundles.
 * @param {object} params
 * @param {string} params.query - Symptom or query to match
 * @param {string} [params.agent_name] - Optional agent filter
 * @param {number} [params.limit=5]
 * @returns {Promise<{content: Array}>}
 */
export async function searchFailures({ query, agent_name, limit = 5 }) {
    if (!query) return { content: [{ type: "text", text: "Error: Missing search query." }] };

    const queryEmbedding = await getEmbedding(query);
    const client = await pool.connect();

    try {
        let sql, params;
        if (queryEmbedding) {
            const embeddingStr = `[${queryEmbedding.join(',')}]`;
            if (agent_name) {
                sql = `
                    SELECT id, agent_name, error_symptom, root_cause, recovery_patch, rerun_status, created_at,
                           (1 - (embedding <=> $1::vector)) as similarity
                    FROM agent_failure_bundles
                    WHERE agent_name = $2
                    ORDER BY embedding <=> $1::vector ASC
                    LIMIT $3
                `;
                params = [embeddingStr, agent_name, limit];
            } else {
                sql = `
                    SELECT id, agent_name, error_symptom, root_cause, recovery_patch, rerun_status, created_at,
                           (1 - (embedding <=> $1::vector)) as similarity
                    FROM agent_failure_bundles
                    ORDER BY embedding <=> $1::vector ASC
                    LIMIT $2
                `;
                params = [embeddingStr, limit];
            }
        } else {
            // Text search fallback
            if (agent_name) {
                sql = `
                    SELECT id, agent_name, error_symptom, root_cause, recovery_patch, rerun_status, created_at, 0.5 as similarity
                    FROM agent_failure_bundles
                    WHERE agent_name = $1 AND (error_symptom ILIKE $2 OR root_cause ILIKE $2)
                    ORDER BY created_at DESC LIMIT $3
                `;
                params = [agent_name, `%${query}%`, limit];
            } else {
                sql = `
                    SELECT id, agent_name, error_symptom, root_cause, recovery_patch, rerun_status, created_at, 0.5 as similarity
                    FROM agent_failure_bundles
                    WHERE error_symptom ILIKE $1 OR root_cause ILIKE $1
                    ORDER BY created_at DESC LIMIT $2
                `;
                params = [`%${query}%`, limit];
            }
        }

        const res = await client.query(sql, params);
        if (res.rows.length === 0) {
            return { content: [{ type: "text", text: `[AgentDebugX] No matching failure bundles found for query: "${query}"` }] };
        }

        const formatted = res.rows.map(row => {
            return `### Failure Bundle #${row.id} (${(row.similarity * 100).toFixed(1)}% match)\n` +
                   `- **Agent**: ${row.agent_name}\n` +
                   `- **Symptom**: ${row.error_symptom}\n` +
                   `- **Root Cause**: ${row.root_cause}\n` +
                   `- **Recovery Patch**: ${JSON.stringify(row.recovery_patch)}\n` +
                   `- **Logged At**: ${row.created_at}\n`;
        }).join('\n---\n');

        return {
            content: [{
                type: "text",
                text: `## 🐞 AgentDebugX Error Hub Search Results\n\n${formatted}`
            }]
        };
    } finally {
        client.release();
    }
}

/**
 * Retrieves specific recovery pattern and patch instructions for a failure bundle ID.
 * @param {object} params
 * @param {number} params.failure_id
 * @returns {Promise<{content: Array}>}
 */
export async function getRecoveryPattern({ failure_id }) {
    if (!failure_id) return { content: [{ type: "text", text: "Error: failure_id is required." }] };

    const client = await pool.connect();
    try {
        const res = await client.query(`
            SELECT id, agent_name, error_symptom, root_cause, recovery_patch, trajectory, rerun_status, created_at
            FROM agent_failure_bundles
            WHERE id = $1
        `, [failure_id]);

        if (res.rows.length === 0) {
            return { content: [{ type: "text", text: `[AgentDebugX] Failure bundle #${failure_id} not found.` }] };
        }

        const row = res.rows[0];
        const outputText = `## 🔧 AgentDebugX Recovery Pattern for Bundle #${row.id}\n\n` +
            `**Agent**: ${row.agent_name}\n` +
            `**Error Symptom**: ${row.error_symptom}\n` +
            `**Attributed Root Cause**: ${row.root_cause}\n\n` +
            `### 🛠️ Execution Recovery Patch\n\`\`\`json\n${JSON.stringify(row.recovery_patch, null, 2)}\n\`\`\`\n\n` +
            `### 📜 Trajectory Steps (${Array.isArray(row.trajectory) ? row.trajectory.length : 0} recorded)\n\`\`\`json\n${JSON.stringify(row.trajectory, null, 2)}\n\`\`\`\n`;

        return {
            content: [{
                type: "text",
                text: outputText
            }]
        };
    } finally {
        client.release();
    }
}

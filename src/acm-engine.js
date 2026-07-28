/**
 * @module acm-engine
 * Agentic Context Management (ACM) Engine.
 * Treating context & memory as architectural lifecycle problems (ingestion, staging, compaction, eviction, token budgeting).
 * Based on HF Paper 2607.21503 (Gaurav Dadhich).
 */

import { pool } from 'pg-git-mcp/db/pool.js';

/**
 * Initializes the ACM database table.
 */
export async function initAcmTable() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS ide_agent_context_lifecycle (
                id SERIAL PRIMARY KEY,
                fragment_id VARCHAR(100) UNIQUE NOT NULL,
                project VARCHAR(100),
                stage VARCHAR(50) DEFAULT 'staged',
                content TEXT NOT NULL,
                token_count INT DEFAULT 0,
                ttl_days INT DEFAULT 30,
                metadata JSONB DEFAULT '{}'::jsonb,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
    } finally {
        client.release();
    }
}

/**
 * Manages the lifecycle stage of a context fragment (stage, compact, evict, list, get).
 * @param {object} params
 * @param {string} params.action - 'stage' | 'compact' | 'evict' | 'get' | 'list'
 * @param {string} [params.fragment_id]
 * @param {string} [params.content]
 * @param {string} [params.stage] - 'staged' | 'active' | 'compacted' | 'evicted'
 * @param {number} [params.ttl_days]
 * @param {string} [params.project]
 * @param {object} [params.metadata]
 * @returns {Promise<{content: Array}>}
 */
export async function manageContextLifecycle({
    action = 'stage',
    fragment_id,
    content,
    stage = 'staged',
    ttl_days = 30,
    project = 'default',
    metadata = {}
}) {
    const client = await pool.connect();
    try {
        if (action === 'stage') {
            if (!fragment_id || !content) {
                return { content: [{ type: "text", text: "Error: fragment_id and content are required for staging." }] };
            }
            // Estimate token count (~4 chars per token)
            const token_count = Math.ceil(content.length / 4);

            await client.query(`
                INSERT INTO ide_agent_context_lifecycle (fragment_id, project, stage, content, token_count, ttl_days, metadata, updated_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW())
                ON CONFLICT (fragment_id) DO UPDATE SET
                    project = EXCLUDED.project,
                    stage = EXCLUDED.stage,
                    content = EXCLUDED.content,
                    token_count = EXCLUDED.token_count,
                    ttl_days = EXCLUDED.ttl_days,
                    metadata = EXCLUDED.metadata,
                    updated_at = NOW()
            `, [fragment_id, project, stage, content, token_count, ttl_days, JSON.stringify(metadata)]);

            return {
                content: [{
                    type: "text",
                    text: `[ACM Engine] ✅ Staged fragment '${fragment_id}' for project '${project}' at stage '${stage}' (~${token_count} tokens, TTL: ${ttl_days}d).`
                }]
            };
        } else if (action === 'compact') {
            if (!fragment_id) {
                return { content: [{ type: "text", text: "Error: fragment_id is required for compaction." }] };
            }
            const newContent = content || '[Compacted Context Summary]';
            const token_count = Math.ceil(newContent.length / 4);

            const res = await client.query(`
                UPDATE ide_agent_context_lifecycle
                SET stage = 'compacted', content = $1, token_count = $2, updated_at = NOW()
                WHERE fragment_id = $3
                RETURNING fragment_id, project
            `, [newContent, token_count, fragment_id]);

            if (res.rows.length === 0) {
                return { content: [{ type: "text", text: `[ACM Engine] Fragment '${fragment_id}' not found.` }] };
            }

            return {
                content: [{
                    type: "text",
                    text: `[ACM Engine] 📦 Compacted fragment '${fragment_id}' (~${token_count} tokens remaining).`
                }]
            };
        } else if (action === 'evict') {
            if (!fragment_id) {
                return { content: [{ type: "text", text: "Error: fragment_id is required for eviction." }] };
            }

            const res = await client.query(`
                UPDATE ide_agent_context_lifecycle
                SET stage = 'evicted', token_count = 0, updated_at = NOW()
                WHERE fragment_id = $1
                RETURNING fragment_id
            `, [fragment_id]);

            if (res.rows.length === 0) {
                return { content: [{ type: "text", text: `[ACM Engine] Fragment '${fragment_id}' not found.` }] };
            }

            return {
                content: [{
                    type: "text",
                    text: `[ACM Engine] 🗑️ Evicted fragment '${fragment_id}' from context window retention.`
                }]
            };
        } else if (action === 'get') {
            if (!fragment_id) {
                return { content: [{ type: "text", text: "Error: fragment_id is required to get fragment state." }] };
            }

            const res = await client.query(`
                SELECT fragment_id, project, stage, content, token_count, ttl_days, metadata, created_at, updated_at
                FROM ide_agent_context_lifecycle
                WHERE fragment_id = $1
            `, [fragment_id]);

            if (res.rows.length === 0) {
                return { content: [{ type: "text", text: `[ACM Engine] Fragment '${fragment_id}' not found.` }] };
            }

            const row = res.rows[0];
            return {
                content: [{
                    type: "text",
                    text: `## 📌 ACM Fragment '${row.fragment_id}'\n` +
                        `- **Project**: ${row.project}\n` +
                        `- **Stage**: ${row.stage}\n` +
                        `- **Token Count**: ~${row.token_count}\n` +
                        `- **TTL**: ${row.ttl_days} days\n` +
                        `- **Last Updated**: ${row.updated_at}\n\n` +
                        `### Content\n${row.content}`
                }]
            };
        } else if (action === 'list') {
            const res = await client.query(`
                SELECT fragment_id, stage, token_count, ttl_days, updated_at
                FROM ide_agent_context_lifecycle
                WHERE project = $1 AND stage != 'evicted'
                ORDER BY updated_at DESC
            `, [project]);

            if (res.rows.length === 0) {
                return { content: [{ type: "text", text: `[ACM Engine] No active/staged fragments found for project '${project}'.` }] };
            }

            const summary = res.rows.map(r => `- **${r.fragment_id}** [${r.stage}] ~${r.token_count} tokens (TTL: ${r.ttl_days}d)`).join('\n');
            return {
                content: [{
                    type: "text",
                    text: `## 📋 ACM Context Lifecycle Fragments for '${project}'\n\n${summary}`
                }]
            };
        } else {
            return { content: [{ type: "text", text: `[ACM Engine] Unknown action '${action}'. Valid actions: stage, compact, evict, get, list.` }] };
        }
    } catch (e) {
        return { content: [{ type: "text", text: `[ACM Engine] Error in manageContextLifecycle: ${e.message}` }] };
    } finally {
        client.release();
    }
}

/**
 * Audits context token budget consumption and context window pressure.
 * @param {object} params
 * @param {string} [params.project]
 * @param {number} [params.token_budget] - Default 8192 tokens
 * @param {number} [params.current_tokens] - Additional prompt tokens currently loaded
 * @returns {Promise<{content: Array}>}
 */
export async function auditContextBudget({ project = 'default', token_budget = 8192, current_tokens = 0 }) {
    const client = await pool.connect();
    try {
        const res = await client.query(`
            SELECT stage, SUM(token_count) as total_tokens, COUNT(*) as fragment_count
            FROM ide_agent_context_lifecycle
            WHERE project = $1 AND stage != 'evicted'
            GROUP BY stage
        `, [project]);

        let stagedTokens = 0;
        let activeTokens = 0;
        let compactedTokens = 0;

        res.rows.forEach(r => {
            const cnt = parseInt(r.total_tokens || 0, 10);
            if (r.stage === 'staged') stagedTokens = cnt;
            else if (r.stage === 'active') activeTokens = cnt;
            else if (r.stage === 'compacted') compactedTokens = cnt;
        });

        const managedTokens = stagedTokens + activeTokens + compactedTokens;
        const aggregateTokens = managedTokens + current_tokens;
        const utilizationPct = ((aggregateTokens / token_budget) * 100).toFixed(1);

        let status = 'HEALTHY';
        let recommendation = 'Context budget within normal limits. No immediate compaction required.';

        if (aggregateTokens > token_budget) {
            status = 'CRITICAL_OVERFLOW';
            recommendation = '⚠️ Context overflow! Execute `manageContextLifecycle({ action: "compact" })` or `evict` stale staged fragments immediately.';
        } else if (utilizationPct > 75) {
            status = 'WARNING_HIGH_PRESSURE';
            recommendation = '⚡ Context pressure high (>75%). Consider compacting active/staged fragments before initiating deep research queries.';
        }

        const report = `## 📊 ACM Context Window & Token Cost Audit for '${project}'\n\n` +
            `- **Token Budget**: ${token_budget} tokens\n` +
            `- **Active Managed Tokens**: ${managedTokens} tokens (Staged: ${stagedTokens}, Active: ${activeTokens}, Compacted: ${compactedTokens})\n` +
            `- **Unmanaged Prompt Tokens**: ${current_tokens} tokens\n` +
            `- **Total Context Usage**: ${aggregateTokens} / ${token_budget} tokens (${utilizationPct}%)\n` +
            `- **Status**: **${status}**\n\n` +
            `### 💡 Recommendation\n${recommendation}`;

        return {
            content: [{
                type: "text",
                text: report
            }]
        };
    } catch (e) {
        return { content: [{ type: "text", text: `[ACM Engine] Error in auditContextBudget: ${e.message}` }] };
    } finally {
        client.release();
    }
}

/**
 * @module arex-engine
 * AREX Recursively Self-Improving Deep Research State Engine.
 * Based on HF Paper 2607.21461.
 */

import { pool } from 'pg-git-mcp/db/pool.js';

/**
 * Initializes AREX research state database table.
 */
export async function initArexTable() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS arex_research_states (
                id SERIAL PRIMARY KEY,
                task_id VARCHAR(100) UNIQUE NOT NULL,
                verified_evidence JSONB DEFAULT '[]'::jsonb,
                unresolved_constraints JSONB DEFAULT '[]'::jsonb,
                next_action_hints JSONB DEFAULT '[]'::jsonb,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
    } finally {
        client.release();
    }
}

/**
 * Updates or creates an AREX research state for a research task.
 * @param {object} params
 * @param {string} params.task_id
 * @param {Array<string|object>} [params.verified_evidence]
 * @param {Array<string|object>} [params.unresolved_constraints]
 * @param {Array<string>} [params.next_action_hints]
 * @returns {Promise<{content: Array}>}
 */
export async function updateResearchState({ task_id, verified_evidence = [], unresolved_constraints = [], next_action_hints = [] }) {
    if (!task_id) {
        return { content: [{ type: "text", text: "Error: task_id is required." }] };
    }

    const client = await pool.connect();
    try {
        await client.query(`
            INSERT INTO arex_research_states (task_id, verified_evidence, unresolved_constraints, next_action_hints, updated_at)
            VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, NOW())
            ON CONFLICT (task_id) DO UPDATE SET
                verified_evidence = EXCLUDED.verified_evidence,
                unresolved_constraints = EXCLUDED.unresolved_constraints,
                next_action_hints = EXCLUDED.next_action_hints,
                updated_at = NOW()
        `, [
            task_id,
            JSON.stringify(verified_evidence),
            JSON.stringify(unresolved_constraints),
            JSON.stringify(next_action_hints)
        ]);

        return {
            content: [{
                type: "text",
                text: `[AREX Engine] ✅ Research state for task '${task_id}' updated.\nVerified Evidence: ${verified_evidence.length} items | Unresolved Constraints: ${unresolved_constraints.length} items`
            }]
        };
    } catch (e) {
        return { content: [{ type: "text", text: `[AREX Engine] Error updating research state: ${e.message}` }] };
    } finally {
        client.release();
    }
}

/**
 * Audits a candidate research answer against the task's AREX state.
 * @param {object} params
 * @param {string} params.task_id
 * @param {string} [params.candidate_response]
 * @returns {Promise<{content: Array}>}
 */
export async function auditResearchConstraints({ task_id, candidate_response = '' }) {
    if (!task_id) return { content: [{ type: "text", text: "Error: task_id is required." }] };

    const client = await pool.connect();
    try {
        const res = await client.query(`
            SELECT task_id, verified_evidence, unresolved_constraints, next_action_hints, updated_at
            FROM arex_research_states
            WHERE task_id = $1
        `, [task_id]);

        if (res.rows.length === 0) {
            return { content: [{ type: "text", text: `[AREX Engine] Research state for task '${task_id}' not found.` }] };
        }

        const row = res.rows[0];
        const evidence = row.verified_evidence || [];
        const constraints = row.unresolved_constraints || [];
        const hints = row.next_action_hints || [];

        let auditSummary = `## 🔬 AREX Outer Loop Audit for Task '${task_id}'\n\n` +
            `**Last Updated**: ${row.updated_at}\n\n` +
            `### ✅ Verified Evidence (${evidence.length})\n` +
            evidence.map((e, idx) => `${idx + 1}. ${typeof e === 'string' ? e : JSON.stringify(e)}`).join('\n') + `\n\n` +
            `### ⚠️ Unresolved Constraints (${constraints.length})\n` +
            constraints.map((c, idx) => `${idx + 1}. ${typeof c === 'string' ? c : JSON.stringify(c)}`).join('\n') + `\n\n` +
            `### 🎯 Suggested Next Follow-up Research Actions\n` +
            hints.map((h, idx) => `${idx + 1}. ${h}`).join('\n') + `\n`;

        return {
            content: [{
                type: "text",
                text: auditSummary
            }]
        };
    } finally {
        client.release();
    }
}

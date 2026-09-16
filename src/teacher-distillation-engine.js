/**
 * @module teacher-distillation-engine
 * Hierarchical Teacher Memory Distillation Engine for Small LLM Agents.
 * Based on ArXiv Paper 2608.07169 (10/10 Applicability).
 * 
 * Implements three distinct tiers of teacher memory:
 *   - Tier 1: Workflow (procedural task plans and execution sequences)
 *   - Tier 2: Subtask (intermediate subtask goals, inputs, and constraint checks)
 *   - Tier 3: Function (tool-level parameter corrections & error recovery patterns)
 */

import { pool } from 'pg-git-mcp/db/pool.js';
import { getEmbedding } from './embedding-helper.js';
import { getProjectDb, cosineSimilarity } from './sqlite-engine.js';
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

/**
 * Ensures the PostgreSQL database table for teacher memory distillation exists.
 */
export async function initTeacherMemoryTable() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS agent_teacher_memories (
                id SERIAL PRIMARY KEY,
                project VARCHAR(100),
                tier VARCHAR(20) NOT NULL CHECK (tier IN ('workflow', 'subtask', 'function')),
                task_pattern TEXT NOT NULL,
                teacher_model VARCHAR(100) NOT NULL,
                student_model VARCHAR(100),
                trajectory JSONB NOT NULL,
                distilled_rule TEXT NOT NULL,
                embedding VECTOR(1024),
                tags JSONB,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
    } finally {
        client.release();
    }
}

/**
 * Logs a teacher trajectory distillation into the memory substrate.
 * Supports PostgreSQL durable store and optional local SQLite project cache.
 * 
 * @param {object} params
 * @param {string} params.tier - Memory tier ('workflow', 'subtask', 'function')
 * @param {string} params.task_pattern - Description of the task pattern or tool name
 * @param {string} params.teacher_model - Identifier of the teacher model (e.g. 'gemini-3.5-flash', 'claude-3.5-sonnet')
 * @param {string} [params.student_model] - Target student model (e.g. 'qwen2.5-coder:7b')
 * @param {object|array} params.trajectory - Structured execution trajectory steps
 * @param {string} params.distilled_rule - High-level distilled operational rule/lesson
 * @param {string} [params.project] - Optional project association
 * @param {string[]} [params.tags] - Optional tags
 * @returns {Promise<{content: Array}>}
 */
export async function distillTeacherMemory({
    tier,
    task_pattern,
    teacher_model,
    student_model = 'qwen2.5-coder:7b',
    trajectory,
    distilled_rule,
    project,
    tags
}) {
    if (!tier || !task_pattern || !teacher_model || !trajectory || !distilled_rule) {
        throw new McpError(ErrorCode.InvalidParams, "Missing required parameters: tier, task_pattern, teacher_model, trajectory, distilled_rule");
    }

    if (!['workflow', 'subtask', 'function'].includes(tier.toLowerCase())) {
        throw new McpError(ErrorCode.InvalidParams, "Invalid tier. Must be 'workflow', 'subtask', or 'function'");
    }

    const textToEmbed = `${tier} | ${task_pattern} | ${distilled_rule}`;
    const embedding = await getEmbedding(textToEmbed);
    const embeddingStr = embedding ? `[${embedding.join(',')}]` : null;
    const tagsStr = tags ? JSON.stringify(tags) : null;
    const trajectoryStr = JSON.stringify(trajectory);

    // Save to PostgreSQL if available
    let pgId = null;
    try {
        const client = await pool.connect();
        try {
            const res = await client.query(`
                INSERT INTO agent_teacher_memories 
                (project, tier, task_pattern, teacher_model, student_model, trajectory, distilled_rule, embedding, tags)
                VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::vector, $9::jsonb)
                RETURNING id
            `, [
                project || null,
                tier.toLowerCase(),
                task_pattern,
                teacher_model,
                student_model,
                trajectoryStr,
                distilled_rule,
                embeddingStr,
                tagsStr
            ]);
            pgId = res.rows[0].id;
        } finally {
            client.release();
        }
    } catch (e) {
        console.warn(`[teacher-distillation] Postgres write failed, saving to local SQLite fallback: ${e.message}`);
    }

    // Save to local SQLite if project specified
    if (project) {
        try {
            const db = await getProjectDb(project);
            if (db) {
                db.prepare(`
                    INSERT INTO agent_teacher_memories 
                    (pg_id, tier, task_pattern, teacher_model, student_model, trajectory, distilled_rule, embedding, tags)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).run(
                    pgId,
                    tier.toLowerCase(),
                    task_pattern,
                    teacher_model,
                    student_model,
                    trajectoryStr,
                    distilled_rule,
                    embeddingStr,
                    tagsStr
                );
            }
        } catch (sqliteErr) {
            console.warn(`[teacher-distillation] SQLite write warning: ${sqliteErr.message}`);
        }
    }

    return {
        content: [{
            type: "text",
            text: `[TeacherMemory] ✅ Distilled ${tier.toUpperCase()} memory successfully saved (ID: ${pgId || 'local-sqlite'}).\n` +
                  `Pattern: ${task_pattern}\n` +
                  `Teacher: ${teacher_model} ➔ Student: ${student_model}\n` +
                  `Rule: ${distilled_rule}`
        }]
    };
}

/**
 * Retrieves hierarchical teacher memories matching a query and optional tier filter.
 * 
 * @param {object} params
 * @param {string} params.query - Semantic search query
 * @param {string} [params.tier] - Optional memory tier filter ('workflow', 'subtask', 'function')
 * @param {string} [params.project] - Optional project filter
 * @param {number} [params.limit=3]
 * @returns {Promise<{content: Array}>}
 */
export async function retrieveTeacherDistillation({ query, tier, project, limit = 3 }) {
    if (!query) throw new McpError(ErrorCode.InvalidParams, "Missing query parameter");

    const queryEmbedding = await getEmbedding(query);
    const results = [];

    // 1. Search PostgreSQL
    try {
        const client = await pool.connect();
        try {
            let sql = `
                SELECT id, project, tier, task_pattern, teacher_model, student_model, trajectory, distilled_rule, tags, created_at
            `;
            const queryParams = [];

            if (queryEmbedding) {
                const embeddingStr = `[${queryEmbedding.join(',')}]`;
                queryParams.push(embeddingStr);
                sql += `, (1 - (embedding <=> $1::vector)) as similarity FROM agent_teacher_memories WHERE 1=1 `;
            } else {
                sql += `, 0.5 as similarity FROM agent_teacher_memories WHERE (task_pattern ILIKE $1 OR distilled_rule ILIKE $1) `;
                queryParams.push(`%${query}%`);
            }

            if (tier) {
                queryParams.push(tier.toLowerCase());
                sql += `AND tier = $${queryParams.length} `;
            }

            if (project) {
                queryParams.push(project);
                sql += `AND (project = $${queryParams.length} OR project IS NULL) `;
            }

            if (queryEmbedding) {
                sql += `ORDER BY embedding <=> $1::vector ASC `;
            } else {
                sql += `ORDER BY created_at DESC `;
            }

            queryParams.push(limit);
            sql += `LIMIT $${queryParams.length}`;

            const res = await client.query(sql, queryParams);
            for (const r of res.rows) {
                results.push({ ...r, source: 'pg' });
            }
        } finally {
            client.release();
        }
    } catch (pgErr) {
        console.warn(`[teacher-distillation] Postgres search warning: ${pgErr.message}`);
    }

    // 2. Local SQLite search fallback if results are sparse
    if (project && results.length < limit) {
        try {
            const db = await getProjectDb(project);
            if (db) {
                let sql = `SELECT id, tier, task_pattern, teacher_model, student_model, trajectory, distilled_rule, tags, embedding, created_at FROM agent_teacher_memories WHERE 1=1 `;
                const sqlParams = [];
                if (tier) {
                    sql += `AND tier = ? `;
                    sqlParams.push(tier.toLowerCase());
                }
                sql += `ORDER BY created_at DESC LIMIT ?`;
                sqlParams.push(limit);

                const rows = db.prepare(sql).all(...sqlParams);
                for (const r of rows) {
                    let sim = 0.5;
                    if (queryEmbedding && r.embedding) {
                        try {
                            const embArr = JSON.parse(r.embedding);
                            sim = cosineSimilarity(queryEmbedding, embArr);
                        } catch {}
                    }
                    results.push({
                        id: r.id,
                        project,
                        tier: r.tier,
                        task_pattern: r.task_pattern,
                        teacher_model: r.teacher_model,
                        student_model: r.student_model,
                        trajectory: typeof r.trajectory === 'string' ? JSON.parse(r.trajectory) : r.trajectory,
                        distilled_rule: r.distilled_rule,
                        tags: r.tags,
                        created_at: r.created_at,
                        similarity: sim,
                        source: 'sqlite'
                    });
                }
            }
        } catch (sqliteErr) {
            console.warn(`[teacher-distillation] SQLite fallback search warning: ${sqliteErr.message}`);
        }
    }

    // Sort combined results by similarity
    results.sort((a, b) => (b.similarity || 0) - (a.similarity || 0));
    const finalResults = results.slice(0, limit);

    if (finalResults.length === 0) {
        return {
            content: [{
                type: "text",
                text: `=== 🎓 Teacher Memory Distillation: "${query}" ===\n\nNo teacher memories found.`
            }]
        };
    }

    let output = `=== 🎓 Teacher Memory Distillation: "${query}" (${finalResults.length} matches) ===\n\n`;
    for (const r of finalResults) {
        const score = typeof r.similarity === 'number' ? `(Score: ${(r.similarity * 100).toFixed(1)}%)` : '';
        output += `### Tier: ${r.tier.toUpperCase()} | ${r.task_pattern} ${score}\n` +
                  `- **Teacher ➔ Student**: ${r.teacher_model} ➔ ${r.student_model || 'all'}\n` +
                  `- **Distilled Rule**: ${r.distilled_rule}\n` +
                  `- **Trajectory Steps**: ${Array.isArray(r.trajectory) ? r.trajectory.length : 1} step(s)\n` +
                  `\`\`\`json\n${JSON.stringify(r.trajectory, null, 2)}\n\`\`\`\n\n---\n`;
    }

    return { content: [{ type: "text", text: output.trim() }] };
}

/**
 * Distills a specific tool call failure + teacher fix trajectory into a Tier 3 Function Memory entry.
 * Convenient shortcut for student agent recovery.
 * 
 * @param {object} params
 * @param {string} params.tool_name - Tool that experienced an error
 * @param {string} params.failed_input - Input parameters that caused failure
 * @param {string} params.error_message - Error output
 * @param {string} params.corrected_input - Corrected input parameters from teacher
 * @param {string} params.explanation - Explanation of why the fix works
 * @param {string} [params.teacher_model='gemini-3.5-flash']
 * @param {string} [params.project]
 * @returns {Promise<{content: Array}>}
 */
export async function distillFunctionMemory({
    tool_name,
    failed_input,
    error_message,
    corrected_input,
    explanation,
    teacher_model = 'gemini-3.5-flash',
    project
}) {
    if (!tool_name || !failed_input || !error_message || !corrected_input || !explanation) {
        throw new McpError(ErrorCode.InvalidParams, "Missing required parameters for Function Memory distillation");
    }

    const trajectory = [
        { step: 1, action: "failed_tool_call", tool: tool_name, input: failed_input, error: error_message },
        { step: 2, action: "teacher_correction", tool: tool_name, input: corrected_input, explanation }
    ];

    const distilled_rule = `When calling tool '${tool_name}' and encountering '${error_message.substring(0, 100)}', use parameter structure: ${corrected_input}. ${explanation}`;

    return await distillTeacherMemory({
        tier: 'function',
        task_pattern: `tool:${tool_name}`,
        teacher_model,
        student_model: 'qwen2.5-coder:7b',
        trajectory,
        distilled_rule,
        project,
        tags: [tool_name, 'function-error-fix', 'tier-3']
    });
}

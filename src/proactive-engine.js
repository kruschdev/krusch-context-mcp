import dotenv from 'dotenv';
import { chat } from './llm.js';
import { searchMemory } from './memory-engine.js';
import { nuggetNudges } from './nuggets-engine.js';
import { getEmbedding } from './embedding-helper.js';
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { writeState } from './v2-engine.js';
import { pool } from 'pg-git-mcp/db/pool.js';

// Ensure environment variables are loaded
dotenv.config();

/**
 * Proactively audits current agent trajectory against historical lessons, bugs, and rules.
 *
 * @param {object} args
 * @param {string|Array} args.history - Conversational history or last user input string
 * @param {string} [args.project] - Optional active project context
 * @returns {Promise<{content: Array}>} MCP tool response
 */
export async function handleProactiveNudge({ history, project }) {
    if (!history) {
        throw new McpError(ErrorCode.InvalidParams, "Missing required parameter 'history'");
    }

    // 1. Parse history into a query query string
    let queryText = "";
    if (Array.isArray(history)) {
        // Find last user message
        const lastUser = history.slice().reverse().find(m => m.role === 'user');
        if (lastUser) {
            queryText = typeof lastUser.content === 'string' ? lastUser.content : JSON.stringify(lastUser.content);
        } else {
            // Fallback to concatenating the last few turns
            queryText = history.slice(-3).map(m => `${m.role}: ${m.content}`).join('\n');
        }
    } else if (typeof history === 'string') {
        queryText = history;
    } else {
        throw new McpError(ErrorCode.InvalidParams, "Parameter 'history' must be a string or message array.");
    }

    if (!queryText.trim()) {
        return { content: [{ type: "text", text: "NO_NUDGES_REQUIRED" }] };
    }

    console.error(`[krusch-context-mcp] Proactive audit triggered for query: "${queryText.substring(0, 80)}..."`);

    // 2. Generate embedding for queryText
    const vector = await getEmbedding(queryText);
    if (!vector) {
        throw new McpError(ErrorCode.InternalError, "Failed to generate query embedding");
    }

    // 3. Search Macro-scale (lessons, bugs, priorities, nuggets) and Meso-scale (activities)
    const categories = ['lessons', 'bugs', 'priorities'];
    const memoryPromises = categories.map(cat =>
        searchMemory({ category: cat, query: queryText, limit: 3, active_project: project, _embedding: vector })
            .catch(err => {
                console.error(`[krusch-context-mcp] Memory search error for category '${cat}':`, err.message);
                return { content: [{ type: "text", text: "" }] };
            })
    );

    const nuggetsPromise = nuggetNudges({ query: queryText, active_project: project, _embedding: vector, limit: 3 })
        .catch(err => {
            console.error('[krusch-context-mcp] Nuggets search error:', err.message);
            return { content: [{ type: "text", text: "" }] };
        });

    const mesoPromise = pool.query(`
        SELECT content, created_at FROM interaction_memory
        WHERE category = 'activity' AND (project = $1 OR project IS NULL)
        ORDER BY created_at DESC LIMIT 3
    `, [project || null]).catch(err => {
        console.error('[krusch-context-mcp] Meso activities query failed:', err.message);
        return { rows: [] };
    });

    const [nuggetsResult, mesoResult, ...memoryResults] = await Promise.all([nuggetsPromise, mesoPromise, ...memoryPromises]);

    // 4. Compile multi-scale context block
    let contextBlock = "";

    // Micro-scale
    contextBlock += `### 1. Micro-Scale Context (Current Task)\nQuery / Target: "${queryText}"\n\n`;

    // Meso-scale
    if (mesoResult && mesoResult.rows && mesoResult.rows.length > 0) {
        contextBlock += `### 2. Meso-Scale Context (Recent Activities)\n`;
        for (const row of mesoResult.rows) {
            const dateStr = row.created_at ? new Date(row.created_at).toISOString().split('T')[0] : 'unknown';
            contextBlock += `- [${dateStr}] ${row.content}\n`;
        }
        contextBlock += `\n`;
    }

    // Macro-scale
    let macroBlock = "";
    for (let i = 0; i < categories.length; i++) {
        const text = memoryResults[i].content[0].text;
        if (text && !text.includes("No results found")) {
            macroBlock += `#### Past ${categories[i].toUpperCase()}\n${text}\n\n`;
        }
    }

    const nuggetText = nuggetsResult.content[0].text;
    if (nuggetText && !nuggetText.includes("No relevant nudges found")) {
        macroBlock += `#### Holographic Nuggets\n${nuggetText}\n\n`;
    }

    if (macroBlock.trim()) {
        contextBlock += `### 3. Macro-Scale Context (Lessons, Bugs, & Rules)\n${macroBlock}`;
    }

    // If no context exists to audit against, return NO_NUDGES_REQUIRED
    if (!contextBlock.trim()) {
        return { content: [{ type: "text", text: "NO_NUDGES_REQUIRED" }] };
    }

    // 5. Setup prompt and local LLM
    const systemPrompt = `You are the Proactive Context Auditor for the Krusch homelab.
Your job is to examine the current user prompt / action trajectory and audit it against the retrieved facts, lessons, bugs, priorities, and nuggets.
You must determine if there is any critical lesson, user preference, bug history, or project constraint that the user or agent might be ignoring or violating.

Retrieved Context Block:
${contextBlock}

Rules for output:
1. If you find a critical mismatch (e.g. they are trying to run a model with mismatched dimensions, using an invalid API key, deleting database files without confirmation, etc.), generate a concise Markdown alert starting with "### 🧠 Proactive Context Nudge" describing the warning/reminder and suggested action.
2. If NO rules, constraints, or historical lessons are violated, or if the current action is completely aligned and safe, you MUST return exactly the string: "NO_NUDGES_REQUIRED" and nothing else.
3. Keep it brief, constructive, and actionable. Do not add general greeting text or conversational filler.
`;

    const userMsg = `Current agent trajectory / user query:
"${queryText}"`;

    // Try local Ollama first, fallback to OpenRouter or other configuration
    let llmConfig = {
        provider: 'ollama',
        model: process.env.COMPLETION_MODEL || process.env.PROACTIVE_MODEL || 'qwen2.5-coder:7b',
        apiUrl: process.env.COMPLETION_URL
            || (process.env.OLLAMA_URL 
                ? `${process.env.OLLAMA_URL.replace(/\/$/, '')}/v1/chat/completions` 
                : 'http://localhost:11434/v1/chat/completions'),
        apiKey: process.env.COMPLETION_API_KEY || null,
        maxTokens: 1000,
        temperature: 0.1
    };

    // If OLLAMA_URL is not set but OPENROUTER_API_KEY is present, default to OpenRouter
    if (process.env.OPENROUTER_API_KEY && !process.env.OLLAMA_URL && !process.env.COMPLETION_URL && !process.env.USE_LOCAL_OLLAMA_ONLY) {
        llmConfig = {
            provider: 'openai',
            apiKey: process.env.OPENROUTER_API_KEY,
            apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
            model: process.env.COMPLETION_MODEL || process.env.PROACTIVE_MODEL || 'google/gemini-2.5-flash',
            maxTokens: 1000,
            temperature: 0.1
        };
    }

    try {
        console.error(`[krusch-context-mcp] Querying proactive auditor (model: ${llmConfig.model})...`);
        const responseText = await chat(systemPrompt, userMsg, llmConfig);
        return { content: [{ type: "text", text: responseText.trim() }] };
    } catch (err) {
        console.error("[krusch-context-mcp] Proactive audit LLM call failed:", err.message);
        // Fail-safe: if the LLM call fails, return NO_NUDGES_REQUIRED so execution is not blocked
        return { content: [{ type: "text", text: "NO_NUDGES_REQUIRED" }] };
    }
}

/**
 * Logs developer/agent feedback for proactive nudges to capture alignment signals.
 * Writes a state of category 'alignment_signal' containing the audited query as content,
 * and the nudge feedback metadata inside action_trace.
 *
 * @param {object} args
 * @param {string} args.query_text - The audited query
 * @param {string} args.nudge_text - The warning nudge text
 * @param {boolean} args.user_approved - Whether the nudge was approved/helpful
 * @param {boolean} args.agent_corrected - Whether the agent corrected its trajectory
 * @param {string} [args.correction_diff] - Optional diff showing correction
 * @param {string} [args.project] - Optional project association
 */
export async function handleNudgeFeedback({ query_text, nudge_text, user_approved, agent_corrected, correction_diff, project }) {
    if (!query_text || !nudge_text) {
        throw new McpError(ErrorCode.InvalidParams, "Missing required parameters 'query_text' and 'nudge_text'");
    }

    const action_trace = {
        nudge_text,
        user_approved: !!user_approved,
        agent_corrected: !!agent_corrected,
        correction_diff: correction_diff || null,
        timestamp: new Date().toISOString()
    };

    // Use writeState from v2-engine to persist the alignment signal
    return await writeState({
        content: query_text,
        category: 'alignment_signal',
        author_id: 'proactive-auditor',
        action_trace,
        project: project || null
    });
}

/**
 * Analyzes the execution trajectory of a memory state using STRACE principles.
 * Identifies root cause steps where errors first occurred or where confidence dropped.
 *
 * @param {object} args
 * @param {string} args.memory_id - The UUID of the leaf/head memory to analyze.
 * @returns {Promise<{content: Array}>} MCP tool response
 */
export async function handleAnalyzeTrajectory({ memory_id }) {
    if (!memory_id) {
        throw new McpError(ErrorCode.InvalidParams, "Missing required parameter 'memory_id'");
    }

    const client = await pool.connect();
    try {
        // Query the parent-child chain (provenance) of the memory, including action_trace
        const queryStr = `
            WITH RECURSIVE provenance_tree AS (
                SELECT id, parent_id, version_id, author_id, source_ref, created_at, content, status, action_trace
                FROM interaction_memory
                WHERE id = $1
                UNION ALL
                SELECT m.id, m.parent_id, m.version_id, m.author_id, m.source_ref, m.created_at, m.content, m.status, m.action_trace
                FROM interaction_memory m
                INNER JOIN provenance_tree pt ON pt.parent_id = m.id
            )
            SELECT * FROM provenance_tree ORDER BY version_id ASC;
        `;
        const res = await client.query(queryStr, [memory_id]);
        if (res.rows.length === 0) {
            return { content: [{ type: "text", text: `Error: Memory ID '${memory_id}' not found.` }], isError: true };
        }

        let report = `### 📊 Structural Trajectory Analysis (STRACE) for Memory ${memory_id.substring(0, 8)}\n\n`;
        report += `Total versions traced: **${res.rows.length}**\n\n`;

        const faults = [];
        let totalSteps = 0;

        for (const row of res.rows) {
            report += `#### Version ${row.version_id} (Author: ${row.author_id}, Status: ${row.status})\n`;
            report += `- **Created At:** ${row.created_at.toISOString()}\n`;
            if (row.source_ref) {
                report += `- **Source Ref:** \`${row.source_ref}\`\n`;
            }

            let trace = [];
            if (row.action_trace) {
                try {
                    trace = typeof row.action_trace === 'string' ? JSON.parse(row.action_trace) : row.action_trace;
                } catch(e) {
                    report += `  - ⚠️ Failed to parse action trace JSON.\n`;
                }
            }

            if (!Array.isArray(trace)) {
                trace = trace ? [trace] : [];
            }

            if (trace.length === 0) {
                report += `  - *No action trace logged for this version.*\n`;
                continue;
            }

            report += `- **Action Trace Steps:**\n`;
            for (const step of trace) {
                totalSteps++;
                const stepIdx = step.step_index || step.step || totalSteps;
                const actionName = step.action || step.tool || 'unknown_action';
                const status = step.status || (step.success === false ? 'failed' : 'success');
                const resultText = step.result || step.output || step.error || '';
                const confidence = step.confidence !== undefined ? step.confidence : 1.0;

                const statusEmoji = status === 'failed' || resultText.toLowerCase().includes('error') || resultText.toLowerCase().includes('failed') ? '❌' : '✅';
                
                report += `  ${statusEmoji} **Step ${stepIdx}:** \`${actionName}\` (Confidence: ${confidence.toFixed(2)})\n`;
                if (step.args) {
                    report += `    - **Arguments:** \`${JSON.stringify(step.args)}\`\n`;
                }

                // If step failed or output contains error, log as potential causal fault node
                const isError = status === 'failed' || resultText.toLowerCase().includes('error') || resultText.toLowerCase().includes('failed') || resultText.toLowerCase().includes('exception');
                if (isError) {
                    faults.push({
                        version: row.version_id,
                        step: stepIdx,
                        action: actionName,
                        confidence,
                        snippet: resultText.substring(0, 200)
                    });
                }
            }
            report += `\n`;
        }

        // Causal Localization & Fault Isolation
        report += `### 🔍 Causal Fault Isolation\n\n`;
        if (faults.length === 0) {
            report += `✅ **No step-level failures or anomalies detected in the trajectory.**\n`;
        } else {
            report += `⚠️ Found **${faults.length}** anomaly/failure steps in the execution graph:\n\n`;
            for (const fault of faults) {
                report += `- **[Version ${fault.version}, Step ${fault.step}]** \`${fault.action}\` (Confidence: ${fault.confidence.toFixed(2)}):\n`;
                report += `  > *Error Snip:* \`${fault.snippet.replace(/\n/g, ' ')}\`\n`;
            }
            
            // Highlight the root cause (earliest version, earliest step)
            const root = faults[0];
            report += `\n🎯 **STRACE Root Cause Suggestion:** The trajectory drift likely originated at **Version ${root.version}, Step ${root.step}** during the execution of \`${root.action}\`.\n`;
        }

        return { content: [{ type: "text", text: report }] };
    } catch (err) {
        throw new McpError(ErrorCode.InternalError, `Trajectory analysis database error: ${err.message}`);
    } finally {
        client.release();
    }
}

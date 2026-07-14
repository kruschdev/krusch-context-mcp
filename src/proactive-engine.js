import dotenv from 'dotenv';
import { chat } from './llm.js';
import { searchMemory } from './memory-engine.js';
import { nuggetNudges } from './nuggets-engine.js';
import { getEmbedding } from 'pg-git-mcp/lib/embedding.js';
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { writeState } from './v2-engine.js';

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

    // 3. Search memories (lessons, bugs, priorities) and nuggets concurrently
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

    const [nuggetsResult, ...memoryResults] = await Promise.all([nuggetsPromise, ...memoryPromises]);

    // 4. Compile context block
    let contextBlock = "";
    for (let i = 0; i < categories.length; i++) {
        const text = memoryResults[i].content[0].text;
        if (text && !text.includes("No results found")) {
            contextBlock += `### Past ${categories[i].toUpperCase()}\n${text}\n\n`;
        }
    }

    const nuggetText = nuggetsResult.content[0].text;
    if (nuggetText && !nuggetText.includes("No relevant nudges found")) {
        contextBlock += `### Holographic Nuggets\n${nuggetText}\n\n`;
    }

    // If no context is found, there is nothing to audit against
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
        model: process.env.PROACTIVE_MODEL || 'qwen2.5-coder:7b',
        apiUrl: process.env.OLLAMA_URL 
            ? `${process.env.OLLAMA_URL.replace(/\/$/, '')}/v1/chat/completions` 
            : 'http://localhost:11434/v1/chat/completions',
        maxTokens: 1000,
        temperature: 0.1
    };

    // If OLLAMA_URL is not set but OPENROUTER_API_KEY is present, default to OpenRouter
    if (process.env.OPENROUTER_API_KEY && !process.env.OLLAMA_URL && !process.env.USE_LOCAL_OLLAMA_ONLY) {
        llmConfig = {
            provider: 'openai',
            apiKey: process.env.OPENROUTER_API_KEY,
            apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
            model: process.env.PROACTIVE_MODEL || 'google/gemini-2.5-flash',
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

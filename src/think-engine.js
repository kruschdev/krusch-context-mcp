import dotenv from 'dotenv';
import { chat } from './llm.js';
import { searchMemory } from './memory-engine.js';
import { getEmbedding, PRIORITY } from './embedding-helper.js';
import { searchBlobs } from 'pg-git-mcp/server/git-engine.js';
import { pool } from 'pg-git-mcp/db/pool.js';
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

// Ensure environment variables are loaded
dotenv.config();

/**
 * Cited synthesis, conflict detection, and gap analysis.
 *
 * @param {object} args
 * @param {string} args.query - Query topic or question
 * @param {string} [args.project] - Optional project context
 * @returns {Promise<{content: Array}>} MCP response payload
 */
export async function handleThink({ query, project }) {
    if (!query) {
        throw new McpError(ErrorCode.InvalidParams, "Missing required parameter 'query'");
    }

    console.error(`[krusch-context-mcp] Think execution initiated for query: "${query}"${project ? ` (project: ${project})` : ''}`);

    // 1. Generate semantic query embedding
    const vector = await getEmbedding(query, PRIORITY.HIGH);
    if (!vector) {
        throw new McpError(ErrorCode.InternalError, "Failed to generate embedding for the query");
    }

    // 2. Resolve repository ID if project context provided
    let resolvedRepoId = undefined;
    if (project) {
        const repoRes = await pool.query(`SELECT id FROM repositories WHERE name = $1`, [project]);
        if (repoRes.rows.length > 0) {
            resolvedRepoId = repoRes.rows[0].id;
        } else {
            console.warn(`[krusch-context-mcp] Project '${project}' not matched in PG-Git. Proceeding without repo filter.`);
        }
    }

    // 3. Retrieve subjective context (episodic memory categories)
    const categories = ['lessons', 'bugs', 'priorities', 'outcomes', 'activity'];
    const memoryPromises = categories.map(cat =>
        searchMemory({ category: cat, query, limit: 3, active_project: project, _embedding: vector })
            .catch(err => {
                console.error(`[krusch-context-mcp] Memory query error for category '${cat}':`, err);
                return { content: [{ type: "text", text: "" }] };
            })
    );

    // 4. Retrieve objective context (PG-Git codebase blobs)
    const blobsPromise = searchBlobs(vector, 5, resolvedRepoId)
        .catch(err => {
            console.error('[krusch-context-mcp] Git blob query error:', err);
            return [];
        });

    // 5. Gather all search matches concurrently
    const [blobMatches, ...memoryResults] = await Promise.all([blobsPromise, ...memoryPromises]);

    // 6. Construct structured context block
    let contextBlock = "=== SUBJECTIVE MEMORY RETRIEVAL ===\n\n";
    for (let i = 0; i < categories.length; i++) {
        const text = memoryResults[i].content[0].text;
        if (text && !text.includes("No results found")) {
            contextBlock += text + "\n\n";
        }
    }

    contextBlock += "=== OBJECTIVE CODEBASE (PG-GIT) ===\n\n";
    if (blobMatches.length === 0) {
        contextBlock += "No relevant files found.\n";
    } else {
        for (const r of blobMatches) {
            const projectTag = r.project ? `[${r.project}]` : '';
            const pathStr = r.file_path ? ` | Path: ${r.file_path}` : '';
            contextBlock += `--- Match (Score: ${Number(r.similarity).toFixed(2)}) | ${projectTag} ${r.file_name}${pathStr} ---\n`;
            contextBlock += (r.summary || '(no preview)') + '\n\n';
        }
    }

    // 7. Configure local/global LLM config
    const geminiApiKey = process.env.GEMINI_API_KEY;
    const llmConfig = geminiApiKey ? {
        provider: 'gemini',
        apiKey: geminiApiKey,
        model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
        maxTokens: 4000,
        temperature: 0.1
    } : {
        provider: 'ollama',
        model: process.env.COMPLETION_MODEL || process.env.THINK_MODEL || 'qwen2.5-coder:14b',
        apiUrl: process.env.COMPLETION_URL
            || (process.env.OLLAMA_URL 
                ? `${process.env.OLLAMA_URL.replace(/\/$/, '')}/v1/chat/completions` 
                : 'http://localhost:11434/v1/chat/completions'),
        apiKey: process.env.COMPLETION_API_KEY || null,
        maxTokens: 4000,
        temperature: 0.1
    };

    const systemPrompt = `You are the Krusch Fleet Central Reasoning Engine (GBrain Synthesis Service).
Your task is to synthesize the search results from the subjective homelab memory database and objective PG-Git codebase files to answer the user's query.

You MUST format your output exactly as standard Markdown with the following three headers:

### Cited Synthesis
Provide a clear, detailed, and directly cited response answering the user's query based on the retrieved context.
Every claim, status, credential, host IP, or fact you assert MUST be explicitly cited.
Use the format:
- For subjective memory matches: [Memory #ID] (e.g. "[Memory #123]")
- For objective codebase matches: [file_name](file:///path/to/file) or [file_name]

### Conflicts & Contradictions
Analyze the retrieved context to detect and highlight any conflicting information, configuration parameters, or outdated patterns.
For example, look for:
- Sibling memories that report different statuses (e.g., node UP vs DOWN, different ports).
- Mismatches between codebase realities and memory records.
- Outdated documentation or rules.
If no conflicts or contradictions are detected, state: "No conflicts or contradictions detected in the retrieved context."

### Information Gaps
Identify crucial contextual details that are missing from the retrieved sources to fully answer the query.
Detail what specific information, database records, files, or telemetry you would need to inspect next.
`;

    const userMessage = `User Query: "${query}"

Retrieved Context Blocks:
${contextBlock}
`;

    try {
        console.error(`[krusch-context-mcp] Dispatching synthesis request to LLM (provider: ${llmConfig.provider}, model: ${llmConfig.model})`);
        const text = await chat(systemPrompt, userMessage, llmConfig);
        return { content: [{ type: "text", text: text.trim() }] };
    } catch (err) {
        console.error("[krusch-context-mcp] LLM invocation failed:", err);
        throw new McpError(ErrorCode.InternalError, `LLM reasoning failed: ${err.message}`);
    }
}

#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError
} from "@modelcontextprotocol/sdk/types.js";

// Import logic from our required MCP packages
import { addMemory, searchMemory, listMemories, deleteMemory, updateMemory } from './memory-engine.js';
import { getEmbedding } from 'pg-git/lib/embedding.js';
import { searchBlobs, getRepositories } from 'pg-git/server/git-engine.js';
import { pool } from 'pg-git/db/pool.js';

// Verify DB connection
async function verifyDatabase() {
    try {
        await pool.query('SELECT 1');
        try {
            await pool.query('ALTER TABLE ide_agent_memory ADD COLUMN project VARCHAR(255)');
        } catch (e) {
            if (e.code !== '42701') throw e; // 42701 is duplicate column
        }
        try {
            await pool.query('ALTER TABLE ide_agent_memory ADD COLUMN tags TEXT');
        } catch (e) {
            if (e.code !== '42701') throw e;
        }
        console.error('[krusch-context-mcp] Database connection verified via pg-git pool. Migrations completed.');
    } catch (err) {
        console.error('[krusch-context-mcp] FATAL: Cannot reach PostgreSQL:', err.message);
        process.exit(1);
    }
}

const server = new Server({ name: "krusch-context-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "mcp_homelab-memory_add",
        description: "Add a new fact or memory to the persistent IDE database. Use this strictly to document bugs, priorities, lessons, or project outcomes.",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string" },
            category: { type: "string", enum: ['priorities', 'bugs', 'outcomes', 'lessons', 'activity'] },
            content: { type: "string" },
            tags: { type: "array", items: { type: "string" } }
          },
          required: ["category", "content"]
        }
      },
      {
        name: "mcp_homelab-memory_search",
        description: "Search the persistent IDE database for past lessons, bugs, priorities, or project outcomes via semantic embeddings.",
        inputSchema: {
          type: "object",
          properties: {
            active_project: { type: "string" },
            category: { type: "string", enum: ['priorities', 'bugs', 'outcomes', 'lessons', 'activity'] },
            query: { type: "string" },
            limit: { type: "number", default: 3 }
          },
          required: ["category", "query"]
        }
      },
      {
        name: "pg_git_semantic_search",
        description: "Semantically search the contents of all files in PG-Git. Results are automatically decayed by age so recent code ranks higher.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "number", default: 5 },
            project: { type: "string" },
            repository_id: { type: "number" }
          },
          required: ["query"]
        }
      },
      {
        name: "deep_context_search",
        description: "Zero-Trust composite search. Query both the objective codebase (PG-Git) and subjective history (Homelab Memory) simultaneously. Use this to establish a holistic baseline context for a topic.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "The search query." },
            project: { type: "string", description: "Optional project name to boost results." }
          },
          required: ["query"]
        }
      },
      {
        name: "mcp_homelab-memory_list",
        description: "List recent memories in a category, optionally filtered by project. No embedding required — fast chronological listing.",
        inputSchema: {
          type: "object",
          properties: {
            category: { type: "string", enum: ['priorities', 'bugs', 'outcomes', 'lessons', 'activity'] },
            project: { type: "string", description: "Filter by project name" },
            limit: { type: "number", default: 10 }
          },
          required: ["category"]
        }
      },
      {
        name: "mcp_homelab-memory_delete",
        description: "Delete a specific memory by its ID. Use list or search first to find the ID.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "number", description: "The numeric ID of the memory to delete" }
          },
          required: ["id"]
        }
      },
      {
        name: "mcp_homelab-memory_update",
        description: "Update an existing memory's content, tags, or project assignment. Content changes trigger re-embedding.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "number", description: "The numeric ID of the memory to update" },
            content: { type: "string", description: "New content (triggers re-embedding)" },
            tags: { type: "array", items: { type: "string" } },
            project: { type: "string", description: "New project assignment" }
          },
          required: ["id"]
        }
      },
      {
        name: "pg_git_list_repos",
        description: "List all repositories indexed in PG-Git with their IDs and descriptions.",
        inputSchema: {
          type: "object",
          properties: {}
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments || {};
  try {
    if (request.params.name === "mcp_homelab-memory_add") {
      return await addMemory(args);

    } else if (request.params.name === "mcp_homelab-memory_search") {
      return await searchMemory(args);

    } else if (request.params.name === "mcp_homelab-memory_list") {
      return await listMemories(args);

    } else if (request.params.name === "mcp_homelab-memory_delete") {
      return await deleteMemory(args);

    } else if (request.params.name === "mcp_homelab-memory_update") {
      return await updateMemory(args);

    } else if (request.params.name === "pg_git_list_repos") {
      const repos = await getRepositories();
      if (repos.length === 0) {
        return { content: [{ type: "text", text: "No repositories indexed in PG-Git." }] };
      }
      let output = `=== 📦 PG-Git Repositories (${repos.length}) ===\n`;
      for (const r of repos) {
        output += `\n- ID: ${r.id} | Name: ${r.name}${r.description ? ` | ${r.description}` : ''}${r.created_at ? ` | Created: ${new Date(r.created_at).toISOString().split('T')[0]}` : ''}`;
      }
      return { content: [{ type: "text", text: output }] };

    } else if (request.params.name === "pg_git_semantic_search") {
      const { query: searchQuery, limit = 5, repository_id, project } = args;
      
      let resolvedRepoId = repository_id;
      if (project && !resolvedRepoId) {
          const repoRes = await pool.query(`SELECT id FROM repositories WHERE name = $1`, [project]);
          if (repoRes.rows.length > 0) resolvedRepoId = repoRes.rows[0].id;
      }
      
      const vector = await getEmbedding(searchQuery);
      if (!vector) throw new McpError(ErrorCode.InternalError, "Failed to generate embedding");
      
      const results = await searchBlobs(vector, limit, resolvedRepoId);
      if (results.length === 0) return { content: [{ type: "text", text: "No semantically relevant files found." }] };
      
      let output = `=== 🔍 Semantic Codebase Results ===\n`;
      for (const r of results) {
          const dateStr = r.last_seen_at ? new Date(r.last_seen_at).toISOString().split('T')[0] : 'unknown';
          const projectTag = r.project ? `[${r.project}]` : '';
          const pathStr = r.file_path ? ` | Path: ${r.file_path}` : '';
          output += `\n--- Match (Score: ${Number(r.similarity).toFixed(2)}) | ${projectTag} ${r.file_name}${pathStr} | Seen: ${dateStr} ---\n`;
          const content = r.content.toString('utf-8');
          output += content.substring(0, 500) + (content.length > 500 ? '...\n' : '\n');
      }
      return { content: [{ type: "text", text: output }] };

    } else if (request.params.name === "deep_context_search") {
      const { query, project } = args;
      
      console.error(`[krusch-context-mcp] Executing deep context search for: "${query}"...`);
      
      // Generate embedding ONCE and share across all queries
      const vector = await getEmbedding(query);
      if (!vector) throw new McpError(ErrorCode.InternalError, "Failed to generate embedding");
      
      // Resolve repo ID for blob search
      let resolvedRepoId = undefined;
      if (project) {
          const repoRes = await pool.query(`SELECT id FROM repositories WHERE name = $1`, [project]);
          if (repoRes.rows.length > 0) resolvedRepoId = repoRes.rows[0].id;
      }
      
      // Search all memory categories + blobs concurrently with shared embedding
      const categories = ['lessons', 'bugs', 'priorities', 'outcomes', 'activity'];
      const memoryPromises = categories.map(cat =>
          searchMemory({ category: cat, query, limit: 2, active_project: project, _embedding: vector })
              .catch(() => ({ content: [{ type: "text", text: "" }] }))
      );
      const blobsPromise = searchBlobs(vector, 3, resolvedRepoId);
      
      const [blobMatches, ...memoryResults] = await Promise.all([blobsPromise, ...memoryPromises]);
      
      let output = `=== 🌍 DEEP CONTEXT SYNTHESIS ===\n\n`;
      
      // Merge memory results, skipping empty categories
      for (let i = 0; i < categories.length; i++) {
          const text = memoryResults[i].content[0].text;
          if (text && !text.includes("No results found")) {
              output += text + "\n\n";
          }
      }
      
      output += `=== 🔍 OBJECTIVE CODEBASE (PG-GIT) ===\n`;
      if (blobMatches.length === 0) {
        output += "No relevant files found.\n";
      } else {
        for (const r of blobMatches) {
            const projectTag = r.project ? `[${r.project}]` : '';
            const pathStr = r.file_path ? ` | Path: ${r.file_path}` : '';
            output += `\n--- Match (Score: ${Number(r.similarity).toFixed(2)}) | ${projectTag} ${r.file_name}${pathStr} ---\n`;
            const content = r.content.toString('utf-8');
            output += content.substring(0, 500) + (content.length > 500 ? '...\n' : '\n');
        }
      }
      
      return { content: [{ type: "text", text: output }] };

    } else {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
    }
  } catch (err) {
    if (err instanceof McpError) throw err;
    return { content: [{ type: "text", text: `[Error] ${err.message}` }], isError: true };
  }
});

async function shutdown() {
  console.error('[krusch-context-mcp] Shutting down...');
  try { await pool.end(); } catch (_) { }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

async function main() {
  await verifyDatabase();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[krusch-context-mcp] Server running on stdio");
}

main().catch(err => {
  console.error("[Fatal]", err);
  process.exit(1);
});

#!/usr/bin/env node

/**
 * @module krusch-context-mcp
 * Sovereign, low-latency working-memory and AST code-retrieval layer for coding agents.
 * 13 core tools by default, with modular companion extensions.
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ErrorCode,
  McpError
} from "@modelcontextprotocol/sdk/types.js";

import { trace } from '@opentelemetry/api';
import { initTracing } from './telemetry.js';

// Core engine imports
import {
  addMemory,
  searchMemory,
  listMemories,
  deleteMemory,
  updateMemory,
  consolidateMemories,
  compileProjectState,
  supersedeMemory,
  invalidateMemory
} from './memory-engine.js';
import { nuggetRemember, nuggetNudges, nuggetForget, nuggetList } from './nuggets-engine.js';
import { handleThink } from './think-engine.js';
import { handleProactiveNudge, handleNudgeFeedback } from './proactive-engine.js';
import { getEmbedding, getEmbeddingProvider, getConfiguredEmbeddingDim } from './embedding-helper.js';
import {
  searchBlobs,
  getRepositories,
  getRepoRootTree,
  getTreeEntries,
  getBlob,
  searchSymbols,
  getSymbolsForBlob,
  getSymbolGraph
} from './git-engine.js';
import { pool } from '../db/pool.js';
import { detectPgContext, initPgContextCollections, isPgContextEnabled } from './pgcontext-helper.js';
import { unifiedRetrieve } from './unified-retrieval.js';
import { loadExtensions, resolveExtension } from './extensions/index.js';
import { detectCurrentProject, getWorktreeStatus } from './project-helper.js';

// Verify core database connection and tables
async function verifyDatabase() {
    try {
        await pool.query('SELECT 1');
        
        const hasPgContext = await detectPgContext(pool);
        if (hasPgContext) {
            console.error('[krusch-context-mcp] pgContext extension active. Initializing collections...');
            await initPgContextCollections(pool);
        }
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS ide_agent_memory (
                id SERIAL PRIMARY KEY,
                category VARCHAR(50) NOT NULL,
                content TEXT NOT NULL,
                tags TEXT,
                embedding VECTOR(1024),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        try {
            await pool.query('ALTER TABLE ide_agent_memory ADD COLUMN project VARCHAR(255)');
        } catch (e) {
            if (e.code !== '42701' && e.code !== '42P07') throw e;
        }
        try {
            await pool.query('ALTER TABLE ide_agent_memory ADD COLUMN tags TEXT');
        } catch (e) {
            if (e.code !== '42701') throw e;
        }
        try {
            await pool.query("ALTER TABLE ide_agent_memory ADD COLUMN status VARCHAR(20) DEFAULT 'ACTIVE'");
        } catch (e) {
            if (e.code !== '42701') throw e;
        }
        try {
            await pool.query('ALTER TABLE ide_agent_memory ADD COLUMN supersedes_id INT');
        } catch (e) {
            if (e.code !== '42701') throw e;
        }
        try {
            await pool.query('ALTER TABLE ide_agent_memory ADD COLUMN superseded_by INT');
        } catch (e) {
            if (e.code !== '42701') throw e;
        }
        try {
            await pool.query('ALTER TABLE ide_agent_memory ADD COLUMN valid_until TIMESTAMP');
        } catch (e) {
            if (e.code !== '42701') throw e;
        }

        // Add ide_agent_nuggets table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS ide_agent_nuggets (
                id SERIAL PRIMARY KEY,
                key VARCHAR(255) UNIQUE NOT NULL,
                value TEXT NOT NULL,
                kind VARCHAR(50) DEFAULT 'project',
                embedding vector(1024),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        try {
            await pool.query('ALTER TABLE ide_agent_nuggets ADD COLUMN project VARCHAR(255)');
        } catch (e) {
            if (e.code !== '42701') throw e;
        }

        await pool.query('CREATE INDEX IF NOT EXISTS idx_v1_embedding ON ide_agent_memory USING hnsw (embedding vector_cosine_ops)');

        console.error('[krusch-context-mcp] Core database connection verified. Core tables ready.');
    } catch (err) {
        console.error('[krusch-context-mcp] FATAL: Cannot reach PostgreSQL:', err.message);
        process.exit(1);
    }
}

export const VERSION = "1.7.0";
const server = new Server({ name: "krusch-context-mcp", version: VERSION }, { capabilities: { tools: {}, prompts: {} } });

// Core tool definitions (13 curated daily drivers)
export const CORE_TOOLS = new Set([
  "krusch_context_retrieve",
  "krusch_context_add_memory",
  "krusch_context_supersede_memory",
  "krusch_context_invalidate_memory",
  "krusch_context_search_memory",
  "krusch_context_compile_state",
  "krusch_context_nugget_remember",
  "krusch_context_nugget_nudges",
  "krusch_context_search_symbols",
  "krusch_context_symbol_graph",
  "krusch_context_search_code",
  "krusch_context_health",
  "krusch_context_proactive_nudge"
]);

// Extended core inspection tools (13 tools)
export const EXTENDED_CORE_TOOLS = new Set([
  "krusch_context_list_memories",
  "krusch_context_delete_memory",
  "krusch_context_update_memory",
  "krusch_context_consolidate",
  "krusch_context_deep_search",
  "krusch_context_list_repos",
  "krusch_context_read_tree",
  "krusch_context_read_blob",
  "krusch_context_file_symbols",
  "krusch_context_nugget_forget",
  "krusch_context_nugget_list",
  "krusch_context_think",
  "krusch_context_nudge_feedback"
]);

export function getActiveProfile() {
  const profileArg = process.argv.find(a => a.startsWith('--profile='));
  const rawProfile = profileArg 
    ? profileArg.split('=')[1] 
    : (process.env.KRUSCH_PROFILE || 'core');
  
  const normalized = rawProfile.toLowerCase().trim();
  if (normalized === 'full' || normalized === 'all') return 'full';
  if (normalized === 'extended' || normalized === 'standard') return 'extended';
  if (normalized === 'sovereign' || normalized === 'triad' || normalized === 'quartet') return 'sovereign';
  if (normalized === 'ecosystem' || normalized === 'cascade') return 'ecosystem';
  if (normalized === 'router') return 'router';
  return 'core';
}

export function getRequestedExtensions() {
  const extArg = process.argv.find(a => a.startsWith('--extensions=') || a.startsWith('--extension='));
  const rawList = extArg 
    ? extArg.split('=')[1].split(',').map(s => s.trim()).filter(Boolean)
    : (process.env.KRUSCH_EXTENSIONS ? process.env.KRUSCH_EXTENSIONS.split(',').map(s => s.trim()).filter(Boolean) : []);

  const profile = getActiveProfile();
  if (profile === 'full' || rawList.includes('all')) {
    return ['all'];
  }
  if (profile === 'router') {
    return ['semantic-router'];
  }
  if (profile === 'sovereign' || profile === 'ecosystem') {
    // Sovereign Quartet bundle: loads semantic-router, law, nexus, and biz
    const exts = new Set(['semantic-router', 'law', 'nexus', 'biz', ...rawList.filter(e => e !== 'none' && e !== 'no-polygres')]);
    return Array.from(exts);
  }

  const exts = new Set(rawList.filter(e => e !== 'none' && e !== 'no-polygres'));
  return Array.from(exts);
}


// Core Tool Schemas
export const CORE_TOOL_DEFINITIONS = [
  {
    name: "krusch_context_retrieve",
    description: "Polygres-inspired unified context retrieval tool. Combines HNSW vector search, multi-hop graph walks, and server-side token budget packing into a single context payload.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        project: { type: "string" },
        graph_hops: { type: "number", default: 1 },
        limit_tokens: { type: "number", default: 4000 },
        include_code: { type: "boolean", default: true },
        include_state: { type: "boolean", default: false, description: "Optionally prepend compiled project state briefing directly into the packed payload" }
      },
      required: ["query"]
    }
  },
  {
    name: "krusch_context_add_memory",
    description: "Add a new fact or memory to the persistent IDE database. Supports MobileMem temporal superseding via supersedes_id.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        active_project: { type: "string", description: "Optional project context (alias for project)" },
        category: { type: "string", enum: ['priorities', 'bugs', 'outcomes', 'lessons', 'activity'] },
        content: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        supersedes_id: { type: "number", description: "Optional ID of a previous memory record that this new fact supersedes/replaces." }
      },
      required: ["category", "content"]
    }
  },
  {
    name: "krusch_context_supersede_memory",
    description: "Explicitly supersede an outdated memory with updated knowledge, linking lineage and marking the old record as SUPERSEDED.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Target memory ID to supersede" },
        category: { type: "string", enum: ['priorities', 'bugs', 'outcomes', 'lessons', 'activity'] },
        content: { type: "string", description: "New authoritative content" },
        project: { type: "string" },
        active_project: { type: "string", description: "Optional project context (alias for project)" },
        tags: { type: "array", items: { type: "string" } }
      },
      required: ["id", "category", "content"]
    }
  },
  {
    name: "krusch_context_invalidate_memory",
    description: "Explicitly mark a memory record as INVALIDATED (e.g. revoked secret, deprecated invariant, obsolete design rule).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Memory ID to invalidate" },
        project: { type: "string" },
        active_project: { type: "string", description: "Optional project context (alias for project)" },
        reason: { type: "string", description: "Reason for invalidating this memory" }
      },
      required: ["id"]
    }
  },
  {
    name: "krusch_context_search_memory",
    description: "Search the persistent IDE database for past lessons, bugs, priorities, or project outcomes. Excludes superseded/invalidated records by default.",
    inputSchema: {
      type: "object",
      properties: {
        active_project: { type: "string", description: "The active project context (alias for project)" },
        project: { type: "string", description: "The active project context (alias for active_project)" },
        category: { type: "string", enum: ['priorities', 'bugs', 'outcomes', 'lessons', 'activity'] },
        query: { type: "string" },
        limit: { type: "number", default: 3 },
        search_type: { type: "string", enum: ['semantic', 'keyword', 'tag'], default: 'semantic' },
        include_history: { type: "boolean", default: false },
        include_superseded: { type: "boolean", default: false, description: "If true, includes superseded and invalidated records" }
      },
      required: ["category", "query"]
    }
  },
  {
    name: "krusch_context_compile_state",
    description: "Compile a consolidated project state briefing (active priorities, recent blockers, outcome history, steering nuggets). Auto-detects project if omitted.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "The project to compile state for. Defaults to detected active project if omitted." },
        active_project: { type: "string", description: "Alias for project" }
      },
      required: []
    }
  },
  {
    name: "krusch_context_search_code",
    description: "Semantically search the contents of all files in PG-Git with age-decay weighting.",
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
    name: "krusch_context_search_symbols",
    description: "Search extracted AST code symbols (functions, classes, interfaces, methods) across indexed repositories.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Symbol name or substring to search" },
        limit: { type: "number", default: 20 },
        repository_id: { type: "number", description: "Optional repository ID filter" },
        project: { type: "string", description: "Optional project name filter" }
      },
      required: ["query"]
    }
  },
  {
    name: "krusch_context_symbol_graph",
    description: "Traverse dependency and call edges for an AST symbol up to N hops.",
    inputSchema: {
      type: "object",
      properties: {
        symbol_name: { type: "string", description: "The symbol identifier to traverse" },
        depth: { type: "number", default: 2 },
        repository_id: { type: "number", description: "Optional repository ID" },
        project: { type: "string", description: "Optional project name filter" }
      },
      required: ["symbol_name"]
    }
  },
  {
    name: "krusch_context_nugget_remember",
    description: "Store a short, durable Holographic Nugget memory fact (coding standards, conventions).",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
        value: { type: "string" },
        kind: { type: "string", enum: ['project', 'user', 'agent'] },
        project: { type: "string", description: "The project context (alias for active_project)." },
        active_project: { type: "string", description: "The active project context. Required for 'project' kind nuggets." }
      },
      required: ["key", "value"]
    }
  },
  {
    name: "krusch_context_nugget_nudges",
    description: "Return short, relevant Nuggets facts to gently steer the agent.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        kinds: { type: "array", items: { type: "string", enum: ['project', 'user', 'agent'] } },
        limit: { type: "number", default: 3 },
        project: { type: "string", description: "The project context (alias for active_project)." },
        active_project: { type: "string", description: "The active project context. Required to retrieve 'project' kind nuggets." }
      },
      required: ["query"]
    }
  },
  {
    name: "krusch_context_proactive_nudge",
    description: "Proactively audits current agent trajectory against historical lessons, bugs, priorities, and nuggets. Returns a warning nudge if any constraints or rules are violated.",
    inputSchema: {
      type: "object",
      properties: {
        history: {
          oneOf: [
            { type: "string", description: "The last user query or current task context." },
            {
              type: "array",
              items: {
                type: "object",
                properties: {
                  role: { type: "string", enum: ["user", "assistant", "system"] },
                  content: { type: "string" }
                },
                required: ["role", "content"]
              },
              description: "Full sliding window of conversation history."
            }
          ]
        },
        project: { type: "string", description: "Optional active project scope." }
      },
      required: ["history"]
    }
  },
  {
    name: "krusch_context_health",
    description: "Inspect the health, connectivity, and counts of the context engine.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  }
];

// Extended Core Tool Schemas
export const EXTENDED_CORE_DEFINITIONS = [
  {
    name: "krusch_context_list_memories",
    description: "List recent memories in a category, optionally filtered by project. Fast chronological listing.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", enum: ['priorities', 'bugs', 'outcomes', 'lessons', 'activity'] },
        project: { type: "string", description: "Filter by project name" },
        active_project: { type: "string", description: "Optional project filter (alias for project)" },
        limit: { type: "number", default: 10 }
      },
      required: ["category"]
    }
  },
  {
    name: "krusch_context_delete_memory",
    description: "Delete a specific memory by its numeric ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "The numeric ID of the memory to delete" },
        source_project: { type: "string", description: "Project name for SQLite memory. Leave empty for Global PG." },
        project: { type: "string", description: "Optional alias for source_project" }
      },
      required: ["id"]
    }
  },
  {
    name: "krusch_context_update_memory",
    description: "Update an existing memory's content, tags, or project assignment.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "The numeric ID of the memory to update" },
        source_project: { type: "string", description: "Project name if SQLite memory." },
        active_project: { type: "string", description: "Optional alias for source_project" },
        content: { type: "string", description: "New content (triggers re-embedding)" },
        tags: { type: "array", items: { type: "string" } },
        project: { type: "string", description: "New project assignment" }
      },
      required: ["id"]
    }
  },
  {
    name: "krusch_context_consolidate",
    description: "Consolidate duplicate or highly similar memories within a category and project.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", enum: ['priorities', 'bugs', 'outcomes', 'lessons', 'activity'] },
        project: { type: "string" },
        active_project: { type: "string", description: "Optional alias for project" },
        threshold: { type: "number", default: 0.88 },
        dry_run: { type: "boolean", default: true }
      },
      required: ["category"]
    }
  },
  {
    name: "krusch_context_deep_search",
    description: "Deep concurrent search across all episodic memory categories and PG-Git codebase blobs.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
        project: { type: "string", description: "Optional project name." }
      },
      required: ["query"]
    }
  },
  {
    name: "krusch_context_list_repos",
    description: "List all repositories indexed in PG-Git with their IDs and descriptions.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "krusch_context_read_tree",
    description: "Browse the file tree of a repository indexed in PG-Git.",
    inputSchema: {
      type: "object",
      properties: {
        repository_id: { type: "number", description: "The repository ID" },
        tree_id: { type: "string", description: "The tree hash to browse. Omit for root tree." }
      },
      required: ["repository_id"]
    }
  },
  {
    name: "krusch_context_read_blob",
    description: "Read the full content of a specific file (blob) from PG-Git by its SHA hash.",
    inputSchema: {
      type: "object",
      properties: {
        blob_id: { type: "string", description: "The SHA hash of the blob to read" }
      },
      required: ["blob_id"]
    }
  },
  {
    name: "krusch_context_file_symbols",
    description: "Get all AST code symbols extracted for a given file blob SHA.",
    inputSchema: {
      type: "object",
      properties: {
        blob_id: { type: "string", description: "The SHA hash of the blob" }
      },
      required: ["blob_id"]
    }
  },
  {
    name: "krusch_context_nugget_forget",
    description: "Delete a specific holographic nugget by key.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
        project: { type: "string", description: "Project context (alias for active_project)." },
        active_project: { type: "string", description: "Active project context." }
      },
      required: ["key"]
    }
  },
  {
    name: "krusch_context_nugget_list",
    description: "List all saved holographic nuggets chronologically.",
    inputSchema: {
      type: "object",
      properties: {
        kinds: { type: "array", items: { type: "string", enum: ['project', 'user', 'agent'] } },
        project: { type: "string" },
        active_project: { type: "string" }
      }
    }
  },
  {
    name: "krusch_context_think",
    description: "Perform cited context synthesis, conflict detection, and gap analysis across memory and codebase.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The query or question to think about." },
        project: { type: "string", description: "Optional project filter." }
      },
      required: ["query"]
    }
  },
  {
    name: "krusch_context_nudge_feedback",
    description: "Logs developer feedback for proactive auditor nudges to collect alignment signals.",
    inputSchema: {
      type: "object",
      properties: {
        query_text: { type: "string" },
        nudge_text: { type: "string" },
        user_approved: { type: "boolean" },
        agent_corrected: { type: "boolean" },
        correction_diff: { type: "string" },
        project: { type: "string" }
      },
      required: ["query_text", "nudge_text", "user_approved", "agent_corrected"]
    }
  }
];

// Inline Git and Code Search Handlers
async function handleListRepos() {
  const repos = await getRepositories();
  if (repos.length === 0) {
    return { content: [{ type: "text", text: "No repositories indexed in PG-Git." }] };
  }
  let output = `=== 📦 PG-Git Repositories (${repos.length}) ===\n`;
  for (const r of repos) {
    output += `\n- ID: ${r.id} | Name: ${r.name}${r.description ? ` | ${r.description}` : ''}${r.created_at ? ` | Created: ${new Date(r.created_at).toISOString().split('T')[0]}` : ''}`;
  }
  return { content: [{ type: "text", text: output }] };
}

async function handleSearchCode(args) {
  const { query: searchQuery, limit = 5, project, repository_id } = args;
  let resolvedRepoId = repository_id;
  const targetProject = project || detectCurrentProject();
  if (targetProject && !resolvedRepoId) {
      const repoRes = await pool.query(`SELECT id FROM repositories WHERE name = $1`, [targetProject]);
      if (repoRes.rows.length > 0) {
          resolvedRepoId = repoRes.rows[0].id;
      } else if (project) {
          throw new McpError(ErrorCode.InvalidParams, `Project '${project}' not found in PG-Git. Use krusch_context_list_repos to verify exact repository names.`);
      }
  }
  
  const vector = await getEmbedding(searchQuery);
  if (!vector) throw new McpError(ErrorCode.InternalError, "Failed to generate embedding");
  
  const results = await searchBlobs(vector, limit, resolvedRepoId, searchQuery);
  if (results.length === 0) return { content: [{ type: "text", text: "No semantically relevant files found." }] };
  
  let output = `=== 🔍 Semantic Codebase Results ===\n`;
  for (const r of results) {
      const dateStr = r.last_seen_at ? new Date(r.last_seen_at).toISOString().split('T')[0] : 'unknown';
      const projectTag = r.project ? `[${r.project}]` : '';
      const pathStr = r.file_path ? ` | Path: ${r.file_path}` : '';
      output += `\n--- Match (Score: ${Number(r.similarity).toFixed(2)}) | ${projectTag} ${r.file_name}${pathStr} | Seen: ${dateStr} ---\n`;
      output += (r.summary || '(no preview)') + '\n';
  }
  return { content: [{ type: "text", text: output }] };
}

async function handleDeepSearch(args) {
  const { query, project } = args;
  const vector = await getEmbedding(query);
  if (!vector) throw new McpError(ErrorCode.InternalError, "Failed to generate embedding");
  
  let resolvedRepoId = undefined;
  if (project) {
      const repoRes = await pool.query(`SELECT id FROM repositories WHERE name = $1`, [project]);
      if (repoRes.rows.length > 0) {
          resolvedRepoId = repoRes.rows[0].id;
      } else {
          throw new McpError(ErrorCode.InvalidParams, `Project '${project}' not found in PG-Git. Use krusch_context_list_repos to verify exact repository names.`);
      }
  }
  
  const categories = ['lessons', 'bugs', 'priorities', 'outcomes', 'activity'];
  const memoryPromises = categories.map(cat =>
      searchMemory({ category: cat, query, limit: 2, active_project: project, _embedding: vector })
          .catch(() => ({ content: [{ type: "text", text: "" }] }))
  );
  const blobsPromise = searchBlobs(vector, 3, resolvedRepoId, query);
  
  const [blobMatches, ...memoryResults] = await Promise.all([blobsPromise, ...memoryPromises]);
  
  let output = `=== 🌍 DEEP CONTEXT SYNTHESIS ===\n\n`;
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
        output += (r.summary || '(no preview)') + '\n';
    }
  }
  return { content: [{ type: "text", text: output }] };
}

async function handleReadTree(args) {
  const { repository_id, tree_id } = args;
  let treeHash = tree_id;
  if (!treeHash) {
    treeHash = await getRepoRootTree(repository_id);
    if (!treeHash) return { content: [{ type: "text", text: "No root tree found for this repository." }] };
  }
  const entries = await getTreeEntries(treeHash);
  if (entries.length === 0) return { content: [{ type: "text", text: `No entries found in tree: ${treeHash}` }] };
  let output = `=== 🌳 Tree: ${treeHash.substring(0, 12)}... (${entries.length} entries) ===\n`;
  for (const e of entries) {
    const icon = e.type === 'tree' ? '📁' : '📄';
    output += `\n${icon} ${e.name} (${e.type}) → ${e.object_id}`;
  }
  return { content: [{ type: "text", text: output }] };
}

async function handleReadBlob(args) {
  const blob = await getBlob(args.blob_id);
  if (!blob) return { content: [{ type: "text", text: `No blob found with ID: ${args.blob_id}` }] };
  const content = blob.content instanceof Buffer ? blob.content.toString('utf-8') : String(blob.content);
  const header = `=== 📄 Blob: ${args.blob_id.substring(0, 12)}... (${blob.size || content.length} bytes) ===\n`;
  return { content: [{ type: "text", text: header + content }] };
}

async function handleSearchSymbols(args) {
  const { query, limit = 20, repository_id, project } = args;
  let resolvedRepoId = repository_id;
  const targetProject = project || detectCurrentProject();
  if (targetProject && !resolvedRepoId) {
    const repoRes = await pool.query('SELECT id FROM repositories WHERE name = $1', [targetProject]);
    if (repoRes.rows.length > 0) resolvedRepoId = repoRes.rows[0].id;
  }
  const symbols = await searchSymbols(query, limit, resolvedRepoId);
  if (symbols.length === 0) return { content: [{ type: "text", text: `No symbols matching '${query}' found.` }] };
  let output = `=== 🧩 Code Symbols Matching '${query}' (${symbols.length}) ===\n`;
  for (const s of symbols) {
    const doc = s.docstring ? ` - ${s.docstring.split('\n')[0]}` : '';
    const loc = s.file_path ? ` | ${s.file_path}:${s.start_line}-${s.end_line}` : '';
    output += `\n- [${s.kind}] ${s.name}${s.signature ? `(${s.signature})` : ''}${loc}${doc}`;
  }
  return { content: [{ type: "text", text: output }] };
}

async function handleFileSymbols(args) {
  const { blob_id } = args;
  const symbols = await getSymbolsForBlob(blob_id);
  if (symbols.length === 0) return { content: [{ type: "text", text: `No AST symbols recorded for blob '${blob_id}'.` }] };
  let output = `=== 🧩 AST Symbols for Blob ${blob_id.substring(0, 10)} (${symbols.length}) ===\n`;
  for (const s of symbols) {
    output += `\n- [${s.kind}] ${s.name} (L${s.start_line}-L${s.end_line})`;
  }
  return { content: [{ type: "text", text: output }] };
}

async function handleSymbolGraph(args) {
  const { symbol_name, repository_id, project, depth = 2 } = args;
  let resolvedRepoId = repository_id;
  const targetProject = project || detectCurrentProject();
  if (targetProject && !resolvedRepoId) {
    const repoRes = await pool.query('SELECT id FROM repositories WHERE name = $1', [targetProject]);
    if (repoRes.rows.length > 0) resolvedRepoId = repoRes.rows[0].id;
  }
  const graph = await getSymbolGraph(symbol_name, resolvedRepoId, depth);
  let output = `=== 🕸️ Symbol Dependency Graph: ${symbol_name} ===\n`;
  output += `Nodes: ${graph.nodes.length} | Edges: ${graph.edges.length}\n\n`;
  if (graph.nodes.length > 0) {
    output += `--- Symbols ---\n`;
    for (const n of graph.nodes) {
      output += `- [${n.kind}] ${n.name} in ${n.file_path || 'unknown'}\n`;
    }
  }
  if (graph.edges.length > 0) {
    output += `\n--- Edges ---\n`;
    for (const e of graph.edges) {
      output += `- ${e.source_symbol} --(${e.edge_type})--> ${e.target_symbol}\n`;
    }
  }
  return { content: [{ type: "text", text: output }] };
}

async function handleHealthCheck() {
  const dbCheck = await pool.query('SELECT COUNT(*) as count FROM ide_agent_memory');
  const repoCheck = await pool.query('SELECT COUNT(*) as count FROM repositories');
  const nuggetCheck = await pool.query('SELECT COUNT(*) as count FROM ide_agent_nuggets');
  const symbolCheck = await pool.query('SELECT COUNT(*) as count FROM code_symbols').catch(() => ({ rows: [{ count: 0 }] }));
  
  let v2Count = 0;
  try {
    const v2Check = await pool.query("SELECT COUNT(*) as count FROM interaction_memory WHERE status = 'active'");
    v2Count = v2Check.rows[0].count;
  } catch (_) {}

  const memoryCount = dbCheck.rows[0].count;
  const repoCount = repoCheck.rows[0].count;
  const nuggetCount = nuggetCheck.rows[0].count;
  const symbolCount = symbolCheck.rows[0]?.count || 0;
  const engineStatus = isPgContextEnabled() ? 'pgContext (HNSW + Single-Pass Filter)' : 'pgvector (Standard)';
  const embedProvider = getEmbeddingProvider();
  const expectedDim = getConfiguredEmbeddingDim();

  let dimensionStatus = { ok: true, details: [] };
  try {
    const dimCheck = await pool.query(`
      SELECT c.relname, a.attname, a.atttypmod 
      FROM pg_attribute a 
      JOIN pg_class c ON a.attrelid = c.oid 
      WHERE c.relname IN ('ide_agent_memory', 'ide_agent_nuggets', 'blobs') 
        AND a.attname = 'embedding'
    `);
    for (const row of dimCheck.rows) {
      const colDim = row.atttypmod;
      if (colDim !== -1 && colDim !== expectedDim) {
        dimensionStatus.ok = false;
        dimensionStatus.details.push(`${row.relname} is vector(${colDim})`);
      }
    }
  } catch (err) {
    dimensionStatus.ok = false;
    dimensionStatus.details.push(`Could not query column dimensions: ${err.message}`);
  }

  const isHealthy = dimensionStatus.ok;
  const statusHeader = isHealthy ? '[krusch-context-mcp] 🟢 Server is healthy.' : '[krusch-context-mcp] ⚠️ Server is degraded (Dimension Mismatch).';

  let text = `${statusHeader}\n- Episodic memories (v1): ${memoryCount}\n- Holographic nuggets: ${nuggetCount}\n- Indexed repositories: ${repoCount}\n- Extracted symbols: ${symbolCount}\n- Embedding Provider: ${embedProvider.name}\n- Vector Engine: ${engineStatus}`;

  if (dimensionStatus.ok) {
    text += `\n- Vector Dimensions: 🟢 ${expectedDim}d (verified: ide_agent_memory, ide_agent_nuggets, blobs)`;
  } else {
    text += `\n- Vector Dimensions: ⚠️ MISMATCH — ${dimensionStatus.details.join('; ')} (config expects ${expectedDim}d)`;
    text += `\n- Dimension Remediation: Set EMBED_DIMS in .env to match DB, or run: psql $DATABASE_URL -v target_dim=${expectedDim} -f db/migrate_dimensions.sql`;
  }

  text += `\n- Database: Connected\n- Version: ${VERSION}`;
  if (v2Count > 0) {
    text += `\n- Company Brain states (v2): ${v2Count}`;
  }

  const worktree = getWorktreeStatus();
  if (worktree.isDirty) {
    text += `\n- Worktree Status: ${worktree.message}`;
  } else {
    text += `\n- Worktree Status: 🟢 Clean (synchronized with Git HEAD)`;
  }

  return { content: [{ type: "text", text }] };
}

// Master Dispatch Table
export const TOOL_HANDLERS = new Map([
  ['krusch_context_retrieve',       (args) => unifiedRetrieve(args)],
  ['krusch_context_add_memory',       (args) => addMemory(args)],
  ['krusch_context_supersede_memory', (args) => supersedeMemory(args)],
  ['krusch_context_invalidate_memory', (args) => invalidateMemory(args)],
  ['krusch_context_search_memory',    (args) => searchMemory(args)],
  ['krusch_context_compile_state',  (args) => compileProjectState(args)],
  ['krusch_context_nugget_remember', (args) => nuggetRemember(args)],
  ['krusch_context_nugget_nudges',   (args) => nuggetNudges(args)],
  ['krusch_context_search_symbols',   (args) => handleSearchSymbols(args)],
  ['pg_git_search_symbols',           (args) => handleSearchSymbols(args)],
  ['krusch_context_symbol_graph',     (args) => handleSymbolGraph(args)],
  ['pg_git_dependency_graph',         (args) => handleSymbolGraph(args)],
  ['krusch_context_search_code',     (args) => handleSearchCode(args)],
  ['krusch_context_health',          () => handleHealthCheck()],
  ['krusch_context_health_check',    () => handleHealthCheck()],
  ['krusch_context_proactive_nudge', (args) => handleProactiveNudge(args)],
  ['krusch_context_nudge_feedback', (args) => handleNudgeFeedback(args)],

  // Extended Core inspection handlers
  ['krusch_context_list_memories',    (args) => listMemories(args)],
  ['krusch_context_delete_memory',  (args) => deleteMemory(args)],
  ['krusch_context_update_memory',  (args) => updateMemory(args)],
  ['krusch_context_consolidate',    (args) => consolidateMemories(args)],
  ['krusch_context_deep_search',     (args) => handleDeepSearch(args)],
  ['krusch_context_list_repos',      () => handleListRepos()],
  ['krusch_context_read_tree',       (args) => handleReadTree(args)],
  ['krusch_context_read_blob',       (args) => handleReadBlob(args)],
  ['krusch_context_file_symbols',     (args) => handleFileSymbols(args)],
  ['pg_git_file_symbols',             (args) => handleFileSymbols(args)],
  ['krusch_context_nugget_forget',   (args) => nuggetForget(args)],
  ['krusch_context_nugget_list',     (args) => nuggetList(args)],
  ['krusch_context_think',           (args) => handleThink(args)]
]);

export let activeExtensions = [];

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const activeProfile = getActiveProfile();
  let tools = [];

  if (activeProfile === 'router') {
    tools = CORE_TOOL_DEFINITIONS.filter(t => t.name === 'krusch_context_health');
  } else {
    tools = [...CORE_TOOL_DEFINITIONS];
    if (activeProfile === 'extended' || activeProfile === 'full') {
      tools.push(...EXTENDED_CORE_DEFINITIONS);
    }
  }

  for (const ext of activeExtensions) {
    if (ext.tools) {
      tools.push(...ext.tools);
    }
  }

  return { tools };
});

export const CORE_PROMPTS = [
  {
    name: "session_start",
    description: "Initializes coding agent working memory: hydrates compiled project state, priorities, and steering conventions.",
    arguments: [
      { name: "project", description: "Target project name (auto-detected if omitted)", required: false }
    ],
    generateMessages: (args) => {
      const proj = args?.project || detectCurrentProject() || "current project";
      return [
        {
          role: "user",
          content: {
            type: "text",
            text: `Please initialize the session for '${proj}' using krusch-context-mcp:\n` +
                  `1. Call krusch_context_compile_state to review active priorities, recent lessons, and blockers.\n` +
                  `2. Call krusch_context_nugget_nudges to load active project conventions and steering rules.\n` +
                  `3. Report a concise briefing before proposing any code edits.`
          }
        }
      ];
    }
  },
  {
    name: "pre_commit",
    description: "Pre-commit verification prompt: audits uncommitted changes against steering rules and updates memory.",
    arguments: [
      { name: "project", description: "Target project name (auto-detected if omitted)", required: false }
    ],
    generateMessages: (args) => {
      const proj = args?.project || detectCurrentProject() || "current project";
      return [
        {
          role: "user",
          content: {
            type: "text",
            text: `Before committing changes in '${proj}':\n` +
                  `1. Call krusch_context_nugget_nudges to ensure changes comply with all project conventions.\n` +
                  `2. If any architectural decisions or bug workarounds changed, record them via krusch_context_add_memory or supersede outdated ones via krusch_context_supersede_memory.\n` +
                  `3. Remind to run 'npm run snapshot -- .' if new files were created to synchronize PG-Git symbol graphs.`
          }
        }
      ];
    }
  }
];

server.setRequestHandler(ListPromptsRequestSchema, async () => {
  const prompts = CORE_PROMPTS.map(p => ({
    name: p.name,
    description: p.description,
    arguments: p.arguments || []
  }));

  const skillsExt = activeExtensions.find(e => e.name === 'skills-docs');
  if (skillsExt) {
    const { listSkills } = await import('./extensions/skills-docs/skills-engine.js');
    const skills = listSkills();
    prompts.push(...skills.map(s => ({
      name: s.name,
      description: s.description,
      arguments: s.argumentHint ? [{ name: "argument", description: s.argumentHint, required: false }] : []
    })));
  }

  return { prompts };
});

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const promptName = request.params.name;
  const corePrompt = CORE_PROMPTS.find(p => p.name === promptName);
  if (corePrompt) {
    return {
      description: corePrompt.description,
      messages: corePrompt.generateMessages(request.params.arguments || {})
    };
  }

  const skillsExt = activeExtensions.find(e => e.name === 'skills-docs');
  if (skillsExt) {
    const { getSkill } = await import('./extensions/skills-docs/skills-engine.js');
    const skill = getSkill(promptName);
    if (skill) {
      return {
        description: skill.description,
        messages: [{ role: "user", content: { type: "text", text: skill.body } }]
      };
    }
  }

  throw new McpError(ErrorCode.InvalidParams, `Prompt '${promptName}' not found.`);
});

const tracer = trace.getTracer('krusch-context-mcp');

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const args = request.params.arguments || {};
  
  return await tracer.startActiveSpan(`tool_call: ${toolName}`, async (span) => {
    span.setAttribute('tool.name', toolName);
    span.setAttribute('tool.arguments', JSON.stringify(args));
    
    try {
      const handler = TOOL_HANDLERS.get(toolName);
      if (!handler) {
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
      }
      
      const result = await handler(args);
      
      if (result && result.content && result.content[0] && result.content[0].text) {
          const textPreview = result.content[0].text.substring(0, 500);
          span.setAttribute('tool.result_preview', textPreview);
          span.setAttribute('tool.is_error', result.isError === true);
      }
      
      span.setStatus({ code: 1 });
      return result;
    } catch (err) {
      span.setStatus({ code: 2, message: err.message });
      span.recordException(err);
      
      if (err instanceof McpError) throw err;
      return { content: [{ type: "text", text: `[Error] ${err.message}` }], isError: true };
    } finally {
      span.end();
    }
  });
});

async function shutdown() {
  console.error('[krusch-context-mcp] Shutting down...');
  try { await pool.end(); } catch (_) { }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

async function main() {
  const tracePath = process.env.KRUSCH_TRACE_PATH || path.resolve(process.cwd(), 'data', 'traces.jsonl');
  initTracing(tracePath);
  console.error(`[krusch-context-mcp] Tracing initialized: ${tracePath}`);

  await verifyDatabase();

  // Load requested extensions
  const requestedExts = getRequestedExtensions();
  if (requestedExts.length > 0) {
    console.error(`[krusch-context-mcp] Loading extensions: ${requestedExts.join(', ')}...`);
    activeExtensions = await loadExtensions(requestedExts, pool);
    for (const ext of activeExtensions) {
      if (ext.handlers) {
        for (const [name, fn] of ext.handlers.entries()) {
          TOOL_HANDLERS.set(name, fn);
        }
      }
    }
    console.error(`[krusch-context-mcp] Active extensions loaded: ${activeExtensions.map(e => e.name).join(', ')}`);
  }

  const activeProfile = getActiveProfile();
  let exposedCount = activeProfile === 'router' ? 1 : CORE_TOOLS.size;
  if (activeProfile === 'extended' || activeProfile === 'full') {
    exposedCount += EXTENDED_CORE_TOOLS.size;
  }
  for (const ext of activeExtensions) {
    if (ext.tools) exposedCount += ext.tools.length;
  }

  console.error(`[krusch-context-mcp] Server ready | Profile: '${activeProfile}' | Exposed Tools: ${exposedCount} | Extensions: ${activeExtensions.length}`);
  
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[krusch-context-mcp] Server running on stdio");
}

const isMain = process.argv[1] && (path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isMain) {
  main().catch(err => {
    console.error("[Fatal]", err);
    process.exit(1);
  });
}

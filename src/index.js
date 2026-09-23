#!/usr/bin/env node

/**
 * @module krusch-context-mcp
 * Universal Memory & Steering Engine for AI Agents.
 * Exposes exactly 5 canonical verbs:
 *   1. retrieve - hybrid context & state retrieval
 *   2. remember - unified memory & nugget write API with duplicate guard
 *   3. revise - temporal superseding and invalidation with mandatory reason
 *   4. nudge - invariant auditor and feedback weighting
 *   5. health - operational status and 30-day TTL decay review
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

import {
  addMemory,
  searchMemory,
  listMemories,
  deleteMemory,
  updateMemory,
  consolidateMemories,
  compileProjectState,
  supersedeMemory,
  invalidateMemory,
  getHealthStats,
  CLOSED_CATEGORIES
} from './memory-engine.js';
import { nuggetRemember, nuggetNudges, nuggetForget, nuggetList } from './nuggets-engine.js';
import { handleProactiveNudge, recordNudgeFeedback } from './proactive-engine.js';
import { getEmbedding, getEmbeddingProvider, getConfiguredEmbeddingDim } from './embedding-helper.js';
import { pool } from '../db/pool.js';
import { unifiedRetrieve } from './unified-retrieval.js';
import { detectCurrentProject, getWorktreeStatus } from './project-helper.js';
import { getStorageMode, setStorageMode, getSqliteDb } from './storage-adapter.js';

// Verify storage initialization (SQLite default, Postgres fallback)
async function verifyDatabase() {
    const mode = getStorageMode();
    if (mode === 'postgres') {
        try {
            await pool.query('SELECT 1');
            console.error('[krusch-context-mcp] PostgreSQL connection verified.');
        } catch (err) {
            console.warn('[krusch-context-mcp] PostgreSQL unreachable. Falling back to local SQLite (.agent/context.db).');
            setStorageMode('sqlite');
        }
    }
    // Ensure SQLite storage is ready
    getSqliteDb();
}

export const VERSION = "1.8.0";
const server = new Server({ name: "krusch-context-mcp", version: VERSION }, { capabilities: { tools: {}, prompts: {} } });

// Core 5 Verbs
export const CORE_TOOLS = new Set([
  "krusch_context_retrieve",
  "krusch_context_remember",
  "krusch_context_revise",
  "krusch_context_nudge",
  "krusch_context_health"
]);

// Extended Admin Tools (only active in --profile=extended)
export const EXTENDED_CORE_TOOLS = new Set([
  "krusch_context_list_memories",
  "krusch_context_delete_memory",
  "krusch_context_consolidate",
  "krusch_context_nugget_list"
]);

export function getActiveProfile() {
  const profileArg = process.argv.find(a => a.startsWith('--profile='));
  const rawProfile = profileArg 
    ? profileArg.split('=')[1] 
    : (process.env.KRUSCH_PROFILE || 'core');
  
  const normalized = rawProfile.toLowerCase().trim();
  if (normalized === 'extended' || normalized === 'admin') return 'extended';
  return 'core';
}

// 5 Core Tool Definitions
export const CORE_TOOL_DEFINITIONS = [
  {
    name: "krusch_context_retrieve",
    description: "Universal context retrieval tool. Pulls active project memories, steering rules, and state briefings respecting token budget limits.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query or topic" },
        mode: { type: "string", enum: ['hybrid', 'memory', 'state'], default: 'hybrid', description: "Retrieval mode" },
        category: { type: "string", enum: ['decision', 'bug', 'invariant', 'lesson', 'blocker'], description: "Optional closed category filter" },
        limit_tokens: { type: "number", default: 4000, description: "Maximum token budget to return" },
        include_state: { type: "boolean", default: false, description: "Optionally prepend compiled state briefing" },
        project: { type: "string", description: "Target project (auto-detected if omitted)" }
      },
      required: ["query"]
    }
  },
  {
    name: "krusch_context_remember",
    description: "Unified write API for episodic memory and persistent steering nuggets. Includes automatic near-duplicate detection and provenance tracking.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The fact, lesson, decision, or invariant to remember" },
        category: { type: "string", enum: ['decision', 'bug', 'invariant', 'lesson', 'blocker'], default: 'lesson', description: "Closed category taxonomy" },
        key: { type: "string", description: "Optional key to store as a persistent steering nugget" },
        provenance: {
          type: "object",
          properties: {
            file: { type: "string" },
            commit: { type: "string" },
            pr: { type: "string" },
            author: { type: "string", enum: ['human', 'agent'], default: 'agent' },
            confidence: { type: "number", default: 1.0 }
          },
          description: "Provenance metadata"
        },
        tags: { type: "array", items: { type: "string" }, description: "Optional descriptive tags" },
        force: { type: "boolean", default: false, description: "If true, bypasses near-duplicate warnings" },
        project: { type: "string", description: "Target project" }
      },
      required: ["content"]
    }
  },
  {
    name: "krusch_context_revise",
    description: "Unified knowledge revision API. Supports temporal superseding (updating stale knowledge with lineage) and explicit invalidations (revoking obsolete rules with mandatory reason).",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ['supersede', 'invalidate', 'forget_nugget'], description: "Revision action to perform" },
        target_id: { type: "number", description: "Target memory ID (for supersede or invalidate)" },
        reason: { type: "string", description: "Mandatory justification when invalidating a memory" },
        content: { type: "string", description: "New authoritative content when superseding" },
        key: { type: "string", description: "Key of nugget to forget when action is forget_nugget" },
        category: { type: "string", enum: ['decision', 'bug', 'invariant', 'lesson', 'blocker'], description: "Optional category update" },
        provenance: { type: "object", description: "Optional provenance metadata" },
        project: { type: "string", description: "Target project" }
      },
      required: ["action"]
    }
  },
  {
    name: "krusch_context_nudge",
    description: "Invariant auditor and alignment feedback loop. Checks proposed code diffs or actions against active project invariants, and adjusts rule weights based on developer feedback.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ['audit', 'feedback'], default: 'audit', description: "Action: audit against invariants or submit feedback" },
        code: { type: "string", description: "Code or diff snippet to audit" },
        file_path: { type: "string", description: "Optional target file path" },
        trigger: { type: "string", enum: ['pre_commit', 'pre_edit', 'manual'], default: 'manual', description: "Trigger point. Default: manual. ('every_turn' is disabled to prevent audit spam)" },
        hook: { type: "string", enum: ['pre_commit', 'pre_edit', 'manual'], description: "Alias for trigger" },
        rule_id: { type: "string", description: "Rule or memory ID when providing feedback" },
        feedback: { type: "string", enum: ['helpful', 'unhelpful', 'false_positive'], description: "Feedback rating to tune rule weights" },
        project: { type: "string", description: "Target project" }
      }
    }
  },
  {
    name: "krusch_context_health",
    description: "Operational health check, memory counts by closed taxonomy, storage mode, and 30-day TTL decay review.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Target project" }
      }
    }
  }
];

export const EXTENDED_CORE_DEFINITIONS = [
  {
    name: "krusch_context_list_memories",
    description: "List memories chronologically for inspection.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", enum: ['decision', 'bug', 'invariant', 'lesson', 'blocker'] },
        limit: { type: "number", default: 10 },
        project: { type: "string" }
      },
      required: ["category"]
    }
  },
  {
    name: "krusch_context_delete_memory",
    description: "Hard-delete a memory record (admin cleanup).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number" },
        project: { type: "string" }
      },
      required: ["id"]
    }
  },
  {
    name: "krusch_context_consolidate",
    description: "Consolidate duplicate memories within a category.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", enum: ['decision', 'bug', 'invariant', 'lesson', 'blocker'] },
        threshold: { type: "number", default: 0.15 },
        dry_run: { type: "boolean", default: false },
        project: { type: "string" }
      },
      required: ["category"]
    }
  },
  {
    name: "krusch_context_nugget_list",
    description: "List all persistent steering nuggets.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" }
      }
    }
  }
];

// MCP Prompts
export const CORE_PROMPTS = [
  {
    name: "session_start",
    description: "Initialize an agent session by retrieving project state briefing and active invariants.",
    arguments: [
      { name: "project", description: "Target project context", required: false }
    ],
    generateMessages: (args) => [
      {
        role: "user",
        content: {
          type: "text",
          text: `Starting session for project '${args.project || "detected"}'. Call krusch_context_retrieve with mode='state' (or krusch_context_compile_state) to load active decisions, invariants, and recent lessons.`
        }
      }
    ]
  },
  {
    name: "pre_commit",
    description: "Audit staged changes against active project invariants before commit.",
    arguments: [
      { name: "project", description: "Target project context", required: false }
    ],
    generateMessages: (args) => [
      {
        role: "user",
        content: {
          type: "text",
          text: `Reviewing staged changes. Call krusch_context_nudge (or krusch_context_nugget_nudges) with hook='pre-commit' to verify all active invariants and blockers are respected.`
        }
      }
    ]
  }
];


// MCP Tool Listing Handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const profile = getActiveProfile();
  const tools = [...CORE_TOOL_DEFINITIONS];

  if (profile === 'extended') {
    tools.push(...EXTENDED_CORE_DEFINITIONS);
  }

  return { tools };
});

// MCP Prompt Listing Handlers
server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return {
    prompts: CORE_PROMPTS.map(p => ({
      name: p.name,
      description: p.description,
      arguments: p.arguments
    }))
  };
});

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const prompt = CORE_PROMPTS.find(p => p.name === name);
  if (!prompt) {
    throw new McpError(ErrorCode.InvalidParams, `Prompt '${name}' not found.`);
  }
  return {
    description: prompt.description,
    messages: prompt.generateMessages(args || {})
  };
});

// MCP Tool Execution Handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    // 1. krusch_context_retrieve (alias: retrieve)
    if (name === "krusch_context_retrieve" || name === "retrieve") {
      return await unifiedRetrieve(args);
    }

    // 2. krusch_context_remember (alias: remember, add_memory, nugget_remember)
    if (name === "krusch_context_remember" || name === "remember") {
      if (args.key) {
        return await nuggetRemember({
          key: args.key,
          value: args.content || args.value,
          kind: 'project',
          active_project: args.project
        });
      }
      return await addMemory(args);
    }
    if (name === "krusch_context_add_memory") {
      console.warn(`[krusch-context-mcp] ⚠️ DEPRECATED: 'krusch_context_add_memory' is deprecated in v1.8.0. Use 'krusch_context_remember({ content, category })' instead.`);
      return await addMemory(args);
    }
    if (name === "krusch_context_nugget_remember") {
      console.warn(`[krusch-context-mcp] ⚠️ DEPRECATED: 'krusch_context_nugget_remember' is deprecated in v1.8.0. Use 'krusch_context_remember({ key, content })' instead.`);
      return await nuggetRemember({
        key: args.key,
        value: args.value || args.content,
        kind: 'project',
        active_project: args.project || args.active_project
      });
    }

    // 3. krusch_context_revise (alias: revise, supersede_memory, invalidate_memory, nugget_forget)
    if (name === "krusch_context_revise" || name === "revise") {
      const { action } = args;
      if (action === 'supersede') {
        return await supersedeMemory({
          id: args.target_id || args.id,
          category: args.category,
          content: args.content,
          project: args.project,
          provenance: args.provenance
        });
      }
      if (action === 'invalidate') {
        return await invalidateMemory({
          id: args.target_id || args.id,
          reason: args.reason,
          project: args.project
        });
      }
      if (action === 'forget_nugget') {
        return await nuggetForget({ key: args.key, project: args.project });
      }
      throw new McpError(ErrorCode.InvalidParams, `Unknown revise action: '${action}'. Permitted: supersede, invalidate, forget_nugget`);
    }

    // Legacy revise aliases
    if (name === "krusch_context_supersede_memory") {
      console.warn(`[krusch-context-mcp] ⚠️ DEPRECATED: 'krusch_context_supersede_memory' is deprecated in v1.8.0. Use 'krusch_context_revise({ action: "supersede", target_id, content })' instead.`);
      return await supersedeMemory(args);
    }
    if (name === "krusch_context_invalidate_memory") {
      console.warn(`[krusch-context-mcp] ⚠️ DEPRECATED: 'krusch_context_invalidate_memory' is deprecated in v1.8.0. Use 'krusch_context_revise({ action: "invalidate", target_id, reason })' instead.`);
      return await invalidateMemory(args);
    }
    if (name === "krusch_context_nugget_forget") {
      console.warn(`[krusch-context-mcp] ⚠️ DEPRECATED: 'krusch_context_nugget_forget' is deprecated in v1.8.0. Use 'krusch_context_revise({ action: "forget_nugget", key })' instead.`);
      return await nuggetForget(args);
    }

    // 4. krusch_context_nudge (alias: nudge, proactive_nudge, nugget_nudges, nudge_feedback)
    if (name === "krusch_context_nudge" || name === "nudge") {
      return await handleProactiveNudge(args);
    }
    if (name === "krusch_context_proactive_nudge") {
      console.warn(`[krusch-context-mcp] ⚠️ DEPRECATED: 'krusch_context_proactive_nudge' is deprecated in v1.8.0. Use 'krusch_context_nudge({ trigger: "pre_commit", code })' instead.`);
      return await handleProactiveNudge(args);
    }
    if (name === "krusch_context_nudge_feedback") {
      console.warn(`[krusch-context-mcp] ⚠️ DEPRECATED: 'krusch_context_nudge_feedback' is deprecated in v1.8.0. Use 'krusch_context_nudge({ action: "feedback", rule_id, feedback })' instead.`);
      return await recordNudgeFeedback(args);
    }
    if (name === "krusch_context_nugget_nudges") {
      console.warn(`[krusch-context-mcp] ⚠️ DEPRECATED: 'krusch_context_nugget_nudges' is deprecated in v1.8.0. Use 'krusch_context_retrieve({ query, category: "invariant" })' instead.`);
      return await nuggetNudges(args);
    }

    // 5. krusch_context_health (alias: health)
    if (name === "krusch_context_health" || name === "health") {
      return await getHealthStats(args);
    }

    // Legacy retrieval & inspection aliases
    if (name === "krusch_context_search_memory") {
      console.warn(`[krusch-context-mcp] ⚠️ DEPRECATED: 'krusch_context_search_memory' is deprecated in v1.8.0. Use 'krusch_context_retrieve({ query, mode: "memory" })' instead.`);
      return await searchMemory(args);
    }
    if (name === "krusch_context_compile_state") {
      console.warn(`[krusch-context-mcp] ⚠️ DEPRECATED: 'krusch_context_compile_state' is deprecated in v1.8.0. Use 'krusch_context_retrieve({ query: "*", include_state: true })' instead.`);
      return await compileProjectState(args);
    }
    if (name === "krusch_context_list_memories") {
      return await listMemories(args);
    }
    if (name === "krusch_context_delete_memory") {
      return await deleteMemory(args);
    }
    if (name === "krusch_context_consolidate") {
      return await consolidateMemories(args);
    }
    if (name === "krusch_context_nugget_list") {
      return await nuggetList(args);
    }

    throw new McpError(ErrorCode.MethodNotFound, `Tool '${name}' not recognized.`);
  } catch (err) {
    if (err instanceof McpError) throw err;
    console.error(`[krusch-context-mcp] Tool error (${name}):`, err);
    return {
      content: [{ type: "text", text: `[krusch-context] ❌ Error executing ${name}: ${err.message}` }],
      isError: true
    };
  }
});

export async function runServer() {
  await verifyDatabase();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const mode = getStorageMode();
  console.error(`[krusch-context-mcp] v${VERSION} running on stdio (${CORE_TOOLS.size} core tools, storage: ${mode})`);
}

// Auto-run if executed directly as script
if (import.meta.url === `file://${process.argv[1]}`) {
  runServer().catch(err => {
    console.error("[krusch-context-mcp] Fatal error starting server:", err);
    process.exit(1);
  });
}

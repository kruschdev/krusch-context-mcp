#!/usr/bin/env node

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

import { loadSkills, listSkills, getSkill } from './skills-engine.js';

import fs from 'fs/promises';
import path from 'path';
import { trace } from '@opentelemetry/api';
import { initTracing } from './telemetry.js';

// Import logic from our required MCP packages
import { addMemory, searchMemory, listMemories, deleteMemory, updateMemory, consolidateMemories, compileProjectState } from './memory-engine.js';
import { writeState, resolveConflict, getProvenance, updateOntology, searchLens, traverseGraph, linkBlob } from './v2-engine.js';
import { nuggetRemember, nuggetNudges, nuggetForget, nuggetList } from './nuggets-engine.js';
import { handleThink } from './think-engine.js';
import { handleProactiveNudge, handleNudgeFeedback, handleAnalyzeTrajectory } from './proactive-engine.js';
import { writeSessionHandoff, readSessionReview } from './session-engine.js';
import { getEmbedding } from './embedding-helper.js';
import { searchBlobs, getRepositories, getRepoRootTree, getTreeEntries, getBlob } from 'pg-git-mcp/server/git-engine.js';
import { pool } from 'pg-git-mcp/db/pool.js';
import { detectPgContext, initPgContextCollections, isPgContextEnabled } from './pgcontext-helper.js';
import { unifiedRetrieve } from './unified-retrieval.js';
import { initAgentDebugXTable, logAgentFailure, searchFailures, getRecoveryPattern } from './agentdebugx-engine.js';
import { initDataFlowTables, registerOperator, inspectOperatorRegistry, mutatePipelineDag } from './dataflow-engine.js';
import { setwiseRerank } from './setwise-engine.js';
import { initArexTable, updateResearchState, auditResearchConstraints } from './arex-engine.js';
import { initAcmTable, manageContextLifecycle, auditContextBudget } from './acm-engine.js';

// Verify DB connection
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
            if (e.code !== '42701' && e.code !== '42P07') throw e; // 42701 duplicate column, 42P07 duplicate relation/column in some PG configs
        }
        try {
            await pool.query('ALTER TABLE ide_agent_memory ADD COLUMN tags TEXT');
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
            if (e.code !== '42701') throw e; // 42701 is duplicate column
        }

        // Rename legacy tables to interaction_memory if they exist
        try {
            const homelabCheck = await pool.query(`
                SELECT EXISTS (
                    SELECT FROM information_schema.tables 
                    WHERE table_schema = 'public' 
                    AND table_name = 'homelab_memory_v2'
                )
            `);
            const v2Check = await pool.query(`
                SELECT EXISTS (
                    SELECT FROM information_schema.tables 
                    WHERE table_schema = 'public' 
                    AND table_name = 'memory_v2'
                )
            `);
            const targetCheck = await pool.query(`
                SELECT EXISTS (
                    SELECT FROM information_schema.tables 
                    WHERE table_schema = 'public' 
                    AND table_name = 'interaction_memory'
                )
            `);

            if (homelabCheck.rows[0].exists && !targetCheck.rows[0].exists) {
                await pool.query('ALTER TABLE homelab_memory_v2 RENAME TO interaction_memory');
                console.error('[krusch-context-mcp] Successfully renamed homelab_memory_v2 to interaction_memory');
            } else if (v2Check.rows[0].exists && !targetCheck.rows[0].exists) {
                await pool.query('ALTER TABLE memory_v2 RENAME TO interaction_memory');
                console.error('[krusch-context-mcp] Successfully renamed memory_v2 to interaction_memory');
            }
        } catch (e) {
            console.error('[krusch-context-mcp] Rename migration error:', e.message);
        }

        await pool.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS interaction_memory (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                category VARCHAR(50) NOT NULL,
                content TEXT NOT NULL,
                embedding VECTOR(1024),
                author_id VARCHAR(100) NOT NULL,
                source_ref VARCHAR(255),
                confidence FLOAT DEFAULT 1.0,
                action_trace JSONB,
                parent_id UUID REFERENCES interaction_memory(id),
                version_id INT DEFAULT 1,
                status VARCHAR(20) DEFAULT 'active',
                ontology_tags TEXT[],
                read_roles TEXT[] DEFAULT '{system}',
                write_roles TEXT[] DEFAULT '{system}',
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            )
        `);

        try {
            await pool.query('ALTER TABLE interaction_memory ADD COLUMN project VARCHAR(255)');
        } catch (e) {
            if (e.code !== '42701') throw e; // 42701 is duplicate column
        }

        // Add indexes
        await pool.query('CREATE INDEX IF NOT EXISTS idx_v2_ontology_tags ON interaction_memory USING GIN (ontology_tags)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_v2_embedding ON interaction_memory USING hnsw (embedding vector_cosine_ops)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_v1_embedding ON ide_agent_memory USING hnsw (embedding vector_cosine_ops)');

        // Add memory_to_blob_edges table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS memory_to_blob_edges (
                memory_id UUID REFERENCES interaction_memory(id),
                blob_id VARCHAR(255),
                relationship VARCHAR(50),
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            )
        `);

        // Initialize AI Watch research integration tables
        await initAgentDebugXTable();
        await initDataFlowTables();
        await initArexTable();
        await initAcmTable();

        console.error('[krusch-context-mcp] Database connection verified via pg-git pool. Migrations completed.');
    } catch (err) {
        console.error('[krusch-context-mcp] FATAL: Cannot reach PostgreSQL:', err.message);
        process.exit(1);
    }
}

const server = new Server({ name: "krusch-context-mcp", version: "1.2.0" }, { capabilities: { tools: {}, prompts: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
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
            include_code: { type: "boolean", default: true }
          },
          required: ["query"]
        }
      },
      {
        name: "krusch_context_add_memory",
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
        name: "krusch_context_search_memory",
        description: "Search the persistent IDE database for past lessons, bugs, priorities, or project outcomes. Supports GRASP options (semantic, keyword, tag matching; history/lineage expansion; codebase file association).",
        inputSchema: {
          type: "object",
          properties: {
            active_project: { type: "string" },
            category: { type: "string", enum: ['priorities', 'bugs', 'outcomes', 'lessons', 'activity'] },
            query: { type: "string" },
            limit: { type: "number", default: 3 },
            search_type: { type: "string", enum: ['semantic', 'keyword', 'tag'], default: 'semantic' },
            include_history: { type: "boolean", default: false },
            include_linked_blobs: { type: "boolean", default: false }
          },
          required: ["category", "query"]
        }
      },
      {
        name: "krusch_context_search_code",
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
        name: "krusch_context_compile_state",
        description: "Contextmaxxing: Compile a comprehensive, structured Markdown document of a project's current state. This proactively gathers recent priorities, outcomes, lessons, and behavioral nudges into a single payload so you don't have to search for them individually.",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string", description: "The project name to compile state for." }
          },
          required: ["project"]
        }
      },
      {
        name: "krusch_context_deep_search",
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
        name: "krusch_context_list_memories",
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
        name: "krusch_context_write_state",
        description: "Company Brain Substrate (v2): Write a memory state with optimistic concurrency control. Replaces standard add_memory.",
        inputSchema: {
          type: "object",
          properties: {
            content: { type: "string", description: "The memory content." },
            category: { type: "string", enum: ['priorities', 'bugs', 'outcomes', 'lessons', 'activity'] },
            author_id: { type: "string", description: "Identifier of the agent/human (e.g., 'agent:antigravity')." },
            parent_id: { type: "string", description: "If updating an existing state, provide the UUID to ensure optimistic concurrency control." },
            source_ref: { type: "string", description: "Optional URI or document hash that generated this memory." },
            ontology_tags: { type: "array", items: { type: "string" } },
            action_trace: { type: "array", items: { type: "object" }, description: "Optional trace of agent actions that led to this state." },
            project: { type: "string", description: "Optional project association for the state." }
          },
          required: ["content", "category", "author_id"]
        }
      },
      {
        name: "krusch_context_resolve_conflict",
        description: "Company Brain Substrate (v2): Merge branching states, deprecate conflicting IDs, and create a unified head.",
        inputSchema: {
          type: "object",
          properties: {
            conflict_ids: { type: "array", items: { type: "string" }, description: "The IDs of the conflicting sibling states." },
            resolution_content: { type: "string", description: "The combined, correct truth." },
            author_id: { type: "string", description: "Identifier of the resolving agent/human." }
          },
          required: ["conflict_ids", "resolution_content", "author_id"]
        }
      },
      {
        name: "krusch_context_get_provenance",
        description: "Company Brain Substrate (v2): Interrogate why a piece of context exists by tracing its version history.",
        inputSchema: {
          type: "object",
          properties: {
            memory_id: { type: "string", description: "The UUID of the memory to trace." }
          },
          required: ["memory_id"]
        }
      },
      {
        name: "krusch_context_update_ontology",
        description: "Company Brain Substrate (v2): Update ontology tags across all active memories.",
        inputSchema: {
          type: "object",
          properties: {
            old_tag: { type: "string" },
            new_tag: { type: "string" }
          },
          required: ["old_tag", "new_tag"]
        }
      },
      {
        name: "krusch_context_search_lens",
        description: "Company Brain Substrate (v2): Lens-Based Retrieval. Performs semantic search filtered by user or agent role.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            roles: { type: "array", items: { type: "string" }, description: "Array of roles to filter by (e.g., ['system', 'admin'])" },
            limit: { type: "number", default: 5 },
            status: { type: "string", default: "active" }
          },
          required: ["query", "roles"]
        }
      },
      {
        name: "krusch_context_traverse_graph",
        description: "Company Brain Substrate (v2): Graph Traversal. Traverses parent/child memory lineage and linked codebase blobs.",
        inputSchema: {
          type: "object",
          properties: {
            memory_id: { type: "string", description: "The UUID of the memory to traverse from." },
            direction: { type: "string", enum: ['parents', 'children', 'blobs', 'actionable', 'all'], default: 'all' },
            depth: { type: "number", default: 3 }
          },
          required: ["memory_id"]
        }
      },
      {
        name: "krusch_context_link_blob",
        description: "Company Brain Substrate (v2): Link a memory state to a codebase file (blob) to build the organizational graph.",
        inputSchema: {
          type: "object",
          properties: {
            memory_id: { type: "string", description: "The UUID of the memory state." },
            blob_id: { type: "string", description: "The SHA hash of the codebase blob (from PG-Git)." },
            relationship: { type: "string", description: "The relationship type (e.g., 'references', 'fixes', 'implements', 'deprecates')." }
          },
          required: ["memory_id", "blob_id", "relationship"]
        }
      },
      {
        name: "krusch_context_delete_memory",
        description: "Delete a specific memory by its ID. Use list or search first to find the ID.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "number", description: "The numeric ID of the memory to delete" },
            source_project: { type: "string", description: "The project name if this is a project-specific SQLite memory. Leave empty for Global PG memories." }
          },
          required: ["id"]
        }
      },
      {
        name: "krusch_context_update_memory",
        description: "Update an existing memory's content, tags, or project assignment. Content changes trigger re-embedding.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "number", description: "The numeric ID of the memory to update" },
            source_project: { type: "string", description: "The project name if this is a project-specific SQLite memory. Leave empty for Global PG memories." },
            content: { type: "string", description: "New content (triggers re-embedding)" },
            tags: { type: "array", items: { type: "string" } },
            project: { type: "string", description: "New project assignment" }
          },
          required: ["id"]
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
        description: "Browse the file tree of a repository indexed in PG-Git. Returns directory entries (files and subdirectories) for a given tree ID. Use krusch_context_list_repos first to get a repo ID, then call with no tree_id to get the root.",
        inputSchema: {
          type: "object",
          properties: {
            repository_id: { type: "number", description: "The repository ID (from krusch_context_list_repos)" },
            tree_id: { type: "string", description: "The tree hash to browse. Omit for root tree." }
          },
          required: ["repository_id"]
        }
      },
      {
        name: "krusch_context_read_blob",
        description: "Read the full content of a specific file (blob) from PG-Git by its blob ID. Get blob IDs from krusch_context_read_tree.",
        inputSchema: {
          type: "object",
          properties: {
            blob_id: { type: "string", description: "The SHA hash of the blob to read" }
          },
          required: ["blob_id"]
        }
      },
      {
        name: "krusch_context_consolidate",
        description: "Find and merge semantically duplicate memories within a category. Use dry_run=true first to preview which pairs would be merged. Default threshold 0.15 (lower = stricter matching).",
        inputSchema: {
          type: "object",
          properties: {
            category: { type: "string", enum: ['priorities', 'bugs', 'outcomes', 'lessons', 'activity'] },
            project: { type: "string", description: "Optional: only consolidate memories for this project" },
            threshold: { type: "number", default: 0.15, description: "Cosine distance threshold — pairs closer than this are considered duplicates" },
            dry_run: { type: "boolean", default: false, description: "If true, only preview matches without merging" }
          },
          required: ["category"]
        }
      },
      {
        name: "krusch_context_health_check",
        description: "Verify that the Krusch Context MCP server is alive, connected to kruschdb, and functioning.",
        inputSchema: {
          type: "object",
          properties: {}
        }
      },
      {
        name: "krusch_docs_list",
        description: "List all available external manuals and documentation that have been ingested into the semantic database.",
        inputSchema: {
          type: "object",
          properties: {}
        }
      },
      {
        name: "krusch_docs_search",
        description: "Semantically search a specific external manual. Use krusch_docs_list to find available manual names.",
        inputSchema: {
          type: "object",
          properties: {
            manual_name: { type: "string", description: "The exact name of the manual (e.g. anthropic-docs)" },
            query: { type: "string", description: "The search query" },
            limit: { type: "number", default: 5 }
          },
          required: ["manual_name", "query"]
        }
      },
      {
        name: "krusch_context_nugget_remember",
        description: "Store a short, durable Nuggets memory fact. Best for lightweight nudges like preferences or corrections.",
        inputSchema: {
          type: "object",
          properties: {
            key: { type: "string" },
            value: { type: "string" },
            kind: { type: "string", enum: ['project', 'user', 'agent'] },
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
            active_project: { type: "string", description: "The active project context. Required to retrieve 'project' kind nuggets." }
          },
          required: ["query"]
        }
      },
      {
        name: "krusch_context_nugget_forget",
        description: "Delete a specific nugget by key.",
        inputSchema: {
          type: "object",
          properties: {
            key: { type: "string" },
            active_project: { type: "string", description: "The active project context. Required to delete 'project' kind nuggets." }
          },
          required: ["key"]
        }
      },
      {
        name: "krusch_context_nugget_list",
        description: "List all saved nuggets chronologically.",
        inputSchema: {
          type: "object",
          properties: {
            kinds: { type: "array", items: { type: "string", enum: ['project', 'user', 'agent'] } },
            active_project: { type: "string", description: "The active project context. Required to list 'project' kind nuggets." }
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
            project: { type: "string", description: "Optional project name/filter to restrict search scope." }
          },
          required: ["query"]
        }
      },
      {
        name: "krusch_context_list_skills",
        description: "List all available AI agent skills (TDD, Diagnose, Handoff, Caveman, etc.) loaded from the homelab registry.",
        inputSchema: {
          type: "object",
          properties: {}
        }
      },
      {
        name: "krusch_context_get_skill",
        description: "Retrieve a specific AI agent skill's markdown prompt instructions by name.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "The name of the skill to retrieve (e.g. 'tdd', 'diagnose', 'caveman', 'grill-with-docs')" }
          },
          required: ["name"]
        }
      },
      {
        name: "krusch_context_proactive_nudge",
        description: "Proactively audits current agent trajectory against historical lessons, bugs, priorities, and nuggets. Returns a warning nudge if any constraints or custom rules are violated, otherwise returns 'NO_NUDGES_REQUIRED'.",
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
                  description: "Full sliding window of the conversation history."
                }
              ]
            },
            project: { type: "string", description: "Optional active project scope to filter and load SQLite isolated nuggets." }
          },
          required: ["history"]
        }
      },
      {
        name: "krusch_context_nudge_feedback",
        description: "Logs developer or agent feedback for proactive auditor nudges to collect alignment signals for offline post-training/fine-tuning.",
        inputSchema: {
          type: "object",
          properties: {
            query_text: { type: "string", description: "The task context or query audited." },
            nudge_text: { type: "string", description: "The proactive warning nudge text returned." },
            user_approved: { type: "boolean", description: "Whether the nudge was approved or helpful." },
            agent_corrected: { type: "boolean", description: "Whether the agent trajectory was corrected." },
            correction_diff: { type: "string", description: "Optional diff showing the correction." },
            project: { type: "string", description: "Optional project name." }
          },
          required: ["query_text", "nudge_text", "user_approved", "agent_corrected"]
        }
      },
      {
        name: "krusch_context_analyze_trajectory",
        description: "Analyze the step-level execution path of a memory ID using STRACE. Identifies causal fault steps and failure patterns.",
        inputSchema: {
          type: "object",
          properties: {
            memory_id: { type: "string", description: "The UUID of the leaf state in the interaction_memory table to trace." }
          },
          required: ["memory_id"]
        }
      },
      {
        name: "krusch_context_write_session_handoff",
        description: "Session Bridge (IDE ↔ Jean): Write the IDE session summary, calculate modified files, insert the DB record, and autonomously spawn the Jean SRE companion for review. Call this when executing /close.",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string" },
            summary: { type: "string" }
          },
          required: ["project", "summary"]
        }
      },
      {
        name: "krusch_context_read_session_review",
        description: "Session Bridge (Jean ↔ IDE): Fetch the latest session review from the Jean SRE companion. This is guaranteed to be idempotent (it atomically marks the review as consumed). Call this when executing /continue.",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string" }
          },
          required: ["project"]
        }
      },
      // AgentDebugX Tools
      {
        name: "krusch_context_log_agent_failure",
        description: "AgentDebugX Error Hub: Log an agent execution failure trajectory, attributed root cause, and recovery patch bundle.",
        inputSchema: {
          type: "object",
          properties: {
            agent_name: { type: "string" },
            error_symptom: { type: "string" },
            trajectory: { type: "array", description: "Array of trajectory step objects" },
            root_cause: { type: "string" },
            recovery_patch: { type: "object", description: "Recovery patch or parameter modifications" }
          },
          required: ["agent_name", "error_symptom", "root_cause"]
        }
      },
      {
        name: "krusch_context_search_failures",
        description: "AgentDebugX Error Hub: Search for past agent failure bundles matching an error symptom or query.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            agent_name: { type: "string" },
            limit: { type: "number", default: 5 }
          },
          required: ["query"]
        }
      },
      {
        name: "krusch_context_get_recovery_pattern",
        description: "AgentDebugX Error Hub: Get execution recovery pattern and patch for a failure bundle ID.",
        inputSchema: {
          type: "object",
          properties: {
            failure_id: { type: "number" }
          },
          required: ["failure_id"]
        }
      },
      // DataFlow-Harness Tools
      {
        name: "krusch_context_register_pipeline_operator",
        description: "DataFlow-Harness: Register a grounded dataflow/ingestion operator with strict input, output, and side-effect schemas.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string" },
            input_schema: { type: "object" },
            output_schema: { type: "object" },
            side_effects: { type: "string" },
            docs: { type: "string" }
          },
          required: ["name", "input_schema", "output_schema"]
        }
      },
      {
        name: "krusch_context_inspect_pipeline_registry",
        description: "DataFlow-Harness: Inspect active grounded operator schemas in the MCP registry.",
        inputSchema: {
          type: "object",
          properties: {
            filter: { type: "string" }
          }
        }
      },
      {
        name: "krusch_context_mutate_pipeline_dag",
        description: "DataFlow-Harness: Mutate a pipeline DAG using grounded, typed operations (AddNode, RemoveNode, WireEdge, UpdateNodeConfig).",
        inputSchema: {
          type: "object",
          properties: {
            pipeline_name: { type: "string" },
            mutation_type: { type: "string", enum: ["AddNode", "RemoveNode", "WireEdge", "UpdateNodeConfig"] },
            node_data: { type: "object" },
            edge_data: { type: "object" }
          },
          required: ["pipeline_name", "mutation_type"]
        }
      },
      // Rubric4Setwise Tool
      {
        name: "krusch_context_setwise_rerank",
        description: "Rubric4Setwise: Rerank candidate document/memory sets against Redundancy, Conflict, and Complementarity rubrics into a minimal covering set.",
        inputSchema: {
          type: "object",
          properties: {
            candidates: { type: "array", description: "Array of candidate document/memory objects" },
            query: { type: "string" },
            target_count: { type: "number", default: 5 }
          },
          required: ["candidates", "query"]
        }
      },
      // AREX Deep Research Tools
      {
        name: "krusch_context_update_research_state",
        description: "AREX Deep Research: Update or create research state maintaining verified evidence and unresolved constraints.",
        inputSchema: {
          type: "object",
          properties: {
            task_id: { type: "string" },
            verified_evidence: { type: "array" },
            unresolved_constraints: { type: "array" },
            next_action_hints: { type: "array" }
          },
          required: ["task_id"]
        }
      },
      {
        name: "krusch_context_arex_audit",
        description: "AREX Deep Research: Audit research evidence and unresolved constraints for a task to produce self-improving next follow-up steps.",
        inputSchema: {
          type: "object",
          properties: {
            task_id: { type: "string" },
            candidate_response: { type: "string" }
          },
          required: ["task_id"]
        }
      },
      {
        name: "krusch_context_manage_lifecycle",
        description: "Agentic Context Management (ACM): Manage context fragment lifecycle (stage, compact, evict, get, list) and retention policies.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", description: "'stage' | 'compact' | 'evict' | 'get' | 'list'" },
            fragment_id: { type: "string", description: "Unique fragment identifier" },
            content: { type: "string", description: "Context text content or summary" },
            stage: { type: "string", description: "'staged' | 'active' | 'compacted' | 'evicted'" },
            ttl_days: { type: "number", description: "Retention time-to-live in days (default 30)" },
            project: { type: "string", description: "Project identifier" },
            metadata: { type: "object", description: "Optional arbitrary metadata" }
          }
        }
      },
      {
        name: "krusch_context_audit_budget",
        description: "Agentic Context Management (ACM): Audit context window pressure, token budget consumption, and eviction/compaction recommendations.",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string", description: "Project identifier" },
            token_budget: { type: "number", description: "Total token budget (default 8192)" },
            current_tokens: { type: "number", description: "Unmanaged prompt token count" }
          }
        }
      }
    ]
  };
});

server.setRequestHandler(ListPromptsRequestSchema, async () => {
  const skills = listSkills();
  return {
    prompts: skills.map(s => ({
      name: s.name,
      description: s.description,
      arguments: s.argumentHint ? [
        {
          name: "argument",
          description: s.argumentHint,
          required: false
        }
      ] : []
    }))
  };
});

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const name = request.params.name;
  const skill = getSkill(name);
  if (!skill) {
    throw new McpError(ErrorCode.InvalidParams, `Skill '${name}' not found.`);
  }
  
  const argumentValue = request.params.arguments?.argument || "";
  let text = skill.body;
  if (argumentValue) {
    text = `Argument provided by user: "${argumentValue}"\n\n${text}`;
  }

  return {
    description: skill.description,
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: text
        }
      }
    ]
  };
});

// --- Inline tool handlers (tools with logic living in index.js rather than engines) ---

async function handleListSkills() {
  const skills = listSkills();
  let output = `=== 🛠️ Agent Skills Registry (${skills.length}) ===\n`;
  for (const s of skills) {
    output += `\n- Name: ${s.name}\n  Category: ${s.category}\n  Description: ${s.description}\n`;
    if (s.argumentHint) {
      output += `  Argument hint: ${s.argumentHint}\n`;
    }
  }
  return { content: [{ type: "text", text: output }] };
}

async function handleGetSkill(args) {
  const { name } = args;
  const skill = getSkill(name);
  if (!skill) {
    return { content: [{ type: "text", text: `Skill '${name}' not found.` }], isError: true };
  }
  let output = `=== 🛠️ Skill: ${skill.name} (${skill.category}) ===\n`;
  output += `Description: ${skill.description}\n\n`;
  output += skill.body;
  return { content: [{ type: "text", text: output }] };
}

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
  const { query: searchQuery, limit = 5, repository_id, project } = args;
  
  let resolvedRepoId = repository_id;
  if (project && !resolvedRepoId) {
      const repoRes = await pool.query(`SELECT id FROM repositories WHERE name = $1`, [project]);
      if (repoRes.rows.length > 0) {
          resolvedRepoId = repoRes.rows[0].id;
      } else {
          throw new McpError(ErrorCode.InvalidParams, `Project '${project}' not found in PG-Git. Use krusch_context_list_repos to verify exact repository names.`);
      }
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
      output += (r.summary || '(no preview)') + '\n';
  }
  return { content: [{ type: "text", text: output }] };
}

async function handleDeepSearch(args) {
  const { query, project } = args;
  
  console.error(`[krusch-context-mcp] Executing deep context search for: "${query}"...`);
  
  // Generate embedding ONCE and share across all queries
  const vector = await getEmbedding(query);
  if (!vector) throw new McpError(ErrorCode.InternalError, "Failed to generate embedding");
  
  // Resolve repo ID for blob search
  let resolvedRepoId = undefined;
  if (project) {
      const repoRes = await pool.query(`SELECT id FROM repositories WHERE name = $1`, [project]);
      if (repoRes.rows.length > 0) {
          resolvedRepoId = repoRes.rows[0].id;
      } else {
          throw new McpError(ErrorCode.InvalidParams, `Project '${project}' not found in PG-Git. Use krusch_context_list_repos to verify exact repository names.`);
      }
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
    if (!treeHash) return { content: [{ type: "text", text: "No root tree found for this repository. It may not have any commits synced." }] };
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

async function handleHealthCheck() {
  const dbCheck = await pool.query('SELECT COUNT(*) as count FROM ide_agent_memory');
  const repoCheck = await pool.query('SELECT COUNT(*) as count FROM repositories');
  const nuggetCheck = await pool.query('SELECT COUNT(*) as count FROM ide_agent_nuggets');
  const v2Check = await pool.query("SELECT COUNT(*) as count FROM interaction_memory WHERE status = 'active'");
  const memoryCount = dbCheck.rows[0].count;
  const repoCount = repoCheck.rows[0].count;
  const nuggetCount = nuggetCheck.rows[0].count;
  const v2Count = v2Check.rows[0].count;
  const engineStatus = isPgContextEnabled() ? 'pgContext (HNSW + Single-Pass Filter)' : 'pgvector (Standard)';
  return { content: [{ type: "text", text: `[krusch-context-mcp] 🟢 Server is healthy.\n- Episodic memories (v1): ${memoryCount}\n- Company Brain states (v2): ${v2Count}\n- Holographic nuggets: ${nuggetCount}\n- Indexed repositories: ${repoCount}\n- Vector Engine: ${engineStatus}\n- Database: kruschdb\n- Version: 1.2.0` }] };
}

async function handleDocsList() {
  const configPath = process.env.EXTERNAL_DOCS_CONFIG_PATH || path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../pg-git/config/external_docs.json');
  const fileContent = await fs.readFile(configPath, 'utf-8');
  const configData = JSON.parse(fileContent);
  if (configData.length === 0) {
      return { content: [{ type: "text", text: "No manuals available." }] };
  }
  let output = `=== 📚 Available External Manuals ===\n`;
  for (const doc of configData) {
      output += `\n- ${doc.name} (Source: ${doc.url})`;
  }
  return { content: [{ type: "text", text: output }] };
}

async function handleDocsSearch(args) {
  const { manual_name, query: searchQuery, limit = 5 } = args;
  
  const repoRes = await pool.query(`SELECT id FROM repositories WHERE name = $1`, [manual_name]);
  if (repoRes.rows.length === 0) {
      return { content: [{ type: "text", text: `Manual '${manual_name}' not found in database. Use krusch_docs_list to see available manuals.` }] };
  }
  const resolvedRepoId = repoRes.rows[0].id;
  
  const vector = await getEmbedding(searchQuery);
  if (!vector) throw new McpError(ErrorCode.InternalError, "Failed to generate embedding");
  
  const results = await searchBlobs(vector, limit, resolvedRepoId);
  if (results.length === 0) return { content: [{ type: "text", text: "No relevant documentation found." }] };
  
  let output = `=== 📖 Documentation Search: ${manual_name} ===\n`;
  for (const r of results) {
      const pathStr = r.file_path ? ` [${r.file_path}]` : '';
      output += `\n--- Match (Score: ${Number(r.similarity).toFixed(2)})${pathStr} ---\n`;
      output += (r.summary || '(no preview)') + '\n';
  }
  return { content: [{ type: "text", text: output }] };
}

// --- Dispatch table: tool name → handler function ---
const TOOL_HANDLERS = new Map([
  // Polygres-inspired Unified Context Retrieval
  ['krusch_context_retrieve',       (args) => unifiedRetrieve(args)],
  // Memory engine (v1)
  ['krusch_context_add_memory',     (args) => addMemory(args)],
  ['krusch_context_search_memory',  (args) => searchMemory(args)],
  ['krusch_context_list_memories',  (args) => listMemories(args)],
  ['krusch_context_delete_memory',  (args) => deleteMemory(args)],
  ['krusch_context_update_memory',  (args) => updateMemory(args)],
  ['krusch_context_consolidate',    (args) => consolidateMemories(args)],
  ['krusch_context_compile_state',  (args) => compileProjectState(args)],
  // Memory engine (v2 Company Brain)
  ['krusch_context_write_state',      (args) => writeState(args)],
  ['krusch_context_resolve_conflict', (args) => resolveConflict(args)],
  ['krusch_context_get_provenance',   (args) => getProvenance(args)],
  ['krusch_context_update_ontology',  (args) => updateOntology(args)],
  ['krusch_context_search_lens',      (args) => searchLens(args)],
  ['krusch_context_traverse_graph',   (args) => traverseGraph(args)],
  ['krusch_context_link_blob',        (args) => linkBlob(args)],
  // PG-Git codebase
  ['krusch_context_list_repos',  () => handleListRepos()],
  ['krusch_context_search_code', (args) => handleSearchCode(args)],
  ['krusch_context_deep_search', (args) => handleDeepSearch(args)],
  ['krusch_context_read_tree',   (args) => handleReadTree(args)],
  ['krusch_context_read_blob',   (args) => handleReadBlob(args)],
  ['krusch_context_health_check',() => handleHealthCheck()],
  // Docs
  ['krusch_docs_list',   () => handleDocsList()],
  ['krusch_docs_search', (args) => handleDocsSearch(args)],
  // Nuggets
  ['krusch_context_nugget_remember', (args) => nuggetRemember(args)],
  ['krusch_context_nugget_nudges',   (args) => nuggetNudges(args)],
  ['krusch_context_nugget_forget',   (args) => nuggetForget(args)],
  ['krusch_context_nugget_list',     (args) => nuggetList(args)],
  ['krusch_context_think',           (args) => handleThink(args)],
  ['krusch_context_list_skills',     () => handleListSkills()],
  ['krusch_context_get_skill',      (args) => handleGetSkill(args)],
  ['krusch_context_proactive_nudge', (args) => handleProactiveNudge(args)],
  ['krusch_context_nudge_feedback', (args) => handleNudgeFeedback(args)],
  ['krusch_context_analyze_trajectory', (args) => handleAnalyzeTrajectory(args)],
  ['krusch_context_write_session_handoff', (args) => writeSessionHandoff(args)],
  ['krusch_context_read_session_review',  (args) => readSessionReview(args)],
  // AgentDebugX
  ['krusch_context_log_agent_failure',     (args) => logAgentFailure(args)],
  ['krusch_context_search_failures',        (args) => searchFailures(args)],
  ['krusch_context_get_recovery_pattern',   (args) => getRecoveryPattern(args)],
  // DataFlow-Harness
  ['krusch_context_register_pipeline_operator', (args) => registerOperator(args)],
  ['krusch_context_inspect_pipeline_registry',  (args) => inspectOperatorRegistry(args)],
  ['krusch_context_mutate_pipeline_dag',       (args) => mutatePipelineDag(args)],
  // Rubric4Setwise
  ['krusch_context_setwise_rerank',         (args) => setwiseRerank(args)],
  // AREX
  ['krusch_context_update_research_state',  (args) => updateResearchState(args)],
  ['krusch_context_arex_audit',             (args) => auditResearchConstraints(args)],
  // ACM (Agentic Context Management - ArXiv 2607.21503)
  ['krusch_context_manage_lifecycle',       (args) => manageContextLifecycle(args)],
  ['krusch_context_audit_budget',           (args) => auditContextBudget(args)],
]);

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
      
      span.setStatus({ code: 1 }); // OK
      return result;
    } catch (err) {
      span.setStatus({ code: 2, message: err.message }); // ERROR
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

  await loadSkills();
  await verifyDatabase();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[krusch-context-mcp] Server running on stdio");
}

main().catch(err => {
  console.error("[Fatal]", err);
  process.exit(1);
});

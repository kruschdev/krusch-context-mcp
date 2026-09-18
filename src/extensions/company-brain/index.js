/**
 * @module extensions/company-brain
 * Company Brain v2 Substrate Extension for krusch-context-mcp.
 */

import { writeState, resolveConflict, getProvenance, updateOntology, searchLens, traverseGraph, linkBlob } from './v2-engine.js';
import { handleAnalyzeTrajectory } from '../../proactive-engine.js';

export async function initCompanyBrainTables(pool) {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    
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
        } else if (v2Check.rows[0].exists && !targetCheck.rows[0].exists) {
            await pool.query('ALTER TABLE memory_v2 RENAME TO interaction_memory');
        }
    } catch (e) {
        console.error('[company-brain] Rename migration error:', e.message);
    }

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
        if (e.code !== '42701') throw e;
    }

    await pool.query('CREATE INDEX IF NOT EXISTS idx_v2_ontology_tags ON interaction_memory USING GIN (ontology_tags)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_v2_embedding ON interaction_memory USING hnsw (embedding vector_cosine_ops)');

    await pool.query(`
        CREATE TABLE IF NOT EXISTS memory_to_blob_edges (
            memory_id UUID REFERENCES interaction_memory(id),
            blob_id VARCHAR(255),
            relationship VARCHAR(50),
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        )
    `);
}

export const tools = [
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
    name: "krusch_context_analyze_trajectory",
    description: "Analyze the step-level execution path of a memory ID using STRACE. Identifies causal fault steps and failure patterns.",
    inputSchema: {
      type: "object",
      properties: {
        memory_id: { type: "string", description: "The UUID of the leaf state in the interaction_memory table to trace." }
      },
      required: ["memory_id"]
    }
  }
];

export const handlers = new Map([
  ['krusch_context_write_state', writeState],
  ['krusch_context_resolve_conflict', resolveConflict],
  ['krusch_context_get_provenance', getProvenance],
  ['krusch_context_update_ontology', updateOntology],
  ['krusch_context_search_lens', searchLens],
  ['krusch_context_traverse_graph', traverseGraph],
  ['krusch_context_link_blob', linkBlob],
  ['krusch_context_analyze_trajectory', handleAnalyzeTrajectory]
]);

export const extension = {
  name: "company-brain",
  description: "Company Brain v2 Substrate — stateful memory with optimistic concurrency, conflict resolution, provenance tracing, lens-based retrieval, and graph traversal.",
  init: initCompanyBrainTables,
  tools,
  handlers
};

export default extension;

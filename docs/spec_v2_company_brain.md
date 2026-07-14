# Krusch Context MCP Server — Company Brain Specification (v2)

> **Status**: Draft
> **Based On**: Sentra "Company Brain" Infrastructure Principles

## 1. Vision & Architecture Shift
The `krusch-context-mcp` is evolving from a **Query-Time RAG Cache** to a **Company Brain Substrate**. 
Instead of agents repeatedly discovering the company state via search tools and assembling it on the fly, agents will read from and write to a maintained state graph that inherently enforces concurrency, provenance, permissions, and ontology.

## 2. Infrastructure Primitives (Data Model)

To support this transition, the underlying `kruschdb` schema for `homelab_memory` must be expanded to serve as a state machine.

### Extended `homelab_memory` Schema

```sql
CREATE TABLE memory_v2 (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    category VARCHAR(50) NOT NULL,          -- 'priorities', 'bugs', 'outcomes', 'lessons', etc.
    content TEXT NOT NULL,
    embedding VECTOR(1024),
    
    -- [NEW] Provenance & Traces
    author_id VARCHAR(100) NOT NULL,        -- e.g., 'agent:claude-3-opus', 'human:kruschdev'
    source_ref VARCHAR(255),                -- e.g., 'github:pr-123', 'file:///AGENTS.md'
    confidence FLOAT DEFAULT 1.0,           -- 0.0 to 1.0 confidence score
    action_trace JSONB,                     -- Array of actions taken based on this state
    
    -- [NEW] Concurrency & Versioning
    parent_id UUID REFERENCES memory_v2(id), -- Null if root
    version_id INT DEFAULT 1,               -- Incremented on update
    status VARCHAR(20) DEFAULT 'active',    -- 'active', 'stale', 'deprecated', 'resolved'
    
    -- [NEW] Ontology Binding
    ontology_tags TEXT[],                   -- e.g., ['homelab', 'auth', 'postgres']
    
    -- [NEW] Permissions Propagation
    read_roles TEXT[] DEFAULT '{system}',   -- e.g., '{system, admin, guest}'
    write_roles TEXT[] DEFAULT '{system}',
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

### Semantic Edge Graph
A new associative table to map memories to specific codebase blobs natively.
```sql
CREATE TABLE memory_to_blob_edges (
    memory_id UUID REFERENCES memory_v2(id),
    blob_id UUID REFERENCES blobs(id),
    relationship VARCHAR(50),               -- e.g., 'fixes_bug_in', 'documents_feature_of'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

## 3. New MCP Tools (Substrate Interface)

To interact with this infrastructure, the MCP server will expose a new suite of state-management tools, deprecating simple write tools.

### `krusch_context_write_state`
Replaces `krusch_context_add_memory`. Designed for safe concurrent writes.
- **Parameters**:
  - `content` (string): The memory content.
  - `category` (string): Priority, Bug, Lesson, etc.
  - `author_id` (string): Identifier of the agent/human.
  - `parent_id` (uuid, optional): If updating an existing state, provide the UUID to ensure optimistic concurrency control.
  - `ontology_tags` (array of strings, optional).
- **Behavior**: If `parent_id` is provided, the system checks if a newer version exists. If it does, the write is rejected with a conflict error. Otherwise, the old record is marked 'deprecated' and the new record becomes the 'active' head.

### `krusch_context_resolve_conflict`
Used by human orchestrators or advanced agents to resolve branching states.
- **Parameters**:
  - `conflict_ids` (array of uuids): The IDs of the conflicting sibling states.
  - `resolution_content` (string): The combined, correct truth.
  - `author_id` (string).
- **Behavior**: Deprecates the conflicting IDs and creates a new unified state that points to them in its action trace.

### `krusch_context_get_provenance`
Allows an agent to interrogate *why* a piece of context exists.
- **Parameters**:
  - `memory_id` (uuid).
- **Behavior**: Returns the full graph history of the memory, including its author, the source reference, and the chain of previous versions (`parent_id` traversal).

### `krusch_context_update_ontology`
Allows administrative agents to bind or rename tags across the graph.
- **Parameters**:
  - `old_tag` (string)
  - `new_tag` (string)
- **Behavior**: Updates the `ontology_tags` array for all active memories.

## 4. Conflict Handling Workflow
1. Agent A queries state (gets ID 100, Version 1).
2. Agent B queries state (gets ID 100, Version 1).
3. Agent A calls `krusch_context_write_state` with `parent_id: 100`. The server creates ID 101, marks 100 as deprecated.
4. Agent B calls `krusch_context_write_state` with `parent_id: 100`.
5. **Outcome**: The server rejects Agent B's write with a `StateStaleError` and returns the content of ID 101, forcing Agent B to re-evaluate its action based on the latest truth.

## 5. Next Steps
1. Review schema changes.
2. Write knex/pg migration scripts for `kruschdb`.
3. Implement `krusch_context_write_state` in `krusch-context-mcp` with full transaction support.

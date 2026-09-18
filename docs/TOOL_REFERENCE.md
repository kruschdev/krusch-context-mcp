# 📋 Complete Tool Reference

> Every tool, every parameter, every default — everything an agent needs to call these tools correctly.
>
> For a high-level overview, see the [README](../README.md). For configuration and operational setups, see the [Setup Guide](SETUP.md).

---

## 🎯 Tool Profiles & Presets (`KRUSCH_PROFILE`)

To prevent agent context exhaustion and tool selection degradation, tools are organized into three profile tiers and modular companion extensions:

- **`core` (Default — 13 Tools, or 18 Tools with Polygres Cloud)**: The lean, high-signal daily driver context engine. Includes `krusch_context_retrieve`, `add_memory`, `supersede_memory`, `invalidate_memory`, `search_memory`, `compile_state`, `nugget_remember`, `nugget_nudges`, `search_symbols`, `symbol_graph`, `search_code`, `health`, and `proactive_nudge`. When `POLYGRES_API_KEY` is present, the 5 Polygres Cloud tools auto-mount alongside core (18 tools total).
- **`extended` (26 Tools, or 31 with Polygres Cloud)**: Core plus complete memory administrative lifecycle (`list`, `delete`, `update`, `consolidate`), Git exploration (`list_repos`, `read_tree`, `read_blob`, `file_symbols`), cited thinking (`think`), and proactive alignment feedback (`nudge_feedback`).
- **`extensions` / `full` (61 Tools total)**: All core and extended tools plus the 5 modular companion extensions (`polygres-cloud`: 5, `company-brain`: 8, `research`: 15, `session-bridge`: 2, `skills-docs`: 5).

Configure via `KRUSCH_PROFILE=core` in your `.env` or IDE MCP configuration, or pass `--profile=core` on the command line. Registered handlers for all tools remain executable on direct invocation regardless of the active profile.

---

## 🏛️ Architecture & PG-Git Engine Integration

Krusch Context MCP decouples into a 13-tool Core with modular companion extensions (up to **61 tools** in full suite). It natively incorporates the complete codebase indexing and retrieval engine from **[PG-Git](https://github.com/kruschdev/pg-git)** (`pg-git-mcp@1.1.0`):
- **Native Git DAG Storage**: Stores Git trees, blobs, commits, and branches in PostgreSQL without requiring external file-system loose object scanning.
- **Structural Symbol Extraction**: Zero-dependency structural regex and brace-matching parser for JS, TS, Python, Go, Rust, and Shell to populate `code_symbols` and dependency edges in `code_symbol_edges`.
- **Hybrid RRF Search**: Merges dense pgvector cosine similarity with full-text lexical BM25 (`tsv` GIN index) using Reciprocal Rank Fusion and exponential temporal decay ($e^{-0.01t}$).
- **Shared Schema & Dual-Surface Aliases**: Shares identical PostgreSQL tables (`repositories`, `blobs`, `code_symbols`, `code_symbol_edges`, `trees`, `commits`, `branches`) with standalone PG-Git. Exposes first-class `pg_git_*` aliases (`pg_git_search_symbols`, `pg_git_file_symbols`, `pg_git_dependency_graph`) so standalone PG-Git workflows run seamlessly without reconfiguring agent prompts.

---

## Unified Hybrid Retrieval (Polygres-Inspired)

### `krusch_context_retrieve`

**Polygres-Inspired Unified Context Retrieval**: Single-query hybrid retrieval engine that combines dense HNSW vector search, multi-hop graph walks (`graph_hops`), stage-aware context pruning, and server-side token budget packing (`limit_tokens`) into a single Markdown context payload. Cross-references episodic memory and objective PG-Git codebase blobs and AST symbols in a single call.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | `string` | ✅ | — | Natural language retrieval query |
| `project` | `string` | ❌ | `null` | Target project or repository filter |
| `graph_hops` | `number` | ❌ | `1` | Graph traversal depth (hops) across `code_symbol_edges` and `memory_to_blob_edges` |
| `limit_tokens` | `number` | ❌ | `4000` | Hard token budget limit for packed context payload |
| `include_code` | `boolean` | ❌ | `true` | Whether to include matching PG-Git codebase blobs and symbols alongside episodic memory |

**Example call:**
```json
{
  "query": "how does the auth session engine handle JWT validation",
  "project": "krusch-context-mcp",
  "graph_hops": 2,
  "limit_tokens": 3500,
  "include_code": true
}
```

---

## Contextmaxxing & State Hydration

### `krusch_context_compile_state`

**Contextmaxxing**: Proactively compile a comprehensive, structured Markdown document of a project's current state. This gathers recent priorities, outcomes, lessons, and behavioral nudges into a single payload, avoiding the need for multiple independent semantic searches.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `project` | `string` | ✅ | — | The target project string to compile state for |

**Example call:**
```json
{
  "project": "pocket-lawyer"
}
```

---

### `krusch_context_proactive_nudge`

**Trajectory Auditing**: Proactively audits current agent trajectory or user prompt against historical lessons, bugs, priorities, and nuggets. It returns a warning nudge alert if any constraints or custom rules are violated, otherwise it returns `NO_NUDGES_REQUIRED`.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `history` | `string` \| `object[]` | ✅ | — | Conversational history string or message list (array of `{ role: string, content: string }` objects). |
| `project` | `string` | ❌ | `null` | Optional active project scope to filter SQLite isolated nuggets and memories. |

**Expected Returns:**
*   `NO_NUDGES_REQUIRED` — If the trajectory is safe, aligned, or has no matches.
*   `### 🧠 Proactive Context Nudge ...` — A markdown block with warning details and suggested corrective actions if any rule/lesson matches are violated.

**Example call:**
```json
{
  "history": "Let's index the daily research papers using qwen2.5-coder:1.5b embeddings.",
  "project": "ai-watch"
}
```

---

### `krusch_context_nudge_feedback`

**Alignment Feedback Logging**: Logs developer or agent feedback for proactive auditor warnings to capture alignment signals for offline fine-tuning/post-training (Direct-OPD/PUST).

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query_text` | `string` | ✅ | — | The task context or user query that was audited. |
| `nudge_text` | `string` | ✅ | — | The proactive warning nudge text returned by the auditor. |
| `user_approved` | `boolean` | ✅ | — | Whether the warning was approved or deemed helpful by the user. |
| `agent_corrected` | `boolean` | ✅ | — | Whether the agent corrected its trajectory based on the warning. |
| `correction_diff` | `string` | ❌ | `null` | Optional code diff showing the applied trajectory correction. |
| `project` | `string` | ❌ | `null` | Optional project name to associate with the feedback signal. |

**Example call:**
```json
{
  "query_text": "Deploying a new Postgres container to production host drive /dev/sda.",
  "nudge_text": "Warning: OS drive /dev/sda is protected on production node. Target /mnt/media1 instead.",
  "user_approved": true,
  "agent_corrected": true,
  "correction_diff": "- Target drive: /dev/sda\\n+ Target drive: /mnt/media1/postgres",
  "project": "krusch-nexus"
}
```

---

### `krusch_context_analyze_trajectory`

**Structural Trajectory Analysis (STRACE)**: Analyzes the step-level execution path of a memory ID using STRACE principles. It identifies root cause steps where errors first occurred or where confidence dropped by traversing version provenance tree from the `interaction_memory` table and performing Causal Fault Isolation.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `memory_id` | `string` | ✅ | — | The UUID of the leaf/head memory in the interaction_memory table to trace. |

**Example call:**
```json
{
  "memory_id": "9aea1850-834e-4fff-9893-19e352f497d1"
}
```

---

### `krusch_context_think`

**Context Synthesis & Gap Analysis**: Performs cited context synthesis, conflict detection, and gap analysis across both subjective episodic memory and objective PG-Git codebase blobs. It queries memories and code in parallel, formats a combined context block, and dispatches to the completion model to answer complex architectural questions with explicit citations.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | `string` | ✅ | — | The query or architectural question to think about |
| `project` | `string` | ❌ | `null` | Optional project name/filter to restrict search scope |

**Example call:**
```json
{
  "query": "What are the differences between our local SQLite cache and durable PostgreSQL push-sync?",
  "project": "krusch-context-mcp"
}
```

---

## Episodic Memory Tools

### `krusch_context_add_memory`

Store a new episodic memory. Automatically generates a vector embedding and semantic tags via local LLM.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `category` | `string` | ✅ | — | One of: `priorities`, `bugs`, `outcomes`, `lessons`, `activity` |
| `content` | `string` | ✅ | — | The text content of the memory |
| `project` | `string` | ❌ | `null` | If provided, saves to local SQLite (`.agent/memory.db`). If omitted, saves to global Postgres. |
| `tags` | `string[]` | ❌ | *auto-generated* | User-defined tags. If omitted, tags are auto-generated via `llama3.2`. |

**Storage routing:**
- `project` provided → writes to `<project>/.agent/memory.db` (SQLite), async pushes to Postgres
- `project` omitted → writes directly to global `ide_agent_memory` (Postgres)

**Example call:**
```json
{
  "category": "bugs",
  "content": "Port 5441 conflicts with the legacy PocketLawyer DB. Use 5442 for krusch-context-mcp.",
  "project": "krusch-context-mcp",
  "tags": ["port-conflict", "database", "config"]
}
```

---

### `krusch_context_search_memory`

Semantic search over episodic memories with exponential temporal decay. Recent memories score higher.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `category` | `string` | ✅ | — | One of: `priorities`, `bugs`, `outcomes`, `lessons`, `activity` |
| `query` | `string` | ✅ | — | Natural language search query |
| `limit` | `number` | ❌ | `3` | Maximum results to return |
| `active_project` | `string` | ❌ | `null` | If provided, also searches the project's local SQLite DB and merges results |

**How results are ranked:**
1. Embedding similarity is computed via cosine distance (Postgres) or cosine similarity (SQLite)
2. Temporal decay is applied: `score = similarity × e^(-0.01 × age_in_days)`
3. Project-local results get a `+0.3` bias to prefer local context over global
4. Results from both stores are merged, re-ranked, and truncated to `limit`

**Example call:**
```json
{
  "category": "lessons",
  "query": "authentication middleware patterns",
  "limit": 5,
  "active_project": "pocket-lawyer"
}
```

---

### `krusch_context_list_memories`

Fast chronological listing without embedding generation. Use this when you want to browse recent entries, not search semantically.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `category` | `string` | ✅ | — | One of: `priorities`, `bugs`, `outcomes`, `lessons`, `activity` |
| `project` | `string` | ❌ | `null` | If provided, lists from the project's SQLite DB. If omitted, lists from global Postgres. |
| `limit` | `number` | ❌ | `10` | Maximum results to return |

**Example call:**
```json
{
  "category": "activity",
  "project": "krusch-context-mcp",
  "limit": 5
}
```

---

### `krusch_context_delete_memory`

Delete a specific memory by its numeric ID. Use `list_memories` or `search_memory` first to find the ID.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `number` | ✅ | — | Numeric ID of the memory to delete |
| `source_project` | `string` | ❌ | `null` | If provided, deletes from the project's SQLite DB. If omitted, deletes from global Postgres. |

**Example call:**
```json
{
  "id": 42,
  "source_project": "krusch-context-mcp"
}
```

---

### `krusch_context_update_memory`

Update an existing memory's content, tags, or project assignment. Content changes trigger re-embedding.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `number` | ✅ | — | Numeric ID of the memory to update |
| `source_project` | `string` | ❌ | `null` | If provided, updates in the project's SQLite DB. If omitted, updates in global Postgres. |
| `content` | `string` | ❌ | — | New content (triggers re-embedding if changed) |
| `tags` | `string[]` | ❌ | — | New tags array |
| `project` | `string` | ❌ | — | New project assignment (Postgres only — reassigns the memory to a different project) |

> ⚠️ At least one of `content`, `tags`, or `project` must be provided.

**Example call:**
```json
{
  "id": 42,
  "content": "Updated: Port 5442 is now the canonical DB port for all new services.",
  "tags": ["port-config", "canonical"]
}
```

---

### `krusch_context_consolidate`

Find and merge semantically duplicate memories within a category. Uses L2-normalized centroid averaging to merge embeddings without re-embedding.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `category` | `string` | ✅ | — | One of: `priorities`, `bugs`, `outcomes`, `lessons`, `activity` |
| `project` | `string` | ❌ | `null` | If provided, consolidates in the project's SQLite DB. If omitted, consolidates global Postgres. |
| `threshold` | `number` | ❌ | `0.15` | Cosine distance threshold — pairs closer than this are considered duplicates. Lower = stricter. |
| `dry_run` | `boolean` | ❌ | `false` | If `true`, only previews matches without merging |

> 💡 **Best practice:** Always call with `dry_run: true` first to preview which pairs would be merged.

> ⚠️ SQLite consolidation has a 500-row scaling guard. If exceeded, filter by project.

**Example call (preview):**
```json
{
  "category": "bugs",
  "project": "pocket-lawyer",
  "threshold": 0.12,
  "dry_run": true
}
```

---

## Company Brain v2 Substrate Tools

> These tools power the stateful organizational memory layer inspired by [Sentra's "Company Brain" research](https://sentra.app). They provide multi-agent state management with optimistic concurrency control, provenance tracking, role-based retrieval, and graph traversal. While v1 memory tools are sufficient for single-agent workflows, v2 tools are designed for environments where multiple agents (or human-agent pairs) write to the same knowledge substrate.

### `krusch_context_write_state`

Write a memory state with optimistic concurrency control. Unlike `add_memory`, this tool supports versioned writes, author attribution, and parent-child state lineage. Use this when building multi-agent workflows where state integrity matters.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `content` | `string` | ✅ | — | The memory content |
| `category` | `string` | ✅ | — | One of: `priorities`, `bugs`, `outcomes`, `lessons`, `activity` |
| `author_id` | `string` | ✅ | — | Identifier of the writing agent or human (e.g., `agent:antigravity`, `human:krusch`) |
| `parent_id` | `string` | ❌ | `null` | UUID of the parent state. Enables optimistic concurrency — if the parent has been superseded, the write will still succeed but can be detected via `get_provenance`. |
| `source_ref` | `string` | ❌ | `null` | Optional URI, commit SHA, or document hash that generated this memory |
| `ontology_tags` | `string[]` | ❌ | `null` | Semantic ontology tags for structured retrieval (e.g., `['architecture', 'database', 'migration']`) |

**How it works:**
1. Generates an embedding for the content via Ollama
2. Inserts into `interaction_memory` with a UUID, version tracking, and author attribution
3. If `parent_id` is provided, creates a parent→child lineage edge for provenance tracing

**Example call:**
```json
{
  "content": "Decided to use UUID v4 for all v2 memory IDs to support distributed writes without coordination.",
  "category": "lessons",
  "author_id": "agent:antigravity",
  "parent_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "source_ref": "commit:abc123",
  "ontology_tags": ["architecture", "identity", "distributed-systems"]
}
```

---

### `krusch_context_resolve_conflict`

Merge branching states when multiple agents write conflicting updates to the same lineage. Deprecates the conflicting siblings and creates a unified resolution head.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `conflict_ids` | `string[]` | ✅ | — | UUIDs of the conflicting sibling states to merge |
| `resolution_content` | `string` | ✅ | — | The combined, correct truth that supersedes the conflicting states |
| `author_id` | `string` | ✅ | — | Identifier of the resolving agent or human |

**How it works:**
1. Marks all `conflict_ids` as `status: 'deprecated'`
2. Creates a new resolution state with `status: 'active'`
3. Links the resolution to all deprecated states for full audit trail

**Example call:**
```json
{
  "conflict_ids": [
    "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "b2c3d4e5-f6a7-8901-bcde-f12345678901"
  ],
  "resolution_content": "Final decision: Use port 5442 for PostgreSQL (not 5441 or 5443). Both previous entries were partially correct.",
  "author_id": "human:developer"
}
```

---

### `krusch_context_get_provenance`

Trace the complete version history of a memory state — who wrote it, when, what it replaced, and what replaced it. Uses recursive CTEs to walk the full parent→child chain.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `memory_id` | `string` | ✅ | — | UUID of the memory to trace |

**What it returns:**
- The target memory's full metadata (author, status, timestamps, ontology tags)
- All ancestor states (parents, grandparents, etc.)
- All descendant states (children, grandchildren, etc.)
- Status of each state in the chain (`active`, `deprecated`)

**Example call:**
```json
{
  "memory_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
}
```

---

### `krusch_context_update_ontology`

Rename an ontology tag across all active v2 memories. Use this when standardizing vocabulary (e.g., renaming `db` to `database` across the knowledge base).

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `old_tag` | `string` | ✅ | — | The tag to replace |
| `new_tag` | `string` | ✅ | — | The replacement tag |

**Example call:**
```json
{
  "old_tag": "db",
  "new_tag": "database"
}
```

---

### `krusch_context_search_lens`

**Lens-Based Retrieval.** Performs semantic search filtered by the reader's role permissions. Only memories whose `read_roles` intersect with the provided `roles` array are returned.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | `string` | ✅ | — | Semantic search query |
| `roles` | `string[]` | ✅ | — | Roles to filter by (e.g., `['system', 'admin']`). Only memories readable by at least one of these roles are returned. |
| `limit` | `number` | ❌ | `5` | Maximum results |
| `status` | `string` | ❌ | `active` | Memory status filter (`active`, `deprecated`, or omit for `active`) |

**Example call:**
```json
{
  "query": "database migration patterns",
  "roles": ["system", "admin"],
  "limit": 3
}
```

---

### `krusch_context_traverse_graph`

**Graph Traversal.** Navigate the memory lineage tree and linked codebase blobs from any memory node. Supports directional traversal with configurable depth.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `memory_id` | `string` | ✅ | — | UUID of the starting memory node |
| `direction` | `string` | ❌ | `all` | One of: `parents` (ancestors), `children` (descendants), `blobs` (linked codebase files), `all` (everything) |
| `depth` | `number` | ❌ | `3` | Maximum traversal depth |

**What it returns:**
- **Parents:** Ancestor states in the version lineage
- **Children:** Descendant states (forks, updates, resolutions)
- **Blobs:** Linked codebase files from the `memory_to_blob_edges` table (relationship types: `references`, `implements`, `fixes`, etc.)

**Example call:**
```json
{
  "memory_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "direction": "all",
  "depth": 5
}
```

---

### `krusch_context_link_blob`

Link a Company Brain v2 memory state to a codebase file (blob) to build the organizational knowledge graph.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `memory_id` | `string` | ✅ | — | UUID of the memory state |
| `blob_id` | `string` | ✅ | — | SHA hash of the codebase blob (from PG-Git) |
| `relationship` | `string` | ✅ | — | Relationship type: `references`, `implements`, `fixes`, `deprecates`, etc. |

**Example call:**
```json
{
  "memory_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "blob_id": "abc123def456...",
  "relationship": "implements"
}
```

---

## Codebase Search Tools (Native PG-Git Engine)

The Codebase Search subsystem in Krusch Context MCP natively incorporates the complete Git DAG, AST symbol parsing, and hybrid RRF search engine from **[PG-Git](https://github.com/kruschdev/pg-git)** (`pg-git-mcp@1.1.0`).

### Shared Database Schema & Interoperability
Both `krusch-context-mcp` and standalone `pg-git` share the identical PostgreSQL schema:
- `repositories`: Registered repository catalogs, remote origins, and default branches.
- `blobs`: Content-addressed file blobs, deduplicated by SHA hash, with stored `tsv` TSVECTOR columns, GIN full-text indexes, and 1024-dim `pgvector` embeddings.
- `code_symbols`: Multi-language AST symbols (functions, classes, interfaces, methods, routes, variables) with line ranges and signatures.
- `code_symbol_edges`: Directed caller, callee, import, and export dependency graph relationships.
- `trees`, `commits`, `branches`: Complete Git Directed Acyclic Graph.

### Dual-Surface Tool Aliases
To ensure 100% interoperability with tools or agent workflows expecting standalone PG-Git nomenclature, the server registers both native names and direct aliases:
- `krusch_context_search_symbols` ↔ `pg_git_search_symbols`
- `krusch_context_file_symbols` ↔ `pg_git_file_symbols`
- `krusch_context_symbol_graph` ↔ `pg_git_dependency_graph`

---

### `krusch_context_search_code`

**Native Hybrid Code Search**: Searches all source code files indexed in the native Git DAG (`blobs`). Combines dense pgvector cosine similarity and lexical BM25 full-text rank (`tsv` GIN index) via Reciprocal Rank Fusion (RRF), multiplied by exponential temporal decay ($e^{-0.01t}$).

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | `string` | ✅ | — | Natural language or keyword search query (e.g., "how does the scheduler work", "createDbosClient") |
| `limit` | `number` | ❌ | `5` | Maximum results to return |
| `project` | `string` | ❌ | `null` | Filter results to a specific project/repository name. If provided, it must strictly match a known repository name, or the tool will throw an error to prevent cross-project hallucination. |
| `repository_id` | `number` | ❌ | `null` | Filter by exact repository ID (overrides `project` name lookup) |

**Example call:**
```json
{
  "query": "express middleware authentication JWT",
  "limit": 3,
  "project": "pocket-lawyer"
}
```

---

### `krusch_context_search_symbols` / `pg_git_search_symbols`

**Structural AST Symbol Search**: Search extracted code symbols (`code_symbols`) across indexed repositories without scanning entire file contents. Powered by a multi-language zero-dependency AST parser supporting JavaScript, TypeScript, Python, Go, Rust, and Shell.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | `string` | ✅ | — | Symbol name or substring to search (e.g., "verifyToken", "OrderService", "handleSearch") |
| `limit` | `number` | ❌ | `20` | Maximum symbols to return |
| `project` | `string` | ❌ | `null` | Filter by project name |
| `repository_id` | `number` | ❌ | `null` | Filter by repository ID |

**Example call:**
```json
{
  "query": "createDbosClient",
  "limit": 10
}
```

**Returned Metadata:**
- `symbol_name`: Exact identifier
- `symbol_type`: `function`, `class`, `method`, `route`, `interface`, `variable`
- `signature`: Parameter signature or route path
- `file_path`: Relative file path
- `start_line` / `end_line`: Precise 1-indexed source line range

---

### `krusch_context_file_symbols` / `pg_git_file_symbols`

**File Symbol Listing**: Retrieve all AST symbols declared within a specific file blob SHA.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `blob_id` | `string` | ✅ | — | The SHA hash of the blob to inspect |

**Example call:**
```json
{
  "blob_id": "53473d51cfbe37d102507725fb259892abef6462"
}
```

---

### `krusch_context_symbol_graph` / `pg_git_dependency_graph`

**Symbol Dependency Graph Walk**: Traverses outbound imports and inbound dependent callers for an AST symbol or file path up to $N$ hops (`code_symbol_edges`).

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `symbol_name` | `string` | ✅ | — | The symbol identifier or file path to traverse |
| `depth` | `number` | ❌ | `2` | Traversal depth (hops) |
| `project` | `string` | ❌ | `null` | Filter by project name |
| `repository_id` | `number` | ❌ | `null` | Filter by repository ID |

**Example call:**
```json
{
  "symbol_name": "git-engine.js",
  "depth": 2
}
```

---

### `krusch_context_list_repos`

List all repositories indexed in PostgreSQL. No parameters required.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| *(none)* | — | — | — | Returns all repos with ID, name, description, and creation date |

---

### `krusch_context_read_tree`

Browse the file tree of an indexed repository. Use `krusch_context_list_repos` first to get a repository ID.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `repository_id` | `number` | ✅ | — | Repository ID (from `krusch_context_list_repos`) |
| `tree_id` | `string` | ❌ | *root* | SHA hash of the tree to browse. Omit to get the root tree. Use a child tree's `object_id` to drill down. |

**Drill-down workflow:**
```
1. krusch_context_list_repos → get repo ID (e.g., 5)
2. krusch_context_read_tree({ repository_id: 5 }) → root tree entries
3. krusch_context_read_tree({ repository_id: 5, tree_id: "abc123" }) → subdirectory entries
4. krusch_context_read_blob({ blob_id: "def456" }) → file content
```

---

### `krusch_context_read_blob`

Read the full content of a file by its blob SHA hash. Get blob IDs from `krusch_context_read_tree`.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `blob_id` | `string` | ✅ | — | The SHA hash of the blob to read |

---

## Composite Search

### `krusch_context_deep_search`

**Grounded composite search.** Generates a single embedding and queries both the codebase (PG-Git blobs) and all 5 episodic memory categories simultaneously. Use this to establish a holistic baseline before starting work.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | `string` | ✅ | — | Natural language search query |
| `project` | `string` | ❌ | `null` | Optional project name to boost/filter results. If provided, it must strictly match a PG-Git repository name to prevent cross-project context bleeding. |

**What it searches (in parallel):**
1. `blobs` — codebase files (top 3)
2. `ide_agent_memory` — all 5 categories (`lessons`, `bugs`, `priorities`, `outcomes`, `activity`) (top 2 per category)

**Performance:** One embedding call shared across all 6 queries. This is the most efficient way to get comprehensive context.

**Example call:**
```json
{
  "query": "database migration schema changes",
  "project": "krusch-context-mcp"
}
```

---

## Nugget (Steering Facts) Tools

### `krusch_context_nugget_remember`

Store a short, durable fact for behavioral steering. UPSERTs by key — calling with an existing key updates the value.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `key` | `string` | ✅ | — | Unique identifier (e.g., `coding-style:const-preference`) |
| `value` | `string` | ✅ | — | The fact content |
| `kind` | `string` | ❌ | `project` | One of: `project` (project-specific), `user` (global user pref), `agent` (agent-level behavior) |
| `active_project` | `string` | ❌ | `null` | **Required for `project` kind.** The active project context — routes storage to SQLite. |

**Storage routing:**
- `kind: 'project'` + `active_project` provided → SQLite (`.agent/memory.db`), async pushes to Postgres
- `kind: 'user'` or `kind: 'agent'` → always global Postgres
- `kind: 'project'` + no `active_project` → falls back to global Postgres

**Example call:**
```json
{
  "key": "krusch-context-mcp:embedding-model",
  "value": "bge-large at 1024 dims. Do NOT use nomic-embed or other models.",
  "kind": "project",
  "active_project": "krusch-context-mcp"
}
```

---

### `krusch_context_nugget_nudges`

Return short, relevant nugget facts ranked by semantic similarity. Use this at session start to load behavioral context.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | `string` | ✅ | — | Semantic search query (e.g., "coding conventions" or "deployment patterns") |
| `kinds` | `string[]` | ❌ | *all kinds* | Filter by kind: `['project']`, `['user', 'agent']`, etc. |
| `limit` | `number` | ❌ | `3` | Maximum nudges to return |
| `active_project` | `string` | ❌ | `null` | **Required to retrieve `project` kind nuggets** from the project's SQLite DB. |

**Example call:**
```json
{
  "query": "code style and formatting preferences",
  "kinds": ["project", "user"],
  "limit": 5,
  "active_project": "krusch-context-mcp"
}
```

---

### `krusch_context_nugget_forget`

Delete a specific nugget by key.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `key` | `string` | ✅ | — | The nugget key to delete |
| `active_project` | `string` | ❌ | `null` | If provided, deletes from the project's SQLite DB first. Falls back to global Postgres. |

---

### `krusch_context_nugget_list`

List all saved nuggets chronologically (most recently updated first).

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `kinds` | `string[]` | ❌ | *all kinds* | Filter by kind |
| `active_project` | `string` | ❌ | `null` | **Required to list `project` kind nuggets** from the project's SQLite DB. |

---

## Documentation Tools

### `krusch_docs_list`

List all external manuals ingested into the semantic database. No parameters required.

### `krusch_docs_search`

Semantically search a specific external manual by name.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `manual_name` | `string` | ✅ | — | Exact name of the manual (from `krusch_docs_list`, e.g., `anthropic-docs`) |
| `query` | `string` | ✅ | — | Natural language search query |
| `limit` | `number` | ❌ | `5` | Maximum results |

**Example call:**
```json
{
  "manual_name": "anthropic-docs",
  "query": "how to use tool_use with streaming responses",
  "limit": 3
}
```

---

## System Tools

### `krusch_context_health_check`

Verify that the server is alive, connected to the database, and functioning. No parameters required.

Returns episodic memory count, active v2 states, nugget count, indexed repo count, extracted code symbols count, DB engine status, and version.

---

## 🔬 AI Watch Core Research Integration Tools

### `krusch_context_log_agent_failure`

**AgentDebugX Error Hub**: Log an agent execution failure trajectory, attributed root cause, and recovery patch bundle.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `agent_name` | `string` | ✅ | — | Name of the failing agent (e.g. `jean-sre`, `chrys-worker`) |
| `error_symptom` | `string` | ✅ | — | High-level failure symptom description |
| `trajectory` | `object[]` | ❌ | `[]` | Recorded step-by-step agent trajectory objects |
| `root_cause` | `string` | ✅ | — | Attributed root cause of the execution failure |
| `recovery_patch` | `object` | ❌ | `{}` | JSON patch or parameter modifications for rerun recovery |

---

### `krusch_context_search_failures`

**AgentDebugX Error Hub**: Search the Error Hub for past agent failure bundles matching a symptom or query.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | `string` | ✅ | — | Natural language search query or error symptom |
| `agent_name` | `string` | ❌ | `null` | Optional agent name filter |
| `limit` | `number` | ❌ | `5` | Maximum failure bundles to return |

---

### `krusch_context_get_recovery_pattern`

**AgentDebugX Error Hub**: Retrieve specific execution recovery pattern and patch instructions for a failure bundle ID.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `failure_id` | `number` | ✅ | — | Failure bundle ID in Error Hub |

---

### `krusch_context_register_pipeline_operator`

**DataFlow-Harness Grounded Codegen**: Register a grounded dataflow/ingestion operator with strict input, output, and side-effect schemas.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `name` | `string` | ✅ | — | Unique operator name (e.g., `ExtractLegalStatutes`) |
| `input_schema` | `object` | ✅ | — | JSON schema defining operator input arguments |
| `output_schema` | `object` | ✅ | — | JSON schema defining operator return outputs |
| `side_effects` | `string` | ❌ | `'none'` | Side effects description (`none`, `db_write`, `fs_write`) |
| `docs` | `string` | ❌ | `''` | Usage documentation for code-agents |

---

### `krusch_context_inspect_pipeline_registry`

**DataFlow-Harness Grounded Codegen**: Inspect active grounded operator schemas in the MCP registry.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `filter` | `string` | ❌ | `null` | Optional keyword filter |

---

### `krusch_context_mutate_pipeline_dag`

**DataFlow-Harness Grounded Codegen**: Mutate a pipeline DAG using grounded, typed operations (`AddNode`, `RemoveNode`, `WireEdge`, `UpdateNodeConfig`).

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `pipeline_name` | `string` | ✅ | — | Name of target pipeline DAG |
| `mutation_type` | `string` | ✅ | — | Mutation type: `AddNode`, `RemoveNode`, `WireEdge`, `UpdateNodeConfig` |
| `node_data` | `object` | ❌ | `null` | Target node object (`{ id, operator_name, config }`) |
| `edge_data` | `object` | ❌ | `null` | Target edge object (`{ from, to, mapping }`) |

---

### `krusch_context_setwise_rerank`

**Rubric4Setwise Reranking**: Rerank candidate document/memory sets against Redundancy, Conflict, and Complementarity rubrics to return a minimal covering set.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `candidates` | `object[]` | ✅ | — | Array of candidate document/memory objects |
| `query` | `string` | ✅ | — | Original query string |
| `target_count` | `number` | ❌ | `5` | Maximum minimal covering set items to return |

---

### `krusch_context_update_research_state`

**AREX Deep Research**: Update or create an AREX research state maintaining verified evidence and unresolved constraints.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `task_id` | `string` | ✅ | — | Unique research task ID |
| `verified_evidence` | `array` | ❌ | `[]` | List of verified evidence statements/claims |
| `unresolved_constraints` | `array` | ❌ | `[]` | List of open/unverified research constraints |
| `next_action_hints` | `array` | ❌ | `[]` | List of suggested follow-up research actions |

---

### `krusch_context_arex_audit`

**AREX Deep Research**: Audit research evidence and unresolved constraints for a task to produce self-improving next follow-up steps.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `task_id` | `string` | ✅ | — | Research task ID to audit |
| `candidate_response` | `string` | ❌ | `''` | Optional candidate response to verify |

---

### `krusch_context_manage_lifecycle`

**Agentic Context Management (ACM)**: Manage context fragment lifecycle stages (`stage`, `compact`, `evict`, `get`, `list`) and retention policies (HF Paper ArXiv: 2607.21503).

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `action` | `string` | ❌ | `'stage'` | Lifecycle action: `'stage'`, `'compact'`, `'evict'`, `'get'`, `'list'` |
| `fragment_id` | `string` | ❌ | — | Unique fragment identifier |
| `content` | `string` | ❌ | — | Text content or summary |
| `stage` | `string` | ❌ | `'staged'` | Fragment stage: `'staged'`, `'active'`, `'compacted'`, `'evicted'` |
| `ttl_days` | `number` | ❌ | `30` | Retention TTL in days |
| `project` | `string` | ❌ | `'default'` | Target project identifier |
| `metadata` | `object` | ❌ | `{}` | Optional arbitrary JSON metadata |

---

### `krusch_context_audit_budget`

**Agentic Context Management (ACM)**: Audit context window pressure, token budget consumption, and eviction/compaction recommendations (HF Paper ArXiv: 2607.21503).

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `project` | `string` | ❌ | `'default'` | Target project identifier |
| `token_budget` | `number` | ❌ | `8192` | Total token budget limit |
| `current_tokens` | `number` | ❌ | `0` | Additional unmanaged prompt tokens |

---

## Temporal Knowledge & Memory Invalidation (MobileMem, arXiv: 2608.13606)

### `krusch_context_supersede_memory`

**Temporal Fact Superseding**: Explicitly supersede an outdated memory record with updated knowledge, linking provenance lineage and marking the old record as `SUPERSEDED` so it is automatically excluded from active agent retrieval.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `number` | ✅ | — | Target memory ID to supersede |
| `category` | `string` | ✅ | — | Category: `'priorities'`, `'bugs'`, `'outcomes'`, `'lessons'`, `'activity'` |
| `content` | `string` | ✅ | — | New authoritative replacement content |
| `project` | `string` | ❌ | `null` | Optional project scope |
| `tags` | `string[]` | ❌ | `null` | Optional categorization tags |

---

### `krusch_context_invalidate_memory`

**Memory Invalidation**: Explicitly mark a memory record as `INVALIDATED` (e.g., revoked credentials, obsolete architecture rule, superseded constraint), removing it from active retrieval while preserving audit provenance.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `number` | ✅ | — | Memory ID to invalidate |
| `project` | `string` | ❌ | `null` | Optional project scope |
| `reason` | `string` | ❌ | `null` | Reason for invalidating this memory |

---

## Hierarchical Teacher Memory Distillation (arXiv: 2608.07169)

### `krusch_context_distill_teacher_memory`

**Teacher Trajectory Logging**: Log a frontier teacher model execution trajectory across three memory tiers (`workflow`, `subtask`, `function`) for local student LLM agent learning.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `tier` | `string` | ✅ | — | Memory tier: `'workflow'` (plan), `'subtask'` (step), `'function'` (tool fix) |
| `task_pattern` | `string` | ✅ | — | Task pattern or tool name (e.g. `'tool:git_commit'`) |
| `teacher_model` | `string` | ✅ | — | Identifier of teacher model (e.g. `'gemini-2.5-pro'`) |
| `student_model` | `string` | ❌ | `null` | Target student model (e.g. `'qwen2.5-coder:7b'`) |
| `trajectory` | `object[]` | ✅ | — | Structured execution trajectory steps |
| `distilled_rule` | `string` | ✅ | — | High-level operational rule distilled from trajectory |
| `project` | `string` | ❌ | `null` | Optional project association |
| `tags` | `string[]` | ❌ | `null` | Optional categorization tags |

---

### `krusch_context_retrieve_teacher_distillation`

**Teacher Memory Retrieval**: Retrieve distilled teacher trajectories matching a task query or error pattern, optionally filtered by memory tier.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | `string` | ✅ | — | Search query or error message |
| `tier` | `string` | ❌ | `null` | Optional memory tier filter (`'workflow'`, `'subtask'`, `'function'`) |
| `project` | `string` | ❌ | `null` | Optional project filter |
| `limit` | `number` | ❌ | `3` | Maximum matching results to return |

---

### `krusch_context_distill_function_memory`

**Function-Tier Failure Recovery**: Distill a tool call failure and teacher correction into a Tier 3 Function Memory entry for instant student error recovery.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `tool_name` | `string` | ✅ | — | Name of tool that failed |
| `failed_input` | `string` | ✅ | — | Input parameters that triggered failure |
| `error_message` | `string` | ✅ | — | Error message or status code |
| `corrected_input` | `string` | ✅ | — | Corrected parameters provided by teacher |
| `explanation` | `string` | ✅ | — | Explanation of why the correction works |
| `teacher_model` | `string` | ❌ | `'teacher'` | Teacher model identifier |
| `project` | `string` | ❌ | `null` | Optional project filter |

---

## Diverse Skill Routing & Multi-Agent Resilience (September 2026 Breakthroughs)

### `krusch_context_route_skills`

**Diverse Skill Routing (DSR)**: Uses Determinantal Point Processes (DPP) to retrieve an orthogonal, non-redundant set of agent skills matching a task query without token bloat ([arXiv: 2609.05824](https://arxiv.org/abs/2609.05824)).

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | `string` | ✅ | — | Task description, intent, or workflow requirements |
| `max_skills` | `number` | ❌ | `5` | Maximum number of skills to route |
| `max_tokens` | `number` | ❌ | `4000` | Maximum combined token budget for routed skills |
| `diversity_lambda` | `number` | ❌ | `0.6` | Trade-off parameter balancing relevance (1.0) vs. diversity (0.0) |

---

### `krusch_context_evaluate_resilience`

**Multi-Agent Resilience Gate**: Evaluates multi-agent execution traces and inter-agent handoffs for cascading failures, circular deadlocks, and credential leakage ([arXiv: 2609.17320](https://arxiv.org/abs/2609.17320)).

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `handoffs` | `object[]` | ✅ | — | Array of handoff trace events (`{ senderId, recipientId, message, status, error }`) |
| `max_cascade_depth` | `number` | ❌ | `2` | Maximum allowed consecutive error cascade depth |

---

### `krusch_context_list_skills`

**List Available Agent Skills**: Browse all specialized agent skills (TDD, Diagnose, Handoff, Caveman, Cloudflare Tunnel, Container Update, etc.) registered in the homelab skill directory.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| *(none)* | — | — | — | Returns array of skill names, descriptions, and file paths |

---

### `krusch_context_get_skill`

**Retrieve Agent Skill Prompt**: Fetch the full markdown prompt instructions, procedures, and guardrails for a specific homelab agent skill by name.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `name` | `string` | ✅ | — | The exact name of the skill to retrieve (e.g. `'tdd'`, `'diagnose'`, `'caveman'`, `'grill-with-docs'`) |

**Example call:**
```json
{
  "name": "diagnose"
}
```

---

## Session Bridge Tools (IDE ↔ Persistent SRE Scouts)

### `krusch_context_write_session_handoff`

**Session Bridge Close Handler**: Write the active IDE development session summary, calculate modified files, insert the durable handoff record into PostgreSQL, and notify or spawn the Jean SRE companion scout for automated background audit and telemetry correlation. Call this tool during the `/close` workflow.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `project` | `string` | ✅ | — | Project name or repository identifier |
| `summary` | `string` | ✅ | — | Detailed summary of session accomplishments, unresolved edge cases, and in-flight tasks |

**Example call:**
```json
{
  "project": "krusch-context-mcp",
  "summary": "Completed native PG-Git engine consolidation and updated full documentation suite."
}
```

---

### `krusch_context_read_session_review`

**Session Bridge Review Consumer**: Fetch the latest background session review compiled by persistent SRE companions (e.g., Jean SRE). This operation is atomically idempotent — reading the review marks it as acknowledged/consumed so agents don't receive duplicate review prompts. Call this tool during the `/continue` or `/open` workflow.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `project` | `string` | ✅ | — | Project name or repository identifier to read review for |

**Example call:**
```json
{
  "project": "krusch-context-mcp"
}
```

---

## ⚡ Polygres Cloud v0.5.0 Runtime Tools

### `polygres_cloud_usage`

**Polygres Cloud Quota Monitor**: Fetch live monthly microcredit allowance, generation/query usage, and remaining free quota for the active Polygres project. Enables agents and developers inside Cursor and Claude Code to monitor free tier consumption without navigating to the web console.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| *(none)* | — | — | — | Automatically resolves active project credentials from environment |

**Example call:**
```json
{}
```

---

### `polygres_cloud_search`

**Polygres Cloud In-Engine Search**: Perform semantic or hybrid search over a cloud pgContext collection using pure text input. Vector embeddings are generated 100% in-engine by Polygres—eliminating local Ollama queue overhead, external embedding API hops, and client-side vector handling.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `text` | `string` | ✅ | — | Raw text query to search and embed in-engine |
| `collection` | `string` | ❌ | `null` | Target pgContext collection name (optional) |
| `limit` | `number` | ❌ | `10` | Maximum number of results to return |
| `filters` | `object` | ❌ | `null` | Optional metadata key-value filters |

**Example call:**
```json
{
  "text": "how do background embedding pipelines work on watched tables",
  "limit": 5
}
```

---

### `polygres_cloud_models`

**Polygres Cloud Model Catalog**: Discover available in-engine embedding models, supported vector dimensions, and microcredit pricing for the connected project.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| *(none)* | — | — | — | Returns array of supported embedding models and available dimensions |

**Example call:**
```json
{}
```

---

### `polygres_cloud_capabilities`

**Polygres Cloud Engine Capabilities**: Inspect server-side pgContext version, HNSW limits (maximum record bytes, M factor), and compatibility matrix.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| *(none)* | — | — | — | Returns server engine capabilities and pgContext metadata |

**Example call:**
```json
{}
```

---

### `polygres_cloud_embedding_configs`

**Polygres Cloud Watched Tables**: List automated in-database embedding pipelines configured on database tables, including source columns, target embedding tables, and active status.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| *(none)* | — | — | — | Returns array of configured automated table embedding pipelines |

**Example call:**
```json
{}
```


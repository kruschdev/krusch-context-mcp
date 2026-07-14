# 📋 Complete Tool Reference

> Every tool, every parameter, every default — everything an agent needs to call these tools correctly.
>
> For a quick overview, see the [Tool Quick-Reference](../README.md#tool-quick-reference) in the README. For configuration and troubleshooting, see the [Setup Guide](SETUP.md).

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
- `project` omitted → writes directly to global `kruschdb.ide_agent_memory` (Postgres)

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
2. Inserts into `memory_v2` with a UUID, version tracking, and author attribution
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
  "resolution_content": "Final decision: Use port 5442 for kruschdb (not 5441 or 5443). Both previous entries were partially correct.",
  "author_id": "human:krusch"
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

## Codebase Search Tools

### `krusch_context_search_code`

Semantic search over all files indexed in PG-Git (`kruschdb.blobs`). Results are ranked by embedding similarity.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | `string` | ✅ | — | Natural language search query (e.g., "how does the scheduler work") |
| `limit` | `number` | ❌ | `5` | Maximum results to return |
| `project` | `string` | ❌ | `null` | Filter results to a specific project/repository name. If provided, it must exactly match a known repository name, or the tool will throw an error to prevent cross-project hallucination. |
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

### `krusch_context_list_repos`

List all repositories indexed in PG-Git. No parameters required.

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

**Zero-Trust composite search.** Generates a single embedding and queries both the codebase (PG-Git blobs) and all 5 episodic memory categories simultaneously. Use this to establish a holistic baseline before starting work.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | `string` | ✅ | — | Natural language search query |
| `project` | `string` | ❌ | `null` | Optional project name to boost/filter results. If provided, it must strictly match a PG-Git repository name to prevent cross-project context bleeding. |

**What it searches (in parallel):**
1. `kruschdb.blobs` — codebase files (top 3)
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

Returns memory count, nugget count, repo count, DB status, and version.

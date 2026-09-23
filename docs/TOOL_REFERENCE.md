# 📋 Complete Tool Reference

> Every tool, every parameter, every default — everything an agent needs to call these tools correctly.
>
> For a high-level overview, see the [README](../README.md). For configuration and operational setups, see the [Setup Guide](SETUP.md).

---

## 🎯 Tool Profiles & Presets (`KRUSCH_PROFILE`)

To prevent agent context exhaustion and tool selection degradation, tools are organized into lean profile tiers and modular companion extensions:

- **`core` (Sovereign Default — 13 Tools)**: The lean, high-signal daily driver context engine (~900 prompt tokens). Covers hybrid retrieval, episodic memory hygiene, holographic nuggets, native symbol graphs, codebase search, server health, and proactive trajectory auditing.
- **`extended` (26 Tools Total)**: Core (13) plus complete memory administrative lifecycle (`list`, `delete`, `update`, `consolidate`), Git exploration (`list_repos`, `read_tree`, `read_blob`, `file_symbols`), composite search (`deep_search`), holographic forget/list, cited thinking (`think`), and proactive alignment feedback (`nudge_feedback`).
- **`sovereign` (37 Tools Total)**: The Sovereign Triad profile mounting Core (13) + Law (8) + Nexus (6) + Biz (7) + Semantic Router (3).
- **`companion extensions` (29 Tools across 5 modular extensions)**: Run independently as companion MCP servers or load on-demand via `--extensions=...` (`law`: 8, `nexus`: 6, `biz`: 7, `polygres-cloud`: 5, `semantic-router`: 3).
- *(Note: Experimental research engines — AgentDebugX, DataFlow, Setwise, AREX, ACM, Teacher Distillation, Resilience Gate — have been extracted to the dedicated companion package `krusch-research-mcp`)*.

Configure via `KRUSCH_PROFILE=core` in your `.env` or IDE MCP configuration, or pass `--profile=core` on the command line. Registered handlers for all tools remain executable on direct invocation regardless of the active profile.

---

## 🏛️ Architecture & PG-Git Engine Integration

Krusch Context MCP decouples into a 13-tool Core with modular companion extensions (up to **37 tools** in the Sovereign Triad profile, or 55 tools maximum across all extensions). It natively incorporates the complete codebase indexing and retrieval engine from **[PG-Git](https://github.com/kruschdev/pg-git)** (`pg-git-mcp@1.1.0`):
- **Native Git DAG Storage**: Stores Git trees, blobs, commits, and branches in PostgreSQL without requiring external file-system loose object scanning.
- **Structural Symbol Extraction**: Zero-dependency structural regex and brace-matching parser for JS, TS, Python, Go, Rust, and Shell to populate `code_symbols` and dependency edges in `code_symbol_edges`.
- **Hybrid RRF Search**: Merges dense pgvector cosine similarity with full-text lexical BM25 (`tsv` GIN index) using Reciprocal Rank Fusion and exponential temporal decay ($e^{-0.01t}$).
- **Shared Schema & Dual-Surface Aliases**: Shares identical PostgreSQL tables (`repositories`, `blobs`, `code_symbols`, `code_symbol_edges`, `trees`, `commits`, `branches`) with standalone PG-Git. Exposes first-class `pg_git_*` aliases (`pg_git_search_symbols`, `pg_git_file_symbols`, `pg_git_dependency_graph`) so standalone PG-Git workflows run seamlessly without reconfiguring agent prompts.

---

## ⚡ Core Profile (13 Tools — Sovereign Default)

The default 13-tool daily driver profile designed to fit within ~900 prompt tokens.

### `krusch_context_retrieve`

Polygres-inspired unified context retrieval tool. Combines HNSW vector search, multi-hop graph walks, and server-side token budget packing into a single context payload.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | `string` | ✅ | — |  |
| `project` | `string` | ❌ | — |  |
| `graph_hops` | `number` | ❌ | `1` |  |
| `limit_tokens` | `number` | ❌ | `4000` |  |
| `include_code` | `boolean` | ❌ | `true` |  |
| `include_state` | `boolean` | ❌ | `false` | Optionally prepend compiled project state briefing directly into the packed payload |

---

### `krusch_context_add_memory`

Add a new fact or memory to the persistent IDE database. Supports MobileMem temporal superseding via supersedes_id.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `project` | `string` | ❌ | — |  |
| `active_project` | `string` | ❌ | — | Optional project context (alias for project) |
| `category` | `string` | ✅ | — |  |
| `content` | `string` | ✅ | — |  |
| `tags` | `array` | ❌ | — |  |
| `supersedes_id` | `number` | ❌ | — | Optional ID of a previous memory record that this new fact supersedes/replaces. |

---

### `krusch_context_supersede_memory`

Explicitly supersede an outdated memory with updated knowledge, linking lineage and marking the old record as SUPERSEDED.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `number` | ✅ | — | Target memory ID to supersede |
| `category` | `string` | ✅ | — |  |
| `content` | `string` | ✅ | — | New authoritative content |
| `project` | `string` | ❌ | — |  |
| `active_project` | `string` | ❌ | — | Optional project context (alias for project) |
| `tags` | `array` | ❌ | — |  |

---

### `krusch_context_invalidate_memory`

Explicitly mark a memory record as INVALIDATED (e.g. revoked secret, deprecated invariant, obsolete design rule).

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `number` | ✅ | — | Memory ID to invalidate |
| `project` | `string` | ❌ | — |  |
| `active_project` | `string` | ❌ | — | Optional project context (alias for project) |
| `reason` | `string` | ❌ | — | Reason for invalidating this memory |

---

### `krusch_context_search_memory`

Search the persistent IDE database for past lessons, bugs, priorities, or project outcomes. Excludes superseded/invalidated records by default.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `active_project` | `string` | ❌ | — | The active project context (alias for project) |
| `project` | `string` | ❌ | — | The active project context (alias for active_project) |
| `category` | `string` | ✅ | — |  |
| `query` | `string` | ✅ | — |  |
| `limit` | `number` | ❌ | `3` |  |
| `search_type` | `string` | ❌ | `semantic` |  |
| `include_history` | `boolean` | ❌ | `false` |  |
| `include_superseded` | `boolean` | ❌ | `false` | If true, includes superseded and invalidated records |

---

### `krusch_context_compile_state`

Compile a consolidated project state briefing (active priorities, recent blockers, outcome history, steering nuggets). Auto-detects project if omitted.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `project` | `string` | ❌ | — | The project to compile state for. Defaults to detected active project if omitted. |
| `active_project` | `string` | ❌ | — | Alias for project |

---

### `krusch_context_search_code`

Semantically search the contents of all files in PG-Git with age-decay weighting.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | `string` | ✅ | — |  |
| `limit` | `number` | ❌ | `5` |  |
| `project` | `string` | ❌ | — |  |
| `repository_id` | `number` | ❌ | — |  |

---

### `krusch_context_search_symbols`

Search extracted AST code symbols (functions, classes, interfaces, methods) across indexed repositories.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | `string` | ✅ | — | Symbol name or substring to search |
| `limit` | `number` | ❌ | `20` |  |
| `repository_id` | `number` | ❌ | — | Optional repository ID filter |
| `project` | `string` | ❌ | — | Optional project name filter |

---

### `krusch_context_symbol_graph`

Traverse dependency and call edges for an AST symbol up to N hops.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `symbol_name` | `string` | ✅ | — | The symbol identifier to traverse |
| `depth` | `number` | ❌ | `2` |  |
| `repository_id` | `number` | ❌ | — | Optional repository ID |
| `project` | `string` | ❌ | — | Optional project name filter |

---

### `krusch_context_nugget_remember`

Store a short, durable Holographic Nugget memory fact (coding standards, conventions).

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `key` | `string` | ✅ | — |  |
| `value` | `string` | ✅ | — |  |
| `kind` | `string` | ❌ | — |  |
| `project` | `string` | ❌ | — | The project context (alias for active_project). |
| `active_project` | `string` | ❌ | — | The active project context. Required for 'project' kind nuggets. |

---

### `krusch_context_nugget_nudges`

Return short, relevant Nuggets facts to gently steer the agent.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | `string` | ✅ | — |  |
| `kinds` | `array` | ❌ | — |  |
| `limit` | `number` | ❌ | `3` |  |
| `project` | `string` | ❌ | — | The project context (alias for active_project). |
| `active_project` | `string` | ❌ | — | The active project context. Required to retrieve 'project' kind nuggets. |

---

### `krusch_context_proactive_nudge`

Proactively audits current agent trajectory against historical lessons, bugs, priorities, and nuggets. Returns a warning nudge if any constraints or rules are violated.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `history` | `any` | ✅ | — |  |
| `project` | `string` | ❌ | — | Optional active project scope. |

---

### `krusch_context_health`

Inspect the health, connectivity, and counts of the context engine.

*(No parameters required)*

---

## 🛠️ Extended Core Tools (+13 Tools = 26 Tools Total)

Administrative lifecycle, Git object inspection, cited thinking, and proactive alignment feedback.

### `krusch_context_list_memories`

List recent memories in a category, optionally filtered by project. Fast chronological listing.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `category` | `string` | ✅ | — |  |
| `project` | `string` | ❌ | — | Filter by project name |
| `active_project` | `string` | ❌ | — | Optional project filter (alias for project) |
| `limit` | `number` | ❌ | `10` |  |

---

### `krusch_context_delete_memory`

Delete a specific memory by its numeric ID.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `number` | ✅ | — | The numeric ID of the memory to delete |
| `source_project` | `string` | ❌ | — | Project name for SQLite memory. Leave empty for Global PG. |
| `project` | `string` | ❌ | — | Optional alias for source_project |

---

### `krusch_context_update_memory`

Update an existing memory's content, tags, or project assignment.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `number` | ✅ | — | The numeric ID of the memory to update |
| `source_project` | `string` | ❌ | — | Project name if SQLite memory. |
| `active_project` | `string` | ❌ | — | Optional alias for source_project |
| `content` | `string` | ❌ | — | New content (triggers re-embedding) |
| `tags` | `array` | ❌ | — |  |
| `project` | `string` | ❌ | — | New project assignment |

---

### `krusch_context_consolidate`

Consolidate duplicate or highly similar memories within a category and project.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `category` | `string` | ✅ | — |  |
| `project` | `string` | ❌ | — |  |
| `active_project` | `string` | ❌ | — | Optional alias for project |
| `threshold` | `number` | ❌ | `0.88` |  |
| `dry_run` | `boolean` | ❌ | `true` |  |

---

### `krusch_context_deep_search`

Deep concurrent search across all episodic memory categories and PG-Git codebase blobs.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | `string` | ✅ | — | The search query. |
| `project` | `string` | ❌ | — | Optional project name. |

---

### `krusch_context_list_repos`

List all repositories indexed in PG-Git with their IDs and descriptions.

*(No parameters required)*

---

### `krusch_context_read_tree`

Browse the file tree of a repository indexed in PG-Git.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `repository_id` | `number` | ✅ | — | The repository ID |
| `tree_id` | `string` | ❌ | — | The tree hash to browse. Omit for root tree. |

---

### `krusch_context_read_blob`

Read the full content of a specific file (blob) from PG-Git by its SHA hash.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `blob_id` | `string` | ✅ | — | The SHA hash of the blob to read |

---

### `krusch_context_file_symbols`

Get all AST code symbols extracted for a given file blob SHA.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `blob_id` | `string` | ✅ | — | The SHA hash of the blob |

---

### `krusch_context_nugget_forget`

Delete a specific holographic nugget by key.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `key` | `string` | ✅ | — |  |
| `project` | `string` | ❌ | — | Project context (alias for active_project). |
| `active_project` | `string` | ❌ | — | Active project context. |

---

### `krusch_context_nugget_list`

List all saved holographic nuggets chronologically.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `kinds` | `array` | ❌ | — |  |
| `project` | `string` | ❌ | — |  |
| `active_project` | `string` | ❌ | — |  |

---

### `krusch_context_think`

Perform cited context synthesis, conflict detection, and gap analysis across memory and codebase.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | `string` | ✅ | — | The query or question to think about. |
| `project` | `string` | ❌ | — | Optional project filter. |

---

### `krusch_context_nudge_feedback`

Logs developer feedback for proactive auditor nudges to collect alignment signals.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query_text` | `string` | ✅ | — |  |
| `nudge_text` | `string` | ✅ | — |  |
| `user_approved` | `boolean` | ✅ | — |  |
| `agent_corrected` | `boolean` | ✅ | — |  |
| `correction_diff` | `string` | ❌ | — |  |
| `project` | `string` | ❌ | — |  |

---

## 🌐 Modular Companion Extensions

Companion extensions provide targeted capabilities for specific project domains. Load via `--extensions=<name>` or select a profile preset like `KRUSCH_PROFILE=sovereign`.

### Extension: `polygres-cloud` (5 Tools)

### `polygres_cloud_usage`

Polygres Cloud v0.5.0 Quota Monitor: Fetch live microcredit allowance, generation/query usage, and remaining free quota for the active Polygres project.

*(No parameters required)*

### `polygres_cloud_search`

Polygres Cloud v0.5.0 In-Engine Search: Perform semantic or hybrid search over a cloud pgContext collection using pure text input (embeddings generated in-engine with zero local model load).

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `collection` | `string` | ❌ | — | Target pgContext collection name |
| `text` | `string` | ✅ | — | Raw text query to search and embed in-engine |
| `limit` | `number` | ❌ | `10` | Max results to return (default 10) |
| `filters` | `object` | ❌ | — | Optional metadata filters |

### `polygres_cloud_models`

Polygres Cloud v0.5.0 Model Catalog: Discover available in-engine embedding models, dimensions, and microcredit pricing.

*(No parameters required)*

### `polygres_cloud_capabilities`

Polygres Cloud v0.5.0 Engine Capabilities: Inspect server-side pgContext version, HNSW limits (max record bytes, M factor), and compatibility.

*(No parameters required)*

### `polygres_cloud_embedding_configs`

Polygres Cloud v0.5.0 Watched Tables: List automated in-database embedding pipelines configured on database tables.

*(No parameters required)*

---

### Extension: `nexus` (6 Tools)

### `krusch_nexus_list_workspaces`

List document workspaces and indexed document counts in KruschNexus to prevent cross-contamination.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `token` | `string` | ❌ | — | Optional API token for workspace authorization |

### `krusch_nexus_list_documents`

Enumerate ingested documents, page counts, chunk totals, and OCR status in a specific workspace.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `workspace_name` | `string` | ❌ | — | Target workspace name (e.g. 'Matter_104_Oakland', 'Vendor_Contracts_2026') |
| `token` | `string` | ❌ | — | Optional API token for authorization |

### `krusch_nexus_search_corpus`

Execute hybrid vector + full-text search across ingested documents in KruschNexus, returning physical page numbers, character span offsets, and citations.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | `string` | ✅ | — | Search question, keywords, or statutory section tokens (e.g. 'security deposit refund', 'Section 10.1') |
| `workspace_name` | `string` | ✅ | — | Target workspace name (REQUIRED to guarantee isolation) |
| `doc_type` | `string` | ❌ | — | Optional classification filter ('authority', 'work_product', 'fact_narrative', 'general') |
| `limit` | `integer` | ❌ | `5` | Maximum cited hits to return (default: 5, max: 20) |
| `page` | `integer` | ❌ | — | Optional physical page number filter |
| `filename` | `string` | ❌ | — | Optional filename filter |
| `token` | `string` | ❌ | — | Optional API token |

### `krusch_nexus_get_ingest_report`

Retrieve the Ingest Report for a document by its database ID or SHA-256 hash.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `doc_id_or_hash` | `string` | ✅ | — | Document ID or SHA-256 hash |
| `token` | `string` | ❌ | — | Optional API token |

### `krusch_nexus_ingest_file`

Ingest a local document (PDF, DOCX, TXT, MD, etc.) into the KruschNexus corpus with layout extraction, OCR fallback, and span offsets.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `file_path` | `string` | ✅ | — | Absolute filesystem path to document file |
| `workspace_name` | `string` | ✅ | — | Target workspace name (REQUIRED) |
| `doc_type` | `string` | ❌ | `general` | Classification ('authority', 'work_product', 'fact_narrative', 'general') |
| `archive` | `boolean` | ❌ | `false` | Whether to move source file to .ingested/ upon indexing |
| `token` | `string` | ❌ | — | Optional API token |

### `krusch_nexus_verify_span`

Verify that an assertion or excerpt corresponds to an authentic character span offset and physical page in the ingested corpus.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `workspace_name` | `string` | ✅ | — | Target workspace containing the document |
| `query` | `string` | ✅ | — | Proposition text or quote to verify against corpus spans |
| `physical_page` | `integer` | ❌ | — | Optional target page number |
| `char_start` | `integer` | ❌ | — | Optional expected character start offset |
| `char_end` | `integer` | ❌ | — | Optional expected character end offset |
| `token` | `string` | ❌ | — | Optional API token |

---

### Extension: `law` (8 Tools)

### `krusch_law_search_ordinances`

Search versioned municipal codes, county ordinances, and state statutes in the air-gapped KruschLaw store with authority weighting (controlling statute > regulation > ordinance).

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | `string` | ✅ | — | Search terms or colloquial grievance (e.g. 'rent hike notice', 'OMI eviction', 'security deposit') |
| `state` | `string` | ❌ | — | Two-letter state postal abbreviation (default: 'CA') |
| `city` | `string` | ❌ | — | City or county name (e.g. 'Oakland', 'San Francisco', 'Los Angeles') |
| `topic` | `string` | ❌ | — | Classification (e.g. 'Housing & Rent', 'Public Nuisance', 'Building Safety') |
| `limit` | `integer` | ❌ | `5` | Maximum sections to return (default: 5, max: 20) |

### `krusch_law_get_section`

Retrieve unabridged statutory text, parent/child relationships, and exception clauses for a specific section.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `section` | `string` | ✅ | — | Section code (e.g. 'OMC 8.22.360', 'Cal. Civ. Code § 1950.5') |
| `jurisdiction` | `string` | ❌ | — | Optional jurisdiction filter (e.g. 'Oakland Municipal Code') |

### `krusch_law_draft_brief`

Stage an air-gapped, citation-grounded 4-part legal brief for human attorney review. Refuses to draft if governing authorities are absent. Does NOT auto-file.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `facts` | `string` | ✅ | — | Matter narrative, parties, and factual circumstances |
| `case_id` | `integer` | ❌ | — | Optional existing matter ID from KruschLaw database |
| `title` | `string` | ❌ | — | Short descriptive title for the brief |
| `city` | `string` | ❌ | `Oakland` | Governing city (default: 'Oakland') |
| `state` | `string` | ❌ | `CA` | Two-letter state postal abbreviation (default: 'CA') |

### `krusch_law_verify_grounding`

Decompose a proposed legal draft into discrete claims and audit each against local governing authorities for invented citations, wrong propositions, and stale law.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `draft_text` | `string` | ✅ | — | Proposed legal text, memorandum, or draft brief to audit |

### `krusch_law_flag_stale_memories`

Flag all stored agent conclusions and working memories citing an amended statute as STALE_PENDING_REVIEW without silent deletion or automatic overwrite.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `section` | `string` | ✅ | — | Amended statutory section (e.g. 'Section 1950.5(b)', 'OMC 8.22.360') |
| `amendment_diff` | `string` | ❌ | — | Optional text diff showing previous vs amended statutory terms |
| `chaptered_bill_ref` | `string` | ❌ | — | Legislative act or chaptered bill citation (e.g. 'Stats. 2023, ch. 290 (AB 12)') |
| `project` | `string` | ❌ | `krusch-law` | Project identifier (default: 'krusch-law') |

### `krusch_law_review_stale_queue`

Inspect the queue of stored agent conclusions and working memories flagged as STALE_PENDING_REVIEW due to statutory amendments.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `project` | `string` | ❌ | `krusch-law` | Project identifier (default: 'krusch-law') |
| `limit` | `integer` | ❌ | `10` | Maximum queue entries to inspect (default: 10) |

### `krusch_law_resolve_stale_memory`

Resolve a memory in STALE_PENDING_REVIEW status: reaffirm (restore to ACTIVE), supersede (replace with updated statutory conclusions), or invalidate.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `memory_id` | `integer` | ✅ | — | ID of the memory record to resolve |
| `resolution` | `string` | ✅ | — | Resolution action: 'reaffirm' (still valid), 'supersede' (replace with new_content), 'invalidate' (dead rule) |
| `new_content` | `string` | ❌ | — | Updated memory content (required if resolution is 'supersede') |
| `project` | `string` | ❌ | `krusch-law` | Project identifier (default: 'krusch-law') |

### `krusch_law_get_traceability`

Query curated statute-to-code traceability links, binding California housing statutes directly to codebase symbols and files with attorney review attestations.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `doctrine` | `string` | ❌ | — | Optional doctrine filter (e.g. 'Security Deposits', 'Just Cause') |
| `status` | `string` | ❌ | — | Optional verification status filter (e.g. 'manually_verified', 'pending_review') |

---

### Extension: `biz` (7 Tools)

### `krusch_biz_search_contracts`

Search corporate contracts, MSAs, SLAs, NDAs, and company policies in KruschBiz using hybrid vector + lexical retrieval.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | `string` | ✅ | — | Search query or commercial term (e.g. 'limitation of liability', 'net 30 payment terms', 'uptime SLA') |
| `organization` | `string` | ❌ | — | Company or enterprise name (e.g. 'Acme Corp') |
| `agreement_type` | `string` | ❌ | — | Agreement classification (e.g. 'Master Services Agreement', 'Service Level Agreement') |
| `domain` | `string` | ❌ | — | Commercial domain (e.g. 'Procurement & Invoicing', 'Risk & Indemnification') |
| `limit` | `integer` | ❌ | `5` | Maximum clauses to return (default: 5, max: 20) |
| `tenant_id` | `string` | ❌ | `org_default` | Multi-tenant partition identifier (default: 'org_default') |

### `krusch_biz_get_clause`

Retrieve the unabridged contractual text, parent/child relationships, and structured commercial slots for a specific section.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `section` | `string` | ✅ | — | Section identifier (e.g. 'Section 10.1', 'Exhibit B Section 2.1') |
| `organization` | `string` | ❌ | — | Optional organization filter |
| `tenant_id` | `string` | ❌ | `org_default` | Multi-tenant partition identifier (default: 'org_default') |

### `krusch_biz_resolve_controlling_clause`

Traverse the commercial agreement relation graph (AMENDS, SUPERSEDES) to resolve which clause governs a topic as of a specific date.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `counterparty` | `string` | ✅ | — | Counterparty or vendor corporate name (e.g. 'CloudScale AI LLC') |
| `topic` | `string` | ✅ | — | Canonical commercial topic (e.g. 'PAYMENT_TERMS', 'LIMITATION_OF_LIABILITY', 'SLA_PERFORMANCE') |
| `as_of_date` | `string` | ❌ | — | Optional ISO date (YYYY-MM-DD) for historical or point-in-time precedence |
| `tenant_id` | `string` | ❌ | `org_default` | Multi-tenant partition identifier (default: 'org_default') |

### `krusch_biz_detect_conflicts`

Detect conflicting numeric terms and slot discrepancies (e.g. Net 30 vs Net 45) across concurrently active instruments.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `counterparty` | `string` | ✅ | — | Counterparty or vendor corporate name |
| `as_of_date` | `string` | ❌ | — | Optional ISO date (YYYY-MM-DD) |
| `tenant_id` | `string` | ❌ | `org_default` | Multi-tenant partition identifier (default: 'org_default') |

### `krusch_biz_diff_instruments`

Diff two legal instruments side-by-side: aligns clauses by topic, extracts text diffs, and highlights diverging structured slots.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `agreement_a_id` | `integer` | ✅ | — | Base Agreement ID (e.g. 2021 Master Agreement) |
| `agreement_b_id` | `integer` | ✅ | — | Target Agreement ID (e.g. 2025 Master Agreement or Amendment) |
| `tenant_id` | `string` | ❌ | `org_default` | Multi-tenant partition identifier (default: 'org_default') |

### `krusch_biz_draft_deal_brief`

Stage an air-gapped executive commercial memorandum with assertion-level grounding audit. Refuses to draft if governing agreements are absent.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `context_facts` | `string` | ❌ | — | Transaction background narrative, key deal points, and vendor proposals |
| `deal_id` | `integer` | ❌ | — | Optional ID of an existing logged deal matter |
| `title` | `string` | ❌ | — | Title of the transaction or executive memorandum |
| `counterparty` | `string` | ❌ | — | Counterparty corporate name |
| `organization` | `string` | ❌ | — | Internal company name |
| `limit` | `integer` | ❌ | `5` | Number of governing clauses to retrieve (default: 5) |
| `tenant_id` | `string` | ❌ | `org_default` | Multi-tenant partition identifier (default: 'org_default') |

### `krusch_biz_list_deals`

Enumerate active corporate deals, vendor transactions, and matter codes in KruschBiz.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `limit` | `integer` | ❌ | `10` | Maximum deals to return (default: 10) |
| `status` | `string` | ❌ | — | Optional status filter ('active', 'closed', 'under_review') |
| `tenant_id` | `string` | ❌ | `org_default` | Multi-tenant partition identifier (default: 'org_default') |

---

### Extension: `semantic-router` (3 Tools)

### `krusch_context_semantic_route`

Neural Semantic Router (L2): Classify an unstructured natural-language prompt into an optimal model tier and specialist role using pgvector cosine distance against calibrated archetype centroids.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `prompt` | `string` | ✅ | — | The incoming user prompt or task description to classify. |
| `project` | `string` | ❌ | — | Optional project scope to bias model selection based on active workspace stack. |
| `metadata` | `object` | ❌ | — | Optional contextual hints such as active file path or diagnostic logs. |

### `krusch_context_register_semantic_centroid`

Register or update a semantic routing centroid exemplar in the pgvector database.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `archetype` | `string` | ✅ | — | Unique slug for the routing archetype (e.g. 'code_refactoring', 'deep_diagnostics'). |
| `tier` | `string` | ✅ | — | Target model tier. |
| `role` | `string` | ✅ | — | Domain specialist role. |
| `label` | `string` | ✅ | — | Human-readable label. |
| `exemplar` | `string` | ✅ | — | Representative prompt or phrasing whose vector embedding serves as the centroid anchor. |
| `confidence_threshold` | `number` | ❌ | — | Minimum cosine similarity threshold (e.g. 0.65). |
| `metadata` | `object` | ❌ | — | Optional metadata (preferred model, domain tags, etc.). |

### `krusch_context_list_semantic_centroids`

List registered routing archetypes, tiers, and exemplar anchors.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `archetype` | `string` | ❌ | — | Optional filter by archetype name substring. |
| `limit` | `number` | ❌ | — | Maximum centroids to return (default: 50). |

---


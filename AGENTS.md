# krusch-context-mcp — Agent Context

> Unified MCP server: PG-Git codebase search + Homelab episodic memory + Holographic Nuggets + External docs search.

> **Last audit**: 2026-05-12 | **Version**: 1.0.0 | **Tools**: 26

## Architecture Overview

This project is a single MCP server (stdio transport) that unifies three subsystems into one process:

1. **Episodic Memory** — Vector-embedded memories (bugs, lessons, priorities, outcomes, activity) stored in hybrid SQLite + Postgres
2. **Holographic Nuggets** — Lightweight key-value steering facts (preferences, conventions, corrections) with semantic retrieval
3. **Codebase Search** — Semantic search over all indexed source files via the sibling `pg-git` project

All three share a single `pg.Pool` connection to `kruschdb` and a single fleet-balanced Ollama embedding pipeline.

### Lakebase Architecture (Compute/Storage Decoupling)

Project-scoped data follows a two-tier model:
- **Compute Cache**: Per-project SQLite databases at `<project>/.agent/memory.db` — zero-latency reads
- **Object Storage**: Durable Postgres tables (`ide_agent_memory`, `ide_agent_nuggets`) — fleet-wide persistence
- **Sync**: Async write-behind (SQLite → Postgres) on every write; read-ahead pull (Postgres → SQLite) on first project access

### Storage Routing Rules

| Operation | `project`/`active_project` provided | `project`/`active_project` omitted |
|-----------|--------------------------------------|-------------------------------------|
| **Write memory** | SQLite + async PG push | Postgres directly |
| **Search memory** | Merge: SQLite + Postgres (SQLite gets +0.3 bias) | Postgres only |
| **Write nugget** (`kind: 'project'`) | SQLite + async PG push | Postgres fallback |
| **Write nugget** (`kind: 'user'`/`'agent'`) | Always Postgres | Always Postgres |
| **Delete/Update memory** | SQLite (via `source_project`) | Postgres |

## Key Constraints

- **Database schema (`ide_agent_memory`)**: Must maintain `project` and `tags` columns added via dynamic migration. Do NOT alter the column order or types — backward compatibility with existing episodic records is critical.
- **pg-git dependency**: All DB pooling and embedding logic is imported from the sibling `pg-git` project via `file:` link in `package.json`. This project has NO `.env` of its own — it inherits `pg-git/.env` configuration.
- **Ollama models**: Embeddings use `bge-large` (1024 dims). Tag generation uses `llama3.2` for keyword extraction. Both are dispatched through a shared LLM queue at `../../../lib/llm-queue.js`.
- **Memory categories**: Only 5 valid values: `priorities`, `bugs`, `outcomes`, `lessons`, `activity`. Using any other category name will fail silently or error.
- **Strict Project Isolation**: For `search_code` and `deep_search`, if the `project` argument is provided, it must EXACTLY match a known repository name. The server will throw an error rather than falling back to a global codebase search.
- **Nugget kinds**: Only 3 valid values: `project`, `user`, `agent`.
- **Temporal decay**: Search results are weighted by `similarity × e^(-0.01 × age_in_days)`. A memory's relevance drops ~26% after 30 days of inactivity.

## Source Files

| File | Responsibility |
|------|---------------|
| `src/index.js` | MCP server entry point — tool registration, routing, DB migration, codebase/docs/health tools |
| `src/memory-engine.js` | Episodic memory CRUD (add, search, list, delete, update, consolidate, compile_state) |
| `src/v2-engine.js` | Company Brain v2 substrate (write_state, resolve_conflict, provenance, ontology, lens, graph, link_blob) |
| `src/nuggets-engine.js` | Holographic Nuggets CRUD (remember, nudges, forget, list) with hybrid SQLite/Postgres routing |
| `src/sqlite-engine.js` | Lakebase SQLite layer — project DB init, pull/push sync, cosine similarity helper |
| `src/llm-tags.js` | Shared LLM tag generation helper (used by memory-engine + v2-engine) |

## Tool Surface (26 tools)

| Tool | Source | Key Parameters |
|------|--------|---------------|
| `krusch_context_add_memory` | `memory-engine.js` | `category`★, `content`★, `project`, `tags` |
| `krusch_context_search_memory` | `memory-engine.js` | `category`★, `query`★, `limit`, `active_project` |
| `krusch_context_list_memories` | `memory-engine.js` | `category`★, `project`, `limit` |
| `krusch_context_delete_memory` | `memory-engine.js` | `id`★, `source_project` |
| `krusch_context_update_memory` | `memory-engine.js` | `id`★, `content`, `tags`, `project`, `source_project` |
| `krusch_context_consolidate` | `memory-engine.js` | `category`★, `project`, `threshold`, `dry_run` |
| `krusch_context_compile_state` | `memory-engine.js` | `project`★ |
| `krusch_context_write_state` | `v2-engine.js` | `content`★, `category`★, `author_id`★, `parent_id`, `source_ref`, `ontology_tags` |
| `krusch_context_resolve_conflict` | `v2-engine.js` | `conflict_ids`★, `resolution_content`★, `author_id`★ |
| `krusch_context_get_provenance` | `v2-engine.js` | `memory_id`★ |
| `krusch_context_update_ontology` | `v2-engine.js` | `old_tag`★, `new_tag`★ |
| `krusch_context_search_lens` | `v2-engine.js` | `query`★, `roles`★, `limit`, `status` |
| `krusch_context_traverse_graph` | `v2-engine.js` | `memory_id`★, `direction`, `depth` |
| `krusch_context_link_blob` | `v2-engine.js` | `memory_id`★, `blob_id`★, `relationship`★ |
| `krusch_context_search_code` | `index.js` → `pg-git` | `query`★, `limit`, `project`, `repository_id` |
| `krusch_context_list_repos` | `index.js` → `pg-git` | *(none)* |
| `krusch_context_read_tree` | `index.js` → `pg-git` | `repository_id`★, `tree_id` |
| `krusch_context_read_blob` | `index.js` → `pg-git` | `blob_id`★ |
| `krusch_context_deep_search` | `index.js` (composite) | `query`★, `project` |
| `krusch_context_health_check` | `index.js` | *(none)* |
| `krusch_docs_list` | `index.js` | *(none)* |
| `krusch_docs_search` | `index.js` | `manual_name`★, `query`★, `limit` |
| `krusch_context_nugget_remember` | `nuggets-engine.js` | `key`★, `value`★, `kind`, `active_project` |
| `krusch_context_nugget_nudges` | `nuggets-engine.js` | `query`★, `kinds`, `limit`, `active_project` |
| `krusch_context_nugget_forget` | `nuggets-engine.js` | `key`★, `active_project` |
| `krusch_context_nugget_list` | `nuggets-engine.js` | `kinds`, `active_project` |

> ★ = required parameter

## Project Structure

```
krusch-context-mcp/
├── src/
│   ├── index.js              # MCP server entry — tool registration & routing
│   ├── memory-engine.js      # Episodic memory CRUD + consolidation (v1)
│   ├── v2-engine.js          # Company Brain v2 substrate (write, resolve, lens, graph, link)
│   ├── nuggets-engine.js     # Holographic Nuggets CRUD
│   ├── sqlite-engine.js      # Lakebase SQLite layer (pull/push sync)
│   ├── llm-tags.js           # Shared LLM tag generation (Ollama llama3.2)
│   └── telemetry.js          # OpenTelemetry JSONL trace exporter
├── scripts/
│   ├── action_memory_pattern_match.js  # Proactive escalation detection
│   ├── benchmark_latency.js  # Embedding + search latency measurement
│   ├── clear_sqlite_embeddings.js  # Reset local SQLite embedding columns
│   ├── eval_accuracy.js      # Retrieval precision/recall evaluation
│   ├── halo_analysis.js      # Nightly HALO tracing and agent performance analysis
│   ├── install_git_hook.js   # Post-commit hook installer for Lakebase auto-sync
│   ├── spectral_calibration.js     # Embedding space quality analysis
│   └── stress_test_consolidation.js # Synthetic consolidation stress test
├── tests/                    # *.test.js = npm test, test_*.js = manual smoke
│   ├── memory-engine.test.js # Integration tests (pg-git + consolidation + v2 write/resolve)
│   ├── lakebase.test.js      # Lakebase pull/push sync verification
│   ├── sqlite-memory.test.js # SQLite memory engine isolation tests
│   ├── test_client.js        # Smoke test for all 26 tools via JSON-RPC
│   ├── test_v2_memory.js     # Company Brain v2 multi-agent write + conflict resolution
│   ├── test_v2_lens_graph.js  # Lens-based retrieval + graph traversal
│   └── test_v2_action_memory.js # Action Memory graph + commitment compilation
├── docs/
│   ├── assets/               # Banner and documentation images
│   └── TOOL_REFERENCE.md     # Full parameter reference for all 26 tools
├── data/
│   └── traces.jsonl          # OpenTelemetry tool execution traces
├── spec.md                   # Original project specification
├── INFLIGHT.md               # Session state persistence
└── package.json              # ESM, file: link to pg-git
```

## Fragile / Don't Touch

- `ide_agent_memory` column migrations in `verifyDatabase()` — these are idempotent guards; removing them breaks fresh installs
- The `_embedding` internal parameter on `searchMemory`/`addMemory` — used for dedup optimization in `krusch_context_deep_search` (generates one embedding, shares across 6 queries)
- `pg-git/lib/embedding.js:8` — LLM queue import uses fragile relative path `../../../lib/llm-queue.js` (root monorepo). Re-exported as `ollamaQueue` and `PRIORITY` for downstream consumers.
- `src/sqlite-engine.js:25` — `projectsRoot` is resolved relative to `__dirname`. Moving the project folder changes which sibling directories are discoverable for project SQLite DBs.

## Dependencies

| Package | Purpose |
|---------|---------|
| `@modelcontextprotocol/sdk` | MCP protocol server + types |
| `@opentelemetry/api` / `sdk-trace-node` | Tool execution tracing for HALO analysis |
| `better-sqlite3` | Local project SQLite databases (Lakebase compute cache) |
| `ml-pca` | PCA for spectral calibration scripts |
| `pg-git` (file: link) | Shared DB pool, embedding pipeline, blob/tree/repo search |

> **Transitive**: `pg`, `pgvector`, Ollama HTTP client — all provided by `pg-git`.

## Common Operations

```bash
# Start the server
npm start

# Run automated test suite (3 test files, 13 tests)
npm test

# Run stdio-based smoke tests (spawns full MCP server)
npm run test:smoke

# Smoke test all 26 tools against live kruschdb
node tests/test_client.js

# Benchmark embedding + search latency
node scripts/benchmark_latency.js

# Sync this project's codebase into pg-git
node ../pg-git/scripts/sync_to_pg.js .
```

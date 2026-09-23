# ⚙️ Setup & Operations Guide

> Detailed configuration, storage internals, agent lifecycle workflows, and troubleshooting.
>
> For a high-level overview, see the [README](../README.md).

---

## Configuration

Krusch Context MCP operates with its own native, zero-dependency PostgreSQL connection pool (`db/pool.js`) and shares database schema compatibility with [PG-Git-MCP](https://github.com/kruschdev/pg-git-mcp). Create a `.env` file in the project root:

```bash
cp .env.example .env
```

| Variable | Description | Default |
|----------|-------------|---------|
| `KRUSCH_PROFILE` | Tool exposure profile (`core`, `extended`, `sovereign`) | `core` |
| `POLYGRES_PROJECT_ID` | Polygres Cloud project identifier (auto-configures runtime & usage tools) | *(none)* |
| `POLYGRES_RUNTIME_URL` | Polygres Cloud Runtime REST API endpoint (`https://<id>.api.db.polygres.com/v1`) | *(none)* |
| `POLYGRES_API_KEY` | Polygres Cloud authentication API key | *(none)* |
| `DATABASE_URL` | PostgreSQL connection string (Polygres Cloud SSL or local PostgreSQL) | *(required)* |
| `OLLAMA_URL` | Primary Ollama endpoint (Local fallback if cloud embeddings are omitted) | `http://localhost:11434` |
| `OLLAMA_FLEET_URLS` | Comma-separated additional Ollama endpoints for GPU fleet load balancing | *(none)* |
| `EMBED_MODEL` | Embedding model identifier | `bge-large` |
| `EMBED_DIMS` | Embedding vector dimensions (must match Postgres schema) | `1024` |
| `TAG_MODEL` | Model for tag extraction | `llama3.2` |
| `OPENROUTER_API_KEY` | Turnkey OpenRouter API key for zero-VRAM remote embeddings (`baai/bge-large-en-v1.5`) and completions (`llama-3.2-3b-instruct`) | *(none)* |
| `COMPLETION_URL` | Custom OpenAI-compatible completion API URL (e.g., `http://localhost:8080/v1/chat/completions`) | *(none)* |
| `COMPLETION_API_KEY` | Custom API Key for completions (if required) | *(none)* |
| `COMPLETION_MODEL` | Custom model identifier to send to custom completion API | *(none)* |
| `EMBEDDING_URL` | Custom external embedding API URL (OpenAI-compatible `/v1/embeddings` or OpenRouter) | *(none)* |
| `EMBEDDING_API_KEY` | Custom API Key for external embeddings (if required) | *(none)* |
| `EXTERNAL_DOCS_CONFIG_PATH` | Path to JSON config for ingested manuals | `config/external_docs.json` |

---

## Embedding dimensions

All first-party tables (`ide_agent_memory`, `interaction_memory`,
`ide_agent_nuggets`, `blobs`) are created as `VECTOR(1024)`.

| Backend | Model | Dims | Compatible with default schema? |
|---|---|---|---|
| Ollama (default) | `bge-large` | 1024 | Yes |
| OpenRouter / local | `baai/bge-large-en-v1.5` | 1024 | Yes |
| OpenAI / Polygres in-engine | `text-embedding-3-small` | 1536 | No — migrate column + reindex |
| OpenAI / Polygres in-engine | `text-embedding-3-large` | 3072 (default) | No — set `dimensions=1024` if the API allows, or migrate |

Polygres “zero-client” embeddings are convenient, not dimension-compatible
with the local 1024-d schema unless you pin a 1024-d model or migrate
vector columns. Never mix models in one table. To migrate your database between 1024-d and 1536-d:
```bash
# 1. Run the migration script
psql "$DATABASE_URL" -v target_dim=1536 -f db/migrate_dimensions.sql
# 2. Update .env
echo "EMBED_DIMS=1536" >> .env
# 3. Re-embed files
npm run snapshot -- .
```
`krusch_context_health` actively validates that your database vector column dimensions match your configured `EMBED_DIMS` setting on every check.

> [!NOTE]
> **Polygres Cloud + OpenRouter Tagging**: Polygres handles in-engine vectorization and database persistence, but does not provide LLM text generation. For automated episodic memory tagging in a cloud-backed zero-GPU setup, configure `OPENROUTER_API_KEY="sk-or-v1-..."` (defaults to `meta-llama/llama-3.2-3b-instruct`). Without an LLM key, Krusch Context uses deterministic heuristic keyword extraction.

---

## PG-Git Codebase Ingestion & Fleet Synchronization

Krusch Context MCP natively bundles the complete PG-Git engine, eliminating the need to install external sibling packages or configure complex symlinks.

### Ingestion CLI Options

1. **Snapshot Current Project**:
   Recursively parses git trees, extracts AST symbols, builds caller/callee dependency edges, generates chunked centroid embeddings, and indexes content into PostgreSQL `blobs`:
   ```bash
   npm run snapshot -- .
   ```
   Or target any local repository path:
   ```bash
   npm run snapshot -- /path/to/another/repo
   ```

2. **Fleet-Wide Multi-Project Ingestion (`sync-all`)**:
   Iterates through all registered homelab monorepo projects (23+ repositories) in topological order, performing atomic incremental snapshots into the shared database:
   ```bash
   npm run sync-all
   ```

3. **Automatic Git Post-Commit Hook**:
   Installs an autonomous post-commit hook in `.git/hooks/post-commit` that triggers a background snapshot after every commit:
   ```bash
   node scripts/install_git_hook.js
   ```

### Sibling Interoperability with Standalone PG-Git

Because Krusch Context MCP and standalone [PG-Git](https://github.com/kruschdev/pg-git) (`pg-git-mcp@1.1.0`) share the exact same PostgreSQL schema (`repositories`, `blobs`, `code_symbols`, `code_symbol_edges`, `trees`, `commits`, `branches`), you can:
- Ingest repositories using `npm run snapshot` in `krusch-context-mcp`.
- Query those same repositories using standalone `pg-git` tools (`pg_git_search_code`, `pg_git_search_symbols`, `pg_git_dependency_graph`) in single-purpose IDE setups.
- Use Krusch Context MCP for comprehensive, unified context orchestration (episodic memory + codebase search + AST symbols + holographic steering + proactive trajectory auditing) in daily pair-programming sessions.

While Ollama is the default choice to minimize setup friction (it manages model caching, GPU VRAM offloading, and on-demand model concurrency/swapping), you can route requests to any OpenAI-compatible API or local server (like `llama.cpp`'s `llama-server`, LM Studio, or vLLM).

If `COMPLETION_URL` is set, the server will route tag extraction, proactive trajectory auditing, and semantic reasoning (`think`) through the custom OpenAI completion endpoint.
If `EMBEDDING_URL` is set, the server will bypass the local Ollama embedding queue and post directly to the custom endpoint, automatically handling standard `/v1/embeddings` (OpenAI format) and raw `/embedding` (llama.cpp native format) response schemas.


---

## Storage Routing

Understanding where data lives is critical for querying correctly.

### Write Path

| Operation | `project` provided | `project` omitted |
|-----------|-------------------|-------------------|
| `add_memory` | SQLite → async push to Postgres | Postgres directly |
| `nugget_remember` (`kind: 'project'`) | SQLite → async push to Postgres | Postgres fallback |
| `nugget_remember` (`kind: 'user'`/`'agent'`) | Always Postgres | Always Postgres |

### Read Path

| Operation | `active_project` provided | `active_project` omitted |
|-----------|--------------------------|--------------------------| 
| `search_memory` | Merge: SQLite + Postgres (SQLite gets +0.3 bias) | Postgres only |
| `deep_search` | All 5 categories + codebase blobs | All 5 categories + codebase blobs |

### Key Rules

1. **`project` on writes** → routes to SQLite; omitting → routes to Postgres
2. **`active_project` on reads** → merges SQLite + Postgres; omitting → Postgres only
3. **`source_project` on deletes/updates** → targets SQLite; omitting → targets Postgres
4. **Nuggets `kind: 'project'`** → need `active_project` to resolve the SQLite DB
5. **Nuggets `kind: 'user'`/`'agent'`** → always global Postgres

### Memory Categories (Episodic Memory)

For a detailed analysis of episodic memory implementation, scoring, and storage flow, see the [Episodic Memory Guide](EPISODIC_MEMORY.md).

| Category | When to Use |
|----------|-------------|
| `priorities` | Current goals, roadmap items, task alignment |
| `bugs` | Bug reports, root causes, workarounds, fixes |
| `outcomes` | Session summaries, deployment results |
| `lessons` | Architectural decisions, pattern discoveries, "never do this" rules |
| `activity` | Session-level work logs |
| `alignment_signal` | Logs developer/agent feedback for proactive nudges to capture alignment signals |

### Nugget Kinds

| Kind | Scope | Storage | When to Use |
|------|-------|---------|-------------|
| `project` | Per-project | SQLite + async PG push | Project conventions, local patterns |
| `user` | Global | Postgres | Personal preferences, coding style |
| `agent` | Global | Postgres | Agent behavioral tuning, self-corrections |

---

## The Autonomous Agent Lifecycle

Krusch Context MCP enables **infinite session continuity** through four lifecycle workflows:

### `/open` — Start the Day
1. Load priorities and yesterday's outcomes via `search_memory`
2. Retrieve behavioral nudges via `nugget_nudges`
3. Verify codebase understanding via `search_code`

### `/close` — Pause Work
1. Snapshot the codebase into database `blobs`
2. Save session state to `INFLIGHT.md`
3. Commit decisions to long-term memory via `add_memory`
4. Persist behavioral patterns via `nugget_remember`

### `/continue` — Resume Work
1. Load `INFLIGHT.md` for active task state
2. Retrieve relevant memories via `search_memory`
3. Load nudges and verify codebase state hasn't drifted

### `/sweetdreams` — Nightly Consolidation
1. Re-index all project codebases into `blobs`
2. Optimize B-Tree and HNSW indexes
3. Queue overnight analysis for the execution swarm

### `INFLIGHT.md` Template

```markdown
# Project Name - Session State

**Status**: In Progress | Stable | Blocked
**Last Updated**: YYYY-MM-DD

## Current State
- Brief summary of what was accomplished this session.

## Fragile Files / Transient State
- Files or state that must not be touched without understanding context.

## Pending / Next Steps
- [ ] Next task 1
- [ ] Next task 2
```

---

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| Ollama API returned 404 | Embedding model not pulled | `ollama pull bge-large && ollama pull llama3.2` |
| ECONNREFUSED on Ollama URL | Ollama not running | `ollama serve` or switch to default Polygres in-engine embeddings |
| Cannot reach PostgreSQL | Database unreachable or `.env` misconfigured | Verify `DATABASE_URL` in `.env` (ensure `sslmode=require` on Polygres) |
| Column "project" does not exist | Table predates schema migration | Restart the server (idempotent migrations run on boot) |
| `VECTOR_CONFIGURATION_NOT_FOUND` on Polygres | Collection missing vector configuration | Run `polygres_cloud_models` or create collection config via Polygres console |
| `MISSING_API_KEY` on `polygres_cloud_*` | Polygres API key not configured in `.env` | Set `POLYGRES_API_KEY` and `POLYGRES_PROJECT_ID` in `.env` |


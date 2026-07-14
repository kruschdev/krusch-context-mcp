# ⚙️ Setup & Operations Guide

> Detailed configuration, storage internals, agent lifecycle workflows, and troubleshooting.
>
> For a high-level overview, see the [README](../README.md).

---

## Configuration

Krusch Context MCP inherits its database pool from [PG-Git-MCP](https://github.com/kruschdev/pg-git-mcp). Create a `.env` file in the project root:

```bash
cp .env.example .env
```

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string (e.g., `postgresql://user:pass@host:port/kruschdb`) | *(required)* |
| `OLLAMA_URL` | Primary Ollama endpoint | `http://localhost:11434` |
| `OLLAMA_FLEET_URLS` | Comma-separated additional Ollama endpoints for GPU fleet load balancing | *(none)* |
| `EMBED_MODEL` | Ollama embedding model | `bge-large` |
| `TAG_MODEL` | Ollama model for tag extraction | `llama3.2` |
| `EXTERNAL_DOCS_CONFIG_PATH` | Path to JSON config for ingested manuals | `pg-git/config/external_docs.json` |

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

### Memory Categories

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
1. Snapshot the codebase into `kruschdb.blobs`
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
| ECONNREFUSED on Ollama URL | Ollama not running | `ollama serve` or verify fleet node availability |
| Cannot reach PostgreSQL | `kruschdb` unreachable or `.env` misconfigured | Verify `DATABASE_URL` in `.env` |
| Column "project" does not exist | Table predates schema migration | Restart the server (idempotent migrations run on boot) |

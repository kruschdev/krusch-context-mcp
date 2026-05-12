<p align="center">
  <img src="docs/assets/banner.png" alt="Krusch Context MCP" width="800" />
</p>

<p align="center">
  <strong>Unified IDE context engine that merges semantic codebase search with episodic project memory into a single MCP server.</strong>
</p>

[![Version](https://img.shields.io/github/package-json/v/kruschdev/krusch-context-mcp.svg)](https://github.com/kruschdev/krusch-context-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
![Node](https://img.shields.io/badge/Node.js-22+-green.svg)
![Ollama](https://img.shields.io/badge/Ollama-bge--large-blue.svg)
![DB](https://img.shields.io/badge/Database-PostgreSQL%20%2B%20pgvector-lightgrey.svg)

---

## The Problem

Every time you start a new AI coding session, your agent starts from zero. It doesn't remember the bug you fixed yesterday, the architectural decision you made last week, or even what files exist in your project. You end up re-explaining context, watching it hallucinate stale assumptions, and losing momentum to the "goldfish memory" problem.

**Krusch Context MCP fixes this.** It gives your AI coding agent persistent, searchable memory across every session — paired with semantic search over your entire codebase — so your agent always knows *what* your code does, *why* you built it that way, and *what went wrong last time*.

## What It Does

A single [Model Context Protocol](https://modelcontextprotocol.io/) server exposing **26 tools** to any MCP-compatible IDE agent (Cursor, Claude Code, Windsurf, Gemini CLI, etc.):

| Capability | What It Provides |
|-----------|-----------------|
| 🔍 **Semantic Codebase Search** | Search the *meaning* of your code, not just filenames. "How do we handle auth?" returns the actual implementation. |
| 🧠 **Episodic Memory** | Bugs, decisions, and lessons persist across sessions, retrieved by semantic relevance with temporal decay. |
| 💎 **Steering Nudges** | Lightweight key-value facts (preferences, conventions) give the agent behavioral continuity without re-prompting. |
| 📖 **Documentation Search** | Ingested external docs are searchable locally — your agent references *your* versions, not its training data. |
| 🌍 **Zero-Trust Deep Search** | One tool call cross-references codebase reality with historical memory to verify understanding before acting. |

## Why You'd Want It

### 🛡️ Everything Stays On Your Hardware

All embeddings are generated locally via [Ollama](https://ollama.com/) (`bge-large` for vectors, `llama3.2` for tagging). Storage is local PostgreSQL + pgvector + SQLite. Nothing leaves your machine — zero API costs for context retrieval, full data sovereignty, no provider lock-in.

### 🔄 Switch Models Without Losing Context

Memory and codebase context are decoupled from the reasoning engine. Swap between Gemini, Claude, GPT-4o, or local models mid-project — every model inherits the same memories, codebase search, and nudges. Your project history outlives any individual chat session.

### ⚡ One Server, Not Three

This used to require separate MCP servers for memory, codebase search, and nuggets. Krusch Context MCP collapses all of it into a single process with a shared connection pool and embedding pipeline.

---

## 📦 Quick Start

**Prerequisites:**
- [Node.js](https://nodejs.org/) 22+
- [Ollama](https://ollama.com/) running with `bge-large` and `llama3.2` models pulled
- PostgreSQL with the [`pgvector`](https://github.com/pgvector/pgvector) extension enabled
- **PG-Git-MCP** — Krusch Context MCP imports database pooling and embedding logic from the `pg-git-mcp` package. You must provide a `.env` file to configure the PostgreSQL pool. The server **will fail to start** if the database is unreachable.

**1. Install PG-Git-MCP** (codebase ingestion engine):
```bash
npm install -g pg-git-mcp
# Follow pg-git-mcp docs to index your codebase before starting
```

**2. Install Krusch Context MCP:**
```bash
git clone https://github.com/kruschdev/krusch-context-mcp.git
cd krusch-context-mcp
npm install
cp .env.example .env  # Configure your database connection
```

**3. Start:**
```bash
npm start
```

**4. Add to your IDE MCP settings** (e.g., `claude_desktop_config.json`, `.cursor/mcp.json`):
```json
{
  "mcpServers": {
    "krusch-context-mcp": {
      "command": "node",
      "args": ["/path/to/krusch-context-mcp/src/index.js"]
    }
  }
}
```

**5. Restart your IDE.** Your agent now has access to all 26 tools.

### Upgrading to Company Brain v2

```bash
git pull origin main && npm install && npm start
```

The server runs idempotent database migrations on startup. It will create the new `homelab_memory_v2` tables without touching existing data.

---

## 🧠 Architecture

```mermaid
graph TD;
    A[Agent Tool Call] --> B{Krusch Context MCP};
    B -- Semantic Code Search --> C[(PG-Git: blobs)];
    B -- Read/Write --> D[(SQLite Compute Cache: .agent/memory.db)];
    B -- Read/Write --> E[(Postgres Object Storage: ide_agent_memory)];
    
    %% Lakebase Architecture Sync
    D -. Asynchronous Pull/Push .-> E;

    B -- Deep Search --> C;
    B -- Deep Search --> D;
    B -- Deep Search --> E;
    F[Ollama Fleet] -. embeddings .-> B;
```

| Component | Details |
|-----------|---------|
| **Database** | Hybrid: Local SQLite (project memories) + PostgreSQL (global & codebase) |
| **Embeddings** | Ollama `bge-large` @ 1024 dims, fleet load-balanced |
| **Tagging** | Ollama `llama3.2` for automatic keyword extraction |
| **Tables** | `blobs` (codebase), `ide_agent_memory` (episodic), `homelab_memory_v2` (Company Brain v2), `ide_agent_nuggets` (steering facts) |
| **Protocol** | MCP stdio transport |
| **Temporal Decay** | `score = similarity × e^(-0.01 × age_days)` — relevance drops ~26% after 30 days |

### Key Design Decisions

- **📌 Lakebase Architecture** — Inspired by [Neon's decoupled compute/storage](https://neon.com/docs/introduction/architecture-overview): local SQLite for zero-latency reads, async write-behind to durable PostgreSQL. A `+0.3` local scoring bias mitigates Ebbinghaus forgetting as the global corpus grows.
- **🏷️ Hybrid Retrieval** — Memories are auto-tagged via `llama3.2`, addressing pure-cosine failure modes (negation, numeric, role-swap) identified by [Sentra](https://sentra.app).
- **♻️ Consolidation** — Semantic dedup uses L2-normalized centroid averaging without re-embedding. *From [Geometry of Consolidation](https://github.com/niashwin/geometry-of-consolidation).*
- **🛡️ RAG Resilience** — Architected to avoid hubness and dimensional collapse failure modes. *Guided by [Sentra: Geometry of Failure](https://github.com/niashwin/sentra-rag-failure-modes).*
- **💎 Holographic Nuggets** — Adapted from [NeoVertex1/nuggets](https://github.com/NeoVertex1/nuggets) for lightweight steering facts.

### Sentra Memory Substrate Blueprint

This architecture implements the three layers of organizational memory defined in the [Sentra Company Brain research](https://sentra.app):

1. **Factual Memory (Layer 1):** Raw codebase state (`blobs`) and episodic events (`ide_agent_memory`). Answers "what happened" and "what is the code."
2. **Interaction Memory (Layer 2):** The v2 Company Brain substrate (`homelab_memory_v2`) with parent-child UUID lineage, attribution, conflict resolution, and ontology tagging. Answers "why did this happen."
3. **Action Memory (Layer 3):** Agents autonomously compile project state and traverse the context graph to determine next actions without human intervention.

---

## 🚀 Usage Examples

### Episodic Memory

> **You:** "That fixed the port conflict! Save this."  
> **Agent:** *[`add_memory`]* "Saved to 'bugs': port 5441 conflicts with legacy DB, use 5442."

> **You:** "How did we structure the auth system?"  
> **Agent:** *[`search_memory`]* "From 'lessons': chose singleton JWT factory to avoid circular dependencies."

### Codebase Search

> **You:** "How does our auth middleware work?"  
> **Agent:** *[`search_code`]* "Found 3 files — here's the implementation in `lib/auth.js`..."

### Zero-Trust Verification

> **You:** "Before we start, verify what you know about the DB schema."  
> **Agent:** *[`deep_search`]* "Cross-referencing codebase + memory — schema uses pgvector 1024 dims, last session added the `tags` column."

### State Hydration (Contextmaxxing)

> **You:** "Let's start working on krusch-context-mcp."  
> **Agent:** *[`compile_state`]* "Compiled project state: top priority is Contextmaxxing, recent outcomes show a DB bug fix, 3 nudges loaded."

### Steering Nudges

> **You:** "Always use `const` over `let` in this project."  
> **Agent:** *[`nugget_remember`]* "Saved: `coding-style:const-over-let`."

> **You:** "Remind yourself of our conventions before coding."  
> **Agent:** *[`nugget_nudges`]* "3 nudges loaded: prefer const, use JSDoc on exports, 40-line function limit."

### Company Brain v2

> **You:** "Let's standardize on UUIDs for memory IDs."  
> **Agent:** *[`write_state`]* "Wrote decision to 'lessons' with author attribution. Lineage started."

> **You:** "The previous agent was wrong about the database port."  
> **Agent:** *[`resolve_conflict`]* "Merged conflicting states. Deprecated old branches, created unified resolution."

---

## 🤖 Agent Integration Patterns

### Pattern 1: Zero-Trust Session Start

```
1. deep_search({ query: "<topic>", project: "<project>" })
   → Verify codebase + memory in one call

2. nugget_nudges({ query: "<task>", active_project: "<project>" })
   → Load conventions and preferences
```

### Pattern 2: Bug Investigation

```
1. search_memory({ category: "bugs", query: "<symptoms>" })     → Check history
2. search_code({ query: "<error>", project: "<project>" })      → Find implementation
3. [Fix the bug]
4. add_memory({ category: "bugs", content: "<root cause + fix>" }) → Document
```

### Pattern 3: Session Close

```
1. add_memory({ category: "activity", content: "<summary>", project: "<project>" })
2. add_memory({ category: "outcomes", content: "<decisions and results>" })
3. nugget_remember({ key: "<project>:last-session", value: "<in-progress work>" })
4. consolidate({ category: "activity", project: "<project>", dry_run: true })
   → Preview and optionally merge duplicate logs
```

### Pattern 4: Multi-Agent State Resolution

```
1. write_state({ content: "<decision>", category: "lessons", author_id: "agent:a" })
2. write_state({ content: "<conflicting decision>", author_id: "agent:b" })
3. search_lens({ query: "<topic>", roles: ["system"] })         → Detect conflicts
4. resolve_conflict({ conflict_ids: ["<uuid-a>", "<uuid-b>"], resolution_content: "<truth>" })
5. get_provenance({ memory_id: "<resolution-uuid>" })           → Audit trail
```

---

## 🗂️ Tool Quick-Reference

> For full parameter details, defaults, and examples, see the [Complete Tool Reference](docs/TOOL_REFERENCE.md).

| Tool | Description |
|------|-------------|
| **Episodic Memory** | |
| `krusch_context_add_memory` | Store an episodic memory (bug, lesson, priority, outcome, activity) |
| `krusch_context_search_memory` | Semantic search with temporal decay |
| `krusch_context_list_memories` | List recent memories by category (no embedding, fast) |
| `krusch_context_delete_memory` | Delete a memory by ID |
| `krusch_context_update_memory` | Update content/tags/project (re-embeds on content change) |
| `krusch_context_consolidate` | Find and merge semantically duplicate memories |
| `krusch_context_compile_state` | Contextmaxxing — compile full project state into Markdown |
| **Company Brain v2** | |
| `krusch_context_write_state` | Stateful write with concurrency control and author attribution |
| `krusch_context_resolve_conflict` | Merge conflicting sibling states into a unified resolution |
| `krusch_context_get_provenance` | Trace version history and state lineage |
| `krusch_context_update_ontology` | Rename ontology tags across all active v2 memories |
| `krusch_context_search_lens` | Role-filtered semantic retrieval |
| `krusch_context_traverse_graph` | Navigate parent/child lineage and linked codebase blobs |
| `krusch_context_link_blob` | Link a memory state to a codebase file blob |
| **Codebase Search** | |
| `krusch_context_search_code` | Semantic search over all indexed codebase files |
| `krusch_context_list_repos` | List all repositories indexed in PG-Git |
| `krusch_context_read_tree` | Browse the file tree of an indexed repository |
| `krusch_context_read_blob` | Read full content of a file by blob ID |
| `krusch_context_deep_search` | Composite zero-trust search across memory and codebase |
| **Nuggets (Steering Facts)** | |
| `krusch_context_nugget_remember` | Store a short, durable steering fact |
| `krusch_context_nugget_nudges` | Return relevant nudges to steer agent behavior |
| `krusch_context_nugget_forget` | Delete a nugget by key |
| `krusch_context_nugget_list` | List all saved nuggets |
| **Documentation & System** | |
| `krusch_docs_list` | List available external manuals |
| `krusch_docs_search` | Semantically search an external manual |
| `krusch_context_health_check` | Verify server connectivity and status |

---

## 🧭 Storage Routing

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

### Nugget Kinds

| Kind | Scope | Storage | When to Use |
|------|-------|---------|-------------|
| `project` | Per-project | SQLite + async PG push | Project conventions, local patterns |
| `user` | Global | Postgres | Personal preferences, coding style |
| `agent` | Global | Postgres | Agent behavioral tuning, self-corrections |

---

## 🤖 The Autonomous Agent Lifecycle

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

## ⚙️ Configuration

Krusch Context MCP inherits configuration from `pg-git-mcp` but requires its own `.env` file for database credentials.

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string (e.g., `postgresql://user:pass@host:port/kruschdb`) | *(required)* |
| `OLLAMA_URL` | Primary Ollama endpoint | `http://localhost:11434` |
| `OLLAMA_FLEET_URLS` | Comma-separated additional Ollama endpoints for GPU fleet load balancing | *(none)* |
| `EMBED_MODEL` | Ollama embedding model | `bge-large` |
| `TAG_MODEL` | Ollama model for tag extraction | `llama3.2` |
| `EXTERNAL_DOCS_CONFIG_PATH` | Path to JSON config for ingested manuals | `pg-git/config/external_docs.json` |

### Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| Ollama API returned 404 | Embedding model not pulled | `ollama pull bge-large && ollama pull llama3.2` |
| ECONNREFUSED on Ollama URL | Ollama not running | `ollama serve` or verify fleet node availability |
| Cannot reach PostgreSQL | `kruschdb` unreachable or `.env` misconfigured | Verify `DATABASE_URL` in `.env` |
| Column "project" does not exist | Table predates schema migration | Restart the server (idempotent migrations run on boot) |

---

## 📂 Project Structure

```
krusch-context-mcp/
├── src/
│   ├── index.js              # MCP server entry point — tool registration & dispatch
│   ├── memory-engine.js      # Episodic memory CRUD + consolidation (v1)
│   ├── v2-engine.js          # Company Brain v2 substrate (write, resolve, lens, graph, link)
│   ├── nuggets-engine.js     # Holographic Nuggets CRUD (remember, nudges, forget, list)
│   ├── sqlite-engine.js      # Lakebase SQLite layer (project DB init, pull/push sync)
│   └── llm-tags.js           # Shared LLM tag generation (Ollama llama3.2)
├── scripts/
│   ├── action_memory_pattern_match.js  # Proactive escalation detection
│   ├── benchmark_latency.js            # Embedding + search latency measurement
│   ├── clear_sqlite_embeddings.js      # Reset local SQLite embedding columns
│   ├── eval_accuracy.js                # Retrieval precision/recall evaluation
│   ├── install_git_hook.js             # Post-commit hook for Lakebase auto-sync
│   ├── spectral_calibration.js         # Embedding space quality analysis
│   └── stress_test_consolidation.js    # Synthetic consolidation stress test
├── tests/                    # *.test.js = npm test, test_*.js = manual smoke
│   ├── memory-engine.test.js       # Integration tests
│   ├── lakebase.test.js            # Pull/push sync verification
│   ├── sqlite-memory.test.js       # SQLite isolation tests
│   ├── test_client.js              # Smoke test for all 26 tools
│   ├── test_v2_memory.js           # v2 write + conflict resolution
│   ├── test_v2_lens_graph.js       # Lens retrieval + graph traversal
│   └── test_v2_action_memory.js    # Action Memory + commitment compilation
├── docs/
│   ├── assets/               # Banner and documentation images
│   ├── research/             # Sentra Company Brain research essays
│   └── TOOL_REFERENCE.md     # Full parameter reference for all 26 tools
├── spec.md                   # Original project specification
└── package.json              # ESM configuration
```

---

## 🧪 Testing

**Automated** (`npm test`) — uses `node:test`, runs all `*.test.js` files:
```bash
npm test
```

**Manual Smoke** (`npm run test:smoke`) — JSON-RPC stdio tests that spawn the full MCP server:
```bash
npm run test:smoke
```

**All 26 tools against live DB:**
```bash
node tests/test_client.js
```

**Benchmarking & Evaluation:**
```bash
node scripts/benchmark_latency.js       # End-to-end latency
node scripts/eval_accuracy.js           # Precision/recall
node scripts/spectral_calibration.js    # Embedding space health
```

> **Convention:** `*.test.js` = automated tests. `test_*.js` = stdio smoke tests.

---

## 🗺️ Related Projects

| Project | Role |
|---------|------|
| PG-Git | Semantic codebase search engine (sibling dependency) |
| [Krusch Memory MCP](https://github.com/kruschdev/krusch-memory-mcp) | Legacy standalone episodic memory (superseded by this project) |
| [Krusch Sequential MCP](https://github.com/kruschdev/krusch-sequential-mcp) | Sequential thinking with PG persistence |
| [Krusch Cascade Router](https://github.com/kruschdev/krusch-cascade-router) | Automated LLM inference routing and gateway |
| [NeoVertex Nuggets](https://github.com/NeoVertex1/nuggets) | Original Holographic Nuggets architecture |
| [Context Labs HALO](https://github.com/context-labs/halo) | RLM-based tracing engine |

---

## 🙏 Acknowledgments

The evolution from a simple RAG cache to a stateful **Company Brain Substrate** is deeply inspired by the [Sentra "Company Brain" Essay Series](https://sentra.app). We recommend reading their work on why organizational memory is an infrastructure problem.

## 🤝 Contributing

We welcome contributions! Please ensure your tests pass and adhere to the project formatting standards.

## 📄 License

MIT License © 2026 [kruschdev](https://github.com/kruschdev)

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

**🛡️ Everything stays on your hardware** — All embeddings via local [Ollama](https://ollama.com/) (`bge-large` + `llama3.2`). Storage is PostgreSQL + pgvector + SQLite. Zero API costs, full data sovereignty.

**🔄 Switch models without losing context** — Memory is decoupled from the reasoning engine. Swap between Gemini, Claude, GPT-4o, or local models mid-project — every model inherits the same context.

**⚡ One server, not three** — Codebase search, episodic memory, and steering nuggets in a single process with shared connection pool and embedding pipeline.

---

## Quick Start

**Prerequisites:** [Node.js 22+](https://nodejs.org/) · [Ollama](https://ollama.com/) with `bge-large` and `llama3.2` · PostgreSQL with [`pgvector`](https://github.com/pgvector/pgvector)

```bash
# 1. Install PG-Git-MCP (codebase ingestion engine)
npm install -g pg-git-mcp

# 2. Clone and install
git clone https://github.com/kruschdev/krusch-context-mcp.git
cd krusch-context-mcp
npm install
cp .env.example .env  # Configure your database connection

# 3. Start
npm start
```

Add to your IDE MCP settings (e.g., `.cursor/mcp.json`, `claude_desktop_config.json`):

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

Restart your IDE — your agent now has access to all 26 tools.

> **Upgrading?** `git pull origin main && npm install && npm start` — idempotent migrations run on startup.

---

## Architecture

```mermaid
graph TD;
    A[Agent Tool Call] --> B{Krusch Context MCP};
    B -- Semantic Code Search --> C[(PG-Git: blobs)];
    B -- Read/Write --> D[(SQLite Compute Cache)];
    B -- Read/Write --> E[(Postgres Object Storage)];
    D -. Async Pull/Push .-> E;
    B -- Deep Search --> C;
    B -- Deep Search --> D;
    B -- Deep Search --> E;
    F[Ollama Fleet] -. embeddings .-> B;
```

| Component | Details |
|-----------|---------|
| **Storage** | Hybrid: Local SQLite (per-project) + PostgreSQL (global & codebase) |
| **Embeddings** | Ollama `bge-large` @ 1024 dims, fleet load-balanced |
| **Tagging** | Ollama `llama3.2` for automatic keyword extraction |
| **Temporal Decay** | `score = similarity × e^(-0.01 × age_days)` — relevance drops ~26% after 30 days |

### Key Design Decisions

- **Lakebase Architecture** — Local SQLite for zero-latency reads, async write-behind to durable PostgreSQL. A `+0.3` local scoring bias mitigates Ebbinghaus forgetting as the global corpus grows. *Inspired by [Neon](https://neon.com/docs/introduction/architecture-overview).*
- **Hybrid Retrieval** — Auto-tagged via `llama3.2` to address pure-cosine failure modes (negation, numeric, role-swap). *Per [Sentra](https://sentra.app).*
- **Consolidation** — Semantic dedup via L2-normalized centroid averaging without re-embedding. *From [Geometry of Consolidation](https://github.com/niashwin/geometry-of-consolidation).*
- **Holographic Nuggets** — Lightweight steering facts adapted from [NeoVertex1/nuggets](https://github.com/NeoVertex1/nuggets).

### Company Brain Substrate (v2)

Implements the three-layer organizational memory model from the [Sentra "Company Brain" research](https://sentra.app):

1. **Factual Memory** — Raw codebase state + episodic events → *"what happened"*
2. **Interaction Memory** — Parent-child UUID lineage, attribution, conflict resolution → *"why it happened"*
3. **Action Memory** — Autonomous state compilation and graph traversal → *"what to do next"*

---

## Usage Examples

### Episodic Memory

> **You:** "That fixed the port conflict! Save this."  
> **Agent:** *[`add_memory`]* Saved to 'bugs': port 5441 conflicts with legacy DB, use 5442.

> **You:** "How did we structure the auth system?"  
> **Agent:** *[`search_memory`]* From 'lessons': chose singleton JWT factory to avoid circular dependencies.

### Codebase Search

> **You:** "How does our auth middleware work?"  
> **Agent:** *[`search_code`]* Found 3 files — here's the implementation in `lib/auth.js`...

### Zero-Trust Verification

> **You:** "Before we start, verify what you know about the DB schema."  
> **Agent:** *[`deep_search`]* Cross-referencing codebase + memory — schema uses pgvector 1024 dims, last session added the `tags` column.

### Steering Nudges

> **You:** "Always use `const` over `let` in this project."  
> **Agent:** *[`nugget_remember`]* Saved: `coding-style:const-over-let`.

### Multi-Agent Conflict Resolution

> **You:** "The previous agent was wrong about the database port."  
> **Agent:** *[`resolve_conflict`]* Merged conflicting states. Deprecated old branches, created unified resolution.

---

## Agent Integration Patterns

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
1. add_memory({ category: "outcomes", content: "<decisions and results>" })
2. nugget_remember({ key: "<project>:last-session", value: "<in-progress work>" })
3. consolidate({ category: "activity", project: "<project>", dry_run: true })
```

---

## Tool Quick-Reference

> Full parameter details, defaults, and examples → **[Tool Reference](docs/TOOL_REFERENCE.md)**

| Tool | Description |
|------|-------------|
| **Episodic Memory** | |
| `add_memory` | Store a memory (bug, lesson, priority, outcome, activity) |
| `search_memory` | Semantic search with temporal decay |
| `list_memories` | List recent memories by category |
| `delete_memory` / `update_memory` | CRUD by ID |
| `consolidate` | Merge semantically duplicate memories |
| `compile_state` | Contextmaxxing — compile full project state |
| **Company Brain v2** | |
| `write_state` | Stateful write with concurrency control and attribution |
| `resolve_conflict` | Merge conflicting sibling states |
| `get_provenance` | Trace version history and lineage |
| `search_lens` | Role-filtered semantic retrieval |
| `traverse_graph` | Navigate parent/child lineage and linked blobs |
| `update_ontology` / `link_blob` | Tag management and codebase linking |
| **Codebase Search** | |
| `search_code` | Semantic search over indexed files |
| `deep_search` | Composite zero-trust search (memory + codebase) |
| `list_repos` / `read_tree` / `read_blob` | Browse indexed repositories |
| **Nuggets** | |
| `nugget_remember` / `nugget_nudges` / `nugget_forget` / `nugget_list` | Steering fact CRUD |
| **System** | |
| `docs_list` / `docs_search` | External documentation search |
| `health_check` | Server status verification |

---

## Project Structure

```
krusch-context-mcp/
├── src/
│   ├── index.js              # MCP server entry — tool registration & dispatch
│   ├── memory-engine.js      # Episodic memory CRUD + consolidation
│   ├── v2-engine.js          # Company Brain v2 substrate
│   ├── nuggets-engine.js     # Holographic Nuggets CRUD
│   ├── sqlite-engine.js      # Lakebase SQLite layer (pull/push sync)
│   └── llm-tags.js           # Shared LLM tag generation
├── scripts/                  # Benchmarking, evaluation, and maintenance
├── tests/                    # *.test.js = automated, test_*.js = smoke
├── docs/
│   ├── TOOL_REFERENCE.md     # Full parameter reference for all 26 tools
│   ├── SETUP.md              # Configuration, storage routing, troubleshooting
│   └── research/             # Sentra Company Brain research essays
└── package.json
```

---

## Testing

```bash
npm test                                # Automated (node:test, *.test.js)
npm run test:smoke                      # JSON-RPC stdio smoke tests
node tests/test_client.js               # All 26 tools against live DB
node scripts/benchmark_latency.js       # End-to-end latency
node scripts/eval_accuracy.js           # Precision/recall
```

> **Convention:** `*.test.js` = automated tests · `test_*.js` = stdio smoke tests

---

## Related Projects

| Project | Role |
|---------|------|
| [PG-Git-MCP](https://github.com/kruschdev/pg-git-mcp) | Semantic codebase search engine (sibling dependency) |
| [Krusch Memory MCP](https://github.com/kruschdev/krusch-memory-mcp) | Legacy standalone memory (superseded) |
| [Krusch Sequential MCP](https://github.com/kruschdev/krusch-sequential-mcp) | Sequential thinking with PG persistence |
| [Krusch Cascade Router](https://github.com/kruschdev/krusch-cascade-router) | Automated LLM inference routing |
| [NeoVertex Nuggets](https://github.com/NeoVertex1/nuggets) | Original Holographic Nuggets architecture |

---

## Acknowledgments

The evolution from a simple RAG cache to a stateful **Company Brain Substrate** is deeply inspired by the [Sentra "Company Brain" Essay Series](https://sentra.app). We recommend reading their work on why organizational memory is an infrastructure problem.

## Contributing

We welcome contributions! Please ensure tests pass and adhere to the project formatting standards.

## License

MIT License © 2026 [kruschdev](https://github.com/kruschdev)

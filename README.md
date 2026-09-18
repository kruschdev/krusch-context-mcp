<p align="center">
  <img src="docs/assets/banner.png?v=2" alt="Krusch Context MCP" width="800" />
</p>

<p align="center">
  <a href="https://github.com/kruschdev/krusch-context-mcp"><img src="https://img.shields.io/github/package-json/v/kruschdev/krusch-context-mcp.svg" alt="Version" /></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT" /></a>
  <a href="https://modelcontextprotocol.io/"><img src="https://img.shields.io/badge/MCP-11%20core%20tools-purple.svg" alt="11 core MCP tools" /></a>
  <a href="https://modelcontextprotocol.io/"><img src="https://img.shields.io/badge/tiers-core%2011%20%7C%20extended%2031%20%7C%20full%2064-lightgrey.svg" alt="Expansion tiers" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-22+-green.svg" alt="Node" /></a>
  <a href="https://github.com/pgvector/pgvector"><img src="https://img.shields.io/badge/Database-PostgreSQL%20%2B%20pgvector-lightgrey.svg" alt="Database" /></a>
</p>

**11-tool AI context engine** for coding agents: hybrid codebase retrieval, episodic memory, steering nuggets, and a proactive auditor.

Modular expansion tiers: **core (11, default)** → **extended (31)** → **full (64)**. Do not expose the research suite unless you need it.

---

## ⚡ The Problem: Agent Amnesia & Codebase Disconnect

Every time you start a new AI coding session, your agent starts from absolute zero. It forgets the bug you fixed yesterday, the architectural decisions you made last week, and the dependency graph of your code. You find yourself repeatedly re-explaining context, fighting stale hallucinations, and babysitting LLM loops.

**Krusch Context MCP bridges objective codebase reality with persistent agent memory.**

Operating as a [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server, it provides coding agents (Cursor, Claude Code, Windsurf, Gemini CLI) persistent working memory, zero-trust codebase verification, and automated trajectory protection across sessions.

---

## 🎯 Curated Tool Profiles: No Tool Overload

Exposing dozens of overlapping tools hurts LLM performance: it consumes thousands of prompt tokens per turn and causes tool-selection errors. Krusch Context MCP solves this with **Tool Profiles** (`KRUSCH_PROFILE`):

| Profile | Tools Exposed | Default | System Prompt Cost | Intended Use |
| :--- | :---: | :---: | :---: | :--- |
| **`core`** | **11 tools** | ✅ **Yes** | **~850 tokens** | **Recommended for all agents.** High-signal daily drivers: hybrid retrieval, episodic memory, one-shot state compilation, steering nuggets, symbol search, dependency graph, health, and proactive guardrails. |
| **`extended`** | **31 tools** | ❌ No | ~2,400 tokens | Adds full memory lifecycle (`supersede`, `invalidate`, `consolidate`), Git DAG inspection, agent skills prompt registry, and external docs. |
| **`full`** | **64 tools** | ❌ No | ~4,800 tokens | Power-user & research tier: includes Company Brain v2 substrate, AI Watch experimental modules, and remote Polygres Cloud tools. |

> Direct tool calls to registered handlers always succeed even if omitted from `tools/list`, ensuring complete script and CI compatibility.

---

## 🏛️ Core Capabilities: The 5 Pillars

### 1. 🔍 Unified Hybrid Retrieval (`krusch_context_retrieve`)
* **Single-Call Context Packing**: Combines dense vector similarity with multi-hop graph walks and server-side token budget packing (`limit_tokens`) into a single Markdown payload.
* **Bi-Directional Grounding**: Cross-references subjective episodic memory (lessons, bugs, decisions) alongside objective code blobs and symbols in a single turn.
* **Token Budget Awareness**: Automatically ranks and truncates contextual snippets to prevent prompt overflows.

### 2. 🧩 Structural Codebase Engine & Symbol Graphs
* **Native Git DAG Storage**: Retains Git trees, blobs, commits, and branches in PostgreSQL without requiring loose file scanning.
* **Zero-Dependency Structural Lexer**: Fast regex and brace-matching symbol parser extracting functions, classes, interfaces, and routes across JS, TS, Python, Go, Rust, and Shell without native C++ compilation bindings.
* **Relational Symbol Graphs (`symbol_graph`)**: Walk inbound callers, outbound imports, and transitive dependencies up to $N$ hops.
* **Hybrid RRF Search (`search_code`)**: Merges dense cosine similarity with lexical BM25 (`tsv` GIN index) using Reciprocal Rank Fusion and exponential temporal decay ($e^{-0.01t}$).
* **Standalone Synergy**: 100% schema-compatible with [PG-Git](https://github.com/kruschdev/pg-git) (`pg-git-mcp@1.1.0`), supporting dedicated `pg_git_*` aliases.

### 3. 🧠 Episodic Memory & Steering Nuggets
* **Contextmaxxing (`compile_state`)**: Compiles project state (priorities, active blockers, lessons, steering facts) into a single-shot briefing document.
* **Temporal Superseding & Invalidation**: Supersede outdated rules (`supersede_memory`) and invalidate deprecated invariants (`invalidate_memory`) to eliminate stale knowledge drift.
* **Holographic Steering Nuggets (`nugget_remember`)**: Micro-key-value facts (coding standards, conventions) that steer agent behavior without repetitive system prompt edits.
* **Lakebase Architecture**: Zero-latency reads from per-project local SQLite compute cache (`.agent/memory.db`) backed by durable PostgreSQL object storage.

### 4. 🛡️ Proactive Trajectory Auditing & Alignment Loop
* **Proactive Auditor (`proactive_nudge`)**: Background threat-auditor that flags rule violations, architectural drift, or known regressions before edits execute.
* **Closed-Loop Alignment (`nudge_feedback`)**: Automatically captures developer approvals and corrections to refine future proactive guidance.
* **Trajectory Isolation (`analyze_trajectory`)**: Trace execution paths and isolate the exact turn where an agent diverged from project intent.

### 5. 🔬 Research Substrates & Cloud Runtimes (Full Profile)
* **Company Brain v2 Substrate**: Factual memory, interaction memory with parent-child lineage, conflict resolution (`resolve_conflict`), and role-based lens search.
* **Experimental AI Watch Modules**: Failure observability (AgentDebugX), atomic pipeline DAG mutations (DataFlow), minimal cover reranking (Setwise), deep research convergence (AREX), and teacher trajectory distillation.
* **Polygres Cloud Integration**: Optional zero-GPU cloud backend with in-engine embeddings and managed collections.

---

## 📐 Architecture

```mermaid
graph TD;
    Agent["IDE Agent: Cursor / Claude Code / Windsurf"] --> MCP{"Krusch Context MCP<br/><b>Core: 11 Tools (Default)</b><br/>Full: 64 Tools"};

    subgraph "Storage & Memory Layer"
        MCP -- "Self-Hosted / Local (Primary)" --> PG[("🐘 PostgreSQL + pgvector<br/>• Code Blobs, Trees, Commits<br/>• AST Symbols & Graph Edges<br/>• Episodic Memory & Nuggets")];
        MCP -- "Zero-Latency Cache" --> SQLite[("⚡ Local SQLite Lakebase<br/>.agent/memory.db")];
        MCP -. "Optional Managed Cloud" .-> Polygres["⚡ Polygres Cloud<br/>In-Engine Embeddings"];
    end

    subgraph "Local Embeddings & Models"
        PG --> Ollama["🦙 Local Ollama<br/>• bge-large (1024d vectors)<br/>• llama3.2 (tags & brief)"];
    end

    subgraph "Core Operational Engines"
        MCP --> PGGit["🧩 Structural Code Engine<br/>Lexer & Call Graph Walks"];
        MCP --> Memory["🧠 Episodic Memory<br/>Superseding & Nuggets"];
        MCP --> State["📋 Contextmaxxing<br/>compile_state Brief"];
        MCP --> Auditor["🛡️ Proactive Auditor<br/>Trajectory Guardrails"];
    end

    Auditor -. "Warning Nudge" .-> Agent;
    Agent -. "Feedback" .-> Auditor;
```

---

## 🚀 Quick Start

### 1. Clone and Install
```bash
git clone https://github.com/kruschdev/krusch-context-mcp.git
cd krusch-context-mcp
npm install
```

### 2. Configure Your Environment

```bash
cp .env.example .env
```

#### Option A: Local / Self-Hosted Stack (Default & Sovereign)
Uses your local PostgreSQL with `pgvector` and local Ollama (`bge-large`):

```env
KRUSCH_PROFILE="core"
DATABASE_URL="postgresql://postgres:password@localhost:5432/kruschdb"
OLLAMA_URL="http://127.0.0.1:11434"
```

#### Option B: Polygres Cloud (Turnkey Zero-GPU Setup)
If you prefer not running local DB and Ollama instances:

```env
KRUSCH_PROFILE="core"
POLYGRES_PROJECT_ID="your_project_id"
POLYGRES_RUNTIME_URL="https://your_project_id.api.db.polygres.com/v1"
POLYGRES_API_KEY="sk-polygres-your-key"
DATABASE_URL="postgresql://user:pass@app.polygres.com:5432/your_db?sslmode=require"
```

### 3. Ingest Your Codebase (Optional but Recommended)
Index the current repository into the PostgreSQL Git DAG:
```bash
npm run snapshot -- .
```

### 4. Register in Your IDE

Add the server to your IDE's MCP configuration.

#### Cursor (`~/.cursor/mcp.json` or project `.cursor/mcp.json`)
```json
{
  "mcpServers": {
    "krusch-context": {
      "command": "node",
      "args": ["/absolute/path/to/krusch-context-mcp/src/index.js"],
      "env": {
        "KRUSCH_PROFILE": "core",
        "DATABASE_URL": "postgresql://postgres:password@localhost:5432/kruschdb",
        "OLLAMA_URL": "http://127.0.0.1:11434"
      }
    }
  }
}
```

#### Claude Code (`~/.claude.json`)
```json
{
  "mcpServers": {
    "krusch-context": {
      "command": "node",
      "args": ["/absolute/path/to/krusch-context-mcp/src/index.js"],
      "env": {
        "KRUSCH_PROFILE": "core",
        "DATABASE_URL": "postgresql://postgres:password@localhost:5432/kruschdb",
        "OLLAMA_URL": "http://127.0.0.1:11434"
      }
    }
  }
}
```

Restart your IDE — your agent now has immediate access to the **11 core context tools** with zero prompt bloat.

---

## 💡 Practical Agent Workflows (Core Profile)

### Workflow 1: Single-Turn Hybrid Retrieval (`krusch_context_retrieve`)
```javascript
// Retrieve vector context, 2-hop symbol dependencies, and memories packed under 3500 tokens
await krusch_context_retrieve({
  query: "Postgres connection pooling and idle timeout settings",
  project: "krusch-context-mcp",
  graph_hops: 2,
  limit_tokens: 3500,
  include_code: true
});
```

### Workflow 2: One-Shot State Briefing (`krusch_context_compile_state`)
```javascript
// Instant project briefing — returns recent priorities, blockers, and lessons in one payload
await krusch_context_compile_state({
  project: "krusch-context-mcp"
});
```

### Workflow 3: Code Symbol & Caller Exploration
```javascript
// Search function and class signatures across languages
await krusch_context_search_symbols({
  query: "verifyDatabase",
  project: "krusch-context-mcp"
});

// Walk inbound callers and outbound imports
await krusch_context_symbol_graph({
  symbol_name: "verifyDatabase",
  direction: "inbound",
  project: "krusch-context-mcp"
});
```

### Workflow 4: Steering Nuggets (Agent Guardrails)
```javascript
// Persist a high-priority architectural rule
await krusch_context_nugget_remember({
  key: "auth-rule",
  value: "Always validate JWT expiry using UTC timestamps before checking permissions",
  kind: "project"
});

// Semantically retrieve steering rules relevant to current task
await krusch_context_nugget_nudges({
  query: "implement login token validation"
});
```

---

## 📋 Complete Tool Reference

For complete parameter types, input schemas, and JSON examples, see **[TOOL_REFERENCE.md](docs/TOOL_REFERENCE.md)**.

| Profile | Category | Tool | Description |
| :--- | :--- | :--- | :--- |
| **`core`** | Retrieval | `krusch_context_retrieve` | Single-query hybrid vector + graph walk + token budget packing |
| **`core`** | Memory | `krusch_context_add_memory` | Store persistent episodic memory (bug, lesson, priority) |
| **`core`** | Memory | `krusch_context_search_memory`| Semantic search with recency decay |
| **`core`** | State | `krusch_context_compile_state` | One-shot multi-scale project state compilation |
| **`core`** | Nuggets | `krusch_context_nugget_remember`| Store key-value steering fact or preference |
| **`core`** | Nuggets | `krusch_context_nugget_nudges` | Semantically retrieve steering facts for active task |
| **`core`** | Codebase | `krusch_context_search_symbols`| Search extracted structural symbols across languages |
| **`core`** | Codebase | `krusch_context_symbol_graph` | Walk symbol callers, imports, and dependencies |
| **`core`** | Codebase | `krusch_context_search_code` | Hybrid dense pgvector + BM25 RRF search over blobs |
| **`core`** | Health | `krusch_context_health` | Diagnostic check for DB pool, embeddings, and tables |
| **`core`** | Safety | `krusch_context_proactive_nudge`| Trajectory threat auditor — flags rule or bug recurrence |
| `extended` | Memory | `krusch_context_supersede_memory`| Temporal fact superseding with revision lineage |
| `extended` | Memory | `krusch_context_invalidate_memory`| Invalidate obsolete memory record |
| `extended` | Memory | `krusch_context_list_memories` | List recent memories filtered by category and project |
| `extended` | Memory | `krusch_context_delete_memory` | Delete memory record by ID |
| `extended` | Memory | `krusch_context_update_memory` | Update memory content, tags, or metadata |
| `extended` | Memory | `krusch_context_consolidate` | Centroid-based semantic memory deduplication |
| `extended` | Retrieval | `krusch_context_deep_search` | Composite search cross-referencing memory & code |
| `extended` | Codebase | `krusch_context_list_repos` | Browse indexed repositories registered in PostgreSQL |
| `extended` | Codebase | `krusch_context_read_tree` | Inspect repository directory trees in the Git DAG |
| `extended` | Codebase | `krusch_context_read_blob` | Retrieve file content by blob hash or path |
| `extended` | Codebase | `krusch_context_file_symbols` | List all symbols defined in a specific file |
| `extended` | Nuggets | `krusch_context_nugget_forget` | Delete steering fact by key |
| `extended` | Nuggets | `krusch_context_nugget_list` | List active steering nuggets for project |
| `extended` | Thinking | `krusch_context_think` | Cited context synthesis, conflict detection & gap analysis |
| `extended` | Skills | `krusch_context_list_skills` | Browse registered agent skills in homelab directory |
| `extended` | Skills | `krusch_context_get_skill` | Retrieve complete skill prompt markdown instructions |
| `extended` | Docs | `krusch_docs_list` | List ingested external documentation manuals |
| `extended` | Docs | `krusch_docs_search` | Vector search within an ingested documentation manual |
| `extended` | Session | `krusch_context_write_session_handoff`| Persist session handoff summary for background review |
| `extended` | Session | `krusch_context_read_session_review`| Read review compiled by background companions |
| `full` | Substrate | `krusch_context_write_state` ... `link_blob` | Company Brain v2 substrate tools (7 tools) |
| `full` | AI Watch | `log_agent_failure` ... `evaluate_resilience` | Experimental SRE and research engines (18 tools) |
| `full` | Cloud | `polygres_cloud_usage` ... `embedding_configs` | Polygres Cloud runtime and quota tools (5 tools) |
| `full` | Aliases | `pg_git_search_symbols` ... `dependency_graph` | Standalone PG-Git backward compatibility aliases (3 tools) |

---

## 🧪 Testing & Verification

```bash
# Automated unit & integration tests (40 passing tests)
npm test

# Full JSON-RPC stdio smoke test across all tools
npm run test:smoke

# Test a specific profile over stdio
KRUSCH_PROFILE=core node --env-file=.env tests/test_client.js

# Run empirical codebase retrieval accuracy evaluation
npm run eval:accuracy
```

### 📊 Retrieval Evaluation & Benchmarks

Empirical dense vector retrieval accuracy is probed using `npm run eval:accuracy` (`scripts/eval_accuracy.js`):
* **Recall@1**: 20.0% (exact top hit)
* **Recall@5**: 60.0% (expected file within top 5 candidates)
* **Recall@10**: 60.0%

For detailed query logs, corpus breakdown, and benchmark caveats, see **[EVALS.md](docs/EVALS.md)**.

---

## 🔬 Research Inspirations & Theoretical Background

Krusch Context MCP is an engineering testbed that implements pragmatic software adaptations inspired by modern agentic systems and retrieval research:

* **Determinantal Point Processes for Diversity (DSR)**: Orthogonal skill selection balancing relevance and non-redundancy (inspired by DPP skill routing concepts).
* **Temporal Memory & Knowledge Lineage (MobileMem)**: Fact superseding and active lineage filtering for long-running agents.
* **Agentic Context Management (ACM)**: Lifecycle staging, compaction, and context-window token budget auditing.
* **Failure Observability & Patch Catalogs (AgentDebugX)**: Structured error attribution and recovery pattern distribution.
* **Direct Alignment Distillation (Direct-OPD)**: Closed-loop developer feedback updating proactive trajectory rules.
* **Company Brain Substrates**: Multi-tier organizational memory inspired by the [Sentra Company Brain Series](https://sentra.app).

> *Note: These modules represent functional homelab and product engineering adaptations designed to solve developer workflow friction, rather than formal academic benchmark reproductions.*

---

## 🤝 Sibling Synergy with Standalone PG-Git

While Krusch Context MCP includes the complete native codebase engine, **[PG-Git](https://github.com/kruschdev/pg-git)** (`pg-git-mcp@1.1.0`) is maintained as an independent, standalone codebase RAG package. Both packages share identical PostgreSQL schemas (`repositories`, `blobs`, `code_symbols`, `code_symbol_edges`, `trees`, `commits`, `branches`), allowing single-purpose tools and full context orchestrators to query the same database seamlessly without duplicate indexing.

---

## 📄 License

MIT License © 2026 [kruschdev](https://github.com/kruschdev)

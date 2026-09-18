<p align="center">
  <img src="docs/assets/banner.png?v=2" alt="Krusch Context MCP" width="800" />
</p>

<p align="center">
  <a href="https://github.com/kruschdev/krusch-context-mcp"><img src="https://img.shields.io/github/package-json/v/kruschdev/krusch-context-mcp.svg" alt="Version" /></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT" /></a>
  <a href="https://modelcontextprotocol.io/"><img src="https://img.shields.io/badge/MCP-13%20core%20tools-purple.svg" alt="13 core MCP tools" /></a>
  <a href="https://modelcontextprotocol.io/"><img src="https://img.shields.io/badge/architecture-core%2013%20%7C%20extended%2025%20%7C%20extensions-lightgrey.svg" alt="Core + Extensions" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-22+-green.svg" alt="Node" /></a>
  <a href="https://github.com/pgvector/pgvector"><img src="https://img.shields.io/badge/Database-PostgreSQL%20%2B%20pgvector-lightgrey.svg" alt="Database" /></a>
</p>

**13-tool sovereign AI context engine** for coding agents: hybrid codebase retrieval, persistent episodic memory with self-healing superseding/invalidation, holographic steering nuggets, and proactive trajectory auditing. 100% local-first on PostgreSQL + Ollama, with optional turnkey Polygres Cloud runtime.

Modular architecture: **core (13 tools, sovereign default)** → **extended core (26 tools)** → **modular companion extensions** (`research`, `company-brain`, `polygres-cloud`, `session-bridge`, `skills-docs`).

---

## ⚡ The Problem: Agent Amnesia & Codebase Disconnect

Every time you start a new AI coding session, your agent starts from absolute zero. It forgets the bug you fixed yesterday, the architectural decisions you made last week, and the dependency graph of your code. You find yourself repeatedly re-explaining context, fighting stale hallucinations, and babysitting LLM loops.

**Krusch Context MCP bridges objective codebase reality with persistent agent memory.**

Operating as a [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server, it provides coding agents (Cursor, Claude Code, Windsurf, Gemini CLI) persistent working memory, zero-trust codebase verification, and automated trajectory protection across sessions.

---

## 🎯 Curated Tool Profiles: No Tool Overload

Exposing dozens of overlapping tools hurts LLM performance: it consumes thousands of prompt tokens per turn and causes tool-selection errors. Krusch Context MCP solves this with **Tool Profiles** (`KRUSCH_PROFILE`) and **Modular Companion Extensions**:

| Profile / Mode | Tools Exposed | Default | System Prompt Cost | Intended Use |
| :--- | :---: | :---: | :---: | :--- |
| **`core`** *(Sovereign Default)* | **13 tools** | ✅ **Yes** | **~900 tokens** | High-signal daily drivers using local PostgreSQL + local Ollama: hybrid retrieval, episodic memory, active superseding & invalidation, state compilation, steering nuggets, structural symbol search, dependency graph, health, and proactive guardrails. |
| **`extended`** | **26 tools** | ❌ No | ~1,800 tokens | Adds full administrative memory inspection (`list`, `delete`, `update`, `consolidate`), Git tree/blob inspection, cited thinking, and alignment feedback. |
| **`extensions`** | **Companion MCPs** | ❌ No | On-demand | Specialized domains running as independent companion servers or loaded dynamically via `--extensions=...` (`research`, `company-brain`, `polygres-cloud`, `session-bridge`, `skills-docs`). |
| **`full`** | **61 tools** | ❌ No | ~4,200 tokens | Complete monolithic development suite with all 5 companion extensions loaded in-process. |

> [!TIP]
> **Modular Companion Pattern (Recommended)**: Run `krusch-context` for the core 13-tool daily memory loop, and launch companion servers (`npm run start:research`, `npm run start:cloud`, etc.) only for sessions that need specialized tools.
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

### 3. 🧠 Episodic Memory & Steering Nuggets (With Active Hygiene)
* **Contextmaxxing (`compile_state`)**: Compiles project state (priorities, active blockers, lessons, steering facts) into a single-shot briefing document.
* **Temporal Superseding (`supersede_memory`)**: Supersede outdated rules with lineage links and auto-marking of stale facts as `SUPERSEDED`.
* **Explicit Invalidation (`invalidate_memory`)**: Mark revoked secrets, obsolete invariants, or abandoned rules as `INVALIDATED` to guarantee they are never retrieved.
* **Holographic Steering Nuggets (`nugget_remember`)**: Micro-key-value facts (coding standards, conventions) that steer agent behavior without repetitive system prompt edits.
* **Lakebase Architecture**: Zero-latency reads from per-project local SQLite compute cache (`.agent/memory.db`) backed by durable PostgreSQL object storage.

### 4. 🛡️ Proactive Trajectory Auditing & Alignment Loop
* **Proactive Auditor (`proactive_nudge`)**: Background threat-auditor that flags rule violations, architectural drift, or known regressions before edits execute.
* **Closed-Loop Alignment (`nudge_feedback`)**: Automatically captures developer approvals and corrections to refine future proactive guidance.

### 5. ⚡ Modular Companion Extensions & Cloud Support
* **Modular Companion MCPs**: Run specialized domains as independent companion servers or load dynamically via `--extensions=...` (`research`, `company-brain`, `polygres-cloud`, `session-bridge`, `skills-docs`).
* **Turnkey Cloud Option**: Optional support for Polygres Cloud (`polygres_cloud_*`, 5 tools) providing zero-GPU in-engine embeddings, vector search, model catalog, and live microcredit tracking.

---

## 📐 Architecture

```mermaid
graph TD;
    Agent["IDE Agent: Cursor / Claude Code / Windsurf"] --> MCP{"Krusch Context MCP<br/><b>Core: 13 Tools (Default)</b><br/>+ Modular Extensions"};

    subgraph "Storage & Backend Layer"
        MCP -- "Self-Hosted / Fleet" --> PG[("🐘 PostgreSQL + pgvector / pgContext<br/>• Code Blobs, Trees, Commits<br/>• Structural Symbols & Graph Edges<br/>• Episodic Memory & Nuggets")];
        MCP -- "Zero-Latency Cache" --> SQLite[("⚡ Local SQLite Lakebase<br/>.agent/memory.db")];
        MCP -. "Optional Cloud Adapter" .-> Polygres["⚡ Polygres Cloud<br/>In-Engine Embeddings & Search"];
    end

    subgraph "Local Embeddings & Models"
        PG --> Ollama["🦙 Local Ollama<br/>• bge-large (1024d vectors)<br/>• llama3.2 (tags & brief)"];
    end

    subgraph "Core Operational Engines (13 Tools)"
        MCP --> PGGit["🧩 Structural Code Engine<br/>Lexer & Call Graph Walks"];
        MCP --> Memory["🧠 Episodic Memory<br/>Superseding & Invalidation"];
        MCP --> State["📋 Contextmaxxing<br/>compile_state Brief"];
        MCP --> Auditor["🛡️ Proactive Auditor<br/>Trajectory Guardrails"];
    end

    subgraph "Modular Companion Extensions"
        MCP -. "companion / flag" .-> ExtCloud["⚡ Polygres Cloud (5 tools)<br/>Quota & in-engine search"];
        MCP -. "companion / flag" .-> ExtBrain["🧠 Company Brain (8 tools)<br/>Multi-tenant v2 graph"];
        MCP -. "companion / flag" .-> ExtResearch["🔬 Research Suite (15 tools)<br/>AgentDebugX, AREX, ACM"];
        MCP -. "companion / flag" .-> ExtSession["🌉 Session Bridge (2 tools)<br/>Jean SRE handoffs"];
        MCP -. "companion / flag" .-> ExtSkills["🛠️ Skills & Docs (5 tools)<br/>DSR routing & manuals"];
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

#### Option A: Local / Self-Hosted Stack (Sovereign Default)
Uses your local PostgreSQL with `pgvector` and local Ollama (`bge-large`):

```env
KRUSCH_PROFILE="core"
DATABASE_URL="postgresql://postgres:password@localhost:5432/kruschdb"
OLLAMA_URL="http://127.0.0.1:11434"
```

#### Option B: Polygres Cloud Backend (Turnkey Zero-GPU Cloud Alternative)
Uses Polygres Cloud for in-engine embeddings and managed collections:

```env
DATABASE_URL="postgresql://user:password@db.polygres.com:5432/your_database"
POLYGRES_PROJECT_ID="your_project_id"
POLYGRES_RUNTIME_URL="https://your_project_id.api.db.polygres.com/v1"
POLYGRES_API_KEY="poly_live_your_key"
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
      "args": [
        "/absolute/path/to/krusch-context-mcp/src/index.js"
      ],
      "env": {
        "DATABASE_URL": "postgresql://postgres:password@localhost:5432/kruschdb"
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
      "args": [
        "/absolute/path/to/krusch-context-mcp/src/index.js"
      ],
      "env": {
        "DATABASE_URL": "postgresql://postgres:password@localhost:5432/kruschdb"
      }
    }
  }
}
```

> [!NOTE]
> **Enabling Companion Extensions**:
> - **In-process**: Pass `--extensions=polygres-cloud,research` in `args` or set `KRUSCH_EXTENSIONS=...`.
> - **Dedicated Companion MCP Servers (Recommended)**: Add separate server entries pointing to `src/extensions/<name>/server.js` (e.g. `npm run start:research`, `npm run start:cloud`).

Restart your IDE — your agent now has immediate access to the **13 core context tools** with zero prompt bloat (~900 tokens).

## 💡 Practical Agent Workflows (Core Profile & Polygres)

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

### Workflow 5: Active Memory Hygiene (`supersede` & `invalidate`)
```javascript
// Supersede outdated documentation or rules with updated knowledge
await krusch_context_supersede_memory({
  id: 42,
  category: "lessons",
  content: "Use Polygres Cloud Runtime 0.5.0 for in-engine embeddings instead of local Ollama on dev boxes",
  project: "krusch-context-mcp"
});

// Explicitly invalidate deprecated invariants or revoked secrets
await krusch_context_invalidate_memory({
  id: 17,
  reason: "API key rotated and auth pattern deprecated"
});
```

### Workflow 6: Polygres Cloud In-Engine Search & Quota
```javascript
// Check live generation/query microcredit allowance and remaining quota
await polygres_cloud_usage();

// In-engine semantic search over cloud collections (zero local GPU load)
await polygres_cloud_search({
  collection: "project_context",
  text: "Postgres connection pooling timeouts",
  limit: 5
});
```

---

## 📋 Complete Tool Reference

For complete parameter types, input schemas, and JSON examples, see **[TOOL_REFERENCE.md](docs/TOOL_REFERENCE.md)**.

### Core Profile (13 Tools — Sovereign Default)
| Category | Tool | Description |
| :--- | :--- | :--- |
| **Retrieval** | `krusch_context_retrieve` | Polygres-style single-query hybrid vector + graph walk + token budget packing |
| **Memory** | `krusch_context_add_memory` | Store persistent episodic memory (priorities, bugs, outcomes, lessons, activity) |
| **Memory** | `krusch_context_supersede_memory` | Temporal fact superseding with lineage tracking (marks old record `SUPERSEDED`) |
| **Memory** | `krusch_context_invalidate_memory` | Explicitly invalidate obsolete rules/facts (marks record `INVALIDATED`) |
| **Memory** | `krusch_context_search_memory`| Semantic search with recency decay (excludes superseded/invalidated facts) |
| **State** | `krusch_context_compile_state` | One-shot multi-scale project state compilation briefing |
| **Nuggets** | `krusch_context_nugget_remember`| Store fast key-value steering fact or convention (project/user/agent) |
| **Nuggets** | `krusch_context_nugget_nudges` | Semantically retrieve steering facts for the active task |
| **Codebase** | `krusch_context_search_symbols`| Search extracted structural AST symbols across JS, TS, Python, Go, Rust |
| **Codebase** | `krusch_context_symbol_graph` | Walk relational symbol dependency edges, inbound callers, and outbound imports |
| **Codebase** | `krusch_context_search_code` | Hybrid dense pgvector + BM25 RRF search over Git blobs with age decay |
| **Health** | `krusch_context_health` | Diagnostic health check for DB pool, embeddings, and repository status |
| **Safety** | `krusch_context_proactive_nudge`| Proactive threat auditor — flags rule violations or known bug regressions |

### ⚡ Polygres Cloud Companion Tools (5 Tools)
*Run as a standalone companion server via `npm run start:cloud` or load dynamically via `--extensions=polygres-cloud`.*

| Category | Tool | Description |
| :--- | :--- | :--- |
| **Cloud Quota** | `polygres_cloud_usage` | Inspect live microcredit allowance, queries remaining, generation credits, and cost breakdown |
| **Cloud Search** | `polygres_cloud_search` | In-engine semantic vector search over remote Polygres Cloud collections with metadata filtering |
| **Cloud Catalog** | `polygres_cloud_models` | List remote in-database embedding models supported on Polygres Cloud |
| **Cloud Engine** | `polygres_cloud_capabilities` | Verify active runtime engine features (HNSW vector indexing, text-in vectorization, hybrid search) |
| **Cloud Sync** | `polygres_cloud_embedding_configs` | Inspect automated table-embedding configurations synchronized with Polygres Cloud |

### Extended Core Inspection (12 Tools)
*Enabled via `--profile=extended` or `KRUSCH_PROFILE=extended`*

| Category | Tool | Description |
| :--- | :--- | :--- |
| **Memory** | `krusch_context_list_memories` | Chronological listing of memories filtered by category and project |
| **Memory** | `krusch_context_delete_memory` | Delete a specific memory record by numeric ID |
| **Memory** | `krusch_context_update_memory` | Update memory content, tags, or project assignment (triggers re-embedding) |
| **Memory** | `krusch_context_consolidate` | Centroid-based semantic memory deduplication within category |
| **Retrieval** | `krusch_context_deep_search` | Composite search cross-referencing all episodic categories and code blobs |
| **Codebase** | `krusch_context_list_repos` | Browse indexed repositories registered in PostgreSQL Git DAG |
| **Codebase** | `krusch_context_read_tree` | Inspect directory tree objects in the Git DAG |
| **Codebase** | `krusch_context_read_blob` | Retrieve file content by blob SHA hash |
| **Codebase** | `krusch_context_file_symbols` | List all extracted symbols for a specific blob SHA |
| **Nuggets** | `krusch_context_nugget_forget` | Delete a steering fact by key |
| **Nuggets** | `krusch_context_nugget_list` | Chronological list of active steering nuggets |
| **Thinking** | `krusch_context_think` | Cited context synthesis, conflict detection & gap analysis |

### Modular Companion Extensions (`src/extensions/`)
*Run as standalone companion MCP servers or load dynamically via `--extensions=...`*

| Extension | Standalone Launcher | Tools | Key Capabilities |
| :--- | :--- | :---: | :--- |
| **`polygres-cloud`** | `npm run start:cloud` | **5** | Live microcredit quota tracking (`usage`), in-engine semantic search (`search`), in-database model catalog (`models`), HNSW capabilities, and watched table embedding configs. |
| **`company-brain`** | `npm run start:company-brain` | **8** | Company Brain v2 Substrate: optimistic concurrency memory (`write_state`), branching conflict resolution (`resolve_conflict`), version provenance (`get_provenance`), ontology management (`update_ontology`), role lenses (`search_lens`), and graph walks (`traverse_graph`). |
| **`research`** | `npm run start:research` | **15** | AI Watch research suite: failure observability (`AgentDebugX`), DAG mutations (`DataFlow`), minimal cover reranking (`Setwise`), deep research state (`AREX`), context lifecycle (`ACM`), teacher distillation, and resilience gating. |
| **`session-bridge`** | `npm run start:session` | **2** | Jean SRE companion bridge: autonomous session handoff recording (`write_session_handoff`) and idempotent review consumption (`read_session_review`). |
| **`skills-docs`** | `npm run start:skills` | **5** | Agent skills registry (`list_skills`, `get_skill`), Diverse Skill Routing via DPP (`route_skills`), and ingested external documentation manuals (`docs_list`, `docs_search`). |

---

## 🧪 Testing & Verification

```bash
# Automated unit & integration tests (42 passing tests)
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

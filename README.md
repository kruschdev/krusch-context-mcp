<p align="center">
  <img src="docs/assets/banner.png?v=2" alt="Krusch Context MCP" width="800" />
</p>

<p align="center">
  <a href="https://github.com/kruschdev/krusch-context-mcp"><img src="https://img.shields.io/github/package-json/v/kruschdev/krusch-context-mcp.svg" alt="Version" /></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT" /></a>
  <a href="https://modelcontextprotocol.io/"><img src="https://img.shields.io/badge/MCP-13%20core%20tools-purple.svg" alt="13 core MCP tools" /></a>
  <a href="https://modelcontextprotocol.io/"><img src="https://img.shields.io/badge/architecture-core%2013%20%7C%20extended%2026%20%7C%20extensions-lightgrey.svg" alt="Core + Extensions" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-22+-green.svg" alt="Node" /></a>
  <a href="https://github.com/pgvector/pgvector"><img src="https://img.shields.io/badge/Database-PostgreSQL%20%2B%20pgvector-lightgrey.svg" alt="Database" /></a>
</p>

**The 13-tool Sovereign Context Engine for Coding Agents** (~900 prompt tokens): hybrid codebase retrieval, persistent episodic memory with self-healing superseding/invalidation, persistent steering nuggets, and proactive trajectory auditing. 100% local-first on PostgreSQL + Ollama, with optional cloud runtimes.

Architecture: **Sovereign Core (13 tools, default)** → **Extended Core (26 tools)** → **Production Companion Extensions** (`nexus`, `law`, `biz`, `polygres-cloud`, `semantic-router`).

---

## ⚡ The Problem: Agent Amnesia & Codebase Disconnect

Every time you start a new AI coding session, your agent starts from absolute zero. It forgets the bug you fixed yesterday, the architectural decisions you made last week, and the dependency graph of your code. You find yourself repeatedly re-explaining context, fighting stale hallucinations, and babysitting LLM loops.

**Krusch Context MCP bridges objective codebase reality with persistent agent memory.**

Operating as a [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server, it provides coding agents (Cursor, Claude Code, Windsurf, Gemini CLI) persistent working memory, grounded codebase verification, and automated trajectory protection across sessions.

---

## 🎯 Curated Tool Profiles: No Tool Overload

Exposing dozens of overlapping tools hurts LLM performance: it consumes thousands of prompt tokens per turn and causes tool-selection errors. Krusch Context MCP solves this with **Tool Profiles** (`KRUSCH_PROFILE`) and **Production Companion Extensions**:

| Profile / Mode | Tools Exposed | Default | System Prompt Cost | Intended Use |
| :--- | :---: | :---: | :---: | :--- |
| **`core`** *(Sovereign Default)* | **13 tools** | ✅ **Yes** | **~900 tokens** | High-signal daily drivers using local PostgreSQL + local Ollama: hybrid retrieval, episodic memory, active superseding & invalidation, state compilation, steering nuggets, structural symbol search, dependency graph, health, and proactive guardrails. |
| **`sovereign`** / **`triad`** / **`ecosystem`** | **37 tools** | ❌ No | **~2,500 tokens** | Sovereign Quartet substrate: Curated 13 daily drivers + Neural Semantic Router (3) + KruschLaw (8) + KruschNexus (6) + KruschBiz (7) loaded in-process. |
| **`extended`** | **26 tools** | ❌ No | ~1,800 tokens | Adds full administrative memory inspection (`list`, `delete`, `update`, `consolidate`), Git tree/blob inspection, cited thinking, and alignment feedback. |
| **`extensions`** | **Companion MCPs** | ❌ No | On-demand | Production domains running as independent companion servers or loaded dynamically via `--extensions=...` (`nexus`, `law`, `biz`, `polygres-cloud`, `semantic-router`). |

> [!TIP]
> **Modular Companion Pattern (Recommended)**: Run `krusch-context` for the core 13-tool daily memory loop, and launch companion servers (`npm run start:nexus`, `npm run start:biz`, `npm run start:law`, `npm run start:cloud`, etc.) only for sessions that need specialized tools.
> Direct tool calls to registered handlers always succeed even if omitted from `tools/list`, ensuring complete script and CI compatibility.

---

## 🏛️ Core Capabilities: The 5 Pillars

### 1. 🔍 Unified Hybrid Retrieval (`krusch_context_retrieve`)
* **Compound One-Shot Retrieval (`include_state: true`)**: Retrieves the compiled project state briefing (priorities, blockers, lessons, steering rules) alongside code and symbol graphs in a single round-trip turn within your token budget.
* **Auto-Detecting Project Scope**: Automatically resolves the current workspace project from the active working directory, `package.json`, or Git repository if `project` is omitted across all core retrieval and memory tools.
* **Bi-Directional Grounding**: Cross-references subjective episodic memory (lessons, bugs, decisions) alongside objective code blobs and symbols in a single turn.
* **Token Budget Awareness**: Automatically ranks and truncates contextual snippets to prevent prompt overflows.

### 2. 🧩 Structural Codebase Engine & Symbol Graphs
* **Native Git DAG Storage**: Retains Git trees, blobs, commits, and branches in PostgreSQL without requiring loose file scanning.
* **Zero-Dependency Structural Lexer (Transparent Pragmatism)**: Pure JavaScript balanced-brace scanning and regex parser extracting functions, classes, interfaces, and routes across JS, TS, Python, Go, Rust, and Shell. Intentionally avoids brittle native C++ Tree-sitter bindings and `node-gyp` compile errors, delivering 90%+ AST symbol extraction utility with instant cross-platform startup and zero native install overhead.
* **Relational Symbol Graphs (`symbol_graph`)**: Walk inbound callers, outbound imports, and transitive dependencies up to $N$ hops.
* **Hybrid RRF Search (`search_code`)**: Merges dense cosine similarity with lexical BM25 (`tsv` GIN index) using Reciprocal Rank Fusion and exponential temporal decay ($e^{-0.01t}$).
* **Standalone Synergy**: 100% schema-compatible with [PG-Git](https://github.com/kruschdev/pg-git) (`pg-git-mcp@1.1.0`), supporting dedicated `pg_git_*` aliases.

### 3. 🧠 Episodic Memory & Steering Nuggets (With Active Hygiene)
* **Deterministic State Briefing (`compile_state`)**: Compiles project state (priorities, active blockers, lessons, steering rules) and working tree freshness alerts into a single-shot briefing document. Project parameter is optional with auto-detection.
* **Temporal Superseding (`supersede_memory`)**: Supersede outdated rules with lineage links and auto-marking of stale facts as `SUPERSEDED`.
* **Explicit Invalidation (`invalidate_memory`)**: Mark revoked secrets, obsolete invariants, or abandoned rules as `INVALIDATED` to guarantee they are never retrieved.
* **Persistent Steering Nuggets (`nugget_remember`)**: Micro-key-value rules and conventions (coding standards, architectural constraints) that steer agent behavior without prompt bloat.
* **Lakebase Architecture**: Zero-latency reads from per-project local SQLite compute cache (`.agent/memory.db`) backed by durable PostgreSQL object storage.

### 4. 🛡️ Proactive Trajectory Auditing & Alignment Loop
* **Proactive Auditor (`proactive_nudge`)**: Background threat-auditor that flags rule violations, architectural drift, or known regressions before edits execute.
* **Closed-Loop Alignment (`nudge_feedback`)**: Automatically captures developer approvals and corrections to refine future proactive guidance.

### 5. ⚡ Modular Companion Extensions
* **Modular Companion MCPs**: Run specialized domains as independent companion servers (`npm run start:nexus`, `npm run start:biz`, `npm run start:law`, `npm run start:cloud`, `npm run start:router`) or load dynamically via `--extensions=...`.
* **L2 Neural Semantic Router (`npm run start:router`)**: 3 tools (`krusch_context_semantic_route`, `krusch_context_register_semantic_centroid`, `krusch_context_list_semantic_centroids`) providing pgvector HNSW cosine-distance routing for unstructured natural language prompts, bridging Stage-0 pre-router gate misses to domain specialists.
* **Sovereign Triad**: Dedicated engines for KruschNexus (citation spine & ingestion), KruschLaw (ordinances & compliance traceability), and KruschBiz (contract graph & conflict resolution).
* **Turnkey Cloud Option**: Optional support for Polygres Cloud (`polygres_cloud_*`, 5 tools) providing zero-GPU in-engine embeddings, vector search, model catalog, and live microcredit tracking.

---

## 📐 Architecture

```mermaid
graph TD;
    Agent["IDE Agent: Cursor / Claude Code / Windsurf"] --> MCP{"Krusch Context MCP<br/><b>Core: 13 Tools (Default)</b><br/>+ Production Companions"};

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
        MCP --> State["📋 State Briefing<br/>compile_state Brief"];
        MCP --> Auditor["🛡️ Proactive Auditor<br/>Trajectory Guardrails"];
    end

    subgraph "Production Companion Extensions"
        MCP -. "companion / flag" .-> ExtNexus["📄 KruschNexus (6 tools)<br/>Ingest & citation spine"];
        MCP -. "companion / flag" .-> ExtBiz["💼 KruschBiz (7 tools)<br/>Contracts & conflict resolver"];
        MCP -. "companion / flag" .-> ExtLaw["⚖️ KruschLaw (8 tools)<br/>Statutory & traceability"];
        MCP -. "companion / flag" .-> ExtRouter["🧭 Semantic Router (3 tools)<br/>L2 centroid classification"];
        MCP -. "companion / flag" .-> ExtCloud["⚡ Polygres Cloud (5 tools)<br/>Quota & in-engine search"];
    end

    Auditor -. "Warning Nudge" .-> Agent;
    Agent -. "Feedback" .-> Auditor;
```

---

## 🚀 Quick Start

### 1. Installation

**Run directly via npx:**
```bash
npx krusch-context-mcp
# Or companion L2 neural semantic router:
npx krusch-semantic-router
```

**Or clone and install locally:**
```bash
git clone https://github.com/kruschdev/krusch-context-mcp.git
cd krusch-context-mcp
npm install
```

### 2. Start PostgreSQL + pgvector (Turnkey 1-Command Setup)
If you don't already have PostgreSQL with `pgvector` running locally:
```bash
docker compose up -d
```
*Auto-starts PostgreSQL 16 with `pgvector` and `uuid-ossp` on port 5432, pre-initialized with all required schemas from `db/schema.sql`.*

### 3. Configure Your Environment

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
# Optional: add OpenRouter for automated LLM memory tagging
OPENROUTER_API_KEY="sk-or-v1-your-openrouter-key"
```

> [!TIP]
> **Tagging on Polygres Cloud**: Polygres Cloud manages PostgreSQL storage and in-engine vector embeddings, but does not provide LLM text completions. To enable semantic episodic memory tagging without local GPU hardware, pair Polygres with an OpenRouter API key. If omitted, Krusch Context uses deterministic heuristic keyword extraction.

#### Option C: OpenRouter Remote Embeddings (Zero Local VRAM Stack)
Run PostgreSQL and SQLite locally, but offload vector embeddings and tags to OpenRouter (`baai/bge-large-en-v1.5`, 1024 dims). Ideal for developer laptops or CPU-only homelabs without GPU VRAM for Ollama:

```env
KRUSCH_PROFILE="core"
DATABASE_URL="postgresql://postgres:password@localhost:5432/kruschdb"
OPENROUTER_API_KEY="sk-or-v1-your-openrouter-key"
```

### 4. Ingest Your Codebase (Optional but Recommended)
Index the current repository into the PostgreSQL Git DAG:
```bash
npm run snapshot -- .
```

### 5. Register in Your IDE

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

### Workflow 1: Compound One-Shot Hybrid Retrieval (`krusch_context_retrieve`)
```javascript
// Retrieve vector context, 2-hop symbol graph, memories, AND compiled project state in 1 turn
// (project is automatically resolved from git/package.json if omitted!)
await krusch_context_retrieve({
  query: "Postgres connection pooling and idle timeout settings",
  include_state: true,
  graph_hops: 2,
  limit_tokens: 3500,
  include_code: true
});
```

### Workflow 2: One-Shot State Briefing (`krusch_context_compile_state`)
```javascript
// Instant project briefing — auto-detects active workspace project from cwd/git
// Returns recent priorities, blockers, lessons, steering rules, and worktree freshness
await krusch_context_compile_state({});
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

## 🤖 Drop-In Agent Protocols (Cursor & Claude Code)

Context engines only deliver value when coding models actively query and maintain them. Krusch Context includes pre-built protocol instructions ready to copy into your repository:

| Agent / IDE | Template File | Recommended Placement |
| :--- | :--- | :--- |
| **Cursor** | [templates/.cursorrules](templates/.cursorrules) | Root `.cursorrules` or `.cursor/rules/context.mdc` |
| **Claude Code** | [templates/CLAUDE.md](templates/CLAUDE.md) | Root `CLAUDE.md` |
| **Windsurf / Antigravity** | [AGENTS.md](AGENTS.md) | Root `AGENTS.md` |

### Core Agent Routine:
1. **Session Start (1-Turn Compound Retrieval)**: Model calls `krusch_context_retrieve({ query: "...", include_state: true })` (or native `session_start` prompt) to hydrate active blockers, recent priorities, lessons, steering rules, and code context in a single turn. Workspace project is automatically resolved if omitted!
2. **Before Edits**: Model calls `krusch_context_retrieve` and `krusch_context_nugget_nudges` to ground context and enforce project rules.
3. **When Decisions Change**: Model calls `krusch_context_supersede_memory` or `krusch_context_invalidate_memory` to keep the working memory pristine.
4. **Pre-Commit**: Model verifies compliance with `krusch_context_nugget_nudges` (or native `pre_commit` prompt) before committing changes.

### Native Core MCP Prompts
Krusch Context provides built-in MCP prompts (supported out-of-the-box in Cursor, Claude Code, and Antigravity) without requiring optional extensions:
* `session_start`: Prompts the model to hydrate working context via compound retrieval or compile_state.
* `pre_commit`: Prompts the model to audit staged changes against project steering nuggets and verify memory cleanliness.

---

## 📋 Complete Tool Reference

For complete parameter types, input schemas, and JSON examples, see **[TOOL_REFERENCE.md](docs/TOOL_REFERENCE.md)**.

### Core Profile (13 Tools — Sovereign Default)
| Category | Tool | Description |
| :--- | :--- | :--- |
| **Retrieval** | `krusch_context_retrieve` | Polygres-style single-query hybrid vector + graph walk + token budget packing (supports compound `include_state: true`) |
| **Memory** | `krusch_context_add_memory` | Store persistent episodic memory (priorities, bugs, outcomes, lessons, activity) |
| **Memory** | `krusch_context_supersede_memory` | Temporal fact superseding with lineage tracking (marks old record `SUPERSEDED`) |
| **Memory** | `krusch_context_invalidate_memory` | Explicitly invalidate obsolete rules/facts (marks record `INVALIDATED`) |
| **Memory** | `krusch_context_search_memory`| Semantic search with recency decay (excludes superseded/invalidated facts) |
| **State** | `krusch_context_compile_state` | One-shot multi-scale project state compilation briefing (auto-detects project if omitted) |
| **Nuggets** | `krusch_context_nugget_remember`| Store fast key-value steering fact or convention (project/user/agent) |
| **Nuggets** | `krusch_context_nugget_nudges` | Semantically retrieve steering facts for the active task |
| **Codebase** | `krusch_context_search_symbols`| Search extracted structural symbols (functions, classes, routes) across JS, TS, Python, Go, Rust |
| **Codebase** | `krusch_context_symbol_graph` | Walk relational symbol dependency edges, inbound callers, and outbound imports |
| **Codebase** | `krusch_context_search_code` | Hybrid dense pgvector + BM25 RRF search over Git blobs with age decay |
| **Health** | `krusch_context_health` | Diagnostic health check for DB pool, embeddings, and repository / worktree freshness status |
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

### Extended Core Inspection (13 Tools — 26 Total)
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
| **Safety** | `krusch_context_nudge_feedback` | Record developer approvals or corrections to align proactive nudging |

### Modular Companion Extensions (`src/extensions/`)
*Run as standalone companion MCP servers or load dynamically via `--extensions=...`*

| Extension | Standalone Launcher | Tools | Key Capabilities |
| :--- | :--- | :---: | :--- |
| **`nexus`** | `npm run start:nexus` | **6** | KruschNexus sovereign citation spine: universal document ingestion (`ingest_file`), workspace isolation (`list_workspaces`), page and character span verification (`verify_span`), and OCR layout inspection (`get_ingest_report`, `search_corpus`). |
| **`biz`** | `npm run start:biz` | **7** | KruschBiz sovereign corporate intelligence: contract search (`search_contracts`), controlling clause resolution (`resolve_controlling_clause`), clause conflict detection (`detect_conflicts`), side-by-side diffing (`diff_instruments`), and deal briefs (`draft_deal_brief`, `list_deals`). |
| **`law`** | `npm run start:law` | **8** | KruschLaw sovereign legal intelligence: statutory graph exploration (`get_statute_graph`), deterministic jurisdiction machine (`evaluate_jurisdiction`), claim verification (`verify_claim`), code traceability (`get_traceability`), citations (`search_citations`, `extract_citations`), and risk analysis (`analyze_risk`). |
| **`semantic-router`** | `npm run start:router` | **3** | L2 Neural Semantic Router: low-overhead domain intent classification (`semantic_route`), dynamic archetype centroid registration (`register_centroid`), and router inspection (`list_centroids`). |
| **`polygres-cloud`** | `npm run start:cloud` | **5** | Live microcredit quota tracking (`usage`), in-engine semantic search (`search`), in-database model catalog (`models`), HNSW capabilities, and watched table embedding configs. |

> [!NOTE]
> **Experimental ArXiv Research Modules**: The AI Watch research pack (AgentDebugX, DataFlow, Setwise, AREX, ACM, Teacher Distillation, Resilience Gate) has been separated into its own dedicated companion repository: [`krusch-research-mcp`](https://github.com/kruschdev/krusch-research-mcp).

---

## 🧪 Testing & Verification

```bash
# Automated unit & integration tests (42 passing tests)
npm test

# Full JSON-RPC stdio smoke test across all tools
npm run test:smoke

# Test a specific profile over stdio
KRUSCH_PROFILE=core node --env-file=.env tests/test_client.js

# Run foreign codebase benchmark on Express (public third-party repo)
npm run eval:foreign

# Run in-corpus architecture ablation benchmark
npm run eval:accuracy
```

### 📊 Retrieval Evaluation & Benchmarks

Retrieval accuracy is empirically measured across a 3-way ablation (PostgreSQL BM25 lexical search, 1024-d Dense Cosine embeddings via `bge-large`, and Sovereign Hybrid Reciprocal Rank Fusion via `search_code`). Frozen fixtures are versioned under [`evals/fixtures/`](evals/fixtures/).

#### 1. Foreign Public Codebase Benchmark: `expressjs/express` (`npm run eval:foreign`)
Evaluated on [`expressjs/express`](https://github.com/expressjs/express) (206 files, 167 indexed blobs, 3,354 symbols) across 10 benchmark queries (5 semantic concepts + 5 exact code identifiers):

| Method | Recall@1 | Recall@5 | Recall@10 | MRR | Code Identifiers R@1 | Semantic Concepts R@1 |
|---|---|---|---|---|---|---|
| **BM25 Lexical** (Postgres `ts_rank_cd`) | 1/10 (10.0%) | 1/10 (10.0%) | 1/10 (10.0%) | 0.100 | 1/5 (20.0%) | 0/5 (0.0%) |
| **Dense Cosine** (`bge-large` 1024-d) | 6/10 (60.0%) | 9/10 (90.0%) | 9/10 (90.0%) | 0.733 | 2/5 (40.0%) | 4/5 (80.0%) |
| **Hybrid RRF** (`search_code`) | **7/10 (70.0%)** | **9/10 (90.0%)** | **9/10 (90.0%)** | **0.783** | **3/5 (60.0%)** | **4/5 (80.0%)** |

> **Key Takeaway**: On foreign code, Hybrid RRF yields **+20.0 percentage points (+1 hit) on code identifiers** over dense retrieval alone, resolving exact identifier collisions (`res.clearCookie` vs `res.cookie.js`) while maintaining parity on semantic concepts.

#### 2. In-Corpus Architecture Ablation (`npm run eval:accuracy`)
Evaluated on the Sovereign Core repository stack (190 content-addressed blobs, 14 benchmark queries):

| Method | Recall@1 | Recall@5 | Recall@10 | MRR | Code Identifiers R@1 | Semantic Concepts R@1 |
|---|---|---|---|---|---|---|
| **BM25 Lexical** (Postgres `ts_rank_cd`) | 3/14 (21.4%) | 4/14 (28.6%) | 4/14 (28.6%) | 0.238 | 2/6 (33.3%) | 1/8 (12.5%) |
| **Dense Cosine** (`bge-large` 1024-d) | 11/14 (78.6%) | **14/14 (100.0%)** | **14/14 (100.0%)** | 0.881 | 4/6 (66.7%) | **7/8 (87.5%)** |
| **Hybrid RRF** (`search_code`) | **13/14 (92.9%)** | **14/14 (100.0%)** | **14/14 (100.0%)** | **0.964** | **6/6 (100.0%)** | **7/8 (87.5%)** |

For detailed per-query execution logs, published misses, and benchmark methodology caveats (multi-target matching and BM25 tokenization considerations), see **[EVALS.md](docs/EVALS.md)**.

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

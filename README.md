<p align="center">
  <img src="docs/assets/banner.png?v=2" alt="Krusch Context MCP" width="800" />
</p>

<p align="center">
  <strong>Unified AI context engine merging native AST codebase search, episodic project memory, and proactive trajectory auditing into a single 64-tool MCP server.</strong>
</p>

<p align="center">
  <a href="https://github.com/kruschdev/krusch-context-mcp"><img src="https://img.shields.io/github/package-json/v/kruschdev/krusch-context-mcp.svg" alt="Version" /></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT" /></a>
  <a href="https://modelcontextprotocol.io/"><img src="https://img.shields.io/badge/MCP-64%20Tools-purple.svg" alt="MCP Tools" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-22+-green.svg" alt="Node" /></a>
  <a href="https://polygres.com"><img src="https://img.shields.io/badge/Polygres-0.5.0%20Cloud-blue.svg" alt="Polygres" /></a>
  <a href="https://github.com/pgvector/pgvector"><img src="https://img.shields.io/badge/Database-PostgreSQL%20%2B%20pgvector-lightgrey.svg" alt="Database" /></a>
</p>

---

## ⚡ The Problem: "Goldfish Memory"

Every time you start a new AI coding session, your agent starts from absolute zero. It forgets the bug you fixed yesterday, the architectural decisions you made last week, and the dependency graph of your code. You find yourself repeatedly re-explaining context, fighting stale hallucinations, and babysitting LLM loops.

**Krusch Context MCP unifies objective codebase reality with subjective agent memory.**

Operating as a single [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server exposing **64 tools**, it gives coding agents (Cursor, Claude Code, Windsurf, Gemini CLI) persistent working memory, zero-trust codebase verification, and automated trajectory protection across every session.

---

## 🏛️ Core Capabilities: The 5 Pillars

### 1. ⚡ Polygres Cloud Runtime & Native In-Engine Embeddings (v0.5.0)
* **Zero-Client Vectorization**: Uses Polygres in-database embedding models (`text-embedding-3-small`, `text-embedding-3-large`) directly out of the box. No external embedding API keys, no local GPU memory allocation, and zero data movement (`text → embed → store → search` in-engine).
* **Live Quota Monitoring (`polygres_cloud_usage`)**: Direct agent inspection of your monthly 500M free microcredit allowance, remaining balance, and usage statistics live from Cursor or Claude Code.
* **In-Engine Semantic Search (`polygres_cloud_search`)**: Pass pure text in, get ranked vector results out directly from cloud `pgContext` collections.
* **Automated Table Embedding Pipelines (`polygres_cloud_embedding_configs`)**: Monitor and orchestrate watched-table background embedding pipelines running autonomously inside Polygres.

### 2. 🧩 PG-Git Codebase Engine & AST Symbol Dependency Graphs
* **Native Git DAG Storage**: Retains Git trees, blobs, commits, and branches in PostgreSQL without requiring file-system loose object scanning.
* **Multi-Language AST Chunker**: Zero-dependency parser extracting functions, classes, interfaces, and routes across JavaScript, TypeScript, Python, Go, Rust, and Shell.
* **Relational Symbol Graphs (`symbol_graph`)**: Walk inbound callers, outbound imports, and transitive dependencies up to $N$ hops (`code_symbol_edges`).
* **Hybrid RRF Search (`search_code`)**: Merges dense cosine similarity with lexical BM25 (`tsv` GIN index) using Reciprocal Rank Fusion and exponential temporal recency decay ($e^{-0.01t}$).
* **Standalone Synergy**: 100% schema-compatible with [PG-Git](https://github.com/kruschdev/pg-git) (`pg-git-mcp@1.1.0`), supporting dedicated `pg_git_*` tool aliases.

### 3. 🧠 Episodic Memory & Company Brain v2 Substrate
* **Three-Layer Organizational Memory**: Separates **Factual Memory** (*what happened*), **Interaction Memory** (*why it happened* with UUID parent-child lineage), and **Action Memory** (*what to do next*).
* **Contextmaxxing (`compile_state`)**: Compiles multi-scale project state (micro, meso, macro) into a unified, token-budgeted prompt payload.
* **Temporal Fact Superseding (MobileMem)**: Supersede (`supersede_memory`) and invalidate (`invalidate_memory`) stale assumptions to maintain a pristine, drift-free knowledge graph.
* **Centroid-Based Consolidation (`consolidate`)**: Deduplicate and compress semantic memories via L2-normalized centroid averaging without requiring re-embedding.
* **Holographic Steering Nuggets (`nugget_remember`)**: Micro-key-value facts (coding standards, formatting preferences) steer the agent without manual re-prompting.

### 4. 🛡️ Proactive Trajectory Auditing & Multi-Agent Resilience
* **Direct-OPD Proactive Auditor (`proactive_nudge`)**: Background threat-auditor that flags rule violations, architectural drift, or known bugs before code changes execute.
* **Closed-Loop Alignment (`nudge_feedback`)**: Automatically records developer acceptance or corrections to fine-tune future nudge guidance.
* **Multi-Agent Resilience Gate (`evaluate_resilience`)**: Audits multi-agent handoffs for cascading failures, deadlocks, and credential leakage (*arXiv: 2609.17320*).
* **Diverse Skill Routing (`route_skills`)**: Determinantal Point Process (DPP) routing selects orthogonal, non-redundant agent skills without prompt bloat (*arXiv: 2609.05824*).
* **Structural Trajectory Analysis (`analyze_trajectory`)**: STRACE causal fault isolation isolating the exact step where an agent went off track (*arXiv: 2607.07702*).

### 5. 🔬 Autonomous SRE Healing & AI Watch Research Engines
* **AgentDebugX Error Hub (`log_agent_failure`, `search_failures`, `get_recovery_pattern`)**: Failure observability and validated recovery patch distribution (*arXiv: 2607.18754*).
* **DataFlow-Harness Grounded Codegen (`mutate_pipeline_dag`)**: Schema-validated operator registry and atomic pipeline DAG mutations (*arXiv: 2607.16617*).
* **Rubric4Setwise Minimal Cover Reranker (`setwise_rerank`)**: Filters candidate documents down to minimal covering sets using Redundancy, Conflict, and Complementarity rubrics (*arXiv: 2607.19238*).
* **AREX Deep Research Engine (`update_research_state`, `arex_audit`)**: Recursive self-improvement evidence tracking with stopping convergence audits (*arXiv: 2607.21461*).
* **Hierarchical Teacher Distillation (`distill_teacher_memory`)**: Workflow, subtask, and function-tier trajectory distillation enabling student models to learn operational patterns (*arXiv: 2608.07169*).
* **Agentic Context Management (`manage_lifecycle`, `audit_budget`)**: Staging, compaction, and context-window token budget pressure auditing (*arXiv: 2607.21503*).

---

## 📐 Architecture

```mermaid
graph TD;
    Agent[IDE Agent: Cursor / Claude Code / Windsurf] --> MCP{Krusch Context MCP<br/><b>64 Tools</b>};

    subgraph "Storage & In-Engine AI Substrate"
        MCP -- "Default Cloud Runtime" --> Polygres["⚡ Polygres Cloud v0.5.0<br/>• Native In-Engine Embeddings<br/>• 500M Free Microcredits<br/>• pgContext HNSW & pgGraph"];
        MCP -- "Self-Hosted / Local Wire" --> PG[("🐘 PostgreSQL + pgvector<br/>• Codebase Blobs & Commits<br/>• AST Symbols & Graph Edges<br/>• Episodic Memory & Nuggets")];
        MCP -- "Fast Read Cache" --> SQLite[("⚡ Local SQLite Lakebase")];
    end

    subgraph "Core Operational Engines"
        MCP --> PGGit["🧩 PG-Git Code Engine<br/>AST Chunking & Hybrid RRF"];
        MCP --> CBrain["🧠 Company Brain v2<br/>Contextmaxxing & Lineage"];
        MCP --> Auditor["🛡️ Proactive Auditor<br/>Direct-OPD Alignment Loop"];
        MCP --> SRE["🔬 AI Watch SRE Hub<br/>AgentDebugX & AREX Engine"];
    end

    subgraph "Optional External Models"
        PG -. "Custom BYO Embeddings" .-> ExtModels["Ollama / OpenRouter<br/>(e.g., BGE-large)"];
    end

    Auditor -. "Warning Nudge" .-> Agent;
    Agent -. "nudge_feedback" .-> Auditor;
```

---

## 🚀 Quick Start

### 1. Clone and Install
```bash
git clone https://github.com/kruschdev/krusch-context-mcp.git
cd krusch-context-mcp
npm install
```

### 2. Configure Your Database

Copy the template configuration:
```bash
cp .env.example .env
```

#### Option A: Polygres Cloud (Default & Recommended)
Connect your free [Polygres](https://polygres.com) project. Embeddings and vector searches are handled **100% in-engine** with zero extra API keys:
```env
POLYGRES_PROJECT_ID="your_project_id"
POLYGRES_RUNTIME_URL="https://your_project_id.api.db.polygres.com/v1"
POLYGRES_API_KEY="sk-polygres-your-key"
DATABASE_URL="postgresql://user:pass@app.polygres.com:5432/your_db?sslmode=require"
```

#### Option B: Self-Hosted PostgreSQL & Ollama
Run fully local on your own hardware using local PostgreSQL with `pgvector` and Ollama:
```env
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/contextdb"
OLLAMA_URL="http://127.0.0.1:11434"
```

*(Optional: If you prefer bringing custom cloud models like BAAI BGE-large, set `EMBEDDING_URL="https://openrouter.ai/api/v1/embeddings"`, `EMBEDDING_API_KEY`, and `EMBED_MODEL="baai/bge-large-en-v1.5"`).*

### 3. Ingest Your Codebase (Optional but Recommended)
```bash
npm run snapshot -- .
```

### 4. Register in Your IDE

Add to your IDE MCP configuration (e.g., `.cursor/mcp.json` or Claude Desktop config):

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

Restart your IDE — your agent now has immediate access to all **64 tools**.

---

## 💡 Practical Agent Workflows

### Workflow 1: Polygres Cloud Quota & Pure-Text Search
```javascript
// Check live free microcredits inside Claude Code or Cursor
await polygres_cloud_usage();
// => "Polygres Cloud Usage: 500.00M / 500.00M microcredits remaining (0.00M used)"

// Search cloud collections using pure text (vectorized in-engine by Polygres)
await polygres_cloud_search({
  collection: "project_knowledge",
  text: "How does the authentication session lifecycle work?",
  limit: 5
});
```

### Workflow 2: AST Symbol Search & Dependency Exploration
```javascript
// Search specific classes, functions, or routes without scanning whole files
await krusch_context_search_symbols({
  query: "verifySessionToken",
  project: "krusch-context-mcp"
});
// => Found verifySessionToken(req, res, next) at lib/auth.js:42-88

// Traverse inbound and outbound dependency edges up to 2 hops
await krusch_context_symbol_graph({
  name: "verifySessionToken",
  hops: 2
});
// => Traced 4 callers in routes/api.js and imports from db/pool.js
```

### Workflow 3: Unified Hybrid Retrieval (`krusch_context_retrieve`)
```javascript
// Single-call retrieval combining vector search, graph walks, and token budget packing
await krusch_context_retrieve({
  query: "Postgres connection pooling and idle timeout settings",
  project: "krusch-context-mcp",
  graph_hops: 2,
  limit_tokens: 3000,
  include_code: true
});
```

### Workflow 4: Proactive Trajectory Auditing & Alignment
```javascript
// Proactively evaluate proposed changes against historical lessons and rules
await krusch_context_proactive_nudge({
  history: "Refactoring database connection pool to use 50 max connections...",
  project: "krusch-context-mcp"
});
// => Warning: Prior incident logged: pool max > 25 triggers exhaustion on shared tier.

// Record developer acceptance to improve future alignment
await krusch_context_nudge_feedback({
  nudge_id: "nudge_123",
  feedback_type: "accepted",
  comment: "Reduced pool size to 20 per recommendation."
});
```

### Workflow 5: Zero-Trust Startup Deep Search
```javascript
// Verify subjective memory against objective codebase reality before writing code
await krusch_context_deep_search({
  query: "How are migrations executed on startup?",
  project: "krusch-context-mcp"
});
```

---

## 📋 Complete Tool Reference (64 Tools)

For detailed schemas and parameter guides, see **[Complete Tool Reference](docs/TOOL_REFERENCE.md)**.

| Category | Tool | Description |
| :--- | :--- | :--- |
| **Polygres Cloud (v0.5.0)** | `polygres_cloud_usage` | Inspect live monthly microcredits (generation & query usage) |
| | `polygres_cloud_search` | Pure text semantic/hybrid search with in-engine vectorization |
| | `polygres_cloud_models` | Discover available in-engine embedding models & dimensions |
| | `polygres_cloud_capabilities` | Inspect server pgContext version, HNSW limits, and contract |
| | `polygres_cloud_embedding_configs`| List watched-table background embedding pipelines |
| **Unified Retrieval** | `krusch_context_retrieve` | Single-query hybrid vector + graph walk + token budget packing |
| | `krusch_context_deep_search` | Composite zero-trust search cross-referencing memory & code |
| **Codebase & AST Engine** | `krusch_context_search_code` | Hybrid dense pgvector + BM25 RRF search over git blobs |
| | `krusch_context_search_symbols` | Search extracted AST symbols (functions, classes, routes) |
| | `krusch_context_file_symbols` | List all AST symbols defined in a specific file or blob |
| | `krusch_context_symbol_graph` | Walk symbol callers, imports, and dependencies up to $N$ hops |
| | `pg_git_search_symbols` | Standalone PG-Git alias for AST symbol search |
| | `pg_git_file_symbols` | Standalone PG-Git alias for file symbol lookup |
| | `pg_git_dependency_graph` | Standalone PG-Git alias for symbol graph traversal |
| | `krusch_context_list_repos` | Browse indexed repositories registered in PostgreSQL |
| | `krusch_context_read_tree` | Inspect repository directory trees in the Git DAG |
| | `krusch_context_read_blob` | Retrieve complete file content by blob hash or path |
| **Episodic Memory** | `krusch_context_add_memory` | Store persistent memory (bug, lesson, priority, outcome) |
| | `krusch_context_supersede_memory` | MobileMem temporal fact superseding with revision lineage |
| | `krusch_context_invalidate_memory`| Invalidate obsolete memory record from active retrieval |
| | `krusch_context_search_memory` | Semantic search with recency decay & dynamic GRASP filters |
| | `krusch_context_list_memories` | List recent memories filtered by category and project |
| | `krusch_context_update_memory` | Update memory content, project, or metadata |
| | `krusch_context_delete_memory` | Delete memory record by ID |
| | `krusch_context_consolidate` | Centroid-based semantic memory compression & deduplication |
| **Steering Nuggets** | `krusch_context_nugget_remember` | Store key-value steering fact (conventions, preferences) |
| | `krusch_context_nugget_nudges` | Semantically retrieve steering facts relevant to task |
| | `krusch_context_nugget_list` | List active steering nuggets for project |
| | `krusch_context_nugget_forget` | Delete steering fact by key |
| **Company Brain v2** | `krusch_context_compile_state` | Contextmaxxing — compile multi-scale project state |
| | `krusch_context_write_state` | Stateful write with optimistic concurrency and lineage |
| | `krusch_context_resolve_conflict`| Merge conflicting sibling states and deprecate old branches |
| | `krusch_context_get_provenance` | Trace interaction lineage and version history |
| | `krusch_context_search_lens` | Role-filtered semantic search (Architect, SRE, Product) |
| | `krusch_context_traverse_graph`| Traverse parent/child state lineage and linked blobs |
| | `krusch_context_update_ontology`| Manage project tags and domain ontology nodes |
| | `krusch_context_link_blob` | Create explicit edges between episodic memory and code blobs |
| **Auditing & Safety** | `krusch_context_proactive_nudge` | Trajectory threat auditor — warn on rule or bug recurrence |
| | `krusch_context_nudge_feedback` | Record developer feedback as Direct-OPD alignment signals |
| | `krusch_context_analyze_trajectory`| STRACE causal fault isolation to locate first failure step |
| | `krusch_context_think` | Cited context synthesis, conflict detection & gap analysis |
| | `krusch_context_evaluate_resilience`| Multi-Agent Resilience Gate auditing handoffs for cascades |
| **AI Watch Research & SRE**| `krusch_context_log_agent_failure` | Log execution failure, symptoms, and candidate patches |
| | `krusch_context_search_failures` | Search past agent failures by semantic symptom or role |
| | `krusch_context_get_recovery_pattern`| Retrieve validated recovery pattern and patch bundle |
| | `krusch_context_register_pipeline_operator`| Register typed, schema-validated operator in DAG registry |
| | `krusch_context_inspect_pipeline_registry`| Inspect and search registered pipeline operators |
| | `krusch_context_mutate_pipeline_dag`| Apply atomic DAG mutations (`AddNode`, `WireEdge`, `Config`) |
| | `krusch_context_setwise_rerank` | Rubric4Setwise document-set minimal covering selection |
| | `krusch_context_update_research_state`| Update AREX inner research state (evidence, constraints) |
| | `krusch_context_arex_audit` | Audit research constraints and stopping convergence |
| | `krusch_context_manage_lifecycle`| ACM context fragment staging, compaction, and eviction |
| | `krusch_context_audit_budget` | Audit ACM context window token pressure and budget |
| | `krusch_context_distill_teacher_memory`| Log hierarchical teacher trajectory for student distillation |
| | `krusch_context_retrieve_teacher_distillation`| Retrieve distilled teacher trajectories matching task |
| | `krusch_context_distill_function_memory`| Distill tool failure into Tier 3 Function Memory |
| | `krusch_context_route_skills` | Diverse Skill Routing (DSR via DPP) for orthogonal tools |
| **System & Docs** | `krusch_context_write_session_handoff`| Persist session handoff summary for background SRE review |
| | `krusch_context_read_session_review`| Read idempotent review compiled by background SRE companions |
| | `krusch_context_list_skills` | Browse registered agent skills in homelab directory |
| | `krusch_context_get_skill` | Retrieve complete skill prompt markdown instructions |
| | `krusch_docs_list` | List ingested external documentation manuals |
| | `krusch_docs_search` | Vector search within an ingested documentation manual |
| | `krusch_context_health` | Verify server status, connection pools, and model connectivity |

---

## 🧪 Testing & Verification

The test suite runs without external dependencies and includes unit, stdio smoke, and cloud integration suites:

```bash
# Automated unit tests (40/40 passing)
npm test

# Full JSON-RPC stdio smoke tests (all 64 tools live over stdio)
npm run test:smoke

# Polygres Cloud integration tests (quota tracking, in-engine search, capabilities)
npm run test:cloud

# AI Watch integration suite (AgentDebugX, DataFlow, AREX, ACM, DSR)
npm run test:aiwatch
```

---

## 📚 Academic Foundations & Research Citations

Krusch Context MCP implements and builds upon foundational techniques from leading AI and systems research:

* **Polygres AI-Native Postgres**: Database engine with native in-engine embeddings, pgContext HNSW access method, and pgGraph triplets ([Polygres.com](https://polygres.com)).
* **Diverse Skill Routing (DSR)**: Determinantal Point Process (DPP) skill routing balancing relevance with orthogonal diversity to eliminate prompt bloat ([arXiv: 2609.05824](https://arxiv.org/abs/2609.05824)).
* **Emergence World (Resilience Gate)**: Adversarial stress-testing catching cascading failures, circular delegation deadlocks, and credential leaks ([arXiv: 2609.17320](https://arxiv.org/abs/2609.17320)).
* **Hierarchical Teacher Distillation**: Workflow, subtask, and function-tier trajectory distillation empowering smaller agents ([arXiv: 2608.07169](https://arxiv.org/abs/2608.07169)).
* **MobileMem (Temporal Knowledge Invalidation)**: Lifelong agent memory with temporal fact superseding and active lineage filtering ([arXiv: 2608.13606](https://arxiv.org/abs/2608.13606)).
* **Stage-Aware Context Pruning**: Multi-stage marginal value reduction to prevent token bloat ([arXiv: 2608.08389](https://arxiv.org/abs/2608.08389)).
* **Agentic Context Management (ACM)**: Lifecycle staging, compaction, and context window budget auditing ([ArXiv: 2607.21503](https://huggingface.co/papers/2607.21503)).
* **AgentDebugX (Error Hub)**: Failure observability, root-cause attribution, and validated recovery patch distribution ([AgentDebugX GitHub](https://github.com/AgentDebugX/AgentDebugX) · [ArXiv: 2607.18754](https://arxiv.org/abs/2607.18754)).
* **DataFlow-Harness**: Grounded code-agent platform for schema-validated pipeline DAG mutations ([ArXiv: 2607.16617](https://arxiv.org/abs/2607.16617)).
* **Rubric4Setwise**: Rubric-oriented document-set selection evaluating Redundancy, Conflict, and Complementarity into minimal cover sets ([ArXiv: 2607.19238](https://arxiv.org/abs/2607.19238)).
* **AREX**: Recursively self-improving deep research agent with constraint audits ([ArXiv: 2607.21461](https://arxiv.org/abs/2607.21461)).
* **Structural Trajectory Analysis (STRACE)**: Execution path tracing and Causal Fault Isolation in versioned interaction memory ([ArXiv: 2607.07702](https://arxiv.org/abs/2607.07702)).
* **Direct On-Policy Distillation (Direct-OPD)**: Weak-to-strong feedback distillation for proactive trajectory rules ([ArXiv: 2607.05394](https://arxiv.org/abs/2607.05394)).
* **Granularity-Aware Search Policy (GRASP)**: Dynamic context depth expansion for agentic RAG ([ArXiv: 2607.10463](https://arxiv.org/abs/2607.10463)).
* **Company Brain**: Three-layer organizational memory substrate inspired by the [Sentra Company Brain Series](https://sentra.app).

---

## 🤝 Sibling Synergy with Standalone PG-Git

While Krusch Context MCP includes the complete native codebase engine, **[PG-Git](https://github.com/kruschdev/pg-git)** (`pg-git-mcp@1.1.0`) is maintained as an independent, standalone codebase RAG package. Both packages share identical PostgreSQL schemas (`repositories`, `blobs`, `code_symbols`, `code_symbol_edges`, `trees`, `commits`, `branches`), allowing single-purpose tools and full context orchestrators to query the same database seamlessly without duplicate indexing.

---

## 📄 License

MIT License © 2026 [kruschdev](https://github.com/kruschdev)

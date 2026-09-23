# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.7.0] - 2026-09-23

### Added
- **Sovereign Triad Companion Suite**:
  - Integrated `krusch-nexus` (Universal Document Ingestion & Citation Spine, 6 tools).
  - Integrated `krusch-law` (Legal Intelligence & Statute-to-Code Traceability, 8 tools).
  - Integrated `krusch-biz` (Corporate Intelligence, Controlling Clause Precedence & Diffing, 7 tools).
  - Integrated L2 Neural Semantic Router (`krusch_context_semantic_route`, 3 tools) with calibrated centroids for code, deep reasoning, high-risk, and sovereign domains.
  - Added proactive trajectory auditor guardrails in `krusch_context_proactive_nudge` for ungrounded citations, contract drafting, and statutes.
  - Added Sovereign Triad presets (`sovereign`, `triad`, `ecosystem`) mounting Core + Law + Nexus + Biz + Semantic Router (37 tools total).

### Changed
- **Architectural Separation of Research Machinery**:
  - Extracted 15 experimental research engines (AgentDebugX, DataFlow, Setwise, AREX, ACM, Teacher Distillation, Multi-Agent Resilience Gate) to the dedicated standalone companion package [`krusch-research-mcp`](file:///home/krusch/homelab/projects/krusch-research-mcp).
  - Folded in-memory token deduplication (`selectMinimalCoveringSet`) directly into `src/prune-helper.js` for server-side token budget packing in `unifiedRetrieve`.
  - Moved `src/extensions/company-brain/v2-engine.js` to internal `src/v2-engine.js` for interaction memory writes, eliminating exposed extension overhead.
  - Pruned stale companion servers (`skills-docs`, `session-bridge`, `company-brain`).
  - Streamlined `krusch-context-mcp` product surface to strictly 13 core daily driver tools (~900 tokens) and companion sovereign domain extensions.
  - Updated tool contract tests (`tests/tool-contract.test.js`) to enforce 0 research tools, 0 collisions, and audited documentation against stale full-suite claims.

## [1.6.3] - 2026-09-18

### Added
- **Embedding Dimension Single Source of Truth & Runtime Poison Guard**:
  - Enforced `getConfiguredEmbeddingDim()` resolving `EMBED_DIMS` (default: 1024) across the entire engine.
  - Implemented `validateVectorDimension()` runtime guard in `getEmbedding()` and `getOllamaEmbedding()`, immediately rejecting poison vectors with mismatched dimensions before database operations.
  - Added automated PostgreSQL vector column dimension inspection in `krusch_context_health`, dynamically validating `ide_agent_memory`, `ide_agent_nuggets`, and `blobs` against configured dimensions.
  - Added transactional schema migration script [`db/migrate_dimensions.sql`](db/migrate_dimensions.sql) to easily alter vector columns and rebuild HNSW indexes between 1024-d and 1536-d.
- **Frozen Benchmark Fixtures (`evals/fixtures/`)**:
  - Published frozen, versioned JSON benchmark fixtures:
    - [`evals/fixtures/corpus_14_ablation.json`](evals/fixtures/corpus_14_ablation.json) (14-query in-corpus ablation).
    - [`evals/fixtures/express_benchmark_10.json`](evals/fixtures/express_benchmark_10.json) (10-query foreign codebase benchmark on Express).
  - Added contract tests in `tests/eval-fixtures.test.js` verifying fixture schema and query invariants.
- **Public Foreign Codebase Evaluation (`npm run eval:foreign`)**:
  - Validated retrieval generalization on `expressjs/express` (206 files, 167 blobs, 3,354 symbols).
  - Empirical results show Hybrid RRF delivering **70.0% Recall@1 / 0.783 MRR (60.0% on code identifiers)**, outperforming Dense alone (60.0% R@1 / 0.733 MRR, 40.0% on code identifiers):
    | Method | Recall@1 | Recall@5 | Recall@10 | MRR | Identifiers R@1 | Semantic R@1 |
    |---|---|---|---|---|---|---|
    | **BM25 Lexical** | 10.0% (1/10) | 10.0% (1/10) | 10.0% (1/10) | 0.100 | 20.0% (1/5) | 0.0% (0/5) |
    | **Dense Cosine** (1024-d) | 60.0% (6/10) | 90.0% (9/10) | 90.0% (9/10) | 0.733 | 40.0% (2/5) | 80.0% (4/5) |
    | **Hybrid RRF** (`search_code`) | **70.0% (7/10)** | **90.0% (9/10)** | **90.0% (9/10)** | **0.783** | **60.0% (3/5)** | **80.0% (4/5)** |
- **AST Chunker CommonJS Support**:
  - Enhanced `src/ast-chunker.js` to extract CommonJS and prototype method assignments (`exports.foo = function`, `res.format = function`, etc.).

### Changed
- Aligned documentation, `.env.example`, and setup guides to emphasize `baai/bge-large-en-v1.5` (1024 dims) as the sovereign zero-VRAM drop-in model.
- Synchronized server version to `1.6.3` across `package.json`, core MCP server, and all 5 companion servers.

## [1.6.2] - 2026-09-18

### Added
- **3-Way Retrieval Accuracy Benchmark (`scripts/eval_accuracy.js`)**:
  - Implemented empirical 3-way ablation suite comparing pure BM25 lexical search, pure dense vector search (`bge-large` 1024-d), and Hybrid Reciprocal Rank Fusion (`search_code`).
  - Evaluated on 14 technical benchmarks across conceptual architecture and exact code identifiers, demonstrating Hybrid RRF delivering **92.9% Recall@1 (100% on code identifiers) and 0.964 MRR**, outperforming pure Dense (78.6% R@1 / 0.881 MRR) and pure BM25 (21.4% R@1 / 0.238 MRR).
- **Agent Ergonomics & Automatic Project Grounding**:
  - Implemented automatic git repository detection (`detectCurrentProject()`) across `compileProjectState`, `unifiedRetrieve`, `searchBlobs`, and memory engines, eliminating tedious manual project arguments.
  - Added compound single-turn retrieval (`unifiedRetrieve` with `include_state=true`) packing real-time git status, active episodic memories, and structural symbols into a single MCP turn.
  - Added core agent protocol prompts (`session_start`, `pre_commit`) for Cursor and Claude Code.
- **Zero-VRAM Inference & OpenRouter Auto-Routing**:
  - Added zero-VRAM cloud inference support with automatic OpenRouter routing for embeddings (`baai/bge-large-en-v1.5`, 1024-d drop-in matching sovereign schema) and chat completions (`google/gemini-2.5-flash`).
  - Added zero-dependency regex heuristic fallback tagger for keyword extraction when no local LLM or API keys are present.
- **Automated Tool Contract Invariants (`tests/tool-contract.test.js`)**:
  - Added CI contract tests enforcing tool counts (13 Core, 26 Extended Core, 35 Companion Extensions, 61 Full Suite), zero naming collisions, and documentation synchrony.

### Changed
- Synchronized server version to `1.6.2` across `package.json`, core MCP server, and all 5 companion servers (`company-brain`, `polygres-cloud`, `research`, `session-bridge`, `skills-docs`).
- Updated `docs/EVALS.md` with complete 3-way ablation tables and empirical analysis.

## [1.6.1] - 2026-09-18

### Security
- **CVE-2026-13676 Transitive Dependency Override**: Pinned `fast-uri` to `4.1.3` via npm overrides, neutralizing the URI parsing vulnerability in transitive `@modelcontextprotocol/sdk` and `ajv` dependencies.

### Fixed
- **Tool-Count Discrepancy & Registration Reconciliation**: Added `krusch_context_nudge_feedback` to the `EXTENDED_CORE_TOOLS` set (13 extended tools), bringing the Extended Core profile to 26 tools total (13 core + 13 extended) and the Full monolithic suite to exactly 61 tools (26 + 35 companion extensions). Eliminates runtime log and schema off-by-one discrepancies.
- **Server Version Synchronization**: Synchronized MCP server initialization handshake and health check reporting to version `1.6.1` across core and all companion extension servers (`polygres-cloud`, `company-brain`, `research`, `session-bridge`, `skills-docs`).
- **Documentation & Specification Alignment**: Aligned tool counts across `AGENTS.md`, `README.md`, and `docs/TOOL_REFERENCE.md` to reflect 13 Core, 26 Extended Core, 35 Companion Extensions, and 61 Full Suite tools.

## [1.6.0] - 2026-09-18

### Added
- **Decoupled Architecture (Core + 5 Modular Companion Extensions)**:
  - Reorganized monolith into a 13-tool Sovereign Core Engine with 5 independent companion extensions under `src/extensions/` (`company-brain`, `research`, `polygres-cloud`, `session-bridge`, `skills-docs`).
  - Added standalone runnable MCP servers for all 5 companion extensions (`npm run start:research`, `npm run start:company-brain`, `npm run start:cloud`, `npm run start:session`, `npm run start:skills`).
  - Dynamic extension loader in `src/extensions/index.js` supporting `--extensions=...` and `KRUSCH_EXTENSIONS=...`.
- **Memory Hygiene Promoted to Core**:
  - Promoted `krusch_context_supersede_memory` and `krusch_context_invalidate_memory` into the Sovereign Core profile (13 tools default), enabling active knowledge deprecation out-of-the-box.
- **Accuracy Benchmark**:
  - Added `scripts/eval_accuracy.js` (`npm run eval:accuracy`) evaluating retrieval Recall@k and publishing empirical evaluations.

### Changed
- **Sovereign Local-First Identity**:
  - Reaffirmed local PostgreSQL + Ollama (`bge-large`, 1024 dims) as the primary sovereign default (13 tools, ~900 prompt tokens).
  - Polygres Cloud cleanly decoupled as an optional high-throughput turnkey cloud runtime and companion extension (`npm run start:cloud`), eliminating automatic vendor push.
- **Accurate Profile Tiers**:
  - `core` (13 tools, default)
  - `extended` (26 tools: Core + memory lifecycle, Git DAG inspection, cited thinking, nudge feedback)
  - Companion Extensions (35 tools across 5 extensions: `research` [15], `company-brain` [8], `polygres-cloud` [5], `skills-docs` [5], `session-bridge` [2])
  - `full` (61 tools: Core + Extended + all 5 companion extensions in-process)
- **Backward-Compatibility Re-Exports**: Retained lightweight re-exports in `src/` (`v2-engine.js`, `agentdebugx-engine.js`, `session-engine.js`, etc.) pointing to `src/extensions/` to maintain 100% compatibility for external consumers.
- **Clean Server Startup**: Stripped unneeded experimental and v2 table migrations from core startup (`verifyDatabase()` now strictly checks only core memory and git tables).

### Fixed
- **Secrets and Configuration Hygiene**: Scrubbed all internal IPs, hostnames, and database credentials from `README.md`, `spec.md`, and sample configuration files.
- **Smoke Test Profiles Consistency**: Aligned standalone JSON-RPC test runners (`test_v2_memory.js`, `test_v2_lens_graph.js`, `test_v2_action_memory.js`, `test_teacher_distillation.js`, `test_think.js`, `test_feedback.js`) to default `KRUSCH_PROFILE` to `full` when executed individually.

## [1.5.0] - 2026-09-16

> *Archival Note*: Version 1.5.0 represents the pre-decoupling monolithic architecture (64 tools in-process). In version 1.6.0+, the server was refactored into a 13-tool Sovereign Core with 5 modular companion MCP extensions (61 tools total across the suite).

### Added
- **Polygres Cloud v0.5.0 Runtime Integration (`src/polygres-cloud.js`)**: Direct agent control over cloud collections, in-engine text vectorization, model discovery, and quota monitoring.
- **Native In-Engine Embeddings Out-of-the-Box**: Configured Polygres native in-engine embeddings (`text-embedding-3-small`, `text-embedding-3-large`) as the zero-config default, eliminating external embedding API keys, local VRAM requirements, and data movement.
- **5 New Polygres Cloud MCP Tools (64 Tools Total)**:
  - `polygres_cloud_usage`: Live quota monitoring tracking the 500M monthly free microcredits directly from Cursor & Claude Code.
  - `polygres_cloud_search`: Pure-text semantic and hybrid search with in-engine vectorization.
  - `polygres_cloud_models`: Discovers available in-engine embedding models and dimensions.
  - `polygres_cloud_capabilities`: Inspects server-side pgContext version, HNSW limits, and contract.
  - `polygres_cloud_embedding_configs`: Lists watched-table automated in-database embedding pipelines.
- **Dual-Engine Adapter (`@krusch/toolkit/polygres`)**: Seamless switching between direct local PostgreSQL wire pool and Polygres Cloud Runtime API.
- Automated integration test suite `tests/test_polygres_cloud.js`.

### Changed
- Expanded total MCP tool count from 59 to **64 tools**.
- Streamlined `README.md` into 5 core capability pillars, updated mermaid architecture diagram, and clarified dual-path setup.
- Updated `docs/TOOL_REFERENCE.md`, `docs/POLYGRES_DOCUMENTATION.md`, `docs/SETUP.md`, `docs/EPISODIC_MEMORY.md`, and `docs/KRUSCH_CONTEXT_MCP_DEEP_DIVE.md`.
- Bumped package version to `1.5.0`.

## [1.4.0] - 2026-09-16

### Added
- **Diverse Skill Routing (DSR, arXiv: 2609.05824)**: Added `krusch_context_route_skills` tool using Determinantal Point Processes (DPP) to retrieve orthogonal, non-redundant agent skills matching a task query without token bloat.
- **Emergence World Multi-Agent Resilience Gate (arXiv: 2609.17320)**: Added `krusch_context_evaluate_resilience` tool for auditing multi-agent execution traces, detecting cascading failure depth, circular delegation deadlocks, and credential leakage across agent handoffs.
- **Hierarchical Teacher Memory Distillation (arXiv: 2608.07169)**: Added `krusch_context_distill_teacher_memory`, `krusch_context_retrieve_teacher_distillation`, and `krusch_context_distill_function_memory` for logging and retrieving cross-model student trajectory corrections.
- **Temporal Fact Superseding & Invalidation (MobileMem, arXiv: 2608.13606)**: Added `krusch_context_supersede_memory` and `krusch_context_invalidate_memory` with lineage tracking and exclusion of superseded records from active semantic retrieval.
- Automated unit test suite `tests/research-tools.test.js` covering DSR and Resilience Gate evaluations.

### Fixed
- **Missing `session_handoffs` Migration**: Added `initSessionEngineTable()` in `src/session-engine.js` and wired into `src/index.js` database startup, resolving `relation "session_handoffs" does not exist` errors on fresh databases.
- **Homelab Path & Standalone Portability**: Generalized `HOMELAB_ROOT` in `src/session-engine.js` to dynamically resolve `process.env.HOMELAB_ROOT || (process.env.HOME ? path.join(process.env.HOME, 'homelab') : process.cwd())`. Embedded self-contained algorithms (`routeDiverseSkills`, `evaluateMultiAgentResilience`, `filterActiveMemories`, `prune-helper.js`) ensuring 100% standalone execution without monorepo dependencies.
- **Privacy & Secrets Sanitization**: Audited and scrubbed all private homelab IP addresses, real database passwords, internal node names, and internal configurations from git tracking and documentation.
- **Test Runner Environment**: Updated `npm test` script in `package.json` to load `--env-file=.env`, preventing PostgreSQL connection timeouts.
- **Defensive Repository Queries**: Updated `tests/memory-engine.test.js` to gracefully skip if the Git repository table has not been initialized.

### Changed
- Expanded total MCP tool count to **53 tools**.
- Bumped server and package version to `1.4.0`.

## [1.3.0] - 2026-07-24

### Added
- **AgentDebugX Engine (`src/agentdebugx-engine.js`)**: Failure observability, trajectory root-cause attribution, and Error Hub recovery patch retrieval (`krusch_context_log_agent_failure`, `krusch_context_search_failures`, `krusch_context_get_recovery_pattern`). Based on ArXiv: 2607.18754.
- **DataFlow-Harness Engine (`src/dataflow-engine.js`)**: Grounded code-agent platform for constructing editable data/ingestion pipelines via typed, schema-validated DAG mutations (`krusch_context_register_pipeline_operator`, `krusch_context_inspect_pipeline_registry`, `krusch_context_mutate_pipeline_dag`). Based on ArXiv: 2607.16617.
- **Rubric4Setwise Selection Engine (`src/setwise-engine.js`)**: Rubric-oriented document-set selection evaluating Redundancy, Conflict, and Complementarity into minimal covering context sets (`krusch_context_setwise_rerank` & `setwise_rerank` in `unifiedRetrieve`). Based on ArXiv: 2607.19238.
- **AREX Deep Research Engine (`src/arex-engine.js`)**: Recursively self-improving inner research evidence tracking paired with outer self-improvement constraint audits (`krusch_context_update_research_state`, `krusch_context_arex_audit`). Based on ArXiv: 2607.21461.
- Automated integration test suite `tests/test_ai_watch_integrations.js`.

### Changed
- Expanded total MCP tool count from 33 to 42 tools.
- Updated `README.md`, `INFLIGHT.md`, and project documentation with formal citations and paper acknowledgments.

## [1.2.0] - 2026-07-17

### Added
- Trajectory auditing and analysis tool `krusch_context_analyze_trajectory` utilizing STRACE for step-level execution path tracing and Causal Fault Isolation in versioned interaction memory.
- Multi-scale context block compilation (micro, meso, and macro scales) in the proactive auditor (`krusch_context_proactive_nudge`).
- Automated tests and client smoke tests for the trajectory analysis tool.
- Initial preparation for open-source release (SpectralQuant Ollama Bridge support).

### Changed
- Updated documentation across `AGENTS.md`, `README.md`, and `docs/TOOL_REFERENCE.md` to list and describe all 32 MCP tools.
- Optimistically truncated trace fields in memory state updates to prevent database bloat.
- Rewrote `README.md` to meet documentation standards (badges, capabilities table, setup instructions).
- Moved hardcoded database credentials to environment variables (`.env`).
- Updated `docker-compose` volume mounts for improved containerization.

### Fixed
- Stabilized MCP server by replacing hardcoded local paths with environment-aware configurations.

### Security
- Generated and applied standard MIT License.
- Ensured project directory and sensitive files are correctly ignored via `.gitignore`.

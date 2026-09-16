# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.4.0] - 2026-09-16

### Added
- **Diverse Skill Routing (DSR, arXiv: 2609.05824)**: Added `krusch_context_route_skills` tool using Determinantal Point Processes (DPP) to retrieve orthogonal, non-redundant agent skills matching a task query without token bloat.
- **Emergence World Multi-Agent Resilience Gate (arXiv: 2609.17320)**: Added `krusch_context_evaluate_resilience` tool for auditing multi-agent execution traces, detecting cascading failure depth, circular delegation deadlocks, and credential leakage across agent handoffs.
- **Hierarchical Teacher Memory Distillation (arXiv: 2608.07169)**: Added `krusch_context_distill_teacher_memory`, `krusch_context_retrieve_teacher_distillation`, and `krusch_context_distill_function_memory` for logging and retrieving cross-model student trajectory corrections.
- **Temporal Fact Superseding & Invalidation (MobileMem, arXiv: 2608.13606)**: Added `krusch_context_supersede_memory` and `krusch_context_invalidate_memory` with lineage tracking and exclusion of superseded records from active semantic retrieval.
- Automated unit test suite `tests/research-tools.test.js` covering DSR and Resilience Gate evaluations.

### Fixed
- **Missing `session_handoffs` Migration**: Added `initSessionEngineTable()` in `src/session-engine.js` and wired into `src/index.js` database startup, resolving `relation "session_handoffs" does not exist` errors on fresh databases.
- **Ollama 404 Tag Model Fallback**: Updated default `TAG_MODEL` in `src/llm-tags.js` to `qwen2.5-coder:1.5b` (matching installed local models), eliminating HTTP 404 retries and tag generation warnings.
- **Homelab Path Portability**: Generalized `HOMELAB_ROOT` in `src/session-engine.js` to dynamically resolve `process.env.HOMELAB_ROOT || '/home/krusch/homelab'`.
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

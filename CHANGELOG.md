# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

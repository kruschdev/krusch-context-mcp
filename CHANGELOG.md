# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

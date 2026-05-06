# Krusch Context MCP - Session State

**Status**: Stable, Production-Ready.
**Last Updated**: 2026-05-06

## Current State
- The repository documentation (`README.md`) has been fully standardized to match the broader homelab ecosystem.
- Visual assets (`banner.png`, `social-preview.png`) generated and integrated.
- Tool naming standardized to `krusch_context_*` across 11 tools.
- "Krusch Memory MCP" renamed to "Krusch Context MCP" in the documentation.

## Fragile Files / Transient State
- `src/memory-engine.js`: Contains specific `ide_agent_memory` column definitions (`project`, `tags`). The `verifyDatabase()` function maintains idempotent schema creation.
- The `_embedding` internal parameter must remain untouched in `searchMemory`/`addMemory` for `krusch_context_deep_search` optimization.
- The repository shares environment configurations with `pg-git` and does NOT have its own `.env` file.

## Pending Migrations / Next Steps
- Implement an Ollama prioritization queue for core homelab services.
- Expand integration tests for `read_tree`, `read_blob`, and `consolidate` utility tools.
- Monitor memory and CPU overhead following the consolidation of previously siloed MCP servers.

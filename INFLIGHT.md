# Krusch Context MCP - Session State

**Status**: Stable, Prioritized Fleet Routing Implemented.
**Last Updated**: 2026-05-06

## Current State
- Implemented `ollamaQueue` (`@krusch/toolkit/llm-queue.js`) to manage concurrent Ollama requests across the fleet nodes (`kruschgame`, `kruschdev`, `kruschserv`).
- Updated `pg-git/lib/embedding.js` to enqueue tasks with `LOW` priority by default.
- Refactored `krusch-context-mcp/src/memory-engine.js` to route `searchMemory` queries with `HIGH` priority, leapfrogging bulk batch processing.
- Tool surface verified: 14 tools active. No schema migrations pending.

## Fragile Files / Transient State
- `src/memory-engine.js`: Contains specific `ide_agent_memory` column definitions (`project`, `tags`). The `_embedding` internal parameter must remain untouched in `searchMemory`/`addMemory` for `krusch_context_deep_search` optimization.
- `../../lib/llm-queue.js`: Shared fleet queue. Ensure any changes respect `concurrency` caps to prevent overwhelming local VRAM.

## Pending / Next Steps
- `[ ]` Expand integration tests for `read_tree`, `read_blob`, and `consolidate` utility tools.
- `[ ]` Monitor fleet inference latency now that multiple agents are forced through the Priority Queue during deep context searches.
- `[ ]` Monitor memory and CPU overhead following the consolidation of previously siloed MCP servers.
- `[ ]` Evaluate the accuracy of the `qwen2.5-coder:1.5b` embeddings for very large repositories.

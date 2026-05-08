# INFLIGHT - krusch-context-mcp

## Tool Surface Status
- Tools: `krusch_context_add_memory`, `krusch_context_search_memory`, `krusch_context_list_memories`, `krusch_context_delete_memory`, `krusch_context_update_memory`, `krusch_context_consolidate`, `krusch_context_search_code`, `krusch_context_list_repos`, `krusch_context_read_tree`, `krusch_context_read_blob`, `krusch_context_deep_search`, `krusch_context_health_check`
- Status: 12 tools operational. `searchMemory` and `consolidateMemories` refactored and JSDoc added. No known broken tools.
- Asynchronous Sync: Verified passing; stale 1536-dimensional rows cleared from SQLite cache for `krusch-nexus`.

## Pending Schema Migrations
- `pg_synced` column was added to `ide_agent_nuggets` in SQLite.
- `pg_id` column was added to `ide_agent_memory` in SQLite.
- No pending migrations.

## Ollama Model / Fleet Health
- Fleet nodes are throwing `500 Context Length` errors (input length exceeds context length for `512` context limit on `bge-large` with large files like `memory-engine.js`). This is known and tracked.
- `sync_to_pg.js` skips these gracefully but they flood logs.

## Fragile Files / Transient State
- `src/sqlite-engine.js`: Schema evolution logic is fragile; migrations must be completely idempotent.
- `src/memory-engine.js`: `_calculateCentroidStr` strictly assumes identical dimension lengths between arrays.

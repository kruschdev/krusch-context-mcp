# krusch-context-mcp — Agent Context

> Unified MCP server: PG-Git codebase search + Homelab episodic memory.

## Key Constraints

- **Database schema (`ide_agent_memory`)**: Must maintain `project` and `tags` columns added via dynamic migration. Do NOT alter the column order or types — backward compatibility with existing episodic records is critical.
- **pg-git dependency**: All DB pooling and embedding logic is imported from the sibling `pg-git` project via `file:` link. This project has NO `.env` of its own — it inherits `pg-git/.env` configuration.
- **Ollama model**: Embeddings use `qwen2.5-coder:1.5b` (1536 dims). Tag generation uses `llama3.2` for keyword extraction.

## Tool Surface

| Tool | Source |
|------|--------|
| `krusch_context_add_memory` | `src/memory-engine.js` |
| `krusch_context_search_memory` | `src/memory-engine.js` |
| `krusch_context_list_memories` | `src/memory-engine.js` |
| `krusch_context_delete_memory` | `src/memory-engine.js` |
| `krusch_context_update_memory` | `src/memory-engine.js` |
| `krusch_context_consolidate` | `src/memory-engine.js` (semantic dedup + merge) |
| `krusch_context_search_code` | `src/index.js` (calls `pg-git/server/git-engine.js`) |
| `krusch_context_list_repos` | `src/index.js` (calls `pg-git/server/git-engine.js`) |
| `krusch_context_read_tree` | `src/index.js` (calls `pg-git/server/git-engine.js`) |
| `krusch_context_read_blob` | `src/index.js` (calls `pg-git/server/git-engine.js`) |
| `krusch_context_deep_search` | `src/index.js` (composite, all categories) |
| `krusch_context_health_check` | `src/index.js` (DB connectivity + counts) |

## Fragile / Don't Touch

- `ide_agent_memory` column migrations in `verifyDatabase()` — these are idempotent guards
- The `_embedding` internal parameter on `searchMemory`/`addMemory` — used for dedup optimization in `krusch_context_deep_search`

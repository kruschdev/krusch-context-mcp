# krusch-context-mcp — Agent Context

> Unified MCP server: PG-Git codebase search + Homelab episodic memory.

## Key Constraints

- **Database schema (`ide_agent_memory`)**: Must maintain `project` and `tags` columns added via dynamic migration. Do NOT alter the column order or types — backward compatibility with existing episodic records is critical.
- **pg-git dependency**: All DB pooling and embedding logic is imported from the sibling `pg-git` project via `file:` link. This project has NO `.env` of its own — it inherits `pg-git/.env` configuration.
- **Ollama model**: Embeddings use `qwen2.5-coder:1.5b` (1536 dims). Tag generation uses `llama3.2` for keyword extraction.

## Tool Surface

| Tool | Source |
|------|--------|
| `mcp_homelab-memory_add` | `src/memory-engine.js` |
| `mcp_homelab-memory_search` | `src/memory-engine.js` |
| `mcp_homelab-memory_list` | `src/memory-engine.js` |
| `mcp_homelab-memory_delete` | `src/memory-engine.js` |
| `mcp_homelab-memory_update` | `src/memory-engine.js` |
| `pg_git_semantic_search` | `src/index.js` (calls `pg-git/server/git-engine.js`) |
| `pg_git_list_repos` | `src/index.js` (calls `pg-git/server/git-engine.js`) |
| `deep_context_search` | `src/index.js` (composite, all categories) |

## Fragile / Don't Touch

- `ide_agent_memory` column migrations in `verifyDatabase()` — these are idempotent guards
- The `_embedding` internal parameter on `searchMemory`/`addMemory` — used for dedup optimization in `deep_context_search`

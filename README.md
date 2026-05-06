# krusch-context-mcp

Unified MCP server that merges **PG-Git** (semantic codebase search) with **Homelab Memory** (episodic bug/lesson/priority tracking) into a single context engine for AI coding agents.

## Why

Previously, each IDE agent session needed two separate MCP servers (`pg-git-mcp` + `krusch-memory-mcp`), each with its own Node.js process, PostgreSQL pool, and Ollama connection. This unified server:

- **Shares a single `pg.Pool`** connected to `kruschdb` on `kruschserv:5434`
- **Shares Ollama embedding logic** with fleet-wide round-robin load balancing
- **Provides `krusch_context_deep_search`** — a composite tool that queries both codebase and memory in one call

## Tools

| Tool | Description |
|------|-------------|
| `krusch_context_add_memory` | Store an episodic memory (bug, lesson, priority, outcome, activity) |
| `krusch_context_search_memory` | Semantic search over episodic memories with temporal decay |
| `krusch_context_list_memories` | List recent memories by category (no embedding, fast) |
| `krusch_context_delete_memory` | Delete a memory by ID |
| `krusch_context_update_memory` | Update content/tags/project (re-embeds on content change) |
| `krusch_context_consolidate` | Find and merge semantically duplicate memories |
| `krusch_context_search_code` | Semantic search over all indexed codebase files |
| `krusch_context_list_repos` | List all repositories indexed in PG-Git |
| `krusch_context_read_tree` | Browse the file tree of an indexed repository |
| `krusch_context_read_blob` | Read full content of a specific file by blob ID |
| `krusch_context_deep_search` | Composite zero-trust search across both memory and codebase |

## Setup

```bash
# Requires pg-git sibling project with .env configured
npm install
npm start
```

### MCP Config (Antigravity)

```json
{
  "krusch-context-mcp": {
    "command": "node",
    "args": ["/home/kruschdev/homelab/projects/krusch-context-mcp/src/index.js"]
  }
}
```

## Architecture

- **Database**: PostgreSQL + pgvector (`kruschdb` on `kruschserv:5434`)
- **Embeddings**: Ollama `qwen2.5-coder:1.5b` @ 1536 dims, fleet load-balanced
- **Tables**: `blobs` (codebase), `ide_agent_memory` (episodic)
- **Protocol**: MCP Stdio transport

## Testing

```bash
node test_client.js
```

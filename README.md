# krusch-context-mcp

Unified MCP server that merges **PG-Git** (semantic codebase search) with **Homelab Memory** (episodic bug/lesson/priority tracking) into a single context engine for AI coding agents.

## Why

Previously, each IDE agent session needed two separate MCP servers (`pg-git-mcp` + `krusch-memory-mcp`), each with its own Node.js process, PostgreSQL pool, and Ollama connection. This unified server:

- **Shares a single `pg.Pool`** connected to `kruschdb` on `kruschserv:5434`
- **Shares Ollama embedding logic** with fleet-wide round-robin load balancing
- **Provides `deep_context_search`** — a composite tool that queries both codebase and memory in one call

## Tools

| Tool | Description |
|------|-------------|
| `mcp_homelab-memory_add` | Store an episodic memory (bug, lesson, priority, outcome, activity) |
| `mcp_homelab-memory_search` | Semantic search over episodic memories with temporal decay |
| `mcp_homelab-memory_list` | List recent memories by category (no embedding, fast) |
| `mcp_homelab-memory_delete` | Delete a memory by ID |
| `mcp_homelab-memory_update` | Update content/tags/project (re-embeds on content change) |
| `pg_git_semantic_search` | Semantic search over all indexed codebase files |
| `pg_git_list_repos` | List all repositories indexed in PG-Git |
| `deep_context_search` | Composite zero-trust search across both memory and codebase |

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

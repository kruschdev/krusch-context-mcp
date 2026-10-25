# ⚙️ Setup & Operations Guide (v1.9.0)

> Zero-Docker, SQLite-first setup for AI coding agents.
> For the canonical tool reference, see [TOOL_REFERENCE.md](TOOL_REFERENCE.md).

---

## ⚡ Happy Path: Zero-Docker Setup (30 Seconds)

`krusch-context-mcp` runs 100% locally on Node 22 built-in SQLite (`node:sqlite`). It requires **zero Docker containers**, zero native C++ compilation, and zero database setup out of the box.

### Prerequisites
* **Node.js**: `>= 22.0.0` (Verify with `node -v`)

### Step 1: Initialize Workspace
Inside your project repository, run:

```bash
npx krusch-context-mcp init
```

This command will:
1. Detect your current git project name.
2. Initialize `.agent/context.db` with schema and indexes.
3. Seed starter project guidelines and invariants.
4. Output copy-paste configuration snippets for your IDE.

---

### Step 2: Configure Your IDE / Agent

#### Cursor IDE (`.cursor/mcp.json` or Global Settings)
```json
{
  "mcpServers": {
    "krusch-context": {
      "command": "npx",
      "args": ["-y", "krusch-context-mcp"]
    }
  }
}
```

#### Claude Code (Terminal CLI)
```bash
claude mcp add krusch-context -- npx -y krusch-context-mcp
```

#### Claude Desktop (`claude_desktop_config.json`)
```json
{
  "mcpServers": {
    "krusch-context": {
      "command": "npx",
      "args": ["-y", "krusch-context-mcp"]
    }
  }
}
```

---

### Step 3: Verify Health

Verify that the server is operational:

```bash
npx krusch-context-mcp health
```

Expected output:
```text
✅ Storage Mode: sqlite
✅ Database Path: /path/to/project/.agent/context.db
✅ Health Status: healthy (Node v22.x.x)
📦 Active Memories: 1 | Nuggets: 1
```

---

## 🐘 Optional: PostgreSQL Fleet Mode

For team environments or multi-machine fleets sharing a centralized persistent database, `krusch-context-mcp` supports PostgreSQL:

1. Create a `.env` file in your workspace:
   ```bash
   STORAGE_MODE="postgres"
   DATABASE_URL="postgresql://postgres:password@localhost:5432/context_db"
   ```
2. The server will automatically connect to PostgreSQL and sync with local project caches.
3. If PostgreSQL is temporarily unreachable, the engine gracefully falls back to local SQLite without crashing.

---

## 🧠 Optional: Semantic Embedding Backends

By default, `krusch-context-mcp` uses deterministic lexical keyword matching, Porter-stemmed `FTS5` search (`ide_agent_memory_fts`), recency scoring, and heuristic tag indexing. If you wish to enable dense `1024`-dimensional vector embeddings:

### Option A: Local Ollama (Zero Cloud, `8,192`-Token Context)
```bash
ollama pull snowflake-arctic-embed2
```
In `.env`:
```bash
OLLAMA_URL="http://127.0.0.1:11434"
EMBED_MODEL="snowflake-arctic-embed2"
EMBED_DIMS=1024
```
*(Also supports `qwen3-embedding:0.6b` / `qwen3-embedding:4b` via Matryoshka `1024d` truncation, `nomic-embed-text`, and legacy `bge-large`.)*

### Option B: Cloud OpenRouter (Zero Local VRAM)
In `.env`:
```bash
OPENROUTER_API_KEY="sk-or-v1-your-key-here"
EMBED_MODEL="baai/bge-large-en-v1.5"
EMBED_DIMS=1024
```

---

## 🧩 Sibling Companion Repositories

Codebase search and domain-specific engines run as separate MCP servers:

* **Personal AI Assistant**: [`krusch-companion`](https://github.com/kruschdev/krusch-companion)
* **Microsecond Cascade Routing**: [`krusch-cascade-router`](https://github.com/kruschdev/krusch-cascade-router)
* **Codebase RAG & AST Search**: [`krusch-git`](https://github.com/kruschdev/krusch-git)
* **Document Ingestion**: [`krusch-nexus`](https://github.com/kruschdev/krusch-nexus)
* **Statutory Compliance**: [`krusch-law`](https://github.com/kruschdev/krusch-law)
* **Contract Precedence**: [`krusch-biz`](https://github.com/kruschdev/krusch-biz)

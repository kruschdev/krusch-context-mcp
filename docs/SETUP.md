# ⚙️ Setup & Operations Guide (v1.8.0)

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
   DATABASE_URL="postgresql://krusch:password@localhost:5432/kruschdb"
   ```
2. The server will automatically connect to PostgreSQL and sync with local project caches.
3. If PostgreSQL is temporarily unreachable, the engine gracefully falls back to local SQLite without crashing.

---

## 🧠 Optional: Semantic Embedding Backends

By default, `krusch-context-mcp` uses deterministic lexical keyword matching, recency scoring, and heuristic tag indexing. If you wish to enable dense vector embeddings:

### Option A: Local Ollama (Zero Cloud)
```bash
ollama pull bge-large
```
In `.env`:
```bash
OLLAMA_URL="http://127.0.0.1:11434"
EMBED_MODEL="bge-large"
EMBED_DIMS=1024
```

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

* **Codebase RAG & AST Search**: [`krusch-git`](https://github.com/kruschdev/krusch-git)
* **Document Ingestion**: [`krusch-nexus`](https://github.com/kruschdev/krusch-nexus)
* **Statutory Compliance**: [`krusch-law`](https://github.com/kruschdev/krusch-law)
* **Contract Precedence**: [`krusch-biz`](https://github.com/kruschdev/krusch-biz)

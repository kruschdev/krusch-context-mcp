# Install `krusch-context-mcp`

These are instructions for a coding agent (Claude Code, Codex, Cursor, Windsurf, or Antigravity) that a person asked to install and configure `krusch-context-mcp` (`v2.0.0`) on their machine or inside their repository.

`krusch-context-mcp` gives coding agents persistent working memory across sessions using strictly 5 MCP verbs (`krusch_context_retrieve`, `krusch_context_remember`, `krusch_context_revise`, `krusch_context_nudge`, `krusch_context_health`) backed by Node 22 built-in `node:sqlite` WAL + Porter `FTS5` (with optional local Ollama `1024d` embeddings and optional PostgreSQL 16 + `pgvector` fleet mode).

## 1. Check Prerequisites First (All at Once)

Run one non-destructive check before changing anything:

```bash
id -u
node -v 2>/dev/null || echo "MISSING: node"
npm -v 2>/dev/null || echo "MISSING: npm"
npx --version 2>/dev/null || echo "MISSING: npx"
ollama list 2>/dev/null || echo "OPTIONAL_OFFLINE: ollama"
```

Evaluate the results:
1. **User check**: If `id -u` prints `0` (root), stop and ask the person to run you as a normal non-root user.
2. **Node.js `>= 22.0.0` (Required)**: `krusch-context-mcp` uses Node 22 native `node:sqlite` (`DatabaseSync`) for zero-Docker installation with zero native C++ addons. If Node is missing or below `v22.0.0`, ask the person before switching/installing Node 22 (`nvm install 22` or `fnm use 22`).
3. **Ollama (`snowflake-arctic-embed2`, Optional)**: Out of the box, `krusch-context-mcp` works offline at `$0.00` using Porter-stemmed `FTS5` lexical BM25, tag matching, and recency scoring. If `ollama` is running and the person wants dense `1024d` hybrid vector + lexical RRF, check whether `snowflake-arctic-embed2` is pulled (`ollama pull snowflake-arctic-embed2` only if they approve downloading `~670 MB`).

## 2. Choose the Right Setup Mode

- **Mode A: Zero-Docker Project Setup via `npx` (Recommended Default)**: Initializes `.agent/context.db` (`node:sqlite` WAL) in the current repository, runs health diagnostics, and registers the 5-verb stdio MCP server.
- **Mode B: Standalone Source Checkout + Full Verification Kit**: Clones `https://github.com/kruschdev/krusch-context-mcp.git`, runs all `149` SQLite contract tests plus the `10/10` BEAM zero-leakage verifiers, and wires the local `bin/cli.js` binary into MCP clients.

## 3. Install & Verify

### Mode A: Zero-Docker `npx` Setup (Default)

Inside the person's target project repository:

```bash
npx -y krusch-context-mcp init
npx -y krusch-context-mcp health
```

### Mode B: Source Checkout & 149-Test Verification

```bash
git clone https://github.com/kruschdev/krusch-context-mcp.git
cd krusch-context-mcp
npm ci
[ -f .env ] || cp .env.example .env
npm test
npm run health
```

*(If Ollama is running locally with `snowflake-arctic-embed2`, uncomment `OLLAMA_URL="http://127.0.0.1:11434"` and `EMBED_MODEL="snowflake-arctic-embed2"` in `.env`.)*

## 4. Connect to the Person's Coding Agent / IDE

Always read any existing MCP config file first and merge the `krusch-context-mcp` server entry without deleting other configured servers:

- **Claude Code CLI**:
  ```bash
  claude mcp add krusch-context-mcp -- npx -y krusch-context-mcp
  ```
  *(If installed via Mode B git clone, replace `npx -y krusch-context-mcp` with `node /absolute/path/to/krusch-context-mcp/bin/cli.js` using the real `pwd`.)*
- **Cursor (`.cursor/mcp.json` or `~/.cursor/mcp.json`), Windsurf (`~/.codeium/windsurf/mcp_config.json`), or Antigravity (`~/.gemini/antigravity/mcp_config.json`)**:
  ```json
  {
    "mcpServers": {
      "krusch-context-mcp": {
        "command": "npx",
        "args": ["-y", "krusch-context-mcp"]
      }
    }
  }
  ```
- **Codex (`~/.codex/config.toml`)**:
  ```toml
  [mcp_servers.krusch-context-mcp]
  command = "npx"
  args = ["-y", "krusch-context-mcp"]
  ```

## Never

- **Never run `npm` or `npx` as `root` (`sudo`)**.
- **Never overwrite an existing `.env` or replace an entire IDE `mcp_config.json` / `.mcp.json` file**; merge only the `krusch-context-mcp` key.
- **Never fabricate or commit API keys or `DATABASE_URL` passwords**; keep `STORAGE_MODE="sqlite"` as the default unless the person explicitly supplies a PostgreSQL `DATABASE_URL`.
- **Never pull large Ollama models without asking** if disk space or bandwidth is constrained.

## Tell the Person After

Give the person a short summary:
1. **Storage mode & database path** (default: SQLite WAL at `.agent/context.db`, plus whether `snowflake-arctic-embed2` hybrid embeddings or pure zero-setup `FTS5` lexical mode is active).
2. **Health & test result**: Output of `krusch-context-mcp health` (and `149/149` `npm test` pass count if installed from source).
3. **Configured MCP client(s)**: Which config file was updated and a reminder to reload MCP servers or start a fresh chat session.
4. **Verification prompt for their next session**: `"Call krusch_context_health and krusch_context_retrieve({ query: '*', include_state: true }) to confirm persistent memory is live."`

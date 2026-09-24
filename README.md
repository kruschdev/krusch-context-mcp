# Krusch Context MCP

> Local MCP server: five tools to store, retrieve, and retire project decisions. SQLite by default.

[![Node.js 22+](https://img.shields.io/badge/Node.js-22+-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![MCP: 5 Verbs](https://img.shields.io/badge/MCP-5%20Core%20Verbs-blue.svg)](docs/TOOL_REFERENCE.md)
[![Storage: SQLite-First](https://img.shields.io/badge/Storage-SQLite--First%20(zero--Docker)-lightgrey.svg)](docs/ARCHITECTURE.md)
[![Article: What Makes It Special](https://img.shields.io/badge/Article-What%20Makes%20It%20Special-cyan.svg)](https://krusch.dev/articles/what-makes-krusch-context-mcp-special.html)
[![Docs: What Makes It Special](https://img.shields.io/badge/Docs-What%20Makes%20It%20Special-purple.svg)](docs/WHAT_MAKES_IT_SPECIAL.md)

> 📖 **Read the Systems Deep Dive**: Check out the published architecture essay [**Beyond Flat Vector RAG: What Makes krusch-context-mcp Special**](https://krusch.dev/articles/what-makes-krusch-context-mcp-special.html) on krusch.dev, or the local companion guide in [`docs/WHAT_MAKES_IT_SPECIAL.md`](docs/WHAT_MAKES_IT_SPECIAL.md).

**Krusch Context MCP** gives AI coding agents (Cursor, Claude Code, Windsurf, Antigravity) persistent working memory across sessions. It captures architectural decisions, invariants, lessons, and bug diagnoses, warns on near-duplicate memories, maintains temporal lineage when facts are superseded or invalidated, and audits diffs against active constraints.

---

## 🚫 What This Is Not

* **Not a codebase AST or Git indexer**: Code symbol search, call graphs, and Git DAG traversal belong in [`krusch-git`](https://github.com/kruschdev/krusch-git) or your IDE's native search.
* **Not a 61-tool cafeteria**: Collapsed to strictly 5 canonical verbs (~350 prompt tokens) for boring reliability.
* **Not a cloud SaaS platform**: Runs 100% locally on your machine with zero external cloud dependencies.
* **Not a monolithic domain suite**: Legal compliance ([`krusch-law`](https://github.com/kruschdev/krusch-law)), document ingestion ([`krusch-nexus`](https://github.com/kruschdev/krusch-nexus)), and contract graphs ([`krusch-biz`](https://github.com/kruschdev/krusch-biz)) live in separate companion repositories.

---

## ⚡ 30-Second Quickstart

Requires **Node.js >= 22.0.0**. Run once inside your project repository:

```bash
npx krusch-context-mcp init
```

This command will:
1. Validate Node >= 22.0.0 and initialize `.agent/context.db` via `node:sqlite`.
2. Clear stale MCP tool schemas from local IDE caches.
3. Create your project `.env` with sensible defaults.
4. Seed initial project context and run a diagnostic health check.
5. Print copy-paste JSON configurations for Cursor, Claude Code, and Claude Desktop.

---

## 🛠️ The 5-Verb Agent Loop

Krusch Context MCP exposes strictly **5 canonical verbs** designed to fit into standard coding workflows:

| Verb | Short Alias | Purpose |
| :--- | :--- | :--- |
| **`krusch_context_retrieve`** | `retrieve` | Pulls active memories, steering rules, and project state briefings within a strict `limit_tokens` budget. Returns citations. |
| **`krusch_context_remember`** | `remember` | Writes episodic facts and steering nuggets. Detects near-duplicates (`similarity >= 0.85`) and proposes `revise(action: 'supersede')` without blocking contrasting rules. |
| **`krusch_context_revise`** | `revise` | Updates stale knowledge (`supersede` with lineage tracking) or revokes obsolete rules (`invalidate` with mandatory reason). |
| **`krusch_context_nudge`** | `nudge` | Pre-commit auditor that checks proposed diffs against active project invariants (max 1–3 findings). Trigger defaults to `pre_commit` or `manual`; rejects `every_turn`. |
| **`krusch_context_health`** | `health` | Reports storage mode, memory counts by closed taxonomy, and 30-day TTL decay review. |

> [!NOTE]
> **Optional Admin Profile**: Launching with `--profile=extended` exposes 4 additional tools (`list_memories`, `delete_memory`, `consolidate`, `nugget_list`) for manual repository maintenance. The default agent loop remains strictly the 5 core verbs.

---

## 🤖 Recommended Agent Protocol

Coding agents should interact with memory at specific lifecycle boundaries:

```
┌─────────────────────────────────────────────────────────────┐
│ 1. SESSION START                                            │
│    Agent calls retrieve(query: '*', include_state: true)    │
│    -> Obtains active invariants, recent decisions, blockers │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│ 2. DURING WORK                                              │
│    Agent calls remember(content: '...', category: '...')    │
│    -> If near-duplicate returned, agent calls revise(...)   │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│ 3. PRE-COMMIT / PRE-EDIT                                    │
│    Agent calls nudge(trigger: 'pre_commit')                 │
│    -> Audits code against active invariants (max 3 findings)│
└─────────────────────────────────────────────────────────────┘
```

---

## 🛡️ Safe Memory Writes: Closed Taxonomy & Deduplication

To prevent memory hallucination and database pollution:

1. **Closed Taxonomy**: Every write must use one of 5 categories:
   * `decision`: Architectural choices, design directions, trade-offs.
   * `invariant`: Non-negotiable rules (e.g., "Use node:sqlite, zero native compiles").
   * `bug`: Solved defects, regressions, and root-cause analyses.
   * `lesson`: Tactical insights and framework discoveries.
   * `blocker`: Active dependencies or external obstacles.
2. **Near-Duplicate Detection**: If a proposed memory matches an existing active record ($\ge 0.85$ cosine similarity), the memory is saved with a warning proposing `revise(action: 'supersede', target_id: ...)`. This protects contrasting rules (e.g., "Allow CORS" vs "Do not allow CORS") while flagging twin facts.
3. **Compulsory Invalidation Reasons**: Calling `revise(action: 'invalidate')` strictly requires a non-empty `reason`.
4. **Focused Audits**: `nudge` caps findings at 3 with concrete evidence, rejecting `every_turn` triggers to eliminate auditor nagware.

---

## 🧠 Embedding Reality & Offline Mode

* **Zero-GPU Default**: If neither Ollama nor an API key is present, the engine runs 100% offline using deterministic keyword extraction, recency scoring, and heuristic tag indexing.
* **Local Ollama** (Optional): Set `OLLAMA_URL="http://127.0.0.1:11434"` with `EMBED_MODEL="bge-large"` (1024 dims).
* **Remote Cloud** (Optional): Set `OPENROUTER_API_KEY="sk-..."` with `EMBED_MODEL="baai/bge-large-en-v1.5"` for zero-local-VRAM embeddings.

---

## 🐘 When Do You Need PostgreSQL?

* **Use SQLite (Default)**: Perfect for single developers, local IDE sessions, and projects with hundreds to thousands of decisions. Zero Docker, zero setup.
* **Use PostgreSQL (`STORAGE_MODE=postgres`)**: Required only when scaling to multi-agent swarms across different machines needing centralized persistence and server-side pgvector HNSW indexing.

---

## 🔄 Migration from v1.6 / v1.7

* **Tool Aliases**: Legacy tool names (`add_memory`, `search_memory`, `compile_state`, `supersede_memory`, `invalidate_memory`, `proactive_nudge`) are automatically aliased to the 5 verbs with a deprecation notice.
* **Database Path**: v1.7 used `.agent/memory.db`. v1.8.0 uses `.agent/context.db`. Run `npx krusch-context-mcp init` to migrate.
* See [docs/MIGRATION.md](docs/MIGRATION.md) for the complete mapping table.

---

## 🧩 Sibling Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                 AI Coding Agent (Cursor / Claude)           │
└──────────────────────────────┬──────────────────────────────┘
                               │
               ┌───────────────┴───────────────┐
               ▼                               ▼
┌─────────────────────────────┐ ┌─────────────────────────────┐
│  krusch-context-mcp (v1.8)  │ │   krusch-git (External)     │
│   Project Memory & Steering │ │   Codebase RAG & AST Search │
│       (5 Canonical Verbs)   │ │      (7 Specialized Tools)  │
└──────────────┬──────────────┘ └─────────────────────────────┘
               │
               ▼
┌─────────────────────────────┐
│     .agent/context.db       │
│   (node:sqlite, Node ≥22)   │
└─────────────────────────────┘
```

Other specialized tools ([`krusch-nexus`](https://github.com/kruschdev/krusch-nexus), [`krusch-law`](https://github.com/kruschdev/krusch-law), [`krusch-biz`](https://github.com/kruschdev/krusch-biz)) run as independent MCP servers in their own repositories.

---

## 💻 IDE Configuration

### Cursor (`.cursor/mcp.json`)
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

### Claude Code
```bash
claude mcp add krusch-context -- npx -y krusch-context-mcp
```

### Claude Desktop (`claude_desktop_config.json`)
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

## 📚 Documentation & Specifications

* **[Canonical Tool Reference](docs/TOOL_REFERENCE.md)**: Generated directly from live schemas (`npm run docs:generate`).
* **[Architecture & Failure Modes](docs/ARCHITECTURE.md)**: 2-page specification covering schemas, indexes, and invariants.
* **[Setup & Operations Guide](docs/SETUP.md)**: Zero-Docker setup and optional configurations.
* **[Migration Guide](docs/MIGRATION.md)**: Step-by-step v1.5 → v1.6 → v1.7 → v1.8.0 mapping.
* **[Episodic Memory Guide](docs/EPISODIC_MEMORY.md)**: Deep dive into the closed taxonomy and lifecycle.
* **[Changelog](CHANGELOG.md)**: Version release notes.
* **[Evaluation Baseline Notes](evals/README.md)**: Preliminary benchmark fixtures and token-budget metrics.

---

## 🧪 Testing

```bash
# Run full unit & contract test suite (100% SQLite, zero Docker)
npm test

# Check storage and memory health
npm run health
```

---

## License

MIT © [kruschdev](https://github.com/kruschdev)

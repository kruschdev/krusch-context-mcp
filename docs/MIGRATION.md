# Migration Guide: v1.5 → v1.6 → v1.7 → v1.8.0

This guide documents the architectural evolution and tool deprecation map for `krusch-context-mcp`.

---

## ⚡ Executive Summary of v1.8.0

| Dimension | v1.5 – v1.6 | v1.7 | v1.8.0 (Current) |
|---|---|---|---|
| **Primary Focus** | Multi-engine monolith (memory + code AST + research + cloud) | Sovereign Triad (13 core + 24 companion tools) | **Lean 5-Verb Project Memory & Steering** |
| **Tool Count** | 26–61 tools | 13 core / 37 suite | **5 canonical verbs** (`retrieve`, `remember`, `revise`, `nudge`, `health`) |
| **Default Storage** | PostgreSQL 16 + pgvector + Ollama | Lakebase (`.agent/memory.db` + Postgres push) | **SQLite-First** (`.agent/context.db`, `node:sqlite`) |
| **External Dependencies** | Docker, PostgreSQL, Ollama, native C++ compilation | `better-sqlite3`, `@opentelemetry/*` | **Zero compilation**, 3 pure JS runtime dependencies |
| **Node.js Floor** | Node >= 18 | Node >= 20 | **Node >= 22.0.0** (native `node:sqlite`) |
| **Codebase Search** | Bundled (`search_code`, `symbol_graph`) | Bundled PG-Git | **Extracted to [`krusch-git`](https://github.com/kruschdev/krusch-git)** |
| **Domain Tools** | Bundled (`law`, `biz`, `nexus`) | Embedded companion bridges | **Independent MCP server processes** |

---

## 🗺️ Tool Evolution & Mapping Matrix

In v1.8.0, legacy tool invocations are automatically intercepted, logged with a deprecation notice, and mapped to the appropriate canonical verb for one release cycle.

| Legacy Tool (v1.5 – v1.7) | v1.8.0 Status | Canonical Replacement & Arguments |
|---|---|---|
| `krusch_context_add_memory` | **Deprecated** | `krusch_context_remember({ content, category })` |
| `krusch_context_nugget_remember` | **Deprecated** | `krusch_context_remember({ key, content })` |
| `krusch_context_search_memory` | **Deprecated** | `krusch_context_retrieve({ query, mode: 'memory' })` |
| `krusch_context_compile_state` | **Deprecated** | `krusch_context_retrieve({ query: '*', include_state: true })` |
| `krusch_context_supersede_memory` | **Deprecated** | `krusch_context_revise({ action: 'supersede', target_id, content })` |
| `krusch_context_invalidate_memory` | **Deprecated** | `krusch_context_revise({ action: 'invalidate', target_id, reason })` |
| `krusch_context_nugget_forget` | **Deprecated** | `krusch_context_revise({ action: 'forget_nugget', key })` |
| `krusch_context_proactive_nudge` | **Deprecated** | `krusch_context_nudge({ trigger: 'pre_commit', code })` |
| `krusch_context_nudge_feedback` | **Deprecated** | `krusch_context_nudge({ action: 'feedback', rule_id, feedback })` |
| `krusch_context_nugget_nudges` | **Deprecated** | `krusch_context_retrieve({ query, category: 'invariant' })` |
| `krusch_context_health` | **Canonical** | `krusch_context_health({})` |
| `krusch_context_search_code` | **Extracted** | Use [`krusch-git`](https://github.com/kruschdev/krusch-git) (`krusch_git_semantic_search`) |
| `krusch_context_search_symbols` | **Extracted** | Use [`krusch-git`](https://github.com/kruschdev/krusch-git) (`krusch_git_search_symbols`) |
| `krusch_context_symbol_graph` | **Extracted** | Use [`krusch-git`](https://github.com/kruschdev/krusch-git) (`krusch_git_dependency_graph`) |
| `krusch_context_read_tree` | **Extracted** | Use [`krusch-git`](https://github.com/kruschdev/krusch-git) (`krusch_git_read_tree`) |
| `krusch_context_read_blob` | **Extracted** | Use [`krusch-git`](https://github.com/kruschdev/krusch-git) (`krusch_git_read_blob`) |
| `krusch_context_list_repos` | **Extracted** | Use [`krusch-git`](https://github.com/kruschdev/krusch-git) (`krusch_git_list_repos`) |
| `krusch_context_semantic_route` | **Extracted** | Use `krusch-cascade-router` |
| Companion tools (`law_*`, `biz_*`, `nexus_*`) | **Extracted** | Use respective companion MCP server packages |

---

## 💾 Storage & Database Migration

### 1. SQLite Database Path: `memory.db` → `context.db`
- In v1.7, local cache was placed at `.agent/memory.db`.
- In v1.8.0, the canonical zero-Docker SQLite database is located at `.agent/context.db`.
- **How to migrate local data:**
  ```bash
  # If you have existing data in .agent/memory.db:
  cp .agent/memory.db .agent/context.db
  # Or run initialization:
  npx krusch-context-mcp init
  ```

### 2. Category Taxonomy: Open → Closed Set of 5
Earlier versions allowed arbitrary string categories (e.g., `priorities`, `outcomes`, `activity`, `scratchpad`). 
In v1.8.0, all writes (`remember`) enforce a **closed taxonomy** to ensure high-signal retrieval:

| Old Category | Recommended v1.8.0 Category | Description |
|---|---|---|
| `priorities`, `roadmap` | `decision` | Architectural directions and committed milestones |
| `rules`, `conventions` | `invariant` | Non-negotiable code rules and project constraints |
| `errors`, `outcomes` | `bug` | Resolved defects, root causes, and regressions |
| `activity`, `notes` | `lesson` | Tactical learnings and implementation discoveries |
| `issues`, `deps` | `blocker` | Active obstacles or external dependencies |

---

## 🚀 Migrating Your Agent Configuration

Update your MCP configuration file (`mcp_config.json` or `claude_desktop_config.json`):

### Before (v1.6 / v1.7):
```json
{
  "mcpServers": {
    "krusch-context": {
      "command": "node",
      "args": ["/path/to/krusch-context-mcp/src/index.js", "--profile=core"],
      "env": {
        "DATABASE_URL": "postgresql://postgres:password@localhost:5432/kruschdb",
        "OLLAMA_URL": "http://localhost:11434"
      }
    }
  }
}
```

### After (v1.8.0, Zero-Docker Default):
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
No environment variables, Docker containers, or background database daemons required.

# Krusch Context MCP

> Local MCP server: five tools to store, retrieve, and retire project decisions. SQLite by default.

[![Node.js 22+](https://img.shields.io/badge/Node.js-22+-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![MCP: 5 Verbs](https://img.shields.io/badge/MCP-5%20Core%20Verbs-blue.svg)](docs/TOOL_REFERENCE.md)
[![Storage: SQLite-First](https://img.shields.io/badge/Storage-SQLite--First%20(zero--Docker)-lightgrey.svg)](docs/ARCHITECTURE.md)

**Krusch Context MCP** gives your AI coding agents (Cursor, Claude Code, Windsurf, Antigravity) persistent working memory across sessions. It remembers architectural decisions, project invariants, lessons, and bugs, flags near-duplicate memories, maintains lineage when rules are superseded or invalidated, and audits proposed changes against active constraints.

### 💾 Storage & Scope Reality
- **Default (SQLite)**: Uses Node 22's built-in `node:sqlite` (`.agent/context.db`) with in-memory cosine similarity. Requires **zero Docker, zero PostgreSQL**, and zero native C++ compiles. Ideal for hundreds to low-thousands of project decisions, invariants, and steering nuggets.
- **Codebase Search & AST**: Decoupled from this package. Code search belongs in `pg-git` or the IDE's native search; `krusch-context-mcp` is purely memory hygiene and steering.
- **PostgreSQL**: Optional drop-in adapter (`STORAGE_MODE=postgres`) when you outgrow local cosine or need multi-machine team sync with server-side pgvector HNSW indexing.

---

## ⚡ 30-Second Quickstart

Requires **Node.js >= 22.0.0**. Run this once inside any git repository:

```bash
npx krusch-context-mcp init
```

This single command:
1. Validates Node >= 22.0.0 and initializes `.agent/context.db` via `node:sqlite`.
2. Cleans any stale MCP tool schema files from local IDE cache.
3. Creates or merges your local `.env`.
4. Seeds your initial project context.
5. Runs a diagnostic health check.
6. Prints copy-paste JSON configurations for Cursor, Claude Code, and Claude Desktop.

---

## 🛠️ The 5-Verb Agent Loop

Instead of cluttering the agent's context window with dozens of overlapping tools, Krusch Context MCP exposes strictly **5 canonical verbs** (~350 prompt tokens total):

| Verb | Short Alias | Purpose |
| :--- | :--- | :--- |
| **`krusch_context_retrieve`** | `retrieve` | Pulls active memories, steering rules, and project state briefings within a strict `limit_tokens` budget. Returns citations. |
| **`krusch_context_remember`** | `remember` | Writes episodic facts and persistent steering nuggets. Detects near-duplicates (`similarity >= 0.85`) and proposes `revise(action: 'supersede')` without blocking contrasting rules. |
| **`krusch_context_revise`** | `revise` | Updates stale knowledge (`supersede` with lineage tracking) or revokes obsolete rules (`invalidate` with mandatory reason). |
| **`krusch_context_nudge`** | `nudge` | Pre-commit / pre-edit auditor that checks proposed diffs against active project invariants (max 1–3 findings). Trigger defaults to `pre_commit` or `manual`; rejects `every_turn`. |
| **`krusch_context_health`** | `health` | Reports storage mode, memory counts by closed taxonomy, and 30-day TTL decay review. |

> [!NOTE]
> **Backward Compatibility & Deprecation Window**: Direct calls to legacy tool names (`search_memory`, `compile_state`, `add_memory`, `supersede_memory`, `invalidate_memory`, `nugget_remember`, `proactive_nudge`) log a deprecation notice and route to the corresponding verb handler for one minor version. See [CHANGELOG.md](CHANGELOG.md) for the migration table.

---

## 🛡️ Safe Memory Writes for Agents

To prevent episodic memory from turning into an unmaintained, hallucinated mess:

1. **Closed Taxonomy**: Memories belong to a strict closed set of categories:
   * `decision`: Architectural choices, design directions, trade-offs.
   * `invariant`: Rules that must never be broken (e.g. "Always use node:sqlite, zero native compiles").
   * `bug`: Solved edge cases and regressions to avoid repeating.
   * `lesson`: Tactical insights learned during development.
   * `blocker`: Active dependencies or operational impediments.
2. **Non-Blocking Near-Duplicate Detection**: When calling `remember`, the engine computes vector similarity against active records. If similarity exceeds 0.85, the memory is saved, but the tool returns a warning with the candidate memory ID, similarity score, and a prompt proposing `revise(action: 'supersede', target_id: ...)`. This prevents false positives (e.g. "Use JWT in cookies" vs "Do not put JWT in cookies") from blocking valid contrasting writes.
3. **Mandatory Invalidation Reasons**: Marking a rule as `INVALIDATED` strictly requires a non-empty `reason`.
4. **Focused Invariant Audits**: `nudge` triggers on `pre_commit` or `manual` (`every_turn` is rejected to eliminate audit fatigue). Findings are strictly capped at 3 with concrete evidence. Feedback (`helpful`, `false_positive`) updates and persists rule weights in SQLite.
5. **Provenance Tracking**: Every memory tracks `{ author: 'human' | 'agent', file, commit, pr, confidence }`.
6. **30-Day TTL Decay Review**: Memories inactive or unreferenced for >30 days are flagged in `health` for developer review.

---

## 💻 Manual IDE Configuration

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
claude mcp add krusch-context npx krusch-context-mcp
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

## 🏛️ Homelab Architecture: Separation of Concerns

Each system in the homelab has one job:

```
┌─────────────────────────────────────────────────────────────┐
│                 krusch-context-mcp (This Repo)              │
│       Universal Memory & Steering Engine for All Agents     │
│       (retrieve, remember, revise, nudge, health)           │
└───────┬───────────────────┬───────────────────┬─────────────┘
        │                   │                   │
        ▼                   ▼                   ▼
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│    pg-git    │    │  krusch-law  │    │  krusch-biz  │
│  Codebase &  │    │  Statutory & │    │ Commercial & │
│   Git RAG    │    │  Ordinance   │    │ Contract RAG │
└──────────────┘    └──────────────┘    └──────────────┘
```

* **`krusch-context`** *(this repo)*: The shared memory and invariant brain across all sessions.
* **`pg-git`**: Dedicated structural Git & code chunk indexer.
* **`krusch-law`**: Standalone legal compliance and statutory RAG MCP.
* **`krusch-biz`**: Standalone commercial contract & SLA conflict graph MCP.
* **`krusch-nexus`**: Standalone document citation spine & ingestion MCP.

---

## 📚 Documentation & Specifications

* **[Canonical Tool Reference](docs/TOOL_REFERENCE.md)**: Generated directly from tool code schemas (`npm run docs:generate`).
* **[Architecture & Failure Modes](docs/ARCHITECTURE.md)**: 2-page specification covering SQLite/Postgres schemas, indexes, embedding dimension invariants, and error recovery.
* **[Evaluation Baseline Notes](evals/README.md)**: Transparent description of preliminary fixtures and token-budget metrics.

---

## 🧪 Testing

```bash
# Run full unit & contract test suite (runs 100% on SQLite without Docker)
npm test

# Check storage and memory health
npm run health
```

---

## License

MIT © [kruschdev](https://github.com/kruschdev)

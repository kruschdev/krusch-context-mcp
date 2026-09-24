# Contributing to `krusch-context-mcp`

Thank you for contributing! To preserve the boring reliability and ergonomic focus of this project, all contributions must respect the **v1.8.0 architectural boundaries**.

---

## 🎯 This Repository's Scope

**`krusch-context-mcp` has one job**: Provide autonomous coding agents (Cursor, Claude Code, Windsurf, Antigravity) with persistent episodic working memory and pre-commit invariant steering.

It enforces a strict **5-verb public contract** (~350 prompt tokens):
1. **`retrieve`** (`krusch_context_retrieve`): Context hydration & state briefings packed to token budget.
2. **`remember`** (`krusch_context_remember`): Persist facts with closed taxonomy & near-duplicate warning.
3. **`revise`** (`krusch_context_revise`): Temporal superseding or invalidation with mandatory justification.
4. **`nudge`** (`krusch_context_nudge`): Pre-commit invariant auditor & feedback weighting.
5. **`health`** (`krusch_context_health`): Operational health & 30-day TTL decay review.

---

## 🚫 What Belongs in Sibling Repositories

Do **not** submit PRs that add the following to this repository:

* **Codebase AST & Git DAG Indexing**: Symbol graphs, call trees, and Git object traversal belong in [**`krusch-git`**](https://github.com/kruschdev/krusch-git).
* **Execution & Sandboxing**: Two-phase commit journals, Bubblewrap sandboxing, and diff application belong in [**`krusch`**](https://github.com/kruschdev/krusch).
* **Document Ingestion**: PDF layout-true parsing and bounding-box locators belong in [**`krusch-nexus`**](https://github.com/kruschdev/krusch-nexus).
* **Statutory Law**: Legal authority grounding belongs in [**`krusch-law`**](https://github.com/kruschdev/krusch-law).

---

## 🛡️ Non-Negotiable Pull Request Invariants

1. **Tool Count Invariant**: The public MCP tool schema must contain **strictly 5 canonical verbs**. PRs adding extra tools to the default server export will be rejected.
2. **Zero-Docker Default**: The default runtime is native Node 22 SQLite (`node:sqlite`) saving to `.agent/context.db`. PostgreSQL (`pg`) is an optional dependency and must never become a required startup dependency.
3. **Closed Taxonomy**: Memories must belong to one of the 5 closed categories: `decision`, `bug`, `invariant`, `lesson`, or `blocker`.
4. **Test Suite**: All tests in `tests/*.test.js` must pass with zero warnings (`npm test`).

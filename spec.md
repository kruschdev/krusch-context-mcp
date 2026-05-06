# Krusch Context MCP Server — Specification

> **Author**: Antigravity
> **Date**: 2026-05-05
> **Status**: Active

---

## 1. What Is This?

The **Krusch Context MCP Server** is a unified Model Context Protocol server that merges the semantic codebase indexing of `pg-git` with the episodic memory tracking of `krusch-memory-mcp`. By consolidating these systems into a single server, it shares the underlying PostgreSQL/pgvector connection pool and Ollama embedding pipeline, drastically simplifying IDE configuration and reducing Node.js process overhead. It acts as the ultimate "zero-trust" context layer for AI coding agents, allowing them to simultaneously query objective codebase reality (What) and subjective historical decisions/bugs (Why).

## 2. User Stories

- As an AI agent, I want to query a repository's semantic codebase so that I can understand how a feature is currently implemented without guessing file paths.
- As an AI agent, I want to retrieve historical decisions and known bugs so that I avoid repeating past mistakes.
- As an AI agent starting a new session, I want a single "deep context" tool that retrieves both codebase facts and episodic lessons so that I can establish a complete situational baseline in one turn.
- As the homelab orchestrator, I want a single unified MCP server running on my machine so that I reduce resource footprint and simplify my agent environment configuration.

## 3. Core Features

| Feature | Priority | Notes |
|---------|----------|-------|
| `krusch_context_search_memory` | Must-have | Search episodic memories (`priorities`, `bugs`, `outcomes`, `activity`, `lessons`). |
| `krusch_context_add_memory` | Must-have | Add new episodic memories. |
| `krusch_context_search_code` | Must-have | Search semantic codebase blobs across tracked homelab projects. |
| `krusch_context_deep_search` | Nice-to-have | A composite tool that takes a single query and returns both codebase matches and relevant historical lessons to quickly establish baseline context in one turn. |
| Shared DB Connection Pool | Must-have | Single `pg.Pool` instance connected to `kruschdb` on `kruschserv:5434`. |
| Shared Embedding Engine | Must-have | Shared logic for generating 1536-dim embeddings via `qwen2.5-coder:1.5b` on `kruschgame`. |

## 4. Technical Constraints

- **Stack**: Node.js 22+ (ESM strictly enforced).
- **Database**: PostgreSQL with `pgvector` (`kruschdb` on `kruschserv`).
- **AI/LLM**: Local Ollama instance (`kruschgame`) for vector embeddings.
- **Dependency strategy**: Should this be standalone like `krusch-sequential-mcp` (for open-source release), or use `@krusch/toolkit` since it's deeply tied to the homelab database layout? *(See Open Questions)*
- **Protocol**: Standard Model Context Protocol via Stdio for IDE integration.

## 5. Data Model

The server will interface with two distinct areas of `kruschdb`:

**Episodic Memory (from `krusch-memory-mcp`)**
```sql
-- Table: homelab_memory (or similar existing table)
-- Columns: id, category (enum), content (text), embedding (vector 1536), created_at
```

**Semantic Codebase (from `pg-git`)**
```sql
-- Table: blobs (or similar existing pg-git table)
-- Columns: id, project (text), filepath (text), content (text), embedding (vector 1536), updated_at
```

## 6. Edge Cases & Gotchas

- **Silent Connection Failures**: `pg.Pool` is lazy. We must explicitly run a `SELECT 1` health check on startup and throw errors properly (lessons learned from the previous `krusch-memory-mcp` audit).
- **Ollama Model Tags**: The embedding request must specify the exact model tag (`qwen2.5-coder:1.5b`). If kruschgame only has `qwen2.5-coder:1.5b-base`, the MCP will fail with a 404.
- **Context Window Bloat**: If `deep_context_search` returns too many files and too many memory snippets, it could overwhelm the agent's context window. We need strict limits (e.g., max 3 files, max 3 memories) for the composite tool.

## 7. Acceptance Criteria

- [x] A single MCP server executable exposes tools for both episodic memory and codebase search.
- [x] Database connection pooling and embedding generation logic are unified.
- [x] The server starts and connects to `kruschdb` successfully, throwing clear errors if unavailable.
- [x] A successful search can be executed across both the pg-git blobs and homelab memory records.
- [x] The IDE configuration is updated to replace the two separate MCP servers with this unified one.

## 8. Out of Scope

- Not migrating the actual data. The database schemas in PostgreSQL (`kruschdb`) already exist and are populated. We are only building a unified query interface/MCP server.
- Not adding automatic ingestion triggers for code (that remains the job of the `pg-git` sync scripts for now).

## 9. Delivery Phases

| Phase | Scope | Acceptance |
|-------|-------|------------|
| 1 | Scaffolding & DB Connection | Server starts, connects to DB with explicit health check, handles pooling. |
| 2 | Porting Existing Tools | `krusch_context_*` memory and code search tools are functional under the unified server. |
| 3 | Composite Context Tool | `krusch_context_deep_search` is implemented and verified. |
| 4 | Replacement & Cleanup | Replace old MCPs in IDE config, archive old repos. |

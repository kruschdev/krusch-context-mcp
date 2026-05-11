# Architecture Audit: `krusch-context-mcp` vs Company Brain Substrate

## 1. Overview
This document evaluates the existing `krusch-context-mcp` architecture against the infrastructure primitives outlined in the "Company Brain" research by Sentra. The goal is to identify the gaps between our current query-time RAG approach and a robust, stateful organizational substrate.

## 2. Current Architecture Baseline
The current `spec.md` outlines two primary tables in `kruschdb`:
1. **Episodic Memory (`homelab_memory`)**: `id`, `category`, `content`, `embedding`, `created_at`
2. **Semantic Codebase (`blobs`)**: `id`, `project`, `filepath`, `content`, `embedding`, `updated_at`

### MCP Tools Available
- `krusch_context_search_memory`
- `krusch_context_add_memory`
- `krusch_context_search_code`

---

## 3. Gap Analysis

### A. Concurrency Control
**Sentra Requirement**: "Who wins when two agents write to the same state? What gets versioned?"
**Current State**: 🔴 **None**. `krusch_context_add_memory` currently inserts a new row. There is no concept of updating an existing state, no versioning mechanism (`version_id`), and no way to handle parallel agent writes causing race conditions.
**Required Architecture Addition**:
- Add Optimistic Concurrency Control (OCC) using a `version` or `parent_id` column.
- Support branching or linear conflict resolution.

### B. Provenance & Action Traces
**Sentra Requirement**: "It has to know what happened, why it mattered, who saw it, which source is trusted, what action followed."
**Current State**: 🔴 **Basic**. We track `created_at` and `category`. We do not track the *author* (which agent or human), the *source* (was this derived from a PR, a chat, or a ticket?), or the *confidence* of the data.
**Required Architecture Addition**:
- Add `author_id` (agent vs human).
- Add `source_ref` (URI or document hash that generated this memory).
- Add Action Traces (logging when a memory is *used* to make a decision, not just when it is written).

### C. Permissions Propagation
**Sentra Requirement**: "It does not decide who can see it, inherited permissions... what if a user can see the ticket but not the customer call that explains it?"
**Current State**: 🔴 **None**. All memory and blobs are universally accessible to any agent that can call the MCP server.
**Required Architecture Addition**:
- Integrate a lightweight RBAC or attribute-based access control (ABAC).
- Add `read_roles` and `write_roles` columns to records.

### D. Ontology Binding & State Marking
**Sentra Requirement**: "What gets marked stale? Which ontology applies?"
**Current State**: 🔴 **Manual**. The `/open` workflow asks agents to "Note if any priorities or bugs are looking stale (>3 days)." This is heuristic and query-time, not maintained state.
**Required Architecture Addition**:
- Add `status` (active, stale, deprecated, resolved).
- Add `ontology_tags` (mapping to official homelab taxonomy).
- Add a mechanism to explicitly deprecate old state when a new state arrives.

### E. Query-Time vs Maintained State
**Sentra Requirement**: "Company Brain should work differently... the context graph should already exist as maintained state."
**Current State**: 🟡 **Partial**. We do maintain state for `pg-git` (via periodic syncs) and episodic memories. However, the connection *between* them (e.g., this bug relates to this blob) is generated at query-time via vector similarity.
**Required Architecture Addition**:
- Establish a semantic edge graph. An explicit `related_to` mapping between `homelab_memory` entries and `blobs`.

---

## 4. Conclusion
`krusch-context-mcp` is currently functioning as an "App" that reads a generic database, fitting perfectly into the "App Mistake" described in the essay. To become an "Infrastructure Substrate," it must evolve from a dumb datastore to a state machine that handles concurrency, tracks provenance, and manages access.

**Next Step**: Generate `spec_v2_company_brain.md` to define the database schema migrations and the new suite of MCP tools required to enforce these primitives.

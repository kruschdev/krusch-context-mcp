# Krusch Context MCP: Architecture & Specification Note

A lean, durable, and domain-agnostic **Universal Memory and Steering Engine** for AI agents. Designed to eliminate agent amnesia and prevent repetitive mistakes across coding, legal, and operational workflows.

---

## 1. System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                 AI Coding Agent (Cursor / Claude)           │
└──────────────────────────────┬──────────────────────────────┘
                               │ MCP Protocol (5 Verbs)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                  krusch-context-mcp (v1.8.0)                │
│                                                             │
│   retrieve        remember        revise     nudge   health │
│   (budget)     (dup-detection)  (lineage)   (audit)  (TTL)  │
└──────────────┬──────────────────────────────┬───────────────┘
               │                              │
     (Default Zero-Docker)           (Fleet Mode, Optional)
               ▼                              ▼
┌──────────────────────────────┐ ┌────────────────────────────┐
│      Local SQLite Cache      │ │     PostgreSQL + pgvector  │
│      .agent/context.db       │ │      Durable Fleet Storage │
│        (node:sqlite)         │ │         (Port 5432)        │
└──────────────────────────────┘ └────────────────────────────┘
```

---

## 2. Storage Schemas & Data Model

### `ide_agent_memory` (Episodic Knowledge)
Stores historical learnings, decisions, and constraints with temporal lineage and provenance.

| Column | Type | Description |
| :--- | :--- | :--- |
| `id` | `INTEGER PRIMARY KEY` | Auto-incrementing identifier. |
| `project` | `TEXT` | Project association (e.g. `krusch-context-mcp`). |
| `category` | `TEXT NOT NULL` | Closed set: `decision`, `bug`, `invariant`, `lesson`, `blocker`. |
| `content` | `TEXT NOT NULL` | Factual content or constraint. |
| `tags` | `TEXT` | JSON string array of searchable tags. |
| `embedding` | `TEXT` / `VECTOR(1024)` | 1024-dimensional dense representation. |
| `status` | `TEXT DEFAULT 'ACTIVE'` | Knowledge lifecycle: `ACTIVE`, `SUPERSEDED`, `INVALIDATED`. |
| `supersedes_id`| `INTEGER` | ID of predecessor memory record this replaces. |
| `superseded_by`| `INTEGER` | ID of successor memory record that superseded this record. |
| `invalidated_reason` | `TEXT` | Mandatory justification required when invalidating. |
| `provenance` | `TEXT` | JSON object: `{ file, commit, pr, author, confidence, recorded_at }`. |
| `created_at` | `DATETIME` | Timestamp of creation. |

### `ide_agent_nuggets` (Steering Rules)
Lightweight persistent key-value constraints that steer agent behavior without consuming full episodic context tokens.

| Column | Type | Description |
| :--- | :--- | :--- |
| `key` | `TEXT PRIMARY KEY` | Canonical rule key (e.g. `architecture.db_mode`). |
| `value` | `TEXT NOT NULL` | Concrete steering directive. |
| `kind` | `TEXT NOT NULL` | Scope: `project`, `agent`, or `user`. |
| `embedding` | `TEXT` / `VECTOR(1024)` | Dense representation for similarity search. |

### `auditor_feedback` (Alignment Weighting)
Tracks developer feedback on proactive auditor findings to dynamically tune rule sensitivity.

| Column | Type | Description |
| :--- | :--- | :--- |
| `rule_id` | `TEXT NOT NULL` | Memory or nugget ID evaluated. |
| `feedback` | `TEXT NOT NULL` | `helpful`, `unhelpful`, `false_positive`. |
| `weight` | `REAL DEFAULT 1.0` | Sensitivity weight; decays on false positives to silence nagware. |

---

## 3. Embedding Dimension Invariant

* **Zero-GPU Default**: Deterministic lexical keyword matching, recency scoring, and heuristic tag indexing. Runs 100% offline without external services.
* **Optional Dense Vectors**: Local Ollama (`bge-large` @ 1024 dims) or cloud OpenRouter (`baai/bge-large-en-v1.5` @ 1024 dims).
* **Vector Dimension Invariant**: When vector embeddings are enabled, the vector dimension is strictly **`1024`** float elements. Startup diagnostics validate dimension consistency on `health` checks.

---

## 4. Operational Guardrails

### 1. Non-Blocking Near-Duplicate Guard
When calling `remember`:
* The engine performs a semantic cosine similarity check across existing `ACTIVE` records in the project.
* If similarity exceeds **`0.85`**, the memory is saved, but the tool returns a warning with the candidate memory ID, similarity score, and a prompt proposing `revise(action: 'supersede', target_id: ...)`.
* This non-blocking behavior avoids false-positive write rejections for contrasting rules (e.g., "Allow CORS" vs "Do not allow CORS") while steering agents to maintain clean knowledge graphs.

### 2. Mandatory Invalidation Reason
Calling `revise` with `action: 'invalidate'` requires a non-empty `reason` string explaining why the rule or invariant was revoked. This reason is surfaced in compiled state briefings so agents understand what constraints were retired.

### 3. Token-Budget Pruning
`retrieve` enforces strict server-side token budget adherence. Context items are sorted by relevance and packed until `limit_tokens` is reached. Subsequent candidates are trimmed to protect the LLM context window.

### 4. 30-Day TTL Decay Review
Memories unreferenced or inactive for more than 30 days are surfaced in `health` and `retrieve({ include_state: true })` under the **Decay Review** section for developer evaluation.

---

## 5. Failure Modes & Mitigations

| Failure Mode | Impact | Mitigation Strategy |
| :--- | :--- | :--- |
| **PostgreSQL Unreachable** | Remote fleet persistence fails. | Engine falls back automatically to local SQLite (`.agent/context.db`). Zero startup crash. |
| **Embedding Provider Offline** | Vector generation fails. | Engine falls back to lexical keyword matching and chronological recency ordering. |
| **Agent Prompt Flooding** | LLM context overflow. | `limit_tokens` prunes low-ranking memories and boilerplate before returning payload. |
| **Auditor Nagware** | Repetitive false positive warnings. | Negative feedback (`action: 'feedback'`) reduces rule weight below threshold to suppress rule. |

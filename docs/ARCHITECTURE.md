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
│                  krusch-context-mcp (v2.0.0)                │
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

### `ide_agent_memory` (Episodic Knowledge) + `ide_agent_memory_fts` (Porter FTS5)
Stores historical learnings, decisions, and constraints with temporal lineage, compact binary `Float32Array` embeddings, and trigger-synchronized external-content Porter-stemmed `FTS5` full-text search (`ide_agent_memory_fts`).

| Column | Type | Description |
| :--- | :--- | :--- |
| `id` | `INTEGER PRIMARY KEY` | Auto-incrementing identifier. |
| `project` | `TEXT` | Project association (e.g. `krusch-context-mcp`). |
| `category` | `TEXT NOT NULL` | Closed set: `decision`, `bug`, `invariant`, `lesson`, `blocker`. |
| `content` | `TEXT NOT NULL` | Factual content or constraint. |
| `tags` | `TEXT` | JSON string array of searchable tags. |
| `embedding` | `TEXT` / `VECTOR(1024)` | 1024-dimensional dense representation (JSON / `pgvector`). |
| `embedding_blob` | `BLOB` | Compact little-endian `Float32Array` (`4,096` bytes/row in SQLite) for zero-`JSON.parse` decoding. |
| `status` | `TEXT DEFAULT 'ACTIVE'` | Knowledge lifecycle: `ACTIVE`, `SUPERSEDED`, `INVALIDATED`. |
| `supersedes_id`| `INTEGER` | ID of predecessor memory record this replaces. |
| `superseded_by`| `INTEGER` | ID of successor memory record that superseded this record. |
| `invalidated_reason` | `TEXT` | Mandatory justification required when invalidating. |
| `provenance` | `TEXT` | JSON object: `{ file, locator, quoted_sentence, start_line, end_line, anchor_hash, commit, pr, author, confidence, recorded_at }`. |
| `created_at` | `DATETIME` | Timestamp of creation. |

### `ide_episode_rollups` (Two-Level Episode Summaries) + `ide_episode_rollups_fts` (Porter FTS5)
Derived hierarchical rollup index automatically maintained for long-horizon stores (`>= 240` active rows by default via `KRUSCH_ROLLUP_MIN_ROWS`) without mutating `ide_agent_memory` or adding LLM calls.

| Column | Type | Description |
| :--- | :--- | :--- |
| `id` | `INTEGER PRIMARY KEY` | Auto-incrementing rollup episode identifier. |
| `project` | `TEXT` | Project scope. |
| `session_id` | `INTEGER` | Parsed conversational session number (`NULL` for un-sessioned windows). |
| `window_index` | `INTEGER NOT NULL` | Sub-window index (`0, 1, ...`) within large sessions (`<= 64` turns/window). |
| `start_memory_id` / `end_memory_id` | `INTEGER NOT NULL` | Inclusive child `ide_agent_memory.id` span covered by this rollup. |
| `turn_count` | `INTEGER NOT NULL` | Number of active child memories in the episode window. |
| `child_ids_json` | `TEXT NOT NULL` | JSON array of child `ide_agent_memory.id` values for coarse-to-fine rescue. |
| `directive_ids_json` | `TEXT NOT NULL` | JSON array of standing directive / `invariant` child IDs in this window. |
| `time_range` | `TEXT` | Extracted conversational date/timestamp span for the episode window. |
| `summary` | `TEXT NOT NULL` | Deterministic extractive episode digest (`<= 420` chars, Turn-ID citations stripped). |
| `top_stems_json` | `TEXT NOT NULL` | Top 16 high-IDF informative stems for fast lexical overlap. |
| `embedding_blob` | `BLOB` | Salience-weighted L2-normalized `Float32Array(1024)` centroid (`4,096` bytes). |
| `source_hash` | `TEXT NOT NULL` | Deterministic watermark hash of constituent rows. |
| `created_at` | `DATETIME` | Timestamp when the episode rollup row was materialized. |

### `ide_agent_nuggets` (Steering Rules)
Lightweight persistent key-value constraints scoped per `(key, project)` that steer agent behavior without consuming full episodic context tokens.

| Column | Type | Description |
| :--- | :--- | :--- |
| `key` | `TEXT NOT NULL` | Canonical rule key (composite primary key with `project`). |
| `project` | `TEXT NOT NULL` | Project scope (defaults to `global` when unspecified). |
| `value` | `TEXT NOT NULL` | Concrete steering directive. |
| `kind` | `TEXT NOT NULL` | Scope: `project`, `agent`, or `user`. |
| `embedding` | `TEXT` / `VECTOR(1024)` | Dense representation for similarity search. |

### `auditor_feedback` (Alignment Weighting)
Tracks project-scoped developer feedback on proactive auditor findings to dynamically tune rule sensitivity.

| Column | Type | Description |
| :--- | :--- | :--- |
| `project` | `TEXT` | Project scope for rule weight calibration. |
| `rule_id` | `TEXT NOT NULL` | Memory or nugget ID evaluated. |
| `feedback` | `TEXT NOT NULL` | `helpful`, `unhelpful`, `false_positive`. |
| `weight` | `REAL DEFAULT 1.0` | Sensitivity weight; decays on false positives to silence nagware. |

---

## 3. Embedding Dimension Invariant

* **Zero-GPU Default**: Deterministic lexical keyword matching, Porter-stemmed `FTS5` search (`ide_agent_memory_fts` and `ide_episode_rollups_fts`), recency scoring, and heuristic tag indexing. Runs 100% offline without external services.
* **Optional Dense Vectors**: Local Ollama (`snowflake-arctic-embed2` @ `1024` dims, `8,192`-token context, `/api/embed` with `/api/embeddings` fallback and asymmetric `query:` prefixing; also supports `qwen3-embedding` MRL `1024d`, `nomic-embed-text`, and `bge-large`) or cloud OpenRouter (`baai/bge-large-en-v1.5` @ `1024` dims).
* **Vector Dimension Invariant**: When vector embeddings are enabled, the vector dimension is strictly **`1024`** float elements (`4,096`-byte binary `Float32Array` `embedding_blob` in SQLite across both leaf memories and episode rollup centroids). Startup diagnostics and runtime assertions validate dimension and finite-float consistency.

---

## 4. Operational Guardrails

### 1. Non-Blocking Near-Duplicate Guard
When calling `remember`:
* The engine performs a semantic cosine similarity check across existing `ACTIVE` records in the project.
* If similarity exceeds **`0.85`**, the memory is saved, but the tool returns a warning with the candidate memory ID, similarity score, and a prompt proposing `revise(action: 'supersede', target_id: ...)`.
* This non-blocking behavior avoids false-positive write rejections for contrasting rules (e.g., "Allow CORS" vs "Do not allow CORS") while steering agents to maintain clean knowledge graphs.

### 2. Mandatory Invalidation Reason
Calling `revise` with `action: 'invalidate'` requires a non-empty `reason` string explaining why the rule or invariant was revoked. This reason is surfaced in compiled state briefings so agents understand what constraints were retired.

### 3. Token-Budget Pruning & Multi-Scale Retrieval (`v2.0.0`)
`retrieve` enforces strict server-side token budget adherence (`totalReportedTokens <= safeLimitTokens`). Across multi-session and million-token stores, `unifiedRetrieve` orchestrates three deterministic zero-RPC stages inside the fixed budget:
* **Stage 1B — Hierarchical Episode Rollups**: Synthesizes bounded `#### 🗂️ Hierarchical Episode Panorama` headers on broad summarization/timeline queries, rescues deep pre-scan child turns beyond `KRUSCH_MAX_ACTIVE_SCAN`, and pins standing `USER:` directives on generative/advisory requests.
* **Stage 2 — Gated 2-Hop Multi-Session Bridge Expansion**: When confident Hop-1 hits (`rawScore >= 0.56`) leave query facets uncovered or concentrate in `<= 2` sessions of a multi-session store, `expandMultiHopBridges` projects a damped Gram-Schmidt orthogonal residual vector over `Float32Array` blobs and runs a disjoint-session `FTS5` bridge pass.
* **Stage 3 — Compositional Attribute-Level Grounding**: `evaluateAttributeGrounding` checks `USER:` stem co-occurrence within `±1` same-session turn windows and guards isotropic entity-only neighbor distractors (`rawCosine < 0.48`), promoting ungrounded multi-term probes to `NO_KNOWN_SUPPORT` and surfacing an `Attribute Grounding Note` when an entity anchor is attested without its queried attribute.

### 4. 30-Day TTL Decay Review
Memories unreferenced or inactive for more than 30 days are surfaced in `health` and `retrieve({ include_state: true })` under the **Decay Review** section for developer evaluation.

### 5. Span-Grounded Provenance & Drift Self-Healing (`INV-12`)
When `remember` includes `provenance: { file, locator, quoted_sentence }`, the engine anchors the memory to an exact line range (`start_line..end_line`) and normalized SHA-256 `anchor_hash` without duplicating full file contents. On subsequent `retrieve({ include_state: true })` calls, `evaluateMemorySpanDrift` checks the anchored file on disk: if lines were inserted above the span (`quoted_sentence` still exists verbatim), line offsets self-heal automatically; if the span was mutated or deleted, the memory is flagged under `## ⚠️ Span-Grounded Drift Review`.

---

## 5. Failure Modes & Mitigations

| Failure Mode | Impact | Mitigation Strategy |
| :--- | :--- | :--- |
| **PostgreSQL Unreachable** | Remote fleet persistence fails. | Engine falls back automatically to local SQLite (`.agent/context.db`). Zero startup crash. |
| **Embedding Provider Offline** | Vector generation fails. | Engine falls back to lexical keyword matching and chronological recency ordering. |
| **Agent Prompt Flooding** | LLM context overflow. | `limit_tokens` prunes low-ranking memories and boilerplate before returning payload. |
| **Auditor Nagware** | Repetitive false positive warnings. | Negative feedback (`action: 'feedback'`) reduces rule weight below threshold to suppress rule. |

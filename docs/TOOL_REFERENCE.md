# Canonical Tool Reference (v1.8.0)

*This document is automatically generated from `src/index.js` via `npm run docs:generate`. Do not edit manually.*

## ⚡ Core 5 Verbs (`core` profile, default)

The default profile exposes strictly **5 canonical verbs** (~350 prompt tokens) for maximum reliability and zero tool soup:

| Tool Name | Short Alias | Primary Function |
| :--- | :--- | :--- |
| `krusch_context_retrieve` | `retrieve` | Hybrid context & state retrieval with strict token budget packing. |
| `krusch_context_remember` | `remember` | Unified write API for memories & steering nuggets with near-duplicate warning. |
| `krusch_context_revise` | `revise` | Temporal superseding and explicit invalidation with mandatory reason. |
| `krusch_context_nudge` | `nudge` | Pre-edit / pre-commit invariant auditor and alignment feedback weighting. |
| `krusch_context_health` | `health` | Operational diagnostics, closed-category counts, and 30-day TTL decay review. |

---

## 🔄 Legacy Alias → New Verb Mapping

For backward compatibility, legacy tool invocations are automatically intercepted and routed to the corresponding verb:

| Legacy Tool (v1.6 / v1.7) | Canonical Replacement (v1.8.0) | Notes |
| :--- | :--- | :--- |
| `krusch_context_add_memory` | `krusch_context_remember({ content, category })` | Enforces closed taxonomy |
| `krusch_context_nugget_remember` | `krusch_context_remember({ key, content })` | Sets persistent steering nugget |
| `krusch_context_search_memory` | `krusch_context_retrieve({ query, mode: 'memory' })` | Token budget packed |
| `krusch_context_compile_state` | `krusch_context_retrieve({ query: '*', include_state: true })` | Prepends state briefing |
| `krusch_context_supersede_memory` | `krusch_context_revise({ action: 'supersede', target_id, content })` | Preserves temporal lineage |
| `krusch_context_invalidate_memory` | `krusch_context_revise({ action: 'invalidate', target_id, reason })` | Mandatory reason required |
| `krusch_context_nugget_forget` | `krusch_context_revise({ action: 'forget_nugget', key })` | Retires persistent nugget |
| `krusch_context_proactive_nudge` | `krusch_context_nudge({ trigger: 'pre_commit', code })` | Capped at 3 findings |
| `krusch_context_nudge_feedback` | `krusch_context_nudge({ action: 'feedback', rule_id, feedback })` | Dynamic weight adjustment |
| `krusch_context_nugget_nudges` | `krusch_context_retrieve({ query, category: 'invariant' })` | Unified retrieval |

---

## 🛠️ Detailed Verb Specifications

### `krusch_context_retrieve`

**Description**: Universal context retrieval tool. Pulls active project memories, steering rules, and state briefings respecting token budget limits.

#### Parameters

| Parameter | Type | Required | Description |
| :--- | :--- | :---: | :--- |
| `query` | `string` | **Yes** | Search query or topic |
| `mode` | `string` | No | Retrieval mode [hybrid, memory, state] (default: `hybrid`) |
| `category` | `string` | No | Optional closed category filter [decision, bug, invariant, lesson, blocker] |
| `limit_tokens` | `number` | No | Maximum token budget to return (default: `4000`) |
| `include_state` | `boolean` | No | Optionally prepend compiled state briefing (default: `false`) |
| `project` | `string` | No | Target project (auto-detected if omitted) |

#### Example Return Shape

```markdown
=== 🧠 Active Context Briefing ===
📦 Persistent Invariants & Steering Rules:
• [invariant] architecture.db_mode: SQLite by default with Node 22

📝 Relevant Episodic Memories:
[#42] (decision) | Relevance: 0.942 | file: src/index.js
Decision to standardize on 5 canonical verbs.

--- Budget: 412 / 4000 tokens used ---
```

---

### `krusch_context_remember`

**Description**: Unified write API for episodic memory and persistent steering nuggets. Includes automatic near-duplicate detection and provenance tracking.

#### Parameters

| Parameter | Type | Required | Description |
| :--- | :--- | :---: | :--- |
| `content` | `string` | **Yes** | The fact, lesson, decision, or invariant to remember |
| `category` | `string` | No | Closed category taxonomy [decision, bug, invariant, lesson, blocker] (default: `lesson`) |
| `key` | `string` | No | Optional key to store as a persistent steering nugget |
| `provenance` | `object` | No | Provenance metadata |
| `tags` | `array` | No | Optional descriptive tags |
| `force` | `boolean` | No | If true, bypasses near-duplicate warnings (default: `false`) |
| `project` | `string` | No | Target project |

#### Example Return Shape

```json
{
  "ok": true,
  "id": 43,
  "category": "decision",
  "content": "Use node:sqlite exclusively without native C++ compilation.",
  "warning": "near_duplicate (optional: if cosine >= 0.85)",
  "candidate": {
    "id": 12,
    "similarity": 0.88,
    "suggestion": "Call revise with action: 'supersede' to replace #12"
  }
}
```

---

### `krusch_context_revise`

**Description**: Unified knowledge revision API. Supports temporal superseding (updating stale knowledge with lineage) and explicit invalidations (revoking obsolete rules with mandatory reason).

#### Parameters

| Parameter | Type | Required | Description |
| :--- | :--- | :---: | :--- |
| `action` | `string` | **Yes** | Revision action to perform [supersede, invalidate, forget_nugget] |
| `target_id` | `number` | No | Target memory ID (for supersede or invalidate) |
| `reason` | `string` | No | Mandatory justification when invalidating a memory |
| `content` | `string` | No | New authoritative content when superseding |
| `key` | `string` | No | Key of nugget to forget when action is forget_nugget |
| `category` | `string` | No | Optional category update [decision, bug, invariant, lesson, blocker] |
| `provenance` | `object` | No | Optional provenance metadata |
| `project` | `string` | No | Target project |

#### Example Return Shape

```json
{
  "ok": true,
  "action": "supersede",
  "superseded_id": 12,
  "new_id": 43,
  "message": "Memory #12 marked as SUPERSEDED by #43. Lineage preserved."
}
```

---

### `krusch_context_nudge`

**Description**: Invariant auditor and alignment feedback loop. Checks proposed code diffs or actions against active project invariants, and adjusts rule weights based on developer feedback.

#### Parameters

| Parameter | Type | Required | Description |
| :--- | :--- | :---: | :--- |
| `action` | `string` | No | Action: audit against invariants or submit feedback [audit, feedback] (default: `audit`) |
| `code` | `string` | No | Code or diff snippet to audit |
| `file_path` | `string` | No | Optional target file path |
| `trigger` | `string` | No | Trigger point. Default: manual. ('every_turn' is disabled to prevent audit spam) [pre_commit, pre_edit, manual] (default: `manual`) |
| `hook` | `string` | No | Alias for trigger [pre_commit, pre_edit, manual] |
| `rule_id` | `string` | No | Rule or memory ID when providing feedback |
| `feedback` | `string` | No | Feedback rating to tune rule weights [helpful, unhelpful, false_positive] |
| `project` | `string` | No | Target project |

#### Example Return Shape

```json
{
  "ok": true,
  "trigger": "pre_commit",
  "findings_count": 1,
  "findings": [
    {
      "rule_id": "invariant-2",
      "category": "invariant",
      "severity": "warn",
      "evidence": "Found better-sqlite3 in package.json",
      "suggestion": "Standardize on node:sqlite built-in."
    }
  ]
}
```

---

### `krusch_context_health`

**Description**: Operational health check, memory counts by closed taxonomy, storage mode, and 30-day TTL decay review.

#### Parameters

| Parameter | Type | Required | Description |
| :--- | :--- | :---: | :--- |
| `project` | `string` | No | Target project |

#### Example Return Shape

```json
{
  "status": "healthy",
  "version": "1.8.0",
  "storage": "sqlite",
  "database_path": "/workspace/.agent/context.db",
  "counts": {
    "total": 18,
    "decision": 7,
    "invariant": 4,
    "bug": 3,
    "lesson": 3,
    "blocker": 1
  },
  "decay_review": []
}
```

---

## 📋 Extended Admin Tools (`--profile=extended`)

Tools available only when launched with `--profile=extended` for manual maintenance:

### `krusch_context_list_memories`

**Description**: List memories chronologically for inspection.

#### Parameters

| Parameter | Type | Required | Description |
| :--- | :--- | :---: | :--- |
| `category` | `string` | **Yes** |  [decision, bug, invariant, lesson, blocker] |
| `limit` | `number` | No |  (default: `10`) |
| `project` | `string` | No |  |

### `krusch_context_delete_memory`

**Description**: Hard-delete a memory record (admin cleanup).

#### Parameters

| Parameter | Type | Required | Description |
| :--- | :--- | :---: | :--- |
| `id` | `number` | **Yes** |  |
| `project` | `string` | No |  |

### `krusch_context_consolidate`

**Description**: Consolidate duplicate memories within a category.

#### Parameters

| Parameter | Type | Required | Description |
| :--- | :--- | :---: | :--- |
| `category` | `string` | **Yes** |  [decision, bug, invariant, lesson, blocker] |
| `threshold` | `number` | No |  (default: `0.15`) |
| `dry_run` | `boolean` | No |  (default: `false`) |
| `project` | `string` | No |  |

### `krusch_context_nugget_list`

**Description**: List all persistent steering nuggets.

#### Parameters

| Parameter | Type | Required | Description |
| :--- | :--- | :---: | :--- |
| `project` | `string` | No |  |


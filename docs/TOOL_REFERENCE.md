# 📖 Krusch Context MCP Tool Reference (v1.8.0)

> Auto-generated from source definitions in `src/index.js`. Run `npm run docs:generate` to synchronize.

Krusch Context MCP enforces a strict **5-verb public contract** (~350 prompt tokens) to maximize host agent accuracy and eliminate tool hallucination.

## ⚡ The 5 Canonical Verbs

| Verb | Short Alias | Purpose |
| :--- | :--- | :--- |
| `krusch_context_retrieve` | `retrieve` | Hydrate project decisions, invariants, and state briefings within a strict token budget. |
| `krusch_context_remember` | `remember` | Persist lasting facts with closed categories (`decision`, `bug`, `invariant`, `lesson`, `blocker`) and duplicate warning. |
| `krusch_context_revise` | `revise` | Update facts via temporal superseding (`supersede`) or retire rules with mandatory justification (`invalidate`). |
| `krusch_context_nudge` | `nudge` | Pre-edit / pre-commit invariant auditor and alignment feedback weighting. |
| `krusch_context_health` | `health` | Operational diagnostics, closed-category counts, and 30-day TTL decay review. |

---

## 🔄 Internal Alias Mapping

For backward compatibility, host agent aliases and legacy invocations are automatically intercepted and routed to the corresponding verb:

| Invocation / Alias | Canonical Replacement | Notes |
| :--- | :--- | :--- |
| `retrieve` | `krusch_context_retrieve` | Direct shorthand |
| `remember` | `krusch_context_remember` | Direct shorthand |
| `revise` | `krusch_context_revise` | Direct shorthand |
| `nudge` | `krusch_context_nudge` | Direct shorthand |
| `health` | `krusch_context_health` | Direct shorthand |
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
    "action": "Consider revise(action='supersede', target_id=12)"
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
  "target_id": 12,
  "new_id": 43,
  "lineage": {
    "supersedes_id": 12,
    "status": "SUPERSEDED"
  }
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

```markdown
🛡️ Pre-Commit Invariant Findings (2 active constraints checked):
1. [VIOLATION] invariant:db_query_parameterization
   Line 42 of src/db.js contains raw string template in query.
   Recommendation: Use parameterized $1 bindings.
```

---

### `krusch_context_health`

**Description**: Operational health check, memory counts by closed taxonomy, storage mode, and 30-day TTL decay review.

#### Parameters

| Parameter | Type | Required | Description |
| :--- | :--- | :---: | :--- |
| `project` | `string` | No | Target project |

#### Example Return Shape

```markdown
=== 🏥 Krusch Context MCP Health Report ===
* Store Mode: SQLite (.agent/context.db)
* Total Active Memories: 142
  - Decisions: 38
  - Invariants: 44
  - Bugs: 22
  - Lessons: 31
  - Blockers: 7
* Memories > 30 Days Old: 14 (candidates for review or invalidation)
* Status: HEALTHY (Operational)
```

---


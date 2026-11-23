# 📖 Krusch Context MCP Tool Reference (v2.0.3)

> Auto-generated from source definitions in `src/index.js`. Run `npm run docs:generate` to synchronize.

Krusch Context MCP enforces a strict **5-verb public contract** (`~950` `o200k_base` schema tokens across the full `tools/list` JSON) to maximize host agent accuracy and eliminate tool hallucination.

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

**Description**: Retrieve active memories, steering rules, and project state within a token budget.

#### Parameters

| Parameter | Type | Required | Description |
| :--- | :--- | :---: | :--- |
| `query` | `string` | **Yes** | Search query or "*" |
| `mode` | `string` | No | Retrieval mode [hybrid, memory, state] (default: `hybrid`) |
| `category` | `string` | No | Category filter [decision, bug, invariant, lesson, blocker] |
| `limit_tokens` | `number` | No | Max tokens to return (default: `4000`) |
| `include_state` | `boolean` | No | Prepend compiled project state briefing (default: `false`) |
| `project` | `string` | No | Target project (auto-detected) |

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

**Description**: Store an episodic memory or steering nugget with near-duplicate detection and provenance.

#### Parameters

| Parameter | Type | Required | Description |
| :--- | :--- | :---: | :--- |
| `content` | `string` | **Yes** | Fact, decision, bug, lesson, or invariant |
| `category` | `string` | No | Closed category [decision, bug, invariant, lesson, blocker] (default: `lesson`) |
| `key` | `string` | No | Key for persistent steering nugget |
| `provenance` | `object` | No | Source span and attribution metadata |
| `tags` | `array` | No | Tags |
| `force` | `boolean` | No | Bypass near-duplicate warning (default: `false`) |
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

**Description**: Supersede stale memories with lineage, invalidate obsolete rules with a reason, or forget a nugget.

#### Parameters

| Parameter | Type | Required | Description |
| :--- | :--- | :---: | :--- |
| `action` | `string` | **Yes** | Revision action [supersede, invalidate, forget_nugget] |
| `target_id` | `number` | No | Memory ID (supersede/invalidate) |
| `reason` | `string` | No | Required reason (invalidate) |
| `content` | `string` | No | Replacement content (supersede) |
| `key` | `string` | No | Nugget key (forget_nugget) |
| `category` | `string` | No | Updated category [decision, bug, invariant, lesson, blocker] |
| `provenance` | `object` | No | Provenance metadata |
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

**Description**: Audit a code snippet or diff against active invariants, or submit rule feedback.

#### Parameters

| Parameter | Type | Required | Description |
| :--- | :--- | :---: | :--- |
| `action` | `string` | No | Audit or feedback [audit, feedback] (default: `audit`) |
| `code` | `string` | No | Code or diff to audit |
| `file_path` | `string` | No | Target file path |
| `trigger` | `string` | No | Trigger point [pre_commit, pre_edit, manual] (default: `manual`) |
| `hook` | `string` | No | Alias for trigger [pre_commit, pre_edit, manual] |
| `rule_id` | `string` | No | Rule/memory ID (feedback) |
| `feedback` | `string` | No | Feedback rating [helpful, unhelpful, false_positive] |
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

**Description**: Report storage mode, memory counts by category, span drift, and 30-day decay review.

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


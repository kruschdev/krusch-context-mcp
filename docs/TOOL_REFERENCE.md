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

---

### `krusch_context_health`

**Description**: Operational health check, memory counts by closed taxonomy, storage mode, and 30-day TTL decay review.

#### Parameters

| Parameter | Type | Required | Description |
| :--- | :--- | :---: | :--- |
| `project` | `string` | No | Target project |

---

## 📋 Extended Admin Tools (`extended` profile)

Tools available only when launched with `--profile=extended` for manual inspection and maintenance:

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


# 🧠 Episodic Memory & Knowledge Lifecycle

> Persistent project memory, closed category taxonomy, temporal lineage, and near-duplicate protection.
> For tool schemas, see [TOOL_REFERENCE.md](TOOL_REFERENCE.md).

---

## 1. The Core Concept

Every time an AI coding agent starts a new session (in Claude Code, Cursor, or a terminal CLI), its working memory is empty. Without persistent episodic memory, the agent suffers from amnesia:
* It forgets architectural decisions made yesterday.
* It repeats regressions that were already diagnosed and fixed.
* It hallucinates outdated rules that were superseded weeks ago.

`krusch-context-mcp` gives the agent a persistent, lightweight memory substrate. The agent reads this memory at the start of a session, updates it as decisions solidify, and retires obsolete facts with explicit justification.

---

## 2. Closed Category Taxonomy

To prevent memory contamination and enforce high-signal retrieval, all writes to `remember` must belong to a **closed taxonomy of 5 categories**:

| Category | Description | Example Fact |
|---|---|---|
| 🏛️ **`decision`** | Architectural choices, library selections, and committed design paths | `"Standardized on Node 22 native node:sqlite without native C++ compilation dependencies."` |
| 🛡️ **`invariant`** | Non-negotiable code rules, security constraints, and stylistic standards | `"All API responses must use the envelope { ok: boolean, data?: any, error?: string }."` |
| 🐛 **`bug`** | Diagnosed defects, root-cause analyses, and anti-regression rules | `"Postgres port collision occurred on 5432; homelab fleet routes secondary DBs to 5434."` |
| 💡 **`lesson`** | Practical insights, operational findings, and framework quirks | `"Better-sqlite3 requires node-gyp rebuild on glibc update; native node:sqlite avoids this."` |
| 🚧 **`blocker`** | Active technical impediments or external dependencies pending resolution | `"Waiting on upstream pgvector 0.8 package release before bumping dimension limits."` |

*Writes with categories outside this closed set are rejected.*

---

## 3. Safe Writes: Near-Duplicate Detection

Naive memory stores accumulate duplicate facts over time, confusing agents with repetitive noise. 

When you call `krusch_context_remember`:
1. The engine checks existing active memories in the project for semantic similarity.
2. If cosine similarity is **$\ge 0.85$**, the engine saves the memory but returns a **`near_duplicate` warning**:
   ```json
   {
     "ok": true,
     "id": 44,
     "category": "decision",
     "warning": "near_duplicate",
     "candidate": {
       "id": 12,
       "similarity": 0.89,
       "existing_content": "Use node:sqlite without node-gyp.",
       "suggestion": "If updating knowledge, call revise with action: 'supersede' and target_id: 12"
     }
   }
   ```
3. This steers the agent to maintain a clean knowledge graph instead of polluting the database with twin records.

---

## 4. Revisions: Lineage & Mandatory Invalidation Reasons

Knowledge is not static; project decisions change. `krusch-context-mcp` handles knowledge updates through `krusch_context_revise`.

### A. Superseding (Updating Facts)
When a decision evolves, call `revise` with `action: 'supersede'`:
```json
{
  "action": "supersede",
  "target_id": 12,
  "content": "Migrated from node:sqlite experimental flag to stable Node 22.12 DatabaseSync.",
  "category": "decision"
}
```
* **Effect**: Memory `#12` is marked as `SUPERSEDED`, `#45` is created as `ACTIVE`, and `supersedes_id` / `superseded_by` pointers preserve complete historical lineage. Default retrieval automatically hides `#12` so the agent only sees current facts.

### B. Invalidation (Revoking Stale Invariants)
When a rule or invariant is no longer valid, call `revise` with `action: 'invalidate'`:
```json
{
  "action": "invalidate",
  "target_id": 8,
  "reason": "Removed Docker Compose dependency; homelab runs bare-metal systemd services."
}
```
* **Compulsory Reason**: Invalidation strictly requires a non-empty `reason`. An invalidation without a reason will throw an error. This reason is surfaced in compiled state briefings so agents understand *why* a constraint was retired.

---

## 5. Retrieval: Budget Containment & Temporal Decay

When calling `krusch_context_retrieve`:

### Token Budget Packing
The agent specifies a maximum token budget (default: `limit_tokens: 4000`). The engine ranks candidate facts, trims boilerplate, and packs context until the budget is reached, safeguarding the LLM context window.

### Ebbinghaus Temporal Decay
Candidates are ranked using exponential temporal decay:
$$\text{Score} = \text{Similarity} \times e^{-0.01 \times \text{age}_{\text{days}}}$$
Recent decisions and active rules naturally rank above dormant facts, while 30-day unreferenced items surface for decay review during `health` checks.

---

## 6. Recommended Agent Interaction Protocol

```
┌─────────────────────────────────────────────────────────────┐
│ 1. SESSION START                                            │
│    Agent calls retrieve(query: '*', include_state: true)    │
│    -> Obtains active invariants, recent decisions, blockers │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│ 2. DURING WORK                                              │
│    Agent calls remember(content: '...', category: '...')    │
│    -> If near-duplicate returned, agent calls revise(...)   │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│ 3. PRE-COMMIT                                               │
│    Agent calls nudge(trigger: 'pre_commit')                 │
│    -> Audits code against active invariants (max 3 findings)│
└─────────────────────────────────────────────────────────────┘
```

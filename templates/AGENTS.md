# Agent Operating Manual & Memory Protocol (`krusch-context-mcp`)

You are paired with a developer using `krusch-context-mcp` (v1.8.0) for cross-session working memory.
Memory is stored locally in `.agent/context.db` (SQLite).

## The 5-Verb Memory Protocol

### 1. 🔄 Session Start: Hydrate Context
At the beginning of any non-trivial session or task, call `krusch_context_retrieve`:
```json
{
  "query": "*",
  "include_state": true,
  "limit_tokens": 4000
}
```
*Purpose*: Loads active project invariants, recent architectural decisions, open blockers, and decay review candidates into your prompt context.

### 2. 📝 During Development: Record Lasting Knowledge
When you make a significant design choice, discover a framework quirk, or diagnose a tricky defect, call `krusch_context_remember`:
```json
{
  "category": "decision",
  "content": "<succinct explanation of the decision and trade-off>"
}
```
*Categories (Closed Taxonomy)*:
- `decision`: Architectural commitments, design directions, library selections.
- `invariant`: Non-negotiable code rules (e.g. error envelopes, auth patterns).
- `bug`: Diagnosed root causes and anti-regression rules.
- `lesson`: Operational findings and implementation discoveries.
- `blocker`: Active dependencies or external obstacles.

### 3. ⚠️ Handling Near-Duplicate Warnings
If `remember` returns `warning: 'near_duplicate'`, do not ignore it:
- If the new fact replaces or refines the existing one, call `krusch_context_revise(action: 'supersede', target_id: <id>, content: '...')`.
- If the fact is contrasting or deliberately separate, leave it active.

### 4. 🗑️ Retiring Obsolete Rules
When an invariant, pattern, or dependency is retired, call `krusch_context_revise`:
```json
{
  "action": "invalidate",
  "target_id": <id>,
  "reason": "<mandatory non-empty reason explaining why this rule was revoked>"
}
```

### 5. 🛡️ Pre-Commit Audit
Before completing multi-file changes or pushing commits, audit diffs using `krusch_context_nudge`:
```json
{
  "trigger": "pre_commit",
  "code": "<modified code or diff snippet>"
}
```
*Purpose*: Ensures your changes do not violate active project invariants. Capped at 3 actionable findings.

### 6. 🩺 Health & Diagnostic Hygiene
Inspect store statistics and review aged (>30 days) memories with `krusch_context_health`:
```json
{}
```

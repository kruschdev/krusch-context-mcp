# Claude Code Agent Protocol (`krusch-context-mcp`)

This project uses `krusch-context-mcp` for cross-session working memory, architectural decisions, and invariant steering.

## Required Agent Lifecycle

### 1. Session Start (Hydrate State)
At the start of your turn or session, call `krusch_context_retrieve` to load project constraints:
```javascript
krusch_context_retrieve({
  query: "*",
  include_state: true,
  limit_tokens: 4000
});
```

### 2. During Work (Record Key Decisions & Bugs)
When you decide an architectural pattern or resolve a defect, persist it via `krusch_context_remember`:
```javascript
krusch_context_remember({
  category: "decision", // 'decision' | 'invariant' | 'bug' | 'lesson' | 'blocker'
  content: "Use node:sqlite DatabaseSync built-in; zero native compilation dependencies."
});
```
If a `near_duplicate` warning is returned, evaluate whether to update the existing record with `krusch_context_revise`:
```javascript
krusch_context_revise({
  action: "supersede",
  target_id: 12,
  content: "Updated invariant rule with latest findings.",
  category: "invariant"
});
```

### 3. Retiring Outdated Rules
When an invariant or rule is revoked, invalidate it with an explicit reason:
```javascript
krusch_context_revise({
  action: "invalidate",
  target_id: 8,
  reason: "Replaced custom mutex with atomic SQLite transactions."
});
```

### 4. Pre-Commit Verification
Before declaring a coding task complete, run the invariant audit:
```javascript
krusch_context_nudge({
  trigger: "pre_commit"
});
```

### 5. Memory Health Check
Review stored memory taxonomy and decay candidates:
```javascript
krusch_context_health({});
```

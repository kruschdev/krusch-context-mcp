# Claude Code Agent Protocol (`krusch-context-mcp`)

This project uses `krusch-context-mcp` for cross-session working memory, structural code symbol graphs, and persistent steering rules.

## Standard Tool Calling Lifecycle

### 1. At Start of Work / New Session
Call `krusch_context_retrieve` with `include_state: true` to hydrate current project state alongside code context in a single turn (workspace project is automatically detected if omitted):
```javascript
krusch_context_retrieve({
  query: "<task context>",
  include_state: true,
  graph_hops: 2,
  limit_tokens: 3500,
  include_code: true
});
```
Or inspect the compiled state briefing standalone (`project` is optional with auto-detection):
```javascript
krusch_context_compile_state({});
```

### 2. Before Non-Trivial Code Modifications
Call `krusch_context_retrieve` to fetch unified vector context, symbol graphs, and relevant past memories packed within your token budget:
```javascript
krusch_context_retrieve({
  query: "<task context>",
  project: "<project_name>",
  graph_hops: 2,
  limit_tokens: 3500,
  include_code: true
});
```
Call `krusch_context_nugget_nudges` to check for steering rules and architectural conventions:
```javascript
krusch_context_nugget_nudges({ query: "<task context>" });
```

### 3. When Facts or Architectural Decisions Change
Maintain clean knowledge lineage with active superseding and invalidation:
```javascript
// Supersede outdated rules with new authoritative truth
krusch_context_supersede_memory({
  id: <old_id>,
  category: "lessons",
  content: "<new fact>",
  project: "<project_name>"
});

// Explicitly invalidate revoked secrets or obsolete invariants
krusch_context_invalidate_memory({
  id: <old_id>,
  reason: "<why obsolete>"
});

// Record key milestone outcomes or discovered bug solutions
krusch_context_add_memory({
  category: "lessons",
  content: "...",
  project: "<project_name>"
});
```

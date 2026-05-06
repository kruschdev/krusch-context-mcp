---
description: Resume krusch-context-mcp work from a previous session
---

# /continue — krusch-context-mcp

## Steps

1. **Context Load** (parallel):
   - Read `GEMINI_INFLIGHT.md` from this project root.
   - Query `krusch_context_search_memory` with `category: 'activity'`, `active_project: 'krusch-context-mcp'`.
   - Query `mcp_nuggets-memory_nudges` with `kinds: ['project', 'user']`, query: `krusch-context-mcp`.
   - Execute `krusch_context_search_code` with `project: 'krusch-context-mcp'` to verify codebase state.

2. **Transient State Check**: If GEMINI_INFLIGHT has a Fragile or Transient State block, locate the linked task.md and prepare to resume.

3. **Task Generation**: Generate or update the `task.md` artifact from the inflight next steps.

4. **Execution**: Autonomously execute the next logical step.

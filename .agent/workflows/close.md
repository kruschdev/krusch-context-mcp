---
description: Pause krusch-context-mcp and save state
---

# /close — krusch-context-mcp

## Steps

1. **Self-Sync**: Take a semantic snapshot of this project.
   ```bash
   node /home/kruschdev/homelab/projects/pg-git/scripts/sync_to_pg.js /home/kruschdev/homelab/projects/krusch-context-mcp
   ```

2. **Update GEMINI_INFLIGHT.md**:
   - Create or overwrite `GEMINI_INFLIGHT.md` in this project root.
   - Include: current tool surface status (count, any broken), pending schema migrations, Ollama model/fleet health.
   - Document any **Fragile** files and transient state.

3. **Log Activity**:
   - Execute `krusch_context_add_memory` with `category: 'activity'`, `project: 'krusch-context-mcp'` and content summarizing this session's work.

4. **Save Steering Facts**:
   - Store any new patterns via `mcp_nuggets-memory_remember` with `kind: 'project'`, key prefixed `krusch-context-mcp:`.

5. **Summarize**:
   > "krusch-context-mcp state saved. See you next session."

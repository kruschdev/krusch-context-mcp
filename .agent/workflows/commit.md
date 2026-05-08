---
description: Commit krusch-context-mcp changes with conventional format
---

# /commit — krusch-context-mcp

## Steps

1. **Review changes**:
   ```bash
   cd /home/kruschdev/homelab/projects/krusch-context-mcp && git diff --stat
   ```

2. **Self-Sync**: Snapshot current state into PG-Git.
   ```bash
   node /home/kruschdev/homelab/projects/pg-git/scripts/sync_to_pg.js /home/kruschdev/homelab/projects/krusch-context-mcp
   ```

3. **Stage and Commit**: Use conventional commit format.
   - Scope: `krusch-context-mcp`
   - Example: `feat(krusch-context-mcp): add consolidate_memories tool`

4. **Push to monorepo**:
   ```bash
   git push origin main
   ```

5. **Sync standalone repo**: Push the subtree to `github.com/kruschdev/krusch-context-mcp`.
   ```bash
   # turbo
   cd /home/kruschdev/homelab && git push krusch-context-mcp $(git subtree split --prefix=projects/krusch-context-mcp):main --force
   ```

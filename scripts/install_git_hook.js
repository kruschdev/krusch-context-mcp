#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const currentDir = process.cwd();

function findGitRoot(startPath) {
    let current = startPath;
    while (current !== path.parse(current).root) {
        if (fs.existsSync(path.join(current, '.git'))) {
            return current;
        }
        current = path.dirname(current);
    }
    return null;
}

const gitRoot = findGitRoot(currentDir);

if (!gitRoot) {
    console.error('Error: .git directory not found. Are you in a git repository?');
    process.exit(1);
}

const gitDir = path.join(gitRoot, '.git');
const hooksDir = path.join(gitDir, 'hooks');
const hookPath = path.join(hooksDir, 'post-commit');

if (!fs.existsSync(hooksDir)) {
    fs.mkdirSync(hooksDir, { recursive: true });
}

const hookContent = `#!/bin/bash
# Krusch Context Lakebase Auto-Sync
# Automatically synchronizes the repository to pg-git after every commit.

# Check if pg-git-mcp is installed in node_modules
SYNC_SCRIPT="node_modules/pg-git-mcp/scripts/sync_to_pg.js"

if [ -f "$SYNC_SCRIPT" ]; then
    echo "Backgrounding Krusch Context Lakebase sync..."
    (node "$SYNC_SCRIPT" . > .git/lakebase_sync.log 2>&1 &)
else
    # Fallback to global installation if it exists
    GLOBAL_SCRIPT="$(npm root -g)/pg-git-mcp/scripts/sync_to_pg.js"
    if [ -f "$GLOBAL_SCRIPT" ]; then
        echo "Backgrounding global Krusch Context Lakebase sync..."
        (node "$GLOBAL_SCRIPT" . > .git/lakebase_sync.log 2>&1 &)
    else
        echo "Krusch Context Auto-Sync skipped: pg-git-mcp not found in node_modules or global namespace."
    fi
fi
`;

try {
    fs.writeFileSync(hookPath, hookContent, { mode: 0o755 });
    console.log(`Successfully installed git post-commit hook at ${hookPath}`);
    console.log('Commits will now automatically sync your project to Lakebase in the background.');
} catch (error) {
    console.error('Error installing git hook:', error.message);
    process.exit(1);
}

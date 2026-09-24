#!/usr/bin/env node

/**
 * @module cli
 * Command-line interface for krusch-context-mcp.
 * Supports:
 *   - `npx krusch-context-mcp init`: One-shot zero-Docker installation and setup.
 *   - `npx krusch-context-mcp health`: Operational diagnostics.
 *   - `npx krusch-context-mcp`: Launches MCP server on stdio.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { runServer, VERSION } from '../src/index.js';
import { getHealthStats, addMemory } from '../src/memory-engine.js';
import { getSqliteDb } from '../src/storage-adapter.js';
import { detectCurrentProject } from '../src/project-helper.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 0. Support matrix check: Node >= 22 required for native node:sqlite (DatabaseSync)
const nodeVersion = process.versions.node;
const majorVersion = parseInt(nodeVersion.split('.')[0], 10);
if (majorVersion < 22) {
    console.error(`\x1b[31m❌ Error: krusch-context-mcp v${VERSION} requires Node.js >= 22.0.0 for native SQLite (node:sqlite).\x1b[0m`);
    console.error(`Current version: v${nodeVersion}. Please upgrade Node before running.`);
    process.exit(1);
}

const scriptName = process.argv[1] ? path.basename(process.argv[1]) : '';
const isDirectRun = process.argv[1] && (
    process.argv[1] === __filename || 
    scriptName === 'cli.js' || 
    scriptName === 'krusch-context-mcp'
);

if (isDirectRun) {
    const cmd = process.argv[2];
    if (cmd === 'init') {
        runInit().catch(err => {
            console.error('❌ Init error:', err.message);
            process.exit(1);
        });
    } else if (cmd === 'health' || cmd === '--health') {
        runCliHealth().catch(err => {
            console.error('❌ Health check error:', err.message);
            process.exit(1);
        });
    } else {
        // Default: run MCP server
        runServer().catch(err => {
            console.error('❌ Server startup error:', err.message);
            process.exit(1);
        });
    }
}

function cleanStaleMcpSchemas() {
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    const mcpDirs = [
        path.join(homeDir, '.gemini', 'antigravity-ide', 'mcp', 'krusch-context-mcp'),
        path.join(homeDir, '.gemini', 'antigravity', 'mcp', 'krusch-context-mcp')
    ];
    const coreNames = new Set([
        'krusch_context_retrieve',
        'krusch_context_remember',
        'krusch_context_revise',
        'krusch_context_nudge',
        'krusch_context_health'
    ]);

    let cleaned = 0;
    for (const d of mcpDirs) {
        if (fs.existsSync(d)) {
            try {
                for (const file of fs.readdirSync(d)) {
                    if (file.endsWith('.json')) {
                        const name = file.replace('.json', '');
                        if (!coreNames.has(name)) {
                            fs.unlinkSync(path.join(d, file));
                            cleaned++;
                        }
                    }
                }
            } catch {}
        }
    }
    if (cleaned > 0) {
        console.log(`🧹 Cleaned ${cleaned} stale MCP tool schema files from local IDE cache.`);
    }
}

export function migrateLegacyDatabase(targetDir) {
    const agentDir = path.join(targetDir, '.agent');
    const legacyDb = path.join(agentDir, 'memory.db');
    const contextDb = path.join(agentDir, 'context.db');
    if (fs.existsSync(legacyDb) && !fs.existsSync(contextDb)) {
        fs.copyFileSync(legacyDb, contextDb);
        return true;
    }
    return false;
}

async function runInit() {
    console.log(`\n🚀 Initializing Krusch Context MCP v${VERSION}...\n`);
    cleanStaleMcpSchemas();

    const cwd = process.cwd();
    let isGit = false;
    let gitRoot = cwd;

    try {
        gitRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        isGit = true;
    } catch {}

    const projectName = path.basename(gitRoot || cwd);
    console.log(`📁 Project detected: \x1b[36m${projectName}\x1b[0m ${isGit ? '(git repo)' : ''}`);

    // 1. Initialize local SQLite database (.agent/context.db)
    const agentDir = path.join(gitRoot, '.agent');
    if (!fs.existsSync(agentDir)) {
        fs.mkdirSync(agentDir, { recursive: true });
    }
    if (migrateLegacyDatabase(gitRoot)) {
        console.log(`📦 Migrated legacy database \x1b[33m.agent/memory.db\x1b[0m -> \x1b[32m.agent/context.db\x1b[0m`);
    }
    const db = getSqliteDb(gitRoot);
    console.log(`💾 Local SQLite database initialized at \x1b[32m.agent/context.db\x1b[0m (zero-Docker default)`);

    // Ensure .agent/ is ignored in git
    const gitignorePath = path.join(gitRoot, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
        const gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8');
        if (!gitignoreContent.includes('.agent')) {
            fs.appendFileSync(gitignorePath, '\n# Local Agent State Database\n.agent/\n');
            console.log(`🔒 Added \x1b[32m.agent/\x1b[0m to .gitignore`);
        }
    }

    // 2. Write or update .env
    const envPath = path.join(gitRoot, '.env');
    let envContent = '';
    if (fs.existsSync(envPath)) {
        envContent = fs.readFileSync(envPath, 'utf-8');
    }

    const defaultVars = [
        ['STORAGE_MODE', 'sqlite'],
        ['OLLAMA_URL', 'http://127.0.0.1:11434'],
        ['EMBED_MODEL', 'bge-large'],
        ['EMBED_DIMS', '1024']
    ];

    let updated = false;
    for (const [k, v] of defaultVars) {
        if (!envContent.includes(`${k}=`)) {
            envContent += `\n${k}=${v}`;
            updated = true;
        }
    }

    if (updated || !fs.existsSync(envPath)) {
        fs.writeFileSync(envPath, envContent.trim() + '\n');
        console.log(`📝 Configuration written to \x1b[32m.env\x1b[0m`);
    }

    // 3. Seed starter project invariant if empty
    const countRow = db.prepare(`SELECT count(*) as count FROM ide_agent_memory`).get();
    if (!countRow || countRow.count === 0) {
        try {
            await addMemory({
                category: 'decision',
                content: `Initialized Krusch Context MCP with SQLite local memory for project '${projectName}'.`,
                project: projectName,
                provenance: { author: 'human', confidence: 1.0 },
                force: true
            });
            console.log(`🧠 Seeded initial project memory.`);
        } catch {}
    }

    // 4. Install agent operating protocol (AGENTS.md)
    const agentsPath = path.join(gitRoot, 'AGENTS.md');
    const templateAgentsPath = path.join(__dirname, '..', 'templates', 'AGENTS.md');
    if (!fs.existsSync(agentsPath) && fs.existsSync(templateAgentsPath)) {
        fs.copyFileSync(templateAgentsPath, agentsPath);
        console.log(`🤖 Agent operating protocol installed at \x1b[32mAGENTS.md\x1b[0m`);
    } else if (fs.existsSync(agentsPath)) {
        console.log(`🤖 Agent operating protocol already present at \x1b[36mAGENTS.md\x1b[0m`);
    }

    // 5. Run diagnostic health
    const health = await getHealthStats({ project: projectName });
    console.log(`\n${health.content[0].text}\n`);

    // 6. Print copy-paste IDE configs
    console.log(`========================================================================`);
    console.log(`🎉 \x1b[32mReady! Copy and paste this into your IDE configuration:\x1b[0m\n`);

    console.log(`👉 \x1b[1mCursor\x1b[0m (.cursor/mcp.json):`);
    console.log(JSON.stringify({
        mcpServers: {
            "krusch-context": {
                command: "npx",
                args: ["-y", "krusch-context-mcp"]
            }
        }
    }, null, 2));

    console.log(`\n👉 \x1b[1mClaude Code\x1b[0m:`);
    console.log(`claude mcp add krusch-context npx krusch-context-mcp\n`);

    console.log(`👉 \x1b[1mClaude Desktop\x1b[0m (claude_desktop_config.json):`);
    console.log(JSON.stringify({
        mcpServers: {
            "krusch-context": {
                command: "npx",
                args: ["-y", "krusch-context-mcp"]
            }
        }
    }, null, 2));

    console.log(`💡 \x1b[36mAgent Protocol\x1b[0m: AGENTS.md has been seeded in your project root.`);
    console.log(`   Optional IDE rules are also available in templates/.cursorrules and templates/CLAUDE.md.\n`);
    console.log(`========================================================================\n`);
    process.exit(0);
}

async function runCliHealth() {
    const projectName = detectCurrentProject();
    const health = await getHealthStats({ project: projectName });
    console.log(health.content[0].text);
    process.exit(0);
}


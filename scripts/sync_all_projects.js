#!/usr/bin/env node

/**
 * Batch sync all active homelab projects into PostgreSQL blobs and symbol tables
 * using krusch-context-mcp's native snapshot engine.
 * 
 * Usage: node scripts/sync_all_projects.js
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { query, pool } from '../db/pool.js';
import { snapshot } from './snapshot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MONOREPO_ROOT = path.resolve(__dirname, '../../..');
const HOMELAB_ROOT = path.join(MONOREPO_ROOT, 'projects');

const PROJECTS = [
    'annotated',
    'agent-toolkit-for-aws',
    'berean',
    'caren',
    'first-things-first',
    'heyjb',
    'hivemind-companion-ext',
    'home-ai',
    'krusch-dbos-mcp',
    'krusch-agentic-mcp',
    'krusch-context-mcp',
    'krusch-infra-mcp',
    'krusch-ide',
    'lightmind',
    'money-machine',
    'perkins_snow_removal',
    'pg-git',
    'pocket-lawyer',
    'pocket-lawyer-marketing',
    'roughin-suite',
    'signet',
    'spark',
    'vllm',
];

const ROOT_DIRS = [
    { name: 'scripts', path: path.join(MONOREPO_ROOT, 'scripts') },
    { name: 'lib', path: path.join(MONOREPO_ROOT, 'lib') },
    { name: 'lib-py', path: path.join(MONOREPO_ROOT, 'lib-py') },
    { name: '.agent', path: path.join(MONOREPO_ROOT, '.agent') },
];

async function main() {
    console.log('🚀 Starting Fleet-wide Native Codebase Sync...');
    
    // Sync homelab projects
    for (const proj of PROJECTS) {
        const projPath = path.join(HOMELAB_ROOT, proj);
        if (fs.existsSync(projPath)) {
            try {
                await snapshot(projPath);
            } catch (err) {
                console.error(`❌ Failed syncing project ${proj}:`, err.message);
            }
        }
    }

    // Sync root dirs
    for (const dir of ROOT_DIRS) {
        if (fs.existsSync(dir.path)) {
            try {
                await snapshot(dir.path);
            } catch (err) {
                console.error(`❌ Failed syncing root dir ${dir.name}:`, err.message);
            }
        }
    }

    console.log('✅ Fleet sync complete.');
    await pool.end();
}

main().catch(err => {
    console.error('Fatal Fleet Sync Error:', err);
    process.exit(1);
});

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
const MONOREPO_ROOT = process.env.WORKSPACE_ROOT || path.resolve(__dirname, '../../..');
const PROJECTS_DIR = process.env.PROJECTS_DIR || (fs.existsSync(path.join(MONOREPO_ROOT, 'projects')) ? path.join(MONOREPO_ROOT, 'projects') : MONOREPO_ROOT);

// Dynamically discover subdirectories or accept explicit comma-separated list
const PROJECTS = process.env.SYNC_PROJECTS
    ? process.env.SYNC_PROJECTS.split(',').map(s => s.trim()).filter(Boolean)
    : (fs.existsSync(PROJECTS_DIR)
        ? fs.readdirSync(PROJECTS_DIR).filter(f => {
            try {
                return fs.statSync(path.join(PROJECTS_DIR, f)).isDirectory() && !f.startsWith('.') && f !== 'node_modules';
            } catch {
                return false;
            }
        })
        : []);

const ROOT_DIRS = (process.env.EXTRA_SYNC_DIRS ? process.env.EXTRA_SYNC_DIRS.split(',') : ['scripts', 'lib', 'lib-py'])
    .map(d => ({ name: path.basename(d.trim()), path: path.isAbsolute(d.trim()) ? d.trim() : path.join(MONOREPO_ROOT, d.trim()) }))
    .filter(d => fs.existsSync(d.path));

async function main() {
    console.log('🚀 Starting Fleet-wide Native Codebase Sync...');
    
    // Sync projects
    for (const proj of PROJECTS) {
        const projPath = path.join(PROJECTS_DIR, proj);
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

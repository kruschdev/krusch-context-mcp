import { DatabaseSync as NodeSqliteDriver } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

let openSqliteDb = null;
try {
    const siblingSqliteUrl = new URL('../../../lib/sqlite.js', import.meta.url);
    if (fs.existsSync(siblingSqliteUrl)) {
        ({ openSqliteDb } = await import(siblingSqliteUrl.href));
    } else {
        ({ openSqliteDb } = await import('@krusch/toolkit/sqlite'));
    }
} catch {
    openSqliteDb = null;
}

function openSqliteConnection(dbPath) {
    if (typeof openSqliteDb === 'function') {
        return openSqliteDb(dbPath, {
            wal: true,
            busyTimeout: 5000,
            synchronous: 'NORMAL'
        }).db;
    }
    const db = new NodeSqliteDriver(dbPath);
    try {
        db.exec('PRAGMA busy_timeout = 5000;');
        db.exec('PRAGMA journal_mode = WAL;');
        db.exec('PRAGMA synchronous = NORMAL;');
        db.exec('PRAGMA foreign_keys = ON;');
        return db;
    } catch (err) {
        try { db.close(); } catch {}
        throw err;
    }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.resolve(__dirname, '../../../');
const PROJECTS_DIR = process.env.PROJECTS_DIR || (fs.existsSync(path.join(WORKSPACE_ROOT, 'projects')) ? path.join(WORKSPACE_ROOT, 'projects') : WORKSPACE_ROOT);

const PROJECTS = process.env.SYNC_PROJECTS
    ? process.env.SYNC_PROJECTS.split(',').map(s => s.trim()).filter(Boolean)
    : (fs.existsSync(PROJECTS_DIR)
        ? fs.readdirSync(PROJECTS_DIR).filter(f => {
            try {
                return fs.statSync(path.join(PROJECTS_DIR, f)).isDirectory() && !f.startsWith('.');
            } catch {
                return false;
            }
        })
        : []);

function clearProjectDb(project) {
    const dbPath = path.join(PROJECTS_DIR, project, '.agent', 'context.db');
    if (fs.existsSync(dbPath)) {
        let db = null;
        try {
            db = openSqliteConnection(dbPath);
            
            console.log(`[${project}] Clearing embeddings in ide_agent_memory...`);
            const res1 = db.prepare(`UPDATE ide_agent_memory SET embedding = NULL`).run();
            console.log(`  -> Cleared ${res1.changes} memories.`);
            
            try {
                console.log(`[${project}] Clearing embeddings in ide_agent_nuggets...`);
                const res2 = db.prepare(`UPDATE ide_agent_nuggets SET embedding = NULL`).run();
                console.log(`  -> Cleared ${res2.changes} nuggets.`);
            } catch {
                // Table might not exist yet
            }
        } catch (err) {
            console.error(`[${project}] Failed to clear DB:`, err.message);
        } finally {
            if (db) {
                try { db.close(); } catch {}
            }
        }
    } else {
        console.log(`[${project}] No memory.db found.`);
    }
}

console.log('=== Clearing SQLite Embeddings for all Active Projects ===\n');
for (const proj of PROJECTS) {
    clearProjectDb(proj);
}
console.log('\n✅ SQLite cleanup complete.');

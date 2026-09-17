import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

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
    const dbPath = path.join(PROJECTS_DIR, project, '.agent', 'memory.db');
    if (fs.existsSync(dbPath)) {
        try {
            const db = new Database(dbPath);
            db.pragma('journal_mode = WAL');
            
            console.log(`[${project}] Clearing embeddings in ide_agent_memory...`);
            const res1 = db.prepare(`UPDATE ide_agent_memory SET embedding = NULL`).run();
            console.log(`  -> Cleared ${res1.changes} memories.`);
            
            try {
                console.log(`[${project}] Clearing embeddings in ide_agent_nuggets...`);
                const res2 = db.prepare(`UPDATE ide_agent_nuggets SET embedding = NULL`).run();
                console.log(`  -> Cleared ${res2.changes} nuggets.`);
            } catch (e) {
                // Table might not exist yet
            }
            
            db.close();
        } catch (err) {
            console.error(`[${project}] Failed to clear DB:`, err.message);
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

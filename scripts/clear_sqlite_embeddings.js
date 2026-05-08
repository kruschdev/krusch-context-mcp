import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const HOMELAB_ROOT = '/home/kruschdev/homelab/projects';
const PROJECTS = [
    'annotated', 'berean', 'caren', 'first-things-first', 'heyjb',
    'hivemind-companion-ext', 'home-ai', 'krusch-dbos-mcp', 'krusch-agentic-mcp',
    'krusch-infra-mcp', 'krusch-ide', 'lightmind', 'money-machine',
    'perkins_snow_removal', 'pg-git', 'pocket-lawyer', 'pocket-lawyer-marketing',
    'roughin-suite', 'signet', 'spark'
];

function clearProjectDb(project) {
    const dbPath = path.join(HOMELAB_ROOT, project, '.agent', 'memory.db');
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

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { pool } from 'pg-git/db/pool.js';

import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbCache = new Map();

/**
 * Get or initialize a per-project SQLite database connection.
 * Returns null if the project folder is not found.
 */
export async function getProjectDb(projectName) {
    if (!projectName) return null;
    
    if (dbCache.has(projectName)) {
        return dbCache.get(projectName);
    }
    
    // Homelab projects are in the sibling directories of this MCP server
    const projectsRoot = path.resolve(__dirname, '../../');
    const repoPath = path.join(projectsRoot, projectName);
    
    if (!fs.existsSync(repoPath)) {
        console.warn(`[sqlite-engine] Project folder '${projectName}' not found at ${repoPath}`);
        return null;
    }
    
    const agentDir = path.join(repoPath, '.agent');
    
    if (!fs.existsSync(agentDir)) {
        fs.mkdirSync(agentDir, { recursive: true });
    }
    
    const dbPath = path.join(agentDir, 'memory.db');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    
    // Ensure schema
    db.exec(`
        CREATE TABLE IF NOT EXISTS ide_agent_memory (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            category TEXT NOT NULL,
            content TEXT NOT NULL,
            tags TEXT,
            embedding TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS ide_agent_nuggets (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            kind TEXT NOT NULL,
            embedding TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);
    
    // Schema Evolution (Lakebase Architecture)
    try {
        db.exec(`ALTER TABLE ide_agent_memory ADD COLUMN pg_id INTEGER;`);
    } catch (e) {
        if (!e.message.includes('duplicate column name')) throw e;
    }
    try {
        db.exec(`ALTER TABLE ide_agent_nuggets ADD COLUMN pg_synced BOOLEAN DEFAULT 0;`);
    } catch (e) {
        if (!e.message.includes('duplicate column name')) throw e;
    }
    
    dbCache.set(projectName, db);
    
    // Asynchronous read-ahead (Pull from Object Store to Compute Cache)
    pullProjectMemory(projectName, db).catch(e => console.error(`[sqlite-engine] Async pull failed for ${projectName}:`, e));
    
    return db;
}

/**
 * PULL: Object Storage (Postgres) -> Compute Cache (SQLite)
 * Fetches all memories and nuggets for the project and populates the local cache.
 */
export async function pullProjectMemory(projectName, db) {
    const client = await pool.connect();
    try {
        // 1. Pull Episodic Memories
        const memRes = await client.query(
            `SELECT id, category, content, tags, embedding::text FROM ide_agent_memory WHERE project = $1`,
            [projectName]
        );
        
        const insertMem = db.prepare(`
            INSERT INTO ide_agent_memory (pg_id, category, content, tags, embedding)
            SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM ide_agent_memory WHERE pg_id = ?)
        `);
        
        const memTx = db.transaction((rows) => {
            for (const row of rows) {
                insertMem.run(row.id, row.category, row.content, JSON.stringify(row.tags), row.embedding, row.id);
            }
        });
        memTx(memRes.rows);

        // 2. Pull Nuggets
        const nugRes = await client.query(
            `SELECT key, value, kind, embedding::text FROM ide_agent_nuggets WHERE project = $1`,
            [projectName]
        );
        
        const insertNug = db.prepare(`
            INSERT OR IGNORE INTO ide_agent_nuggets (key, value, kind, embedding, pg_synced)
            VALUES (?, ?, ?, ?, 1)
        `);
        
        const nugTx = db.transaction((rows) => {
            for (const row of rows) {
                insertNug.run(row.key, row.value, row.kind, row.embedding);
            }
        });
        nugTx(nugRes.rows);
        
    } finally {
        client.release();
    }
}

/**
 * PUSH: Compute Cache (SQLite) -> Object Storage (Postgres)
 * Asynchronous write-behind to persist local learnings to the durable fleet history.
 */
export async function pushProjectMemory(projectName, db) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // 1. Push unsynced episodic memories
        const unsyncedMems = db.prepare(`SELECT id, category, content, tags, embedding FROM ide_agent_memory WHERE pg_id IS NULL`).all();
        for (const mem of unsyncedMems) {
            // Reconstruct array string if necessary
            let embedStr = mem.embedding;
            if (embedStr && !embedStr.startsWith('[')) {
                 embedStr = `[${embedStr}]`;
            }
            
            const res = await client.query(
                `INSERT INTO ide_agent_memory (project, category, content, tags, embedding)
                 VALUES ($1, $2, $3, $4, $5) RETURNING id`,
                [projectName, mem.category, mem.content, mem.tags ? JSON.parse(mem.tags) : null, embedStr]
            );
            
            const newPgId = res.rows[0].id;
            db.prepare(`UPDATE ide_agent_memory SET pg_id = ? WHERE id = ?`).run(newPgId, mem.id);
        }

        // 2. Push unsynced nuggets
        const unsyncedNugs = db.prepare(`SELECT key, value, kind, embedding FROM ide_agent_nuggets WHERE pg_synced = 0`).all();
        for (const nug of unsyncedNugs) {
             let embedStr = nug.embedding;
             if (embedStr && !embedStr.startsWith('[')) {
                 embedStr = `[${embedStr}]`;
             }
             
             await client.query(
                 `INSERT INTO ide_agent_nuggets (project, key, value, kind, embedding)
                  VALUES ($1, $2, $3, $4, $5)
                  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, embedding = EXCLUDED.embedding, updated_at = CURRENT_TIMESTAMP`,
                 [projectName, nug.key, nug.value, nug.kind, embedStr]
             );
             
             db.prepare(`UPDATE ide_agent_nuggets SET pg_synced = 1 WHERE key = ?`).run(nug.key);
        }
        
        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK');
        console.error(`[sqlite-engine] Async push failed for ${projectName}:`, e);
    } finally {
        client.release();
    }
}

/**
 * Helper to compute cosine similarity between two numeric arrays.
 */
export function cosineSimilarity(vecA, vecB) {
    if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length === 0 || vecB.length === 0) return 0;
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    const len = Math.min(vecA.length, vecB.length);
    for (let i = 0; i < len; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pool } from '../db/pool.js';
import { detectCurrentProject } from './project-helper.js';

import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbCache = new Map();

/**
 * Execute a transaction on DatabaseSync.
 */
export function withTransaction(db, fn) {
    db.exec('BEGIN');
    try {
        const result = fn();
        db.exec('COMMIT');
        return result;
    } catch (e) {
        try { db.exec('ROLLBACK'); } catch {}
        throw e;
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

/**
 * Get or initialize a per-project SQLite database connection.
 * Stores a Promise in dbCache to prevent the pull race condition.
 */
export async function getProjectDb(projectName) {
    if (!projectName) {
        projectName = detectCurrentProject() || 'default';
    }
    
    if (dbCache.has(projectName)) {
        return dbCache.get(projectName);
    }
    
    const initPromise = _initProjectDb(projectName);
    dbCache.set(projectName, initPromise);
    
    try {
        const db = await initPromise;
        if (db) {
            dbCache.set(projectName, db);
        } else {
            dbCache.delete(projectName);
        }
        return db;
    } catch (e) {
        dbCache.delete(projectName);
        throw e;
    }
}

/**
 * Resolves repository path for a project name.
 */
function resolveProjectPath(projectName) {
    // 1. Current workspace match
    const detected = detectCurrentProject();
    if (projectName === detected || projectName === 'default') {
        return process.cwd();
    }
    
    // 2. Sibling directory match (homelab structure)
    const projectsRoot = path.resolve(__dirname, '../../');
    const siblingPath = path.join(projectsRoot, projectName);
    if (fs.existsSync(siblingPath)) {
        return siblingPath;
    }

    // 3. Fallback to isolated user project directory
    const homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp';
    return path.join(homeDir, '.krusch-context', 'projects', projectName);
}

/**
 * Internal: Creates, migrates, and seeds a project SQLite database.
 */
async function _initProjectDb(projectName) {
    const repoPath = resolveProjectPath(projectName);
    const agentDir = path.join(repoPath, '.agent');
    
    if (!fs.existsSync(agentDir)) {
        fs.mkdirSync(agentDir, { recursive: true });
    }
    
    const dbPath = path.join(agentDir, 'context.db');
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL;');

    
    // Polyfill db.transaction for better-sqlite3 compatibility
    db.transaction = (fn) => (...args) => withTransaction(db, () => fn(...args));

    // Ensure schema
    db.exec(`
        CREATE TABLE IF NOT EXISTS ide_agent_memory (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            category TEXT NOT NULL,
            content TEXT NOT NULL,
            tags TEXT,
            embedding TEXT,
            status TEXT DEFAULT 'ACTIVE',
            supersedes_id INTEGER,
            superseded_by INTEGER,
            invalidated_reason TEXT,
            provenance TEXT,
            valid_until DATETIME,
            pg_id INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS ide_agent_nuggets (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            kind TEXT NOT NULL,
            embedding TEXT,
            pg_synced BOOLEAN DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS auditor_feedback (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            rule_id TEXT NOT NULL,
            feedback TEXT NOT NULL,
            weight REAL DEFAULT 1.0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS agent_teacher_memories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pg_id INTEGER,
            tier TEXT NOT NULL,
            task_pattern TEXT NOT NULL,
            teacher_model TEXT NOT NULL,
            student_model TEXT,
            trajectory TEXT NOT NULL,
            distilled_rule TEXT NOT NULL,
            embedding TEXT,
            tags TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);
    
    // Schema Evolution
    const columns = [
        `ALTER TABLE ide_agent_memory ADD COLUMN pg_id INTEGER;`,
        `ALTER TABLE ide_agent_memory ADD COLUMN status TEXT DEFAULT 'ACTIVE';`,
        `ALTER TABLE ide_agent_memory ADD COLUMN supersedes_id INTEGER;`,
        `ALTER TABLE ide_agent_memory ADD COLUMN superseded_by INTEGER;`,
        `ALTER TABLE ide_agent_memory ADD COLUMN valid_until DATETIME;`,
        `ALTER TABLE ide_agent_memory ADD COLUMN invalidated_reason TEXT;`,
        `ALTER TABLE ide_agent_memory ADD COLUMN provenance TEXT;`,
        `ALTER TABLE ide_agent_nuggets ADD COLUMN pg_synced BOOLEAN DEFAULT 0;`
    ];

    for (const colSql of columns) {
        try {
            db.exec(colSql);
        } catch (e) {
            if (!e.message.includes('duplicate column name')) {
                // Ignore duplicate column errors
            }
        }
    }
    
    // Synchronous read-ahead: try pulling from Postgres if configured
    try {
        await pullProjectMemory(projectName, db);
    } catch {
        // Postgres pull is optional; ignore failure in SQLite standalone mode
    }
    
    return db;
}

/**
 * PULL: Object Storage (Postgres) -> Compute Cache (SQLite)
 */
export async function pullProjectMemory(projectName, db) {
    if (!process.env.DATABASE_URL && !process.env.DB_PASSWORD) {
        return; // Skip if postgres not configured
    }
    let client;
    try {
        client = await pool.connect();
    } catch {
        return; // Postgres unavailable
    }

    try {
        // 1. Pull Episodic Memories
        const memRes = await client.query(
            `SELECT id, category, content, tags, embedding::text, status, supersedes_id FROM ide_agent_memory WHERE project = $1`,
            [projectName]
        );
        
        const insertMem = db.prepare(`
            INSERT INTO ide_agent_memory (pg_id, category, content, tags, embedding, status, supersedes_id)
            SELECT ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM ide_agent_memory WHERE pg_id = ?)
        `);
        
        withTransaction(db, () => {
            for (const row of memRes.rows) {
                insertMem.run(row.id, row.category, row.content, row.tags, row.embedding, row.status || 'ACTIVE', row.supersedes_id || null, row.id);
            }
        });

        // 2. Pull Nuggets
        const nugRes = await client.query(
            `SELECT key, value, kind, embedding::text FROM ide_agent_nuggets WHERE project = $1`,
            [projectName]
        );
        
        const insertNug = db.prepare(`
            INSERT OR IGNORE INTO ide_agent_nuggets (key, value, kind, embedding, pg_synced)
            VALUES (?, ?, ?, ?, 1)
        `);
        
        withTransaction(db, () => {
            for (const row of nugRes.rows) {
                insertNug.run(row.key, row.value, row.kind, row.embedding);
            }
        });
        
    } finally {
        if (client) client.release();
    }
}

/**
 * PUSH: Compute Cache (SQLite) -> Object Storage (Postgres)
 */
export async function pushProjectMemory(projectName, db) {
    if (!process.env.DATABASE_URL && !process.env.DB_PASSWORD) {
        return; // Skip if postgres not configured
    }
    let client;
    try {
        client = await pool.connect();
    } catch {
        return; // Postgres unavailable
    }

    try {
        await client.query('BEGIN');
        
        // 1. Push unsynced episodic memories
        const unsyncedMems = db.prepare(`SELECT id, category, content, tags, embedding, status, supersedes_id, superseded_by FROM ide_agent_memory WHERE pg_id IS NULL`).all();
        const pushedMemIds = [];
        for (const mem of unsyncedMems) {
            let embedStr = mem.embedding;
            if (embedStr && !embedStr.startsWith('[')) {
                 embedStr = `[${embedStr}]`;
            }
            
            let parsedTags = null;
            try { parsedTags = mem.tags ? JSON.parse(mem.tags) : null; } catch { parsedTags = mem.tags; }
            const res = await client.query(
                `INSERT INTO ide_agent_memory (project, category, content, tags, embedding, status, supersedes_id, superseded_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
                [projectName, mem.category, mem.content, parsedTags, embedStr, mem.status || 'ACTIVE', mem.supersedes_id || null, mem.superseded_by || null]
            );
            
            const newPgId = res.rows[0].id;
            pushedMemIds.push(newPgId);
            db.prepare(`UPDATE ide_agent_memory SET pg_id = ? WHERE id = ?`).run(newPgId, mem.id);
        }

        // 2. Push unsynced nuggets
        const unsyncedNugs = db.prepare(`SELECT key, value, kind, embedding FROM ide_agent_nuggets WHERE pg_synced = 0`).all();
        const pushedNugIds = [];
        for (const nug of unsyncedNugs) {
             let embedStr = nug.embedding;
             if (embedStr && !embedStr.startsWith('[')) {
                 embedStr = `[${embedStr}]`;
             }
             
             const res = await client.query(
                 `INSERT INTO ide_agent_nuggets (project, key, value, kind, embedding)
                  VALUES ($1, $2, $3, $4, $5)
                  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, embedding = EXCLUDED.embedding, updated_at = CURRENT_TIMESTAMP
                  RETURNING id`,
                 [projectName, nug.key, nug.value, nug.kind, embedStr]
             );
             if (res.rows.length > 0) pushedNugIds.push(res.rows[0].id);
             
             db.prepare(`UPDATE ide_agent_nuggets SET pg_synced = 1 WHERE key = ?`).run(nug.key);
        }
        
        await client.query('COMMIT');
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch {}
        console.error(`[sqlite-engine] Push failed for ${projectName}:`, e.message);
    } finally {
        if (client) client.release();
    }
}

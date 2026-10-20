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

const parsedVectorCache = new Map();
const MAX_PARSED_VECTOR_CACHE = 2048;

/**
 * Parses and caches a row's embedding into a Float64Array to avoid repeated JSON.parse overhead.
 */
export function getParsedEmbedding(embeddingField) {
    if (!embeddingField) return null;
    if (Array.isArray(embeddingField) || ArrayBuffer.isView(embeddingField)) {
        return embeddingField;
    }
    if (typeof embeddingField !== 'string') return null;

    const cached = parsedVectorCache.get(embeddingField);
    if (cached) return cached;

    try {
        const arr = JSON.parse(embeddingField);
        if (!Array.isArray(arr) || arr.length === 0) return null;
        const typed = Float64Array.from(arr);
        if (parsedVectorCache.size >= MAX_PARSED_VECTOR_CACHE) {
            const oldestKey = parsedVectorCache.keys().next().value;
            parsedVectorCache.delete(oldestKey);
        }
        parsedVectorCache.set(embeddingField, typed);
        return typed;
    } catch {
        return null;
    }
}

/**
 * Helper to compute cosine similarity between two numeric arrays or Float64Arrays.
 */
export function cosineSimilarity(vecA, vecB) {
    if (!vecA || !vecB || !vecA.length || !vecB.length) return 0;
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    const len = Math.min(vecA.length, vecB.length);
    for (let i = 0; i < len; i++) {
        const a = vecA[i];
        const b = vecB[i];
        dotProduct += a * b;
        normA += a * a;
        normB += b * b;
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
export function resolveProjectPath(projectName) {
    const rawProject = String(projectName || '').trim();
    // 1. Current workspace match
    const detected = detectCurrentProject();
    if (!rawProject || rawProject === detected || rawProject === 'default') {
        return process.cwd();
    }
    
    // Sanitize projectName to strip slashes and prevent directory traversal
    const safeProjectName = path.basename(rawProject).replace(/[^a-zA-Z0-9_\-\.]/g, '');
    if (!safeProjectName || safeProjectName === '.' || safeProjectName === '..') {
        return process.cwd();
    }
    
    // 2. Sibling directory match (homelab structure) with containment check
    const candidateRoots = [
        path.resolve(__dirname, '../../'),
        process.env.HOMELAB_PATH ? path.resolve(process.env.HOMELAB_PATH, 'projects') : null,
        '/home/agent/homelab/projects'
    ].filter(Boolean);

    for (const projectsRoot of candidateRoots) {
        const siblingPath = path.resolve(projectsRoot, safeProjectName);
        const rel = path.relative(projectsRoot, siblingPath);
        if (!rel.startsWith('..') && !path.isAbsolute(rel) && rel !== '' && fs.existsSync(siblingPath)) {
            return siblingPath;
        }
    }

    // 3. Fallback to isolated user project directory
    const homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp';
    return path.join(homeDir, '.krusch-context', 'projects', safeProjectName);
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
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec('PRAGMA synchronous = NORMAL;');
    db.exec('PRAGMA foreign_keys = ON;');

    
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
            pg_synced BOOLEAN DEFAULT 0,
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
        `ALTER TABLE ide_agent_memory ADD COLUMN project TEXT;`,
        `ALTER TABLE ide_agent_memory ADD COLUMN pg_id INTEGER;`,
        `ALTER TABLE ide_agent_memory ADD COLUMN pg_synced BOOLEAN DEFAULT 0;`,
        `ALTER TABLE ide_agent_memory ADD COLUMN status TEXT DEFAULT 'ACTIVE';`,
        `ALTER TABLE ide_agent_memory ADD COLUMN supersedes_id INTEGER;`,
        `ALTER TABLE ide_agent_memory ADD COLUMN superseded_by INTEGER;`,
        `ALTER TABLE ide_agent_memory ADD COLUMN valid_until DATETIME;`,
        `ALTER TABLE ide_agent_memory ADD COLUMN invalidated_reason TEXT;`,
        `ALTER TABLE ide_agent_memory ADD COLUMN provenance TEXT;`,
        `ALTER TABLE ide_agent_nuggets ADD COLUMN project TEXT;`,
        `ALTER TABLE ide_agent_nuggets ADD COLUMN pg_synced BOOLEAN DEFAULT 0;`,
        `ALTER TABLE auditor_feedback ADD COLUMN project TEXT;`
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

    // Performance Indexes
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_memory_status_cat ON ide_agent_memory(status, category);
        CREATE INDEX IF NOT EXISTS idx_memory_created_at ON ide_agent_memory(created_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_feedback_project_rule ON auditor_feedback(project, rule_id);
    `);
    
    // Synchronous read-ahead: try pulling from Postgres if configured
    try {
        await pullProjectMemory(projectName, db);
    } catch {
        // Postgres pull is optional; ignore failure in SQLite standalone mode
    }
    
    return db;
}

let _pgSchemaInfo = null;

async function getPgSchemaInfo(client) {
    if (_pgSchemaInfo) return _pgSchemaInfo;
    try {
        const res = await client.query(
            `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'ide_agent_memory'`
        );
        const cols = new Map(res.rows.map(r => [r.column_name, r.data_type]));
        _pgSchemaInfo = {
            hasStatus: cols.has('status'),
            hasInvalidatedReason: cols.has('invalidated_reason'),
            hasProvenance: cols.has('provenance'),
            tagsIsArray: cols.get('tags') === 'ARRAY'
        };
    } catch {
        _pgSchemaInfo = {
            hasStatus: false,
            hasInvalidatedReason: false,
            hasProvenance: false,
            tagsIsArray: false
        };
    }
    return _pgSchemaInfo;
}

function normalizeLegacyCat(cat) {
    const lower = String(cat || 'lesson').toLowerCase().trim();
    if (['decision', 'bug', 'invariant', 'lesson', 'blocker'].includes(lower)) return lower;
    if (lower === 'priorities' || lower === 'priority' || lower === 'decisions') return 'decision';
    if (lower === 'bugs') return 'bug';
    if (lower === 'invariants') return 'invariant';
    if (lower === 'blockers') return 'blocker';
    return 'lesson';
}

/**
 * PULL: Object Storage (Postgres) -> Compute Cache (SQLite)
 */
export async function pullProjectMemory(projectName, db) {
    if (!process.env.DATABASE_URL && !process.env.DB_PASSWORD) {
        return; // Skip if postgres not configured
    }
    if (/^(test_|smoke_)/i.test(String(projectName || ''))) {
        return; // Never pull into ephemeral test projects
    }
    let client;
    try {
        client = await pool.connect();
    } catch {
        return; // Postgres unavailable
    }

    try {
        const schema = await getPgSchemaInfo(client);
        // 1. Pull Episodic Memories
        const memQuery = schema.hasStatus
            ? `SELECT id::text as id, category, content, tags::text as tags, embedding::text, status, supersedes_id FROM ide_agent_memory WHERE project = $1 ORDER BY created_at DESC LIMIT 200`
            : `SELECT id::text as id, category, content, tags::text as tags, embedding::text FROM ide_agent_memory WHERE project = $1 ORDER BY created_at DESC LIMIT 200`;
        const memRes = await client.query(memQuery, [projectName]);
        
        const insertMem = db.prepare(`
            INSERT INTO ide_agent_memory (pg_id, category, content, tags, embedding, status, supersedes_id, pg_synced)
            SELECT ?, ?, ?, ?, ?, ?, ?, 1 WHERE NOT EXISTS (SELECT 1 FROM ide_agent_memory WHERE pg_id = ? OR content = ?)
        `);
        
        withTransaction(db, () => {
            for (const row of memRes.rows) {
                const normCat = normalizeLegacyCat(row.category);
                insertMem.run(row.id, normCat, row.content, row.tags, row.embedding, row.status || 'ACTIVE', row.supersedes_id || null, row.id, row.content);
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
    if (/^(test_|smoke_)/i.test(String(projectName || ''))) {
        return; // Never push ephemeral test projects to production Postgres
    }
    let client;
    try {
        client = await pool.connect();
    } catch {
        return; // Postgres unavailable
    }

    try {
        const schema = await getPgSchemaInfo(client);
        await client.query('BEGIN');

        // Map local SQLite ID -> Postgres pg_id so self-referencing FK constraints never fail
        const mappedRows = db.prepare(`SELECT id, pg_id FROM ide_agent_memory WHERE pg_id IS NOT NULL`).all();
        const localToPgId = new Map();
        for (const r of mappedRows) {
            const numPgId = Number(r.pg_id);
            if (Number.isFinite(numPgId) && numPgId > 0) {
                localToPgId.set(Number(r.id), numPgId);
            }
        }
        const resolvePgRef = (localRefId) => {
            if (localRefId === null || localRefId === undefined) return null;
            return localToPgId.get(Number(localRefId)) ?? null;
        };
        
        // 1a. Push unsynced new episodic memories (ordered by id ASC so older lineage parents map first)
        const unsyncedMems = db.prepare(`
            SELECT id, category, content, tags, embedding, status, supersedes_id, superseded_by, invalidated_reason, provenance
            FROM ide_agent_memory
            WHERE pg_id IS NULL
            ORDER BY id ASC
        `).all();
        const pushedMemIds = [];
        for (const mem of unsyncedMems) {
            let embedStr = mem.embedding;
            if (embedStr && !embedStr.startsWith('[')) {
                 embedStr = `[${embedStr}]`;
            }
            
            let parsedTags = null;
            if (schema.tagsIsArray) {
                try { parsedTags = mem.tags ? JSON.parse(mem.tags) : null; } catch { parsedTags = mem.tags ? [String(mem.tags)] : null; }
            } else {
                parsedTags = mem.tags ? String(mem.tags) : null;
            }

            const pgSupersedesId = resolvePgRef(mem.supersedes_id);
            const pgSupersededBy = resolvePgRef(mem.superseded_by);
            let parsedProv = null;
            if (mem.provenance) {
                try { parsedProv = JSON.parse(mem.provenance); } catch { parsedProv = null; }
            }

            let res;
            if (schema.hasStatus && schema.hasInvalidatedReason && schema.hasProvenance) {
                res = await client.query(
                    `INSERT INTO ide_agent_memory (project, category, content, tags, embedding, status, supersedes_id, superseded_by, invalidated_reason, provenance)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id::text as id`,
                    [
                        projectName,
                        mem.category,
                        mem.content,
                        parsedTags,
                        embedStr,
                        mem.status || 'ACTIVE',
                        pgSupersedesId,
                        pgSupersededBy,
                        mem.invalidated_reason || null,
                        parsedProv
                    ]
                );
            } else if (schema.hasStatus) {
                res = await client.query(
                    `INSERT INTO ide_agent_memory (project, category, content, tags, embedding, status, supersedes_id, superseded_by)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id::text as id`,
                    [projectName, mem.category, mem.content, parsedTags, embedStr, mem.status || 'ACTIVE', pgSupersedesId, pgSupersededBy]
                );
            } else {
                res = await client.query(
                    `INSERT INTO ide_agent_memory (project, category, content, tags, embedding)
                     VALUES ($1, $2, $3, $4, $5) RETURNING id::text as id`,
                    [projectName, mem.category, mem.content, parsedTags, embedStr]
                );
            }
            
            const newPgId = res.rows[0].id;
            pushedMemIds.push(newPgId);
            const numNewPgId = Number(newPgId);
            if (Number.isFinite(numNewPgId) && numNewPgId > 0) {
                localToPgId.set(Number(mem.id), numNewPgId);
            }
            const needsDeferredLineage = Boolean(
                (mem.supersedes_id && !pgSupersedesId) ||
                (mem.superseded_by && !pgSupersededBy)
            );
            db.prepare(`UPDATE ide_agent_memory SET pg_id = ?, pg_synced = ? WHERE id = ?`)
              .run(String(newPgId), needsDeferredLineage ? 0 : 1, mem.id);
        }

        // 1b. Sync modified existing memories (status, supersedes_id, superseded_by, invalidated_reason, provenance)
        if (schema.hasStatus) {
            const dirtyMems = db.prepare(`
                SELECT id, pg_id, status, supersedes_id, superseded_by, invalidated_reason, provenance
                FROM ide_agent_memory
                WHERE pg_id IS NOT NULL AND COALESCE(pg_synced, 0) = 0
                ORDER BY id ASC
            `).all();

            for (const mem of dirtyMems) {
                const pgSupersedesId = resolvePgRef(mem.supersedes_id);
                const pgSupersededBy = resolvePgRef(mem.superseded_by);
                let parsedProv = null;
                if (mem.provenance) {
                    try { parsedProv = JSON.parse(mem.provenance); } catch { parsedProv = null; }
                }

                if (schema.hasInvalidatedReason && schema.hasProvenance) {
                    await client.query(
                        `UPDATE ide_agent_memory
                         SET status = $1, supersedes_id = $2, superseded_by = $3, invalidated_reason = $4, provenance = $5, updated_at = CURRENT_TIMESTAMP
                         WHERE id = $6`,
                        [mem.status || 'ACTIVE', pgSupersedesId, pgSupersededBy, mem.invalidated_reason || null, parsedProv, Number(mem.pg_id)]
                    );
                } else {
                    await client.query(
                        `UPDATE ide_agent_memory
                         SET status = $1, supersedes_id = $2, superseded_by = $3
                         WHERE id = $4`,
                        [mem.status || 'ACTIVE', pgSupersedesId, pgSupersededBy, Number(mem.pg_id)]
                    );
                }
                db.prepare(`UPDATE ide_agent_memory SET pg_synced = 1 WHERE id = ?`).run(mem.id);
            }
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

/**
 * Safely closes all cached SQLite project databases.
 */
export function closeAllDatabases() {
    for (const [name, entry] of dbCache.entries()) {
        try {
            if (entry && typeof entry.close === 'function') {
                entry.close();
            }
        } catch (_) {}
    }
    dbCache.clear();
}

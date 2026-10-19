/**
 * @module storage-adapter
 * Unified storage adapter for krusch-context-mcp.
 * Provides dual-mode persistence:
 *  - SQLite-first default (.agent/context.db via node:sqlite) for zero-Docker, zero-Postgres instant setup.
 *  - PostgreSQL + pgvector as the optional durable/multi-project tier.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pool, query } from '../db/pool.js';
import { detectCurrentProject, getWorktreeStatus } from './project-helper.js';
import { getProjectDb, cosineSimilarity as engineCosineSimilarity, getParsedEmbedding } from './sqlite-engine.js';

let activeStorageMode = null; // 'sqlite' | 'postgres'

let sqliteInstance = null;

export function getStorageMode() {
    if (activeStorageMode) return activeStorageMode;

    const envMode = (process.env.STORAGE_MODE || '').toLowerCase().trim();
    if (envMode === 'postgres') {
        activeStorageMode = 'postgres';
        return activeStorageMode;
    }

    // Default is strictly SQLite-first (zero-Docker default)
    activeStorageMode = 'sqlite';
    return activeStorageMode;
}

export function setStorageMode(mode) {
    if (mode !== 'sqlite' && mode !== 'postgres') {
        throw new Error(`Invalid storage mode: ${mode}`);
    }
    activeStorageMode = mode;
}

/**
 * Resolves or creates the local SQLite database in the active workspace's .agent directory.
 * @param {string} [workspaceDir]
 * @returns {DatabaseSync}
 */
export function getSqliteDb(workspaceDir = process.cwd()) {
    if (sqliteInstance) return sqliteInstance;

    // Search upwards for .git or use workspaceDir
    let current = path.resolve(workspaceDir);
    let targetAgentDir = null;

    while (current !== path.dirname(current)) {
        if (fs.existsSync(path.join(current, '.git')) || fs.existsSync(path.join(current, '.agent'))) {
            targetAgentDir = path.join(current, '.agent');
            break;
        }
        current = path.dirname(current);
    }

    if (!targetAgentDir) {
        targetAgentDir = path.join(process.cwd(), '.agent');
    }

    if (!fs.existsSync(targetAgentDir)) {
        fs.mkdirSync(targetAgentDir, { recursive: true });
    }

    const dbPath = path.join(targetAgentDir, 'context.db');
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec('PRAGMA synchronous = NORMAL;');
    db.exec('PRAGMA foreign_keys = ON;');

    // Initialize unified schema matching sqlite-engine.js
    db.exec(`
        CREATE TABLE IF NOT EXISTS ide_agent_memory (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project TEXT,
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
            project TEXT,
            value TEXT NOT NULL,
            kind TEXT NOT NULL,
            embedding TEXT,
            pg_synced BOOLEAN DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_nuggets_key ON ide_agent_nuggets(key);

        CREATE TABLE IF NOT EXISTS auditor_feedback (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project TEXT,
            rule_id TEXT NOT NULL,
            feedback TEXT NOT NULL,
            weight REAL DEFAULT 1.0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_memory_status_cat ON ide_agent_memory(status, category);
        CREATE INDEX IF NOT EXISTS idx_memory_created_at ON ide_agent_memory(created_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_feedback_project_rule ON auditor_feedback(project, rule_id);
    `);

    sqliteInstance = db;
    return db;
}

/**
 * Computes cosine similarity between two numerical vectors.
 */
export function cosineSimilarity(vecA, vecB) {
    return engineCosineSimilarity(vecA, vecB);
}

/**
 * Detects near-duplicate memories in SQLite or Postgres.
 * Returns match object if similarity >= threshold, null otherwise.
 */
export async function checkNearDuplicateMemory({ project, category, embedding, threshold = 0.85 }) {
    if (!embedding || (!Array.isArray(embedding) && !ArrayBuffer.isView(embedding))) return null;

    const mode = getStorageMode();
    if (mode === 'postgres') {
        try {
            const client = await pool.connect();
            try {
                const res = await client.query(`
                    SELECT id, content, category, 1 - (embedding <=> $1::vector) as similarity
                    FROM ide_agent_memory
                    WHERE (project = $2 OR project IS NULL)
                      AND status = 'ACTIVE'
                    ORDER BY embedding <=> $1::vector ASC
                    LIMIT 1
                `, [`[${embedding.join(',')}]`, project || null]);

                if (res.rows.length > 0 && res.rows[0].similarity >= threshold) {
                    return res.rows[0];
                }
            } finally {
                client.release();
            }
        } catch (e) {
            // Postgres failed or unconfigured, fall back to SQLite
        }
    }

    // SQLite in-memory cosine comparison with cached Float64Array vectors
    const db = await getProjectDb(project);
    if (!db) return null;
    const rows = db.prepare(`
        SELECT id, content, category, embedding
        FROM ide_agent_memory
        WHERE status = 'ACTIVE'
    `).all();

    let bestMatch = null;
    let maxSim = 0;

    for (const row of rows) {
        const rowVec = getParsedEmbedding(row.embedding);
        if (!rowVec) continue;
        const sim = engineCosineSimilarity(embedding, rowVec);
        if (sim > maxSim) {
            maxSim = sim;
            bestMatch = { id: row.id, content: row.content, category: row.category, similarity: sim };
        }
    }

    if (maxSim >= threshold) {
        return bestMatch;
    }
    return null;
}

/**
 * Safely closes active SQLite singleton database if open.
 */
export function closeSqliteDb() {
    if (sqliteInstance) {
        try { sqliteInstance.close(); } catch (_) {}
        sqliteInstance = null;
    }
}

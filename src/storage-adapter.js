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
import { getProjectDb } from './sqlite-engine.js';

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

    // Initialize Schema
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
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS ide_agent_nuggets (
            key TEXT NOT NULL,
            project TEXT,
            value TEXT NOT NULL,
            kind TEXT NOT NULL,
            embedding TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (key, project)
        );

        CREATE TABLE IF NOT EXISTS code_chunks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project TEXT,
            path TEXT NOT NULL,
            content TEXT NOT NULL,
            embedding TEXT,
            symbol TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS code_chunks_fts USING fts5(
            path,
            content,
            symbol,
            tokenize='porter unicode61'
        );

        CREATE TABLE IF NOT EXISTS code_symbols (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project TEXT,
            name TEXT NOT NULL,
            kind TEXT NOT NULL,
            path TEXT NOT NULL,
            line_start INTEGER NOT NULL,
            line_end INTEGER NOT NULL,
            signature TEXT
        );

        CREATE TABLE IF NOT EXISTS symbol_edges (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project TEXT,
            source_symbol TEXT NOT NULL,
            target_symbol TEXT NOT NULL,
            kind TEXT NOT NULL,
            confidence TEXT DEFAULT 'heuristic_regex'
        );

        CREATE TABLE IF NOT EXISTS auditor_feedback (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project TEXT,
            rule_id TEXT NOT NULL,
            feedback TEXT NOT NULL,
            weight REAL DEFAULT 1.0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    sqliteInstance = db;
    return db;
}

/**
 * Computes cosine similarity between two numerical vectors.
 */
export function cosineSimilarity(vecA, vecB) {
    if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length === 0 || vecB.length === 0) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    const len = Math.min(vecA.length, vecB.length);
    for (let i = 0; i < len; i++) {
        dot += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Detects near-duplicate memories in SQLite or Postgres.
 * Returns match object if similarity >= threshold, null otherwise.
 */
export async function checkNearDuplicateMemory({ project, category, embedding, threshold = 0.85 }) {
    if (!embedding || !Array.isArray(embedding)) return null;

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

    // SQLite in-memory cosine comparison
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
        if (!row.embedding) continue;
        try {
            const rowVec = typeof row.embedding === 'string' ? JSON.parse(row.embedding) : row.embedding;
            const sim = cosineSimilarity(embedding, rowVec);
            if (sim > maxSim) {
                maxSim = sim;
                bestMatch = { id: row.id, content: row.content, category: row.category, similarity: sim };
            }
        } catch {
            // skip malformed vector
        }
    }

    if (maxSim >= threshold) {
        return bestMatch;
    }
    return null;
}

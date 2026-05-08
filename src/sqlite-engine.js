import fs from 'fs';
import path from 'path';
import { SQLiteDatabase } from '@krusch/toolkit/db';
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
    const db = new SQLiteDatabase(dbPath);
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
    
    dbCache.set(projectName, db);
    return db;
}

/**
 * Helper to compute cosine similarity between two numeric arrays.
 */
export function cosineSimilarity(vecA, vecB) {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { query, pool } from '../db/pool.js';
import { hashContent } from '../src/git-engine.js';
import { getEmbedding, getChunkedCentroidEmbedding, isEmbeddable, MAX_EMBED_CHARS, ollamaQueue, PRIORITY } from '../src/embedding-helper.js';
import { extractSymbolsAndImports } from '../src/ast-chunker.js';
import { chat } from '../src/llm.js';

const EXCLUDED_DIRS = new Set([
    '.git', 'node_modules', 'dist', 'dist-ext', 'build', '__pycache__', 'data', 'tmp',
    '.gemini', '.venv', 'venv', 'bench_venv', 'mcp_env', '.vscode', 'nodes', 'sandbox',
    'logs', 'sandbox-audits', 'scratch', 'mnt', '.agent', '.turbo', '.next', 'out',
    '.nyc_output', '.source', 'public', 'r', 'kaggle_games_our'
]);

const MAX_BINARY_SIZE = 100 * 1024;
const MAX_EMBEDDABLE_SIZE = 500 * 1024;

let syncProgress = { processed: 0, total: 0, embedded: 0, skipped: 0, symbols: 0, edges: 0 };

async function generateInlineSummary(text, fileName) {
    const defaultSummary = text.substring(0, 500);
    if (process.env.SKIP_LLM_SUMMARY === 'true') {
        return defaultSummary;
    }
    if (text.length < 50) return defaultSummary;

    if (process.env.OPENROUTER_API_KEY || process.env.COMPLETION_URL) {
        try {
            const summary = await chat(
                "You are an expert code summarizer. Respond ONLY with a concise 1-line summary of what this code does.",
                `File: ${fileName}\n\nCode:\n${text.substring(0, 3000)}`,
                { maxTokens: 80 }
            );
            if (summary && summary.trim().length > 5) {
                return summary.trim().substring(0, 500);
            }
        } catch (_) {}
        return defaultSummary;
    }
    try {
        const prompt = `Provide a concise 1-line summary of what this code does. Respond ONLY with the summary.\n\nFile: ${fileName}\n\nCode:\n${text.substring(0, 3000)}`;
        const targetModel = process.env.OLLAMA_SUMMARY_MODEL || 'qwen2.5-coder:3b';
        
        const makeRequest = async (host) => {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 15000);
            try {
                const response = await fetch(`${host}/api/generate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: targetModel,
                        prompt: prompt,
                        stream: false,
                        options: { num_ctx: 1024, num_predict: 80 }
                    }),
                    signal: controller.signal
                });
                if (response.ok) {
                    const data = await response.json();
                    const summaryText = data.response?.trim();
                    if (summaryText && summaryText.length > 5) {
                        return summaryText.substring(0, 500);
                    }
                }
                return defaultSummary;
            } finally {
                clearTimeout(timeout);
            }
        };

        if (process.env.OLLAMA_SUMMARY_HOST) {
            return await makeRequest(process.env.OLLAMA_SUMMARY_HOST);
        } else {
            return await ollamaQueue.enqueue(async (endpoint) => {
                return await makeRequest(endpoint);
            }, PRIORITY.LOW);
        }
    } catch (e) {
        return defaultSummary;
    }
}

async function populateSymbolsAndEdges(sha, repoId, buffer, relativePath, ext) {
    if (!isEmbeddable(ext)) return;
    try {
        const text = buffer.toString('utf-8');
        const { symbols, imports } = extractSymbolsAndImports(text, relativePath);
        
        if (symbols && symbols.length > 0) {
            await query(`DELETE FROM code_symbols WHERE blob_id = $1`, [sha]);
            for (const sym of symbols) {
                await query(`
                    INSERT INTO code_symbols (blob_id, repository_id, file_path, symbol_name, symbol_type, start_line, end_line, signature, content)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                `, [sha, repoId, relativePath, sym.name, sym.type, sym.startLine, sym.endLine, sym.signature, sym.content]);
            }
            syncProgress.symbols += symbols.length;
        }

        if (imports && imports.length > 0) {
            await query(`DELETE FROM code_symbol_edges WHERE source_blob_id = $1`, [sha]);
            for (const imp of imports) {
                await query(`
                    INSERT INTO code_symbol_edges (repository_id, source_blob_id, source_path, target_path, relation, symbols)
                    VALUES ($1, $2, $3, $4, $5, $6)
                `, [repoId, sha, relativePath, imp.targetPath, imp.relation, imp.symbols]);
            }
            syncProgress.edges += imports.length;
        }
    } catch (err) {
        console.warn(`[Symbols] Failed extracting symbols for ${relativePath}: ${err.message}`);
    }
}

async function insertBlob(repoId, buffer, filePath, rootDir) {
    const sha = hashContent(buffer);
    const ext = path.extname(filePath).toLowerCase();
    const fileName = path.basename(filePath);
    const relativePath = path.relative(rootDir, filePath);
    
    const existing = await query(`SELECT id, embedding FROM blobs WHERE id = $1`, [sha]);
    if (existing.rows.length > 0) {
        await query(
            `UPDATE blobs SET last_seen_at = CURRENT_TIMESTAMP, file_name = COALESCE(file_name, $2), file_path = COALESCE(file_path, $3) WHERE id = $1`,
            [sha, fileName, relativePath]
        );
        
        const symCheck = await query(`SELECT count(*) FROM code_symbols WHERE blob_id = $1`, [sha]);
        if (symCheck.rows[0].count === '0') {
            await populateSymbolsAndEdges(sha, repoId, buffer, relativePath, ext);
        }

        if (existing.rows[0].embedding !== null) {
            return sha;
        }
    }

    let embeddingStr = null;
    let summary = null;
    if (isEmbeddable(ext)) {
        const text = buffer.toString('utf-8');
        summary = await generateInlineSummary(text, fileName);
        const textToEmbed = text.substring(0, 30000);
        const vector = await getChunkedCentroidEmbedding(textToEmbed);
        if (vector && vector.length > 0) {
            embeddingStr = `[${vector.join(',')}]`;
        }
    }

    if (embeddingStr) {
        await query(
            `INSERT INTO blobs (id, repository_id, size, embedding, file_name, file_path, summary, storage_mode) VALUES ($1, $2, $3, $4::vector, $5, $6, $7, 'pointer') ON CONFLICT (id) DO UPDATE SET embedding = EXCLUDED.embedding`,
            [sha, repoId, buffer.length, embeddingStr, fileName, relativePath, summary]
        );
        syncProgress.embedded++;
    } else {
        await query(
            `INSERT INTO blobs (id, repository_id, size, file_name, file_path, summary, storage_mode) VALUES ($1, $2, $3, $4, $5, $6, 'pointer') ON CONFLICT (id) DO NOTHING`,
            [sha, repoId, buffer.length, fileName, relativePath, summary]
        );
    }

    await populateSymbolsAndEdges(sha, repoId, buffer, relativePath, ext);
    return sha;
}

function hashTree(entries) {
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const content = entries.map(e => `${e.type} ${e.object_id} ${e.name}`).join('\n');
    return crypto.createHash('sha1').update(`tree ${content.length}\0${content}`).digest('hex');
}

async function processDirectory(dirPath, repoId, rootDir) {
    const items = await fs.readdir(dirPath, { withFileTypes: true });
    const entries = [];

    for (const item of items) {
        if (EXCLUDED_DIRS.has(item.name)) continue;
        
        const nameLower = item.name.toLowerCase();
        if (nameLower.includes('venv') || 
            nameLower === 'site-packages' || 
            nameLower.includes('dist-info') || 
            nameLower.includes('egg-info') ||
            nameLower === '.pytest_cache' ||
            nameLower === '.cache') {
            continue;
        }
        
        const fullPath = path.join(dirPath, item.name);
        const relPath = path.relative(rootDir, fullPath);
        
        const pathsToExclude = [
            'docs/projects', 'projects/archive', 'projects/reference',
            'projects/vllm', 'projects/vllm-hermes', 'projects/TheAgentCompany',
            'projects/agent-toolkit-for-aws', 'projects/Brain3', 'projects/searxng',
            'projects/dbos-worker'
        ];
        if (pathsToExclude.some(p => relPath === p || relPath.startsWith(p + '/'))) {
            continue;
        }

        if (item.isDirectory()) {
            const treeSha = await processDirectory(fullPath, repoId, rootDir);
            if (treeSha) {
                entries.push({ type: 'tree', name: item.name, object_id: treeSha });
            }
        } else {
            let stat;
            try {
                stat = await fs.stat(fullPath);
            } catch (e) {
                if (e.code === 'ENOENT') continue;
                throw e;
            }
            if (stat.isDirectory()) continue;
            
            const ext = path.extname(item.name).toLowerCase();
            const embeddable = isEmbeddable(ext);

            const crashyFiles = new Set(['icons.tsx', 'open-in-chat.tsx', 'docs-copy-page.tsx', 'ai-sdk-agents-patterns.tsx', 'blocks-grid.tsx', 'home-below-hero-layouts.tsx', 'components.json', 'package-lock.json', 'ai-instructions-demo.json', 'ai-instructions.json', 'colors.ts', 'blocks.ts']);
            if (crashyFiles.has(item.name)) {
                syncProgress.skipped++;
                continue;
            }
            
            if (!embeddable && stat.size > MAX_BINARY_SIZE) {
                syncProgress.skipped++;
                continue;
            }
            
            if (embeddable && stat.size > MAX_EMBEDDABLE_SIZE) {
                syncProgress.skipped++;
                continue;
            }
            
            if (stat.size > 50 * 1024 * 1024) {
                syncProgress.skipped++;
                continue;
            }
            
            const buffer = await fs.readFile(fullPath);
            const blobSha = await insertBlob(repoId, buffer, fullPath, rootDir);
            entries.push({ type: 'blob', name: item.name, object_id: blobSha });
            
            syncProgress.processed++;
            if (syncProgress.processed % 100 === 0) {
                console.log(`[Progress] ${syncProgress.processed} files processed, ${syncProgress.embedded} embedded, ${syncProgress.skipped} skipped`);
            }
        }
    }

    if (entries.length === 0) return null;

    const treeSha = hashTree(entries);
    await query(`INSERT INTO trees (id, repository_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [treeSha, repoId]);
    
    for (const entry of entries) {
        await query(
            `INSERT INTO tree_entries (tree_id, type, name, object_id) VALUES ($1, $2, $3, $4) ON CONFLICT (tree_id, name) DO NOTHING`,
            [treeSha, entry.type, entry.name, entry.object_id]
        );
    }

    return treeSha;
}

export async function snapshot(targetDir = process.cwd()) {
    const resolvedDir = path.resolve(targetDir);
    const repoName = path.basename(resolvedDir);
    
    syncProgress = { processed: 0, total: 0, embedded: 0, skipped: 0, symbols: 0, edges: 0 };
    console.log(`[krusch-context-mcp] Starting native snapshot for: ${repoName}`);
    console.log(`Target: ${resolvedDir}`);

    let repoId;
    const res = await query(`SELECT id FROM repositories WHERE name = $1`, [repoName]);
    if (res.rows.length > 0) {
        repoId = res.rows[0].id;
    } else {
        const inserted = await query(`INSERT INTO repositories (name, description) VALUES ($1, $2) RETURNING id`, [repoName, `Automated snapshot of ${repoName}`]);
        repoId = inserted.rows[0].id;
    }

    const rootTreeSha = await processDirectory(resolvedDir, repoId, resolvedDir);
    if (!rootTreeSha) {
        console.log('Directory is empty or all ignored.');
        return null;
    }

    const commitMessage = `Automated snapshot at ${new Date().toISOString()}`;
    const commitContent = `tree ${rootTreeSha}\nmessage ${commitMessage}`;
    const commitSha = crypto.createHash('sha1').update(`commit ${commitContent.length}\0${commitContent}`).digest('hex');

    let parentId = null;
    const branchRes = await query(`SELECT commit_id FROM branches WHERE repository_id = $1 AND name = 'main'`, [repoId]);
    if (branchRes.rows.length > 0) {
        parentId = branchRes.rows[0].commit_id;
    }

    if (parentId) {
        const parentRes = await query(`SELECT tree_id FROM commits WHERE id = $1`, [parentId]);
        if (parentRes.rows.length > 0 && parentRes.rows[0].tree_id === rootTreeSha) {
            console.log('No changes detected since last snapshot. Skipping commit.');
            return commitSha;
        }
    }

    await query(
        `INSERT INTO commits (id, repository_id, tree_id, parent_id, message, author) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
        [commitSha, repoId, rootTreeSha, parentId, commitMessage, 'Semantic-Agent']
    );

    if (parentId) {
        await query(`UPDATE branches SET commit_id = $1 WHERE repository_id = $2 AND name = 'main'`, [commitSha, repoId]);
    } else {
        await query(`INSERT INTO branches (repository_id, name, commit_id) VALUES ($1, $2, $3)`, [repoId, 'main', commitSha]);
    }

    console.log(`✅ Snapshot complete! Commit: ${commitSha}`);
    console.log(`   Processed: ${syncProgress.processed} | Embedded: ${syncProgress.embedded} | Symbols: ${syncProgress.symbols} | Edges: ${syncProgress.edges} | Skipped: ${syncProgress.skipped}`);
    return commitSha;
}

// Run CLI if invoked directly
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
    const target = process.argv[2] || process.cwd();
    snapshot(target)
        .catch(err => {
            console.error('[Snapshot Fatal]', err);
            process.exit(1);
        })
        .finally(() => pool.end());
}

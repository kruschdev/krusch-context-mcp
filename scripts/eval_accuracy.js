import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../db/pool.js';
import { getEmbedding, PRIORITY } from '../src/embedding-helper.js';
import { searchBlobs } from '../src/git-engine.js';

/**
 * 3-Way Retrieval Accuracy Benchmark Suite.
 * Compares:
 *   1. Pure BM25 Lexical Full-Text Search (ts_rank_cd on blobs.tsv)
 *   2. Pure Dense Vector Retrieval (cosine distance on bge-large 1024d embeddings)
 *   3. Hybrid Reciprocal Rank Fusion (Dense + BM25 RRF + Exponential Temporal Decay)
 * 
 * Supports frozen fixture files from evals/fixtures/*.json
 * Usage:
 *   node scripts/eval_accuracy.js [fixturePath] [repoName]
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function loadFixture(customPath) {
    const targetPath = customPath 
        ? path.resolve(customPath)
        : path.resolve(__dirname, '../evals/fixtures/corpus_14_ablation.json');
    
    const content = await fs.readFile(targetPath, 'utf8');
    const data = JSON.parse(content);
    return { data, path: targetPath };
}

async function run() {
    const fixtureArg = process.argv[2];
    const repoArg = process.argv[3];

    const { data: fixture, path: fixturePath } = await loadFixture(fixtureArg);
    const benchmarkQueries = fixture.queries || [];

    console.log(`🚀 Running 3-Way Retrieval Accuracy Benchmark: ${fixture.name || path.basename(fixturePath)}`);
    console.log(`📁 Fixture: ${fixturePath}`);
    if (repoArg) {
        console.log(`🎯 Repository Filter: ${repoArg}`);
    }
    console.log(`📊 Queries: ${benchmarkQueries.length}\n`);

    const client = await pool.connect();

    let targetRepoId = null;
    if (repoArg) {
        const repoRes = await client.query('SELECT id FROM repositories WHERE name = $1', [repoArg]);
        if (repoRes.rows.length > 0) {
            targetRepoId = repoRes.rows[0].id;
        } else {
            console.warn(`⚠️ Repository '${repoArg}' not found in database. Running across all repositories.`);
        }
    }

    let bm25Stats = { r1: 0, r5: 0, r10: 0, mrrSum: 0, semR1: 0, symR1: 0 };
    let denseStats = { r1: 0, r5: 0, r10: 0, mrrSum: 0, semR1: 0, symR1: 0 };
    let hybridStats = { r1: 0, r5: 0, r10: 0, mrrSum: 0, semR1: 0, symR1: 0 };
    const total = benchmarkQueries.length;
    const semTotal = benchmarkQueries.filter(b => b.type === 'semantic').length;
    const symTotal = benchmarkQueries.filter(b => b.type === 'symbolic').length;

    try {
        for (const [idx, item] of benchmarkQueries.entries()) {
            const tierLabel = (item.type || 'standard').toUpperCase().padEnd(8);
            console.log(`[${idx + 1}/${total}] [${tierLabel}] Query: "${item.query}"`);
            
            const embeddingArray = await getEmbedding(item.query, PRIORITY.HIGH);
            if (!embeddingArray) {
                console.error('Failed to generate embedding for query');
                continue;
            }
            
            const embeddingStr = `[${embeddingArray.join(',')}]`;
            
            // 1. Pure BM25 Lexical Search (PostgreSQL full-text)
            let bm25Sql = `
                SELECT b.file_name, b.file_path, r.name as repo, ts_rank_cd(b.tsv, plainto_tsquery('simple', $1)) as score
                FROM blobs b
                JOIN repositories r ON b.repository_id = r.id
                WHERE b.tsv @@ plainto_tsquery('simple', $1)
            `;
            const bm25Params = [item.query];
            if (targetRepoId) {
                bm25Sql += ` AND b.repository_id = $2`;
                bm25Params.push(targetRepoId);
            }
            bm25Sql += ` ORDER BY score DESC LIMIT 10`;
            const bm25Res = await client.query(bm25Sql, bm25Params);
            const bm25Files = bm25Res.rows.map(r => r.file_name);

            // 2. Baseline Dense Vector Search (Cosine Similarity)
            let denseSql = `
                SELECT b.file_name, b.file_path, r.name as repo, (1 - (b.embedding <=> $1::vector)) as similarity
                FROM blobs b
                JOIN repositories r ON b.repository_id = r.id
                WHERE b.embedding IS NOT NULL
            `;
            const denseParams = [embeddingStr];
            if (targetRepoId) {
                denseSql += ` AND b.repository_id = $2`;
                denseParams.push(targetRepoId);
            }
            denseSql += ` ORDER BY b.embedding <=> $1::vector LIMIT 10`;
            const denseRes = await client.query(denseSql, denseParams);
            const denseFiles = denseRes.rows.map(r => r.file_name);
            
            // 3. Hybrid RRF Search (search_code)
            const hybridRes = await searchBlobs(item.query, 10, targetRepoId, { search_type: 'hybrid', vector: embeddingArray });
            const hybridFiles = hybridRes.map(r => r.file_name);

            const findRank = (files) => {
                for (let i = 0; i < files.length; i++) {
                    if (item.expectedMatches.some(m => files[i] && files[i].includes(m))) {
                        return i + 1;
                    }
                }
                return -1;
            };

            const bRank = findRank(bm25Files);
            const dRank = findRank(denseFiles);
            const hRank = findRank(hybridFiles);

            // Record BM25
            if (bRank === 1) {
                bm25Stats.r1++;
                if (item.type === 'semantic') bm25Stats.semR1++; else bm25Stats.symR1++;
            }
            if (bRank >= 1 && bRank <= 5) bm25Stats.r5++;
            if (bRank >= 1 && bRank <= 10) bm25Stats.r10++;
            if (bRank > 0) bm25Stats.mrrSum += 1.0 / bRank;

            // Record Dense
            if (dRank === 1) {
                denseStats.r1++;
                if (item.type === 'semantic') denseStats.semR1++; else denseStats.symR1++;
            }
            if (dRank >= 1 && dRank <= 5) denseStats.r5++;
            if (dRank >= 1 && dRank <= 10) denseStats.r10++;
            if (dRank > 0) denseStats.mrrSum += 1.0 / dRank;

            // Record Hybrid
            if (hRank === 1) {
                hybridStats.r1++;
                if (item.type === 'semantic') hybridStats.semR1++; else hybridStats.symR1++;
            }
            if (hRank >= 1 && hRank <= 5) hybridStats.r5++;
            if (hRank >= 1 && hRank <= 10) hybridStats.r10++;
            if (hRank > 0) hybridStats.mrrSum += 1.0 / hRank;

            console.log(`  - BM25   Top Hit : ${bm25Files[0] || 'No match'} (Rank: ${bRank > 0 ? bRank : 'Miss'})`);
            console.log(`  - Dense  Top Hit : ${denseFiles[0]} (Rank: ${dRank > 0 ? dRank : 'Miss'})`);
            console.log(`  - Hybrid Top Hit : ${hybridFiles[0]} (Rank: ${hRank > 0 ? hRank : 'Miss'})\n`);
        }

        console.log('===================================================================================');
        console.log(`        3-WAY RETRIEVAL BENCHMARK RESULTS: ${fixture.name || 'Benchmark'}          `);
        console.log('===================================================================================');
        console.log(`Total Benchmark Queries : ${total} (${semTotal} Semantic Concepts + ${symTotal} Code Identifiers)`);
        console.log('-----------------------------------------------------------------------------------');
        console.log(`Metric      | BM25 Lexical (Postgres)  | Dense Cosine (bge-large) | Hybrid RRF (search_code)`);
        console.log('-----------------------------------------------------------------------------------');
        console.log(`Recall@1    | ${bm25Stats.r1}/${total} (${((bm25Stats.r1/total)*100).toFixed(1)}%)                | ${denseStats.r1}/${total} (${((denseStats.r1/total)*100).toFixed(1)}%)               | ${hybridStats.r1}/${total} (${((hybridStats.r1/total)*100).toFixed(1)}%)`);
        console.log(`Recall@5    | ${bm25Stats.r5}/${total} (${((bm25Stats.r5/total)*100).toFixed(1)}%)                | ${denseStats.r5}/${total} (${((denseStats.r5/total)*100).toFixed(1)}%)              | ${hybridStats.r5}/${total} (${((hybridStats.r5/total)*100).toFixed(1)}%)`);
        console.log(`Recall@10   | ${bm25Stats.r10}/${total} (${((bm25Stats.r10/total)*100).toFixed(1)}%)                | ${denseStats.r10}/${total} (${((denseStats.r10/total)*100).toFixed(1)}%)              | ${hybridStats.r10}/${total} (${((hybridStats.r10/total)*100).toFixed(1)}%)`);
        console.log(`MRR         | ${(bm25Stats.mrrSum/total).toFixed(3)}                      | ${(denseStats.mrrSum/total).toFixed(3)}                      | ${(hybridStats.mrrSum/total).toFixed(3)}`);
        console.log('-----------------------------------------------------------------------------------');
        if (semTotal > 0 || symTotal > 0) {
            console.log('CATEGORY BREAKDOWN (Recall@1):');
            if (semTotal > 0) {
                console.log(`- Semantic Concepts (${semTotal}) : BM25: ${((bm25Stats.semR1/semTotal)*100).toFixed(1)}% | Dense: ${((denseStats.semR1/semTotal)*100).toFixed(1)}% | Hybrid: ${((hybridStats.semR1/semTotal)*100).toFixed(1)}%`);
            }
            if (symTotal > 0) {
                console.log(`- Code Identifiers  (${symTotal}) : BM25: ${((bm25Stats.symR1/symTotal)*100).toFixed(1)}% | Dense: ${((denseStats.symR1/symTotal)*100).toFixed(1)}% | Hybrid: ${((hybridStats.symR1/symTotal)*100).toFixed(1)}%`);
            }
            console.log('===================================================================================\n');
        }

    } finally {
        client.release();
    }
    
    process.exit(0);
}

run().catch(err => {
    console.error('Benchmark failed:', err);
    process.exit(1);
});

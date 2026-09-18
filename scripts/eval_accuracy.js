import { pool } from '../db/pool.js';
import { getEmbedding, PRIORITY } from '../src/embedding-helper.js';
import { searchBlobs } from '../src/git-engine.js';

/**
 * Retrieval accuracy benchmark comparing dense vector retrieval (bge-large, 1024d)
 * against hybrid Reciprocal Rank Fusion (dense + BM25 tsvector + temporal decay).
 */
const BENCHMARK = [
    {
        query: "priority queue for ollama inference fleet",
        expectedMatches: ["llm-queue.js"]
    },
    {
        query: "database connection pool setup",
        expectedMatches: ["pool.js", "db.js", "SETUP.md"]
    },
    {
        query: "codebase search with reciprocal rank fusion and bm25",
        expectedMatches: ["git-engine.js"]
    },
    {
        query: "episodic memory superseding and invalidation lifecycle",
        expectedMatches: ["memory-engine.js", "invalidation-memory.test.js", "EPISODIC_MEMORY.md"]
    },
    {
        query: "structural symbol and import extraction with regex",
        expectedMatches: ["ast-chunker.js"]
    },
    {
        query: "lakebase sqlite write-behind push sync",
        expectedMatches: ["sqlite-engine.js", "lakebase.test.js"]
    },
    {
        query: "single-turn hybrid retrieval with token budget packing",
        expectedMatches: ["unified-retrieval.js"]
    },
    {
        query: "proactive threat auditor and trajectory guardrails",
        expectedMatches: ["proactive-engine.js"]
    },
    {
        query: "steering nuggets memory persistence and nudges",
        expectedMatches: ["nuggets-engine.js", "EPISODIC_MEMORY.md"]
    },
    {
        query: "postgresql git dag schema with pgvector embeddings",
        expectedMatches: ["schema.sql", "002_hybrid_and_symbols.sql", "SETUP.md"]
    }
];

async function run() {
    console.log('🚀 Running Retrieval Accuracy Benchmark (Dense vs. Hybrid RRF)...\n');
    
    const client = await pool.connect();
    
    let denseMetrics = { r1: 0, r5: 0, r10: 0, mrrSum: 0 };
    let hybridMetrics = { r1: 0, r5: 0, r10: 0, mrrSum: 0 };
    const total = BENCHMARK.length;

    try {
        for (const [idx, item] of BENCHMARK.entries()) {
            console.log(`[${idx + 1}/${total}] Query: "${item.query}"`);
            
            const embeddingArray = await getEmbedding(item.query, PRIORITY.HIGH);
            if (!embeddingArray) {
                console.error('Failed to generate embedding for query');
                continue;
            }
            
            const embeddingStr = `[${embeddingArray.join(',')}]`;
            
            // 1. Baseline Dense Vector Search
            const denseRes = await client.query(`
                SELECT b.file_name, b.file_path, r.name as repo, (1 - (b.embedding <=> $1::vector)) as similarity
                FROM blobs b
                JOIN repositories r ON b.repository_id = r.id
                WHERE b.embedding IS NOT NULL
                ORDER BY b.embedding <=> $1::vector
                LIMIT 10
            `, [embeddingStr]);
            const denseFiles = denseRes.rows.map(r => r.file_name);
            
            // 2. Hybrid RRF Search (search_code)
            const hybridRes = await searchBlobs(item.query, 10, null, { search_type: 'hybrid', vector: embeddingArray });
            const hybridFiles = hybridRes.map(r => r.file_name);

            // Evaluate Dense
            let dRank = -1;
            for (let i = 0; i < denseFiles.length; i++) {
                if (item.expectedMatches.some(m => denseFiles[i] && denseFiles[i].includes(m))) {
                    dRank = i + 1;
                    break;
                }
            }
            if (dRank === 1) denseMetrics.r1++;
            if (dRank >= 1 && dRank <= 5) denseMetrics.r5++;
            if (dRank >= 1 && dRank <= 10) denseMetrics.r10++;
            if (dRank > 0) denseMetrics.mrrSum += 1.0 / dRank;

            // Evaluate Hybrid RRF
            let hRank = -1;
            for (let i = 0; i < hybridFiles.length; i++) {
                if (item.expectedMatches.some(m => hybridFiles[i] && hybridFiles[i].includes(m))) {
                    hRank = i + 1;
                    break;
                }
            }
            if (hRank === 1) hybridMetrics.r1++;
            if (hRank >= 1 && hRank <= 5) hybridMetrics.r5++;
            if (hRank >= 1 && hRank <= 10) hybridMetrics.r10++;
            if (hRank > 0) hybridMetrics.mrrSum += 1.0 / hRank;

            console.log(`  - Dense Top Hit : ${denseFiles[0]} (Rank: ${dRank > 0 ? dRank : 'Miss'})`);
            console.log(`  - Hybrid Top Hit: ${hybridFiles[0]} (Rank: ${hRank > 0 ? hRank : 'Miss'})\n`);
        }

        console.log('===============================================================');
        console.log('                 RETRIEVAL EVALUATION RESULTS                  ');
        console.log('===============================================================');
        console.log(`Total Benchmark Queries : ${total}`);
        console.log('---------------------------------------------------------------');
        console.log(`Metric      | Dense Cosine (bge-large) | Hybrid RRF (search_code)`);
        console.log('---------------------------------------------------------------');
        console.log(`Recall@1    | ${denseMetrics.r1}/${total} (${((denseMetrics.r1/total)*100).toFixed(1)}%)            | ${hybridMetrics.r1}/${total} (${((hybridMetrics.r1/total)*100).toFixed(1)}%)`);
        console.log(`Recall@5    | ${denseMetrics.r5}/${total} (${((denseMetrics.r5/total)*100).toFixed(1)}%)           | ${hybridMetrics.r5}/${total} (${((hybridMetrics.r5/total)*100).toFixed(1)}%)`);
        console.log(`Recall@10   | ${denseMetrics.r10}/${total} (${((denseMetrics.r10/total)*100).toFixed(1)}%)           | ${hybridMetrics.r10}/${total} (${((hybridMetrics.r10/total)*100).toFixed(1)}%)`);
        console.log(`MRR         | ${(denseMetrics.mrrSum/total).toFixed(3)}                      | ${(hybridMetrics.mrrSum/total).toFixed(3)}`);
        console.log('===============================================================\n');

    } finally {
        client.release();
    }
    
    process.exit(0);
}

run().catch(err => {
    console.error('Benchmark failed:', err);
    process.exit(1);
});

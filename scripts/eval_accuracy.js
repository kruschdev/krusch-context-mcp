import { pool } from '../db/pool.js';
import { getEmbedding, PRIORITY } from '../src/embedding-helper.js';
import { searchBlobs } from '../src/git-engine.js';

/**
 * 3-Way Retrieval Accuracy Benchmark Suite.
 * Compares:
 *   1. Pure BM25 Lexical Full-Text Search (ts_rank_cd on blobs.tsv)
 *   2. Pure Dense Vector Retrieval (cosine distance on bge-large 1024d embeddings)
 *   3. Hybrid Reciprocal Rank Fusion (Dense + BM25 RRF + Exponential Temporal Decay)
 * Across two distinct evaluation tiers:
 *   - Semantic Architecture Queries (natural language conceptual queries)
 *   - Symbolic / Lexical Code Queries (exact identifiers, configuration flags, CVE tokens)
 */
const BENCHMARK = [
    // --- Tier 1: Semantic Architecture Queries ---
    {
        type: 'semantic',
        query: "priority queue for ollama inference fleet",
        expectedMatches: ["llm-queue.js"]
    },
    {
        type: 'semantic',
        query: "database connection pool setup",
        expectedMatches: ["SETUP.md", "pool.js", "db.js"]
    },
    {
        type: 'semantic',
        query: "episodic memory superseding and invalidation lifecycle",
        expectedMatches: ["EPISODIC_MEMORY.md", "memory-engine.js"]
    },
    {
        type: 'semantic',
        query: "proactive threat auditor and trajectory guardrails",
        expectedMatches: ["proactive-engine.js", "README.md"]
    },
    {
        type: 'semantic',
        query: "single-turn hybrid retrieval with token budget packing",
        expectedMatches: ["unified-retrieval.js", "EVALS.md"]
    },
    {
        type: 'semantic',
        query: "lakebase sqlite write-behind push sync",
        expectedMatches: ["sqlite-engine.js", "lakebase.test.js"]
    },
    {
        type: 'semantic',
        query: "steering nuggets memory persistence and nudges",
        expectedMatches: ["nuggets-engine.js", "EPISODIC_MEMORY.md", "README.md"]
    },
    {
        type: 'semantic',
        query: "postgresql git dag schema with pgvector embeddings",
        expectedMatches: ["schema.sql", "002_hybrid_and_symbols.sql", "SETUP.md", "README.md"]
    },

    // --- Tier 2: Symbolic / Exact-Identifier Code Queries ---
    {
        type: 'symbolic',
        query: "astChunker balanced brace",
        expectedMatches: ["ast-chunker.js"]
    },
    {
        type: 'symbolic',
        query: "CVE-2026-13676 fast-uri",
        expectedMatches: ["package.json", "CHANGELOG.md"]
    },
    {
        type: 'symbolic',
        query: "KRUSCH_PROFILE extended",
        expectedMatches: ["index.js", "AGENTS.md", ".env.example"]
    },
    {
        type: 'symbolic',
        query: "detectCurrentProject git rev-parse",
        expectedMatches: ["index.js", "project-helper.js", "memory-engine.js"]
    },
    {
        type: 'symbolic',
        query: "routeSkills diverse skills",
        expectedMatches: ["skills-engine.js", "research.test.js"]
    },
    {
        type: 'symbolic',
        query: "evaluateResilience credential leaks",
        expectedMatches: ["resilience-gate.js", "research-tools.test.js"]
    }
];

async function run() {
    console.log('🚀 Running 3-Way Retrieval Accuracy Benchmark (BM25 vs. Dense vs. Hybrid RRF)...\n');
    
    const client = await pool.connect();
    
    let bm25Stats = { r1: 0, r5: 0, r10: 0, mrrSum: 0, semR1: 0, symR1: 0 };
    let denseStats = { r1: 0, r5: 0, r10: 0, mrrSum: 0, semR1: 0, symR1: 0 };
    let hybridStats = { r1: 0, r5: 0, r10: 0, mrrSum: 0, semR1: 0, symR1: 0 };
    const total = BENCHMARK.length;
    const semTotal = BENCHMARK.filter(b => b.type === 'semantic').length;
    const symTotal = BENCHMARK.filter(b => b.type === 'symbolic').length;

    try {
        for (const [idx, item] of BENCHMARK.entries()) {
            const tierLabel = item.type.toUpperCase().padEnd(8);
            console.log(`[${idx + 1}/${total}] [${tierLabel}] Query: "${item.query}"`);
            
            const embeddingArray = await getEmbedding(item.query, PRIORITY.HIGH);
            if (!embeddingArray) {
                console.error('Failed to generate embedding for query');
                continue;
            }
            
            const embeddingStr = `[${embeddingArray.join(',')}]`;
            
            // 1. Pure BM25 Lexical Search (PostgreSQL full-text)
            const bm25Res = await client.query(`
                SELECT b.file_name, b.file_path, r.name as repo, ts_rank_cd(b.tsv, plainto_tsquery('simple', $1)) as score
                FROM blobs b
                JOIN repositories r ON b.repository_id = r.id
                WHERE b.tsv @@ plainto_tsquery('simple', $1)
                ORDER BY score DESC
                LIMIT 10
            `, [item.query]);
            const bm25Files = bm25Res.rows.map(r => r.file_name);

            // 2. Baseline Dense Vector Search (Cosine Similarity)
            const denseRes = await client.query(`
                SELECT b.file_name, b.file_path, r.name as repo, (1 - (b.embedding <=> $1::vector)) as similarity
                FROM blobs b
                JOIN repositories r ON b.repository_id = r.id
                WHERE b.embedding IS NOT NULL
                ORDER BY b.embedding <=> $1::vector
                LIMIT 10
            `, [embeddingStr]);
            const denseFiles = denseRes.rows.map(r => r.file_name);
            
            // 3. Hybrid RRF Search (search_code)
            const hybridRes = await searchBlobs(item.query, 10, null, { search_type: 'hybrid', vector: embeddingArray });
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
        console.log('                     3-WAY RETRIEVAL ABLATION RESULTS                              ');
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
        console.log('CATEGORY BREAKDOWN (Recall@1):');
        console.log(`- Semantic Concepts (${semTotal}) : BM25: ${((bm25Stats.semR1/semTotal)*100).toFixed(1)}% | Dense: ${((denseStats.semR1/semTotal)*100).toFixed(1)}% | Hybrid: ${((hybridStats.semR1/semTotal)*100).toFixed(1)}%`);
        console.log(`- Code Identifiers  (${symTotal}) : BM25: ${((bm25Stats.symR1/symTotal)*100).toFixed(1)}% | Dense: ${((denseStats.symR1/symTotal)*100).toFixed(1)}% | Hybrid: ${((hybridStats.symR1/symTotal)*100).toFixed(1)}%`);
        console.log('===================================================================================\n');

    } finally {
        client.release();
    }
    
    process.exit(0);
}

run().catch(err => {
    console.error('Benchmark failed:', err);
    process.exit(1);
});

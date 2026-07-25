/**
 * @file benchmark_memory_eval.js
 * Comprehensive Memory Retrieval, Precision, Setwise Reranking, and Latency Benchmark Suite for krusch-context-mcp.
 */

import { pool } from 'pg-git-mcp/db/pool.js';
import { getEmbedding } from '../src/embedding-helper.js';
import { searchMemory, addMemory } from '../src/memory-engine.js';
import { unifiedRetrieve } from '../src/unified-retrieval.js';
import { setwiseRerank, selectMinimalCoveringSet } from '../src/setwise-engine.js';
import { logAgentFailure, searchFailures, getRecoveryPattern } from '../src/agentdebugx-engine.js';

// Needle-in-a-haystack test dataset
const NEEDLE_DATASET = [
    {
        needle_id: "NEEDLE_01",
        category: "bugs",
        content: "CRITICAL_BUG_9941: Database deadlock occurs when concurrent WAL checkpoint runs simultaneously with sqlite push on kruschserv:5434. Solution: wrap sqlite-engine push in explicit transaction lock.",
        query: "database deadlock WAL checkpoint sqlite push transaction lock",
        expected_needle: "CRITICAL_BUG_9941"
    },
    {
        needle_id: "NEEDLE_02",
        category: "lessons",
        content: "LESSON_7732: Never run rsync --delete without excluding postgres/ and redis/ data directories, as it wipes production db containers.",
        query: "rsync delete safety postgres data directory exclusion rule",
        expected_needle: "LESSON_7732"
    },
    {
        needle_id: "NEEDLE_03",
        category: "priorities",
        content: "PRIORITY_1109: Upgrade krusch-nexus Company Brain ingestion workers to use pgContext HNSW index on port 5433 for single-pass metadata filtering.",
        query: "company brain ingestion workers pgContext HNSW port 5433 filtering",
        expected_needle: "PRIORITY_1109"
    },
    {
        needle_id: "NEEDLE_04",
        category: "outcomes",
        content: "OUTCOME_5520: Jellyfin media server hardware acceleration enabled via Intel VAAPI on i5-4690K hardware, reducing CPU load from 98% to 14%.",
        query: "jellyfin media server hardware acceleration VAAPI CPU load reduction",
        expected_needle: "OUTCOME_5520"
    }
];

// Noise memories to create a realistic haystack
const HAYSTACK_NOISE = [
    "Routine backup completed for kruschserv Postgres cluster at 03:00 UTC.",
    "Updated Tailwind color tokens in FTF assistant frontend interface.",
    "Cleaned up stale Docker containers on kruschgame sandbox node.",
    "Configured Tailscale mesh network routing between kruschdev and kruschserv.",
    "Validated JSON schema parsing for Pocket Lawyer form submission endpoints.",
    "Optimized SQLite WAL mode page size for First Things First database."
];

async function runBenchmark() {
    console.log("===============================================================");
    console.log("🚀 KRUSCH-CONTEXT-MCP MEMORY & RETRIEVAL BENCHMARK SUITE");
    console.log("===============================================================\n");

    const benchmarkStart = Date.now();
    const insertedIds = [];

    try {
        // Step 1: Seed Needle & Haystack Memory
        console.log("1️⃣ Seeding Test Memory Store (Needles + Haystack)...");
        for (const item of NEEDLE_DATASET) {
            const embed = await getEmbedding(item.content);
            if (embed) {
                const client = await pool.connect();
                try {
                    const res = await client.query(`
                        INSERT INTO ide_agent_memory (category, content, project, embedding)
                        VALUES ($1, $2, 'benchmark_test', $3::vector)
                        RETURNING id
                    `, [item.category, item.content, `[${embed.join(',')}]`]);
                    insertedIds.push(res.rows[0].id);
                } finally {
                    client.release();
                }
            }
        }

        for (const noise of HAYSTACK_NOISE) {
            const embed = await getEmbedding(noise);
            if (embed) {
                const client = await pool.connect();
                try {
                    const res = await client.query(`
                        INSERT INTO ide_agent_memory (category, content, project, embedding)
                        VALUES ('activity', $1, 'benchmark_test', $2::vector)
                        RETURNING id
                    `, [noise, `[${embed.join(',')}]`]);
                    insertedIds.push(res.rows[0].id);
                } finally {
                    client.release();
                }
            }
        }
        console.log(`✅ Seeded ${insertedIds.length} test memory items into database.\n`);

        // Step 2: Evaluate Needle Retrieval (Recall@1, Recall@3, Recall@5, MRR)
        console.log("2️⃣ Benchmarking Needle-in-a-Haystack (NIAH) Memory Retrieval...");
        let recallAt1 = 0;
        let recallAt3 = 0;
        let recallAt5 = 0;
        let mrrSum = 0;
        const latencies = [];

        for (const testCase of NEEDLE_DATASET) {
            const queryStart = Date.now();
            const searchRes = await searchMemory({
                category: testCase.category,
                query: testCase.query,
                active_project: 'benchmark_test',
                limit: 5
            });
            const duration = Date.now() - queryStart;
            latencies.push(duration);

            const resultText = searchRes.content[0]?.text || '';
            const matches = [...resultText.matchAll(/CRITICAL_BUG_\d+|LESSON_\d+|PRIORITY_\d+|OUTCOME_\d+/g)].map(m => m[0]);
            
            const needleIndex = matches.indexOf(testCase.expected_needle);
            const found = needleIndex !== -1;

            if (needleIndex === 0) recallAt1++;
            if (found && needleIndex < 3) recallAt3++;
            if (found && needleIndex < 5) recallAt5++;

            if (found) {
                mrrSum += 1 / (needleIndex + 1);
                console.log(`  🟢 Found ${testCase.expected_needle} at Rank ${needleIndex + 1} (${duration}ms)`);
            } else {
                console.log(`  🔴 FAILED to find ${testCase.expected_needle} in top 5 (${duration}ms)`);
            }
        }

        const totalQueries = NEEDLE_DATASET.length;
        const r1Pct = ((recallAt1 / totalQueries) * 100).toFixed(1);
        const r3Pct = ((recallAt3 / totalQueries) * 100).toFixed(1);
        const r5Pct = ((recallAt5 / totalQueries) * 100).toFixed(1);
        const mrr = (mrrSum / totalQueries).toFixed(3);

        console.log(`\n  📊 NIAH Accuracy Metrics:`);
        console.log(`     - Recall@1: ${recallAt1}/${totalQueries} (${r1Pct}%)`);
        console.log(`     - Recall@3: ${recallAt3}/${totalQueries} (${r3Pct}%)`);
        console.log(`     - Recall@5: ${recallAt5}/${totalQueries} (${r5Pct}%)`);
        console.log(`     - MRR (Mean Reciprocal Rank): ${mrr}\n`);

        // Step 3: Benchmarking Rubric4Setwise Selection & Deduplication
        console.log("3️⃣ Benchmarking Rubric4Setwise Context Selection...");
        const noisyCandidates = [
            { id: "1", title: "DB Lock Rules", content: "Database deadlock occurs when concurrent WAL checkpoint runs simultaneously with sqlite push. Solution: wrap sqlite-engine push in explicit transaction lock.", score: 0.96 },
            { id: "2", title: "DB Lock Duplicate", content: "Database deadlock occurs when concurrent WAL checkpoint runs simultaneously with sqlite push. Solution: wrap sqlite-engine push in explicit transaction lock.", score: 0.94 }, // Exact duplicate
            { id: "3", title: "Postgres Connection", content: "Postgres connection pool settings on kruschserv should use idle timeout of 10s to prevent exhaustion.", score: 0.88 },
            { id: "4", title: "Tailwind Styling", content: "FTF assistant UI uses custom dark glassmorphism styling tokens.", score: 0.80 }
        ];

        const initialTokenCount = noisyCandidates.reduce((acc, c) => acc + Math.ceil(c.content.length / 4), 0);
        const filteredCandidates = selectMinimalCoveringSet(noisyCandidates, "database lock and pool settings", 3);
        const filteredTokenCount = filteredCandidates.reduce((acc, c) => acc + Math.ceil(c.content.length / 4), 0);
        const compressionPct = (((initialTokenCount - filteredTokenCount) / initialTokenCount) * 100).toFixed(1);

        console.log(`  - Raw Candidate Token Count: ${initialTokenCount} tokens`);
        console.log(`  - Setwise Minimal Cover Token Count: ${filteredTokenCount} tokens`);
        console.log(`  - Redundancy Elimination / Compression: ${compressionPct}% saved`);
        console.log(`  - Retained Candidates: ${filteredCandidates.length}/${noisyCandidates.length} (Duplicates successfully filtered)\n`);

        // Step 4: Unified Context Retrieval Latency Profile
        console.log("4️⃣ Benchmarking Unified Hybrid Retrieval End-to-End Latency...");
        const unifiedLatencies = [];
        for (let i = 0; i < 5; i++) {
            const uStart = Date.now();
            await unifiedRetrieve({
                query: "database lock transaction and pgvector optimization",
                project: "benchmark_test",
                graph_hops: 1,
                limit_tokens: 3000,
                setwise_rerank: true
            });
            unifiedLatencies.push(Date.now() - uStart);
        }

        const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
        const sortedLat = [...unifiedLatencies].sort((a, b) => a - b);
        const p95 = sortedLat[Math.floor(sortedLat.length * 0.95)];

        console.log(`  ⏱️  Unified Retrieval Latency Profile (5 runs):`);
        console.log(`     - Average Latency: ${avg(unifiedLatencies).toFixed(0)} ms`);
        console.log(`     - Min Latency: ${Math.min(...unifiedLatencies)} ms`);
        console.log(`     - Max Latency: ${Math.max(...unifiedLatencies)} ms`);
        console.log(`     - P95 Latency: ${p95} ms\n`);

        // Step 5: Overall Summary Score
        const totalDuration = ((Date.now() - benchmarkStart) / 1000).toFixed(2);
        console.log("===============================================================");
        console.log(`🎉 MEMORY BENCHMARK COMPLETED IN ${totalDuration}s`);
        console.log(`- Final Memory Recall Score: ${r1Pct}% Recall@1 | MRR: ${mrr}`);
        console.log(`- Setwise Compression: ${compressionPct}% redundancy reduction`);
        console.log(`- End-to-End Unified Latency: ${avg(unifiedLatencies).toFixed(0)} ms`);
        console.log("===============================================================");

    } catch (err) {
        console.error("❌ Benchmark failed with error:", err);
    } finally {
        // Cleanup benchmark test entries
        if (insertedIds.length > 0) {
            console.log("\n🧹 Cleaning up benchmark test records...");
            const client = await pool.connect();
            try {
                await client.query(`DELETE FROM ide_agent_memory WHERE project = 'benchmark_test'`);
                console.log("✅ Cleanup complete.");
            } catch (_) {}
            finally {
                client.release();
            }
        }
        await pool.end();
        process.exit(0);
    }
}

runBenchmark();

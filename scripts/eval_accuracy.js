import { pool } from '../../pg-git/db/pool.js';
import { getEmbedding } from '../../pg-git/lib/embedding.js';
import { PRIORITY } from '../../../lib/llm-queue.js';

const QUERIES = [
    {
        query: "priority queue for ollama inference fleet",
        expectedMatches: ["llm-queue.js", "request_queue.py", "sweetdreams.md", "llm_foundational_papers.md"]
    },
    {
        query: "database connection pool setup",
        expectedMatches: ["pool.js", "db.js"]
    },
    {
        query: "semantic search across codebase blobs",
        expectedMatches: ["memory-engine.js", "search_code.js", "AGENTS.md", "README.md"]
    },
    {
        query: "jwt authentication middleware factory",
        expectedMatches: ["auth.js"]
    },
    {
        query: "json parser with markdown code block stripping",
        expectedMatches: ["json-parse.js"]
    }
];

async function run() {
    console.log('🚀 Starting Accuracy Evaluation for bge-large...\n');
    
    let totalQueries = QUERIES.length;
    let recallAt1 = 0;
    let recallAt5 = 0;
    let recallAt10 = 0;
    
    const client = await pool.connect();
    
    try {
        for (const testCase of QUERIES) {
            console.log(`Query: "${testCase.query}"`);
            
            const embeddingArray = await getEmbedding(testCase.query, PRIORITY.HIGH);
            if (!embeddingArray) {
                console.error('Failed to generate embedding for query');
                continue;
            }
            
            const embeddingStr = `[${embeddingArray.join(',')}]`;
            
            // Search across blobs
            const res = await client.query(`
                SELECT b.file_name, b.file_path, r.name as repo, (1 - (b.embedding <=> $1::vector)) as similarity
                FROM blobs b
                JOIN repositories r ON b.repository_id = r.id
                WHERE b.embedding IS NOT NULL
                ORDER BY b.embedding <=> $1::vector
                LIMIT 10
            `, [embeddingStr]);
            
            const topFiles = res.rows.map(r => r.file_name);
            console.log(`Top 3 hits:`);
            res.rows.slice(0, 3).forEach((r, i) => {
                console.log(`  ${i+1}. [${(r.similarity*100).toFixed(1)}%] ${r.repo}/${r.file_path}`);
            });
            
            // Check recalls
            const matches = testCase.expectedMatches;
            let foundAt = -1;
            
            for (let i = 0; i < topFiles.length; i++) {
                if (topFiles[i] && matches.some(m => topFiles[i].includes(m))) {
                    foundAt = i;
                    break;
                }
            }
            
            if (foundAt === 0) recallAt1++;
            if (foundAt >= 0 && foundAt < 5) recallAt5++;
            if (foundAt >= 0 && foundAt < 10) recallAt10++;
            
            if (foundAt >= 0) {
                console.log(`✅ Found expected file at rank ${foundAt + 1}\n`);
            } else {
                console.log(`❌ Failed to find expected files in top 10\n`);
            }
        }
        
        console.log('=== Evaluation Results ===');
        console.log(`Total Queries: ${totalQueries}`);
        console.log(`Recall@1:  ${recallAt1}/${totalQueries} (${((recallAt1/totalQueries)*100).toFixed(1)}%)`);
        console.log(`Recall@5:  ${recallAt5}/${totalQueries} (${((recallAt5/totalQueries)*100).toFixed(1)}%)`);
        console.log(`Recall@10: ${recallAt10}/${totalQueries} (${((recallAt10/totalQueries)*100).toFixed(1)}%)`);
        
    } finally {
        client.release();
    }
    
    process.exit(0);
}

run().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});

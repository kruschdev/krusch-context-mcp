import { pool } from '../../pg-git/db/pool.js';
import { getEmbedding } from '../../pg-git/lib/embedding.js';
import { PRIORITY } from '../../../lib/llm-queue.js';
import { PCA } from 'ml-pca';

const QUERIES = [
    { query: "priority queue for ollama inference fleet", expectedMatches: ["llm-queue.js"] },
    { query: "database connection pool setup", expectedMatches: ["pool.js", "db.js"] },
    { query: "semantic search across codebase blobs", expectedMatches: ["memory-engine.js", "search_code.js"] },
    { query: "jwt authentication middleware factory", expectedMatches: ["auth.js"] },
    { query: "json parser with markdown code block stripping", expectedMatches: ["json-parse.js"] }
];

function cosineSimilarity(A, B) {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < A.length; i++) {
        dot += A[i] * B[i];
        normA += A[i] * A[i];
        normB += B[i] * B[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function run() {
    console.log('🚀 Starting Spectral Calibration Evaluation...');
    
    const client = await pool.connect();
    try {
        console.log('1. Fetching sample of 2000 embeddings for PCA calibration...');
        const res = await client.query(`
            SELECT b.file_name, b.file_path, r.name as repo, b.embedding::text as emb_str
            FROM blobs b
            JOIN repositories r ON b.repository_id = r.id
            WHERE b.embedding IS NOT NULL
            LIMIT 2000
        `);
        
        const blobs = res.rows.map(r => ({
            ...r,
            vector: JSON.parse(r.emb_str)
        }));
        
        console.log(`Loaded ${blobs.length} vectors. Applying PCA...`);
        const dataset = blobs.map(b => b.vector);
        const pca = new PCA(dataset);
        
        // According to SpectralQuant, d_eff is 3-4% of head_dim. 
        // For 1536 dims, 4% is ~60 dimensions. Let's try 64 dimensions.
        const kDims = 64;
        console.log(`Projecting dataset from 1536 to ${kDims} principal components...`);
        
        const projectedDataset = pca.predict(dataset, { nComponents: kDims }).to2DArray();
        blobs.forEach((b, i) => {
            b.projected = projectedDataset[i];
        });
        
        console.log('2. Evaluating Queries...');
        let recallAt1 = 0;
        let recallAt5 = 0;
        let recallAt10 = 0;
        
        for (const testCase of QUERIES) {
            console.log(`\nQuery: "${testCase.query}"`);
            
            const rawVector = await getEmbedding(testCase.query, PRIORITY.HIGH);
            if (!rawVector) continue;
            
            // Project the query vector
            const projectedQuery = pca.predict([rawVector], { nComponents: kDims }).to2DArray()[0];
            
            // Calculate similarities
            const results = blobs.map(b => ({
                file_name: b.file_name,
                repo: b.repo,
                file_path: b.file_path,
                similarity: cosineSimilarity(projectedQuery, b.projected)
            }));
            
            // Sort by similarity descending
            results.sort((a, b) => b.similarity - a.similarity);
            const topHits = results.slice(0, 10);
            
            console.log(`Top 3 hits:`);
            topHits.slice(0, 3).forEach((r, i) => {
                console.log(`  ${i+1}. [${(r.similarity*100).toFixed(1)}%] ${r.repo}/${r.file_path}`);
            });
            
            const topFiles = topHits.map(r => r.file_name);
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
                console.log(`✅ Found expected file at rank ${foundAt + 1}`);
            } else {
                console.log(`❌ Failed to find expected files in top 10`);
            }
        }
        
        console.log('\n=== Spectral Calibration Results ===');
        const totalQueries = QUERIES.length;
        console.log(`Dimensions: 1536 -> ${kDims}`);
        console.log(`Recall@1:  ${recallAt1}/${totalQueries} (${((recallAt1/totalQueries)*100).toFixed(1)}%)`);
        console.log(`Recall@5:  ${recallAt5}/${totalQueries} (${((recallAt5/totalQueries)*100).toFixed(1)}%)`);
        console.log(`Recall@10: ${recallAt10}/${totalQueries} (${((recallAt10/totalQueries)*100).toFixed(1)}%)`);
        
    } finally {
        client.release();
    }
}

run().catch(err => {
    console.error('Failed:', err);
    process.exit(1);
});

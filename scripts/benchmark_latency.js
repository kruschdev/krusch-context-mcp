import { getEmbedding } from '../../pg-git/lib/embedding.js';
import { PRIORITY } from '../../../lib/llm-queue.js';

async function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function run() {
    console.log('🚀 Starting Latency Benchmark...\n');
    
    const lowTasks = [];
    const highTasks = [];
    
    console.log('Saturating fleet with 20 LOW priority tasks...');
    for (let i = 0; i < 20; i++) {
        const start = Date.now();
        lowTasks.push(
            getEmbedding(`Low priority background task ${i} for codebase sync. This simulates a large file chunk being indexed during a background batch process. It needs enough text to cause some processing time on the model end. Generating embeddings for this chunk of text to simulate workload.`, PRIORITY.LOW)
                .then(() => Date.now() - start)
        );
    }
    
    // Give LOW tasks a small head start to fill the queue and active slots
    await sleep(2000);
    
    console.log('Firing 5 HIGH priority tasks (simulating live agent searches)...');
    for (let i = 0; i < 5; i++) {
        const start = Date.now();
        highTasks.push(
            getEmbedding(`High priority semantic search query ${i} for active agent session.`, PRIORITY.HIGH)
                .then(() => Date.now() - start)
        );
        // Slight stagger
        await sleep(200);
    }
    
    console.log('Waiting for all HIGH priority tasks to complete...');
    const highLatencies = await Promise.all(highTasks);
    
    console.log('Waiting for all LOW priority tasks to complete (this may take a while)...');
    const lowLatencies = await Promise.all(lowTasks);
    
    const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
    
    console.log('\n=== Benchmark Results ===');
    console.log(`HIGH Priority Latency (Avg): ${avg(highLatencies).toFixed(0)}ms`);
    console.log(`HIGH Priority Max: ${Math.max(...highLatencies)}ms`);
    console.log(`HIGH Priority Min: ${Math.min(...highLatencies)}ms`);
    console.log('---');
    console.log(`LOW Priority Latency (Avg): ${avg(lowLatencies).toFixed(0)}ms`);
    console.log(`LOW Priority Max: ${Math.max(...lowLatencies)}ms`);
    console.log(`LOW Priority Min: ${Math.min(...lowLatencies)}ms`);
    
    if (avg(highLatencies) < avg(lowLatencies)) {
        console.log('\n✅ PASS: HIGH priority tasks leapfrogged LOW priority tasks successfully.');
    } else {
        console.log('\n❌ FAIL: HIGH priority tasks were slower or equal to LOW priority tasks.');
    }
    
    process.exit(0);
}

run().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});

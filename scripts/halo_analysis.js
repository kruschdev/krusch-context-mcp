import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from 'pg-git-mcp/db/pool.js';
import { getEmbedding, ollamaQueue, PRIORITY } from 'pg-git-mcp/lib/embedding.js';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function runHaloAnalysis() {
    console.log("🔍 Running HALO Trace Analysis...");
    const tracePath = process.env.KRUSCH_TRACE_PATH || path.resolve(__dirname, '../data/traces.jsonl');

    try {
        await fs.access(tracePath);
    } catch {
        console.log("✅ No traces found. Skipping HALO analysis.");
        try { pool.end(); } catch (e) {}
        return;
    }

    const stat = await fs.stat(tracePath);
    if (stat.size === 0) {
        console.log("✅ Traces file is empty. Skipping HALO analysis.");
        try { pool.end(); } catch (e) {}
        return;
    }

    const prompt = "Analyze these agent tool call traces to the krusch-context-mcp server. Identify common failure modes, hallucinated parameters, or context gaps. Output a concise lesson learned that can be fed back to the agent to improve tool usage. If there are no obvious failure modes, reply with 'NO_ACTION_NEEDED'.\n\nTraces:\n";
    
    console.log("🚀 Invoking local Ollama inference...");
    let stdout;
    try {
        const traceContent = await fs.readFile(tracePath, 'utf8');
        const fullPrompt = prompt + traceContent;
        
        stdout = await ollamaQueue.enqueue(async (endpoint) => {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 300000);
            try {
                const res = await fetch(`${endpoint}/api/generate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: 'qwen2.5-coder:3b', // standard homelab fast model
                        prompt: fullPrompt,
                        stream: false,
                        options: { temperature: 0.1 }
                    }),
                    signal: controller.signal
                });
                if (!res.ok) throw new Error(`Ollama status ${res.status}`);
                const data = await res.json();
                return data.response;
            } finally {
                clearTimeout(timeoutId);
            }
        }, PRIORITY.LOW);
    } catch (err) {
        console.error("❌ HALO analysis failed:", err);
        try { pool.end(); } catch (e) {}
        return;
    }

    const output = stdout.trim();
    if (!output || output.includes('NO_ACTION_NEEDED')) {
        console.log("✅ HALO found no systemic issues.");
    } else {
        console.log("⚠️ HALO identified systemic issues. Writing lesson to Company Brain...");
        
        const client = await pool.connect();
        try {
            const summary = `HALO Trace Analysis: ${output}`;
            const embeddingArray = await getEmbedding(summary);
            const embeddingStr = embeddingArray ? `[${embeddingArray.join(',')}]` : null;

            if (embeddingStr) {
                await client.query(`
                    INSERT INTO homelab_memory_v2 (category, content, embedding, author_id, status, ontology_tags)
                    VALUES ('lessons', $1, $2::vector, 'agent:halo', 'active', ARRAY['optimization', 'tool-usage'])
                `, [summary, embeddingStr]);
                console.log("✅ Lesson successfully written.");
            }
        } finally {
            client.release();
        }
    }

    // Archive & clear the trace file
    const archivePath = path.resolve(path.dirname(tracePath), `traces_${Date.now()}.jsonl.archive`);
    await fs.rename(tracePath, archivePath);
    console.log(`📦 Traces archived to ${path.basename(archivePath)}`);
    
    // Close pool so process exits
    pool.end();
}

runHaloAnalysis().catch(err => {
    console.error("Fatal error in HALO analysis:", err);
    try { pool.end(); } catch (e) {}
    process.exit(1);
});

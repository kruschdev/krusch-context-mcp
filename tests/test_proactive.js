#!/usr/bin/env node

/**
 * @module test_proactive
 * Smoke test for krusch_context_proactive_nudge tool via JSON-RPC.
 * Seeds test constraints, spawns the MCP server, verifies the tool, and cleans up.
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { pool } from 'pg-git-mcp/db/pool.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

const SERVER = new URL('../src/index.js', import.meta.url).pathname;
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://10.0.0.85:11434';

let nextId = 1;
const pending = new Map();

function send(child, method, params = {}) {
    return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, resolve);
        const msg = JSON.stringify({ jsonrpc: '2.0', method, params, id });
        child.stdin.write(msg + '\n');
        setTimeout(() => {
            if (pending.has(id)) {
                pending.delete(id);
                reject(new Error(`Timeout on ${method} (id=${id})`));
            }
        }, 60000);
    });
}

async function getEmbedding(text) {
    const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: 'bge-large', prompt: text })
    });
    if (!res.ok) throw new Error(`Ollama embedding error: HTTP ${res.status}`);
    const data = await res.ok ? await res.json() : {};
    return data.embedding;
}

async function run() {
    console.log('🌱 Seeding test database memories in Postgres...');
    const client = await pool.connect();

    const lesson1 = "Lesson: The postgres ide_agent_memory table embedding column is constrained to 1024 dimensions. qwen2.5-coder:1.5b embeddings have 1536 dimensions and will fail. Always use bge-large:latest embeddings (1024 dimensions) for this table.";
    const lesson2 = "Lesson: The GEMINI_API_KEY in the homelab .env file is invalid and returns HTTP 400. Always route queries through OpenRouter (google/gemini-2.5-flash via openai provider) using OPENROUTER_API_KEY.";

    let seededIds = [];

    try {
        const embed1 = await getEmbedding(lesson1);
        const embed2 = await getEmbedding(lesson2);

        const res1 = await client.query(`
            INSERT INTO ide_agent_memory (category, content, embedding, project)
            VALUES ('lessons', $1, $2::vector, 'ai-watch-test')
            RETURNING id
        `, [lesson1, `[${embed1.join(',')}]`]);

        const res2 = await client.query(`
            INSERT INTO ide_agent_memory (category, content, embedding, project)
            VALUES ('lessons', $1, $2::vector, 'ai-watch-test')
            RETURNING id
        `, [lesson2, `[${embed2.join(',')}]`]);

        seededIds.push(res1.rows[0].id, res2.rows[0].id);
        console.log(`✅ Seeded ${seededIds.length} test memories:`, seededIds);
    } catch (e) {
        console.error('❌ Database seeding failed:', e.message);
        await pool.end();
        process.exit(1);
    }

    console.log(`\nStarting MCP server process from: ${SERVER}`);
    const child = spawn('node', [SERVER], {
        stdio: ['pipe', 'pipe', 'inherit'],
        env: { ...process.env }
    });

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
        try {
            const msg = JSON.parse(line);
            if (msg.id && pending.has(msg.id)) {
                pending.get(msg.id)(msg);
                pending.delete(msg.id);
            }
        } catch (e) {
            // Skip non-JSON logs
        }
    });

    try {
        console.log('⏳ Initializing connection to MCP server...');
        const initRes = await send(child, 'initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'test-proactive-client', version: '1.0.0' }
        });
        console.log('✅ Initialize:', initRes.result?.serverInfo?.name || 'OK');

        // Send initialized notification
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
        await new Promise(r => setTimeout(r, 500));

        // 1. Verify proactive nudge tool is registered
        const toolsRes = await send(child, 'tools/list');
        const tools = toolsRes.result?.tools || [];
        const nudgeTool = tools.find(t => t.name === 'krusch_context_proactive_nudge');
        if (nudgeTool) {
            console.log('✅ Found krusch_context_proactive_nudge tool in list!');
        } else {
            console.error('❌ krusch_context_proactive_nudge tool not found in list.');
            throw new Error('Tool not registered');
        }

        // 2. Invoke tool with a benign request (should return NO_NUDGES_REQUIRED)
        const benignHistory = "Write a basic hello world in javascript.";
        console.log(`\n🧠 Testing benign request: "${benignHistory}"...`);
        const resBenign = await send(child, 'tools/call', {
            name: 'krusch_context_proactive_nudge',
            arguments: { history: benignHistory, project: 'ai-watch-test' }
        });

        const benignText = resBenign.result?.content?.[0]?.text || '';
        console.log(`Benign Output: "${benignText}"`);
        if (benignText === "NO_NUDGES_REQUIRED") {
            console.log('✅ Benign test passed!');
        } else {
            console.warn('⚠️ Warning: Benign test returned nudges when none were expected.');
        }

        // 3. Invoke tool with a task that triggers constraints
        const problematicHistory = "Let's index the daily research papers using qwen2.5-coder:1.5b embeddings and default Gemini API key.";
        console.log(`\n🧠 Testing constraint-triggering request: "${problematicHistory}"...`);
        const resProblem = await send(child, 'tools/call', {
            name: 'krusch_context_proactive_nudge',
            arguments: { history: problematicHistory, project: 'ai-watch-test' }
        });

        const problemText = resProblem.result?.content?.[0]?.text || '';
        console.log('\n================ PROACTIVE AUDITOR NUDGES ================');
        console.log(problemText);
        console.log('==========================================================');

        const triggersNudge = problemText.includes('### 🧠 Proactive Context Nudge');

        if (triggersNudge) {
            console.log('\n✅ Constraint trigger test passed: Successfully detected and triggered a proactive nudge!');
        } else {
            throw new Error('Proactive auditor failed to generate a nudge header.');
        }

    } catch (e) {
        console.error('❌ Test execution failed:', e.message);
    } finally {
        console.log('\n🧹 Cleaning up test database memories...');
        try {
            await client.query('DELETE FROM ide_agent_memory WHERE id = ANY($1)', [seededIds]);
            console.log('✅ Cleaned up seeded memories successfully.');
        } catch (dbErr) {
            console.error('⚠️ Failed to clean up database memories:', dbErr.message);
        }
        client.release();
        await pool.end();

        console.log('🧹 Tearing down MCP server...');
        child.kill('SIGTERM');
        setTimeout(() => process.exit(0), 500);
    }
}

run().catch(err => {
    console.error('❌ Critical Test Error:', err);
    process.exit(1);
});

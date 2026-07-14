#!/usr/bin/env node

/**
 * @module test_feedback
 * Smoke test for krusch_context_nudge_feedback tool via JSON-RPC.
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
        }, 30000);
    });
}

async function run() {
    console.log(`Starting MCP server process from: ${SERVER}`);
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
        // 0. Initialize Protocol handshake
        console.log('Sending initialize request...');
        await send(child, 'initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'test-feedback-client', version: '1.0.0' }
        });

        // 1. Verify proactive nudge feedback tool is registered
        console.log('Listing tools to verify registration...');
        const listRes = await send(child, 'tools/list');
        const tools = listRes.result?.tools || [];
        const feedbackTool = tools.find(t => t.name === 'krusch_context_nudge_feedback');
        if (feedbackTool) {
            console.log('✅ Found krusch_context_nudge_feedback tool in list!');
        } else {
            console.error('❌ krusch_context_nudge_feedback tool not found in list.');
            process.exit(1);
        }

        // 2. Call krusch_context_nudge_feedback tool
        console.log('Invoking krusch_context_nudge_feedback...');
        const callRes = await send(child, 'tools/call', {
            name: 'krusch_context_nudge_feedback',
            arguments: {
                query_text: 'Let\'s run a benchmark using qwen2.5-coder:1.5b on OS drive /dev/sdc.',
                nudge_text: 'Warning: Running tasks on OS drive /dev/sdc is protected. Use /mnt/nvme instead.',
                user_approved: true,
                agent_corrected: true,
                correction_diff: '- Cwd: /dev/sdc\n+ Cwd: /mnt/nvme/benchmark',
                project: 'feedback-smoke-test'
            }
        });

        console.log('\nResponse received:', JSON.stringify(callRes));
        
        const responseText = callRes.result?.content?.[0]?.text || '';
        if (responseText.includes('State written successfully')) {
            console.log('✅ Tool execution completed: Database record created successfully!');
        } else {
            throw new Error(`Tool execution failed or unexpected response: ${responseText}`);
        }

        // 3. Verify in PostgreSQL
        console.log('\nVerifying record insertion in PostgreSQL database...');
        const pgClient = await pool.connect();
        try {
            const dbRes = await pgClient.query(`
                SELECT id, category, author_id, action_trace, project 
                FROM memory_v2 
                WHERE project = 'feedback-smoke-test' 
                AND category = 'alignment_signal'
            `);
            if (dbRes.rows.length > 0) {
                const row = dbRes.rows[0];
                console.log('✅ Verified in database:', JSON.stringify(row));
                
                // Cleanup: delete the smoke test record
                await pgClient.query('DELETE FROM memory_v2 WHERE id = $1', [row.id]);
                console.log('🧹 Cleaned up smoke test record from database.');
            } else {
                throw new Error('Verification failed: Record not found in Postgres!');
            }
        } finally {
            pgClient.release();
        }

    } catch (err) {
        console.error('❌ Error during smoke test:', err.message);
        child.kill();
        await pool.end();
        process.exit(1);
    }

    console.log('\n🎉 krusch_context_nudge_feedback tool smoke test passed successfully!');
    child.kill();
    await pool.end();
    process.exit(0);
}

run();

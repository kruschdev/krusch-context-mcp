#!/usr/bin/env node

/**
 * @module test_think
 * Smoke test for krusch_context_think tool via JSON-RPC.
 * Spawns the MCP server, invokes the think tool, and prints results.
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const SERVER = new URL('../src/index.js', import.meta.url).pathname;
let nextId = 1;
const pending = new Map();

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
        // Skip non-JSON logging output
    }
});

function send(method, params = {}) {
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
        }, 60000); // 60s timeout for LLM reasoning/Ollama warmups
    });
}

async function run() {
    console.log('⏳ Initializing connection to MCP server...');
    const initRes = await send('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-think-client', version: '1.0.0' }
    });
    console.log('✅ Initialize:', initRes.result?.serverInfo?.name || 'OK');

    // Send initialized notification
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    await new Promise(r => setTimeout(r, 500));

    // 1. Verify think tool is registered
    console.log('\n📋 Verification: Listing tools...');
    const toolsRes = await send('tools/list');
    const tools = toolsRes.result?.tools || [];
    const thinkTool = tools.find(t => t.name === 'krusch_context_think');
    if (thinkTool) {
        console.log('✅ Found krusch_context_think tool in list!');
    } else {
        console.error('❌ krusch_context_think tool not found in list.');
        process.exit(1);
    }

    // 2. Invoke the tool with a test query
    const testQuery = 'Jellyfin migration and Jellyseerr setup credentials';
    console.log(`\n🧠 Testing krusch_context_think with query: "${testQuery}"...`);
    try {
        const res = await send('tools/call', {
            name: 'krusch_context_think',
            arguments: { query: testQuery }
        });

        if (res.error) {
            console.error('❌ MCP Tool call returned an error:', res.error);
            process.exit(1);
        }

        const text = res.result?.content?.[0]?.text || '';
        console.log('\n================== THINK TOOL OUTPUT ==================');
        console.log(text);
        console.log('=======================================================');

        // Simple validation checks on structure
        const hasSynthesis = text.includes('### Cited Synthesis');
        const hasConflicts = text.includes('### Conflicts & Contradictions');
        const hasGaps = text.includes('### Information Gaps');

        if (hasSynthesis && hasConflicts && hasGaps) {
            console.log('\n✅ Structure check PASSED: Output contains Cited Synthesis, Conflicts, and Information Gaps headers.');
        } else {
            console.warn('\n⚠️ Structure check FAILED: Some expected headers are missing from the output.');
        }
    } catch (e) {
        console.error('❌ Error during tool invocation:', e);
        process.exit(1);
    }

    console.log('\n🧹 Tearing down MCP server...');
    child.kill('SIGTERM');
    setTimeout(() => process.exit(0), 500);
}

run().catch(err => {
    console.error('❌ Critical Test Error:', err);
    child.kill('SIGTERM');
    process.exit(1);
});

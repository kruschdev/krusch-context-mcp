#!/usr/bin/env node

/**
 * @module test_v2_lens_graph
 * Smoke test for Lens-Based Retrieval and Graph Traversal.
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { pool } from 'pg-git-mcp/db/pool.js';

const SERVER = new URL('../src/index.js', import.meta.url).pathname;
let nextId = 1;
const pending = new Map();

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
    } catch (e) { /* skip non-JSON lines */ }
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
        }, 30000);
    });
}

async function run() {
    console.log('⏳ Initializing server...');
    const initRes = await send('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-lens-client', version: '1.0.0' }
    });
    console.log('✅ Initialize:', initRes.result?.serverInfo?.name || 'OK');

    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    await new Promise(r => setTimeout(r, 500));

    console.log('\n📝 1. Writing base state...');
    const writeRes1 = await send('tools/call', {
        name: 'krusch_context_write_state',
        arguments: {
            content: "The company's core strategic goal is AI memory with Lens Retrieval.",
            category: "priorities",
            author_id: "agent:tester"
        }
    });
    const text1 = writeRes1.result?.content?.[0]?.text || '';
    const idMatch1 = text1.match(/New ID: ([a-f0-9\-]+)/);
    const parentId = idMatch1 ? idMatch1[1] : null;

    if (!parentId) throw new Error("Failed to extract parent ID");
    console.log(`   Base Memory ID: ${parentId}`);

    console.log('\n📝 2. Updating read_roles directly via DB...');
    await pool.query(`UPDATE interaction_memory SET read_roles = '{executive, engineer}' WHERE id = $1`, [parentId]);
    console.log(`   Updated read_roles to {executive, engineer}`);

    console.log('\n🔍 3. Testing Lens-Based Search (Match)...');
    const lensRes1 = await send('tools/call', {
        name: 'krusch_context_search_lens',
        arguments: {
            query: "strategic goal AI memory",
            roles: ["executive"]
        }
    });
    console.log(`   ${lensRes1.result?.content?.[0]?.text || lensRes1.error?.message}`);

    console.log('\n🔍 4. Testing Lens-Based Search (No Match)...');
    const lensRes2 = await send('tools/call', {
        name: 'krusch_context_search_lens',
        arguments: {
            query: "strategic goal AI memory",
            roles: ["guest"]
        }
    });
    console.log(`   ${lensRes2.result?.content?.[0]?.text || lensRes2.error?.message}`);

    console.log(`\n📝 5. Writing child state...`);
    const writeRes2 = await send('tools/call', {
        name: 'krusch_context_write_state',
        arguments: {
            content: "Graph traversal expands the capability of finding linked documents.",
            category: "lessons",
            author_id: "agent:tester",
            parent_id: parentId
        }
    });
    const text2 = writeRes2.result?.content?.[0]?.text || '';
    const idMatch2 = text2.match(/New ID: ([a-f0-9\-]+)/);
    const childId = idMatch2 ? idMatch2[1] : null;
    console.log(`   Child Memory ID: ${childId}`);

    console.log('\n📝 6. Creating blob edge directly via DB...');
    await pool.query(`
        INSERT INTO memory_to_blob_edges (memory_id, blob_id, relationship)
        VALUES ($1, $2, 'implements')
    `, [childId, 'abc123def456']);

    console.log('\n🕸️ 7. Testing Graph Traversal from Base (children)...');
    const graphRes1 = await send('tools/call', {
        name: 'krusch_context_traverse_graph',
        arguments: { memory_id: parentId, direction: 'children' }
    });
    console.log(`\n${graphRes1.result?.content?.[0]?.text || graphRes1.error?.message}`);

    console.log('\n🕸️ 8. Testing Graph Traversal from Child (all)...');
    const graphRes2 = await send('tools/call', {
        name: 'krusch_context_traverse_graph',
        arguments: { memory_id: childId, direction: 'all' }
    });
    console.log(`\n${graphRes2.result?.content?.[0]?.text || graphRes2.error?.message}`);

    console.log('\n🧹 9. Cleanup...');
    await pool.query(`DELETE FROM memory_to_blob_edges WHERE memory_id = $1`, [childId]);
    await pool.query(`DELETE FROM interaction_memory WHERE id IN ($1, $2)`, [parentId, childId]);
    
    console.log('\n✅ All Lens/Graph memory tests completed.');
    child.kill('SIGTERM');
    await pool.end();
    setTimeout(() => process.exit(0), 1000);
}

run().catch(err => {
    console.error('❌ Test failed:', err);
    child.kill('SIGTERM');
    pool.end();
    process.exit(1);
});

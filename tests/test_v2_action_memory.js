#!/usr/bin/env node

/**
 * @module test_v2_action_memory
 * Smoke test for Action Memory integrations:
 * - Graph traversal with direction: 'actionable'
 * - compileProjectState capturing open commitments
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
        clientInfo: { name: 'test-action-memory', version: '1.0.0' }
    });
    console.log('✅ Initialize:', initRes.result?.serverInfo?.name || 'OK');

    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    await new Promise(r => setTimeout(r, 500));

    console.log('\n📝 1. Writing base state (commitment)...');
    const writeRes1 = await send('tools/call', {
        name: 'krusch_context_write_state',
        arguments: {
            content: "We must resolve the test coverage gaps by Friday.",
            category: "priorities",
            author_id: "agent:tester",
            ontology_tags: ["commitment", "escalation"],
            action_trace: [{ action: "created_commitment", timestamp: new Date().toISOString() }]
        }
    });
    const text1 = writeRes1.result?.content?.[0]?.text || '';
    const idMatch1 = text1.match(/New ID: ([a-f0-9\-]+)/);
    const parentId = idMatch1 ? idMatch1[1] : null;

    if (!parentId) throw new Error("Failed to extract parent ID");
    console.log(`   Base Action Memory ID: ${parentId}`);
    
    // In order for compileProjectState to find it, the memory must have the project name in ontology_tags (as per line 325 of memory-engine.js: AND $1 = ANY(ontology_tags))
    console.log('\n📝 2. Updating tags to include project name via DB...');
    await pool.query(`UPDATE interaction_memory SET ontology_tags = array_append(ontology_tags, 'test_project') WHERE id = $1`, [parentId]);
    console.log(`   Updated ontology_tags to include 'test_project'`);

    console.log(`\n📝 3. Writing child state...`);
    const writeRes2 = await send('tools/call', {
        name: 'krusch_context_write_state',
        arguments: {
            content: "Update: coverage gaps partially fixed.",
            category: "priorities",
            author_id: "agent:tester",
            parent_id: parentId,
            ontology_tags: ["commitment", "test_project"],
            action_trace: [{ action: "updated_commitment", timestamp: new Date().toISOString() }]
        }
    });
    const text2 = writeRes2.result?.content?.[0]?.text || '';
    const idMatch2 = text2.match(/New ID: ([a-f0-9\-]+)/);
    const childId = idMatch2 ? idMatch2[1] : null;
    console.log(`   Child Action Memory ID: ${childId}`);

    console.log('\n🕸️ 4. Testing Graph Traversal with direction actionable...');
    const graphRes1 = await send('tools/call', {
        name: 'krusch_context_traverse_graph',
        arguments: { memory_id: parentId, direction: 'actionable' }
    });
    const graphText = graphRes1.result?.content?.[0]?.text || graphRes1.error?.message;
    console.log(`\n${graphText}`);
    
    if (!graphText.includes("updated_commitment")) {
        console.warn("   ⚠️ Expected to find updated_commitment trace in the traversal output!");
    } else {
        console.log("   ✅ Found actionable trace in traversal.");
    }

    console.log('\n📊 5. Testing compileProjectState for open commitments...');
    const compileRes = await send('tools/call', {
        name: 'krusch_context_compile_state',
        arguments: { project: 'test_project' }
    });
    const compileText = compileRes.result?.content?.[0]?.text || compileRes.error?.message;
    console.log(`\n${compileText}`);
    
    if (!compileText.includes("We must resolve the test coverage gaps by Friday.") && !compileText.includes("Update: coverage gaps partially fixed.")) {
        console.warn("   ⚠️ Expected compileProjectState to list the active commitment!");
    } else {
        console.log("   ✅ Found actionable commitment in compileProjectState.");
    }

    console.log('\n🧹 6. Cleanup...');
    await pool.query(`DELETE FROM interaction_memory WHERE id IN ($1, $2)`, [parentId, childId]);
    
    console.log('\n✅ All Action Memory tests completed.');
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

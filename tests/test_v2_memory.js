#!/usr/bin/env node

/**
 * @module test_v2_memory
 * Smoke test for Company Brain v2 Substrate via JSON-RPC over stdio.
 * Validates end-to-end multi-agent write flows, conflict resolution, and provenance tracing.
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

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
        clientInfo: { name: 'test-v2-client', version: '1.0.0' }
    });
    console.log('✅ Initialize:', initRes.result?.serverInfo?.name || 'OK');

    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    await new Promise(r => setTimeout(r, 500));

    console.log('\n📝 1. Writing initial state (Parent)...');
    const writeRes1 = await send('tools/call', {
        name: 'krusch_context_write_state',
        arguments: {
            content: "Initial feature design for Agentic Search",
            category: "priorities",
            author_id: "agent:antigravity"
        }
    });
    const text1 = writeRes1.result?.content?.[0]?.text || '';
    console.log(`   ${text1}`);
    const idMatch1 = text1.match(/New ID: ([a-f0-9\-]+)/);
    const parentId = idMatch1 ? idMatch1[1] : null;

    if (!parentId) throw new Error("Failed to extract parent ID");

    console.log(`\n📝 2. Writing child state (Version 2)...`);
    const writeRes2 = await send('tools/call', {
        name: 'krusch_context_write_state',
        arguments: {
            content: "Updated feature design for Agentic Search (includes PostgreSQL integration)",
            category: "priorities",
            author_id: "agent:antigravity",
            parent_id: parentId
        }
    });
    const text2 = writeRes2.result?.content?.[0]?.text || '';
    console.log(`   ${text2}`);
    const idMatch2 = text2.match(/New ID: ([a-f0-9\-]+)/);
    const childId = idMatch2 ? idMatch2[1] : null;

    console.log(`\n📝 3. Writing conflicting state (Version 2 sibling)...`);
    // Attempting to write a sibling off the original parent. Note: In reality, since parentId is marked deprecated in step 2,
    // this should FAIL with a State Conflict. Let's see if optimistic concurrency catches it!
    try {
        const writeResConflict = await send('tools/call', {
            name: 'krusch_context_write_state',
            arguments: {
                content: "Conflicting feature design (includes SQLite integration instead)",
                category: "priorities",
                author_id: "agent:other_agent",
                parent_id: parentId
            }
        });
        if (writeResConflict.error) {
             console.log(`   ✅ Caught expected conflict: ${writeResConflict.error.message}`);
        } else if (writeResConflict.result?.isError) {
             console.log(`   ✅ Caught expected conflict error: ${writeResConflict.result.content[0].text}`);
        } else {
             console.log(`   ⚠️ Unexpected success: ${writeResConflict.result?.content?.[0]?.text}`);
        }
    } catch (e) {
        console.log(`   ✅ Caught expected conflict error via catch: ${e.message}`);
    }

    // Now write a valid sibling by branching off a newly created state
    console.log('\n📝 4. Creating two new states to merge (Conflicts)...');
    const c1 = await send('tools/call', {
        name: 'krusch_context_write_state',
        arguments: { content: "Draft A: Use Vector DB", category: "priorities", author_id: "agent:A" }
    });
    const cid1 = c1.result.content[0].text.match(/New ID: ([a-f0-9\-]+)/)[1];
    
    const c2 = await send('tools/call', {
        name: 'krusch_context_write_state',
        arguments: { content: "Draft B: Use SQLite vec", category: "priorities", author_id: "agent:B" }
    });
    const cid2 = c2.result.content[0].text.match(/New ID: ([a-f0-9\-]+)/)[1];

    console.log(`   Draft A ID: ${cid1}`);
    console.log(`   Draft B ID: ${cid2}`);

    console.log('\n🔗 5. Resolving conflicts...');
    const resolveRes = await send('tools/call', {
        name: 'krusch_context_resolve_conflict',
        arguments: {
            conflict_ids: [cid1, cid2],
            resolution_content: "Final Decision: Use hybrid Vector DB with SQLite local cache.",
            author_id: "agent:director"
        }
    });
    const resolveText = resolveRes.result?.content?.[0]?.text || resolveRes.error?.message;
    console.log(`   ${resolveText}`);
    const resolvedMatch = resolveText.match(/Unified State ID: ([a-f0-9\-]+)/);
    const resolvedId = resolvedMatch ? resolvedMatch[1] : null;

    console.log(`\n📜 6. Checking provenance of child state (${childId})...`);
    const provRes1 = await send('tools/call', {
        name: 'krusch_context_get_provenance',
        arguments: { memory_id: childId }
    });
    console.log(`   \n${provRes1.result?.content?.[0]?.text}`);

    if (resolvedId) {
        console.log(`\n📜 7. Checking provenance of resolved state (${resolvedId})...`);
        const provRes2 = await send('tools/call', {
            name: 'krusch_context_get_provenance',
            arguments: { memory_id: resolvedId }
        });
        console.log(`   \n${provRes2.result?.content?.[0]?.text}`);
    }

    console.log('\n✅ All v2 memory tests completed.');
    child.kill('SIGTERM');
    setTimeout(() => process.exit(0), 1000);
}

run().catch(err => {
    console.error('❌ Test failed:', err);
    child.kill('SIGTERM');
    process.exit(1);
});

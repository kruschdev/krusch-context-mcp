#!/usr/bin/env node

/**
 * @module test_client
 * Smoke test for krusch-context-mcp via JSON-RPC over stdio.
 * Spawns the server, sends tool/list and a few tool/call requests, then exits.
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const SERVER = new URL('./src/index.js', import.meta.url).pathname;
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
        clientInfo: { name: 'test-client', version: '1.0.0' }
    });
    console.log('✅ Initialize:', initRes.result?.serverInfo?.name || 'OK');

    // Send initialized notification (no response expected)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    await new Promise(r => setTimeout(r, 500));

    // 1. List tools
    console.log('\n📋 Listing tools...');
    const toolsRes = await send('tools/list');
    const tools = toolsRes.result?.tools || [];
    console.log(`   Found ${tools.length} tools:`);
    for (const t of tools) {
        console.log(`   - ${t.name}`);
    }

    // 2. Test krusch_context_list_repos
    console.log('\n📦 Testing krusch_context_list_repos...');
    try {
        const reposRes = await send('tools/call', { name: 'krusch_context_list_repos', arguments: {} });
        const text = reposRes.result?.content?.[0]?.text || '';
        console.log(`   ${text.substring(0, 200)}`);
    } catch (e) {
        console.log(`   ⚠️ ${e.message}`);
    }

    // 2b. Test krusch_context_read_tree
    console.log('\n🌳 Testing krusch_context_read_tree...');
    try {
        const treeRes = await send('tools/call', { name: 'krusch_context_read_tree', arguments: { repository_id: 1 } });
        const text = treeRes.result?.content?.[0]?.text || '';
        console.log(`   ${text.substring(0, 200)}`);
    } catch (e) {
        console.log(`   ⚠️ ${e.message}`);
    }

    // 2c. Test krusch_context_read_blob (using a bogus sha to test error handling)
    console.log('\n📄 Testing krusch_context_read_blob...');
    try {
        const blobRes = await send('tools/call', { name: 'krusch_context_read_blob', arguments: { blob_id: '1234567890abcdef' } });
        const text = blobRes.result?.content?.[0]?.text || '';
        console.log(`   ${text.substring(0, 200)}`);
    } catch (e) {
        console.log(`   ⚠️ ${e.message}`);
    }

    // 3. Test list_memories
    console.log('\n📋 Testing krusch_context_list_memories...');
    try {
        const listRes = await send('tools/call', {
            name: 'krusch_context_list_memories',
            arguments: { category: 'lessons', limit: 3 }
        });
        const text = listRes.result?.content?.[0]?.text || '';
        console.log(`   ${text.substring(0, 300)}`);
    } catch (e) {
        console.log(`   ⚠️ ${e.message}`);
    }

    // 4. Test search (requires Ollama)
    console.log('\n🔍 Testing krusch_context_search_memory...');
    try {
        const searchRes = await send('tools/call', {
            name: 'krusch_context_search_memory',
            arguments: { category: 'lessons', query: 'MCP server architecture' }
        });
        const text = searchRes.result?.content?.[0]?.text || '';
        console.log(`   ${text.substring(0, 300)}`);
    } catch (e) {
        console.log(`   ⚠️ ${e.message}`);
    }

    // 5. Test krusch_context_nugget_remember
    console.log('\n💎 Testing krusch_context_nugget_remember...');
    try {
        const rememberRes = await send('tools/call', {
            name: 'krusch_context_nugget_remember',
            arguments: { key: '__test_nugget__', value: 'Test nugget from smoke test', kind: 'agent' }
        });
        const text = rememberRes.result?.content?.[0]?.text || '';
        console.log(`   ${text}`);
    } catch (e) {
        console.log(`   ⚠️ ${e.message}`);
    }

    // 6. Test krusch_context_nugget_nudges
    console.log('\n💎 Testing krusch_context_nugget_nudges...');
    try {
        const nudgesRes = await send('tools/call', {
            name: 'krusch_context_nugget_nudges',
            arguments: { query: 'test nugget smoke', limit: 2 }
        });
        const text = nudgesRes.result?.content?.[0]?.text || '';
        console.log(`   ${text.substring(0, 300)}`);
    } catch (e) {
        console.log(`   ⚠️ ${e.message}`);
    }

    // 7. Test krusch_context_nugget_list
    console.log('\n💎 Testing krusch_context_nugget_list...');
    try {
        const listNugRes = await send('tools/call', {
            name: 'krusch_context_nugget_list',
            arguments: { kinds: ['agent'] }
        });
        const text = listNugRes.result?.content?.[0]?.text || '';
        console.log(`   ${text.substring(0, 300)}`);
    } catch (e) {
        console.log(`   ⚠️ ${e.message}`);
    }

    // 8. Test krusch_context_nugget_forget (cleanup)
    console.log('\n💎 Testing krusch_context_nugget_forget...');
    try {
        const forgetRes = await send('tools/call', {
            name: 'krusch_context_nugget_forget',
            arguments: { key: '__test_nugget__' }
        });
        const text = forgetRes.result?.content?.[0]?.text || '';
        console.log(`   ${text}`);
    } catch (e) {
        console.log(`   ⚠️ ${e.message}`);
    }

    console.log('\n✅ All tests completed.');
    child.kill('SIGTERM');
    setTimeout(() => process.exit(0), 1000);
}

run().catch(err => {
    console.error('❌ Test failed:', err);
    child.kill('SIGTERM');
    process.exit(1);
});

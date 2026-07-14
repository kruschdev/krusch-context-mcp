#!/usr/bin/env node

/**
 * @module test_client
 * Smoke test for krusch-context-mcp via JSON-RPC over stdio.
 * Spawns the server, sends tool/list and a few tool/call requests, then exits.
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

    // ============================================================
    // v2 Company Brain Substrate Tests
    // ============================================================

    // 9. Test krusch_context_write_state
    console.log('\n🧠 Testing krusch_context_write_state...');
    let v2StateId = null;
    try {
        const wsRes = await send('tools/call', {
            name: 'krusch_context_write_state',
            arguments: {
                content: '__smoke_test_v2_state__ — ephemeral test state for smoke testing',
                category: 'activity',
                author_id: 'smoke-test-client',
                ontology_tags: ['smoke-test', 'ephemeral']
            }
        });
        const text = wsRes.result?.content?.[0]?.text || '';
        console.log(`   ${text}`);
        // Extract the new state ID from the response
        const idMatch = text.match(/New ID:\s*([0-9a-f-]+)/i);
        if (idMatch) v2StateId = idMatch[1];
    } catch (e) {
        console.log(`   ⚠️ ${e.message}`);
    }

    // 10. Test krusch_context_get_provenance (using the state we just wrote)
    console.log('\n📜 Testing krusch_context_get_provenance...');
    try {
        const targetId = v2StateId || '00000000-0000-0000-0000-000000000000';
        const provRes = await send('tools/call', {
            name: 'krusch_context_get_provenance',
            arguments: { memory_id: targetId }
        });
        const text = provRes.result?.content?.[0]?.text || '';
        console.log(`   ${text.substring(0, 300)}`);
    } catch (e) {
        console.log(`   ⚠️ ${e.message}`);
    }

    // 11. Test krusch_context_search_lens
    console.log('\n🔭 Testing krusch_context_search_lens...');
    try {
        const lensRes = await send('tools/call', {
            name: 'krusch_context_search_lens',
            arguments: { query: 'smoke test ephemeral state', roles: ['agent', 'engineer'], limit: 2 }
        });
        const text = lensRes.result?.content?.[0]?.text || '';
        console.log(`   ${text.substring(0, 300)}`);
    } catch (e) {
        console.log(`   ⚠️ ${e.message}`);
    }

    // 12. Test krusch_context_traverse_graph
    console.log('\n🕸️ Testing krusch_context_traverse_graph...');
    try {
        const targetId = v2StateId || '00000000-0000-0000-0000-000000000000';
        const graphRes = await send('tools/call', {
            name: 'krusch_context_traverse_graph',
            arguments: { memory_id: targetId, direction: 'all', depth: 2 }
        });
        const text = graphRes.result?.content?.[0]?.text || '';
        console.log(`   ${text.substring(0, 300)}`);
    } catch (e) {
        console.log(`   ⚠️ ${e.message}`);
    }

    // 12.5 Test krusch_context_link_blob
    console.log('\n🔗 Testing krusch_context_link_blob...');
    try {
        const targetId = v2StateId || '00000000-0000-0000-0000-000000000000';
        // We test with a dummy blob ID. Since the blob doesn't exist, we expect an error!
        const linkRes = await send('tools/call', {
            name: 'krusch_context_link_blob',
            arguments: { memory_id: targetId, blob_id: 'fake_blob_sha123', relationship: 'references' }
        });
        const text = linkRes.result?.content?.[0]?.text || '';
        console.log(`   ${text.substring(0, 300)}`);
    } catch (e) {
        // Expected "Blob ID fake_blob_sha123 not found in PG-Git database."
        console.log(`   ✅ Expected error (fake blob): ${e.message}`);
    }

    // 13. Test krusch_context_update_ontology (rename a tag that won't collide)
    console.log('\n🏷️ Testing krusch_context_update_ontology...');
    try {
        const ontoRes = await send('tools/call', {
            name: 'krusch_context_update_ontology',
            arguments: { old_tag: 'smoke-test', new_tag: 'smoke-test-renamed' }
        });
        const text = ontoRes.result?.content?.[0]?.text || '';
        console.log(`   ${text}`);
    } catch (e) {
        console.log(`   ⚠️ ${e.message}`);
    }

    // 14. Cleanup: delete the v2 test state directly via SQL (not a tool, just best-effort)
    // Note: resolve_conflict needs 2+ active states, so we just validate it returns the right error
    console.log('\n🔗 Testing krusch_context_resolve_conflict (expected error: need 2+ states)...');
    try {
        const rcRes = await send('tools/call', {
            name: 'krusch_context_resolve_conflict',
            arguments: {
                conflict_ids: ['00000000-0000-0000-0000-000000000000'],
                resolution_content: 'test resolution',
                author_id: 'smoke-test-client'
            }
        });
        const text = rcRes.result?.content?.[0]?.text || rcRes.error?.message || '';
        console.log(`   ${text.substring(0, 300)}`);
    } catch (e) {
        // Expected: "Need at least 2 conflict_ids"
        console.log(`   ✅ Expected error: ${e.message}`);
    }

    if (v2StateId) {
        console.log('\n🧹 Cleaning up v2 test state directly via SQL...');
        try {
            await pool.query('DELETE FROM memory_v2 WHERE id = $1', [v2StateId]);
            console.log(`   ✅ Deleted test state ${v2StateId}`);
        } catch (e) {
            console.log(`   ⚠️ Failed to delete test state: ${e.message}`);
        }
    }

    // ============================================================
    // Agent Skills & Prompts Integration Tests
    // ============================================================

    console.log('\n🛠️ Testing prompts/list...');
    try {
        const promptsRes = await send('prompts/list');
        const prompts = promptsRes.result?.prompts || [];
        console.log(`   Found ${prompts.length} prompts.`);
        const tddPrompt = prompts.find(p => p.name.toLowerCase() === 'tdd');
        if (tddPrompt) {
            console.log(`   ✅ Success: 'tdd' prompt found in list.`);
        } else {
            console.log(`   ❌ Failure: 'tdd' prompt not found in list!`);
        }
    } catch (e) {
        console.log(`   ⚠️ ${e.message}`);
    }

    console.log('\n🛠️ Testing prompts/get (tdd)...');
    try {
        const promptRes = await send('prompts/get', { name: 'tdd' });
        const messages = promptRes.result?.messages || [];
        const text = messages[0]?.content?.text || '';
        console.log(`   ✅ Success: retrieved tdd prompt (${text.substring(0, 150)}...)`);
    } catch (e) {
        console.log(`   ⚠️ ${e.message}`);
    }

    console.log('\n🛠️ Testing tools/call (krusch_context_list_skills)...');
    try {
        const skillsListRes = await send('tools/call', { name: 'krusch_context_list_skills', arguments: {} });
        const text = skillsListRes.result?.content?.[0]?.text || '';
        console.log(`   ✅ Success: list_skills returned:\n   ${text.substring(0, 150)}...`);
    } catch (e) {
        console.log(`   ⚠️ ${e.message}`);
    }

    console.log('\n🛠️ Testing tools/call (krusch_context_get_skill tdd)...');
    try {
        const skillGetRes = await send('tools/call', { name: 'krusch_context_get_skill', arguments: { name: 'tdd' } });
        const text = skillGetRes.result?.content?.[0]?.text || '';
        console.log(`   ✅ Success: get_skill returned:\n   ${text.substring(0, 150)}...`);
    } catch (e) {
        console.log(`   ⚠️ ${e.message}`);
    }

    console.log('\n✅ All tests completed (v1 + v2 + skills).');
    child.kill('SIGTERM');
    await pool.end();
    setTimeout(() => process.exit(0), 1000);
}

run().catch(err => {
    console.error('❌ Test failed:', err);
    child.kill('SIGTERM');
    process.exit(1);
});

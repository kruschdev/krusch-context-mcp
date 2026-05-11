import test from 'node:test';
import assert from 'node:assert';
import { getRepoRootTree, getTreeEntries, getBlob } from 'pg-git-mcp/server/git-engine.js';
import { consolidateMemories } from '../src/memory-engine.js';
import { writeState, resolveConflict } from '../src/v2-engine.js';
import { pool } from 'pg-git-mcp/db/pool.js';

test('Integration Test Suite for krusch-context-mcp tools', async (t) => {
    
    // We assume the DB has at least one repository and some memories for integration testing
    let testRepoId = null;
    let rootTreeId = null;

    await t.test('should retrieve repository root tree', async () => {
        const res = await pool.query('SELECT id FROM repositories LIMIT 1');
        if (res.rows.length === 0) {
            console.log('Skipping: No repositories found in db');
            return;
        }
        testRepoId = res.rows[0].id;
        rootTreeId = await getRepoRootTree(testRepoId);
        assert.ok(rootTreeId, 'Root tree ID should not be null');
        assert.strictEqual(typeof rootTreeId, 'string', 'Root tree ID should be a string');
    });

    await t.test('should list tree entries', async () => {
        if (!rootTreeId) return;
        const entries = await getTreeEntries(rootTreeId);
        assert.ok(Array.isArray(entries), 'Tree entries should be an array');
        if (entries.length > 0) {
            assert.ok(entries[0].name, 'Entry should have a name');
            assert.ok(entries[0].type, 'Entry should have a type');
            assert.ok(entries[0].object_id, 'Entry should have an object_id');
        }
    });

    await t.test('should fetch a blob content', async () => {
        if (!rootTreeId) return;
        const entries = await getTreeEntries(rootTreeId);
        const blobEntry = entries.find(e => e.type === 'blob');
        if (!blobEntry) return;

        const blob = await getBlob(blobEntry.object_id);
        assert.ok(blob, 'Blob should be retrieved');
        if (blob.content !== null) {
            const contentStr = blob.content.toString('utf-8');
            assert.ok(contentStr.length >= 0, 'Content string should have length');
        }
    });

    await t.test('should simulate consolidateMemories (dry run)', async () => {
        const res = await consolidateMemories({
            category: 'lessons',
            threshold: 0.15,
            dry_run: true
        });
        assert.ok(res.content, 'Consolidate should return content');
        const text = res.content[0].text;
        assert.ok(text.includes('Consolidation Preview') || text.includes('No duplicate'), 'Should specify preview or no duplicates in output');
    });

    await t.test('should write state and resolve conflicts (v2 schema)', async () => {
        // Write state A
        const resA = await writeState({
            content: "Testing state A for conflict resolution",
            category: "activity",
            author_id: "agent:test"
        });
        assert.ok(resA.content[0].text.includes('New ID:'), 'Should return New ID for state A');
        const idA = resA.content[0].text.match(/New ID: ([0-9a-fA-F-]+)/)[1];

        // Write state B
        const resB = await writeState({
            content: "Testing state B for conflict resolution",
            category: "activity",
            author_id: "agent:test"
        });
        assert.ok(resB.content[0].text.includes('New ID:'), 'Should return New ID for state B');
        const idB = resB.content[0].text.match(/New ID: ([0-9a-fA-F-]+)/)[1];

        // Resolve conflicts
        const resResolve = await resolveConflict({
            conflict_ids: [idA, idB],
            resolution_content: "Resolved state AB",
            author_id: "agent:test"
        });
        assert.ok(resResolve.content[0].text.includes('Unified State ID:'), 'Should return Unified State ID');
        const unifiedId = resResolve.content[0].text.match(/Unified State ID: ([0-9a-fA-F-]+)/)[1];
        
        // Verify old states are deprecated
        const checkRes = await pool.query('SELECT id, status FROM homelab_memory_v2 WHERE id IN ($1, $2, $3)', [idA, idB, unifiedId]);
        
        const stateA = checkRes.rows.find(r => r.id === idA);
        const stateB = checkRes.rows.find(r => r.id === idB);
        const stateUnified = checkRes.rows.find(r => r.id === unifiedId);

        assert.strictEqual(stateA.status, 'deprecated', 'State A should be deprecated');
        assert.strictEqual(stateB.status, 'deprecated', 'State B should be deprecated');
        assert.strictEqual(stateUnified.status, 'active', 'Unified state should be active');

        // Cleanup
        await pool.query('DELETE FROM memory_to_blob_edges WHERE memory_id IN ($1, $2, $3)', [idA, idB, unifiedId]);
        await pool.query('DELETE FROM homelab_memory_v2 WHERE id IN ($1, $2, $3)', [idA, idB, unifiedId]);
    });
    
    // Cleanup pool
    t.after(async () => {
        await pool.end();
    });
});

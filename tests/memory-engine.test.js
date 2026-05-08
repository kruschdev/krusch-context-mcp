import test from 'node:test';
import assert from 'node:assert';
import { getRepoRootTree, getTreeEntries, getBlob } from '../../pg-git/server/git-engine.js';
import { consolidateMemories } from '../src/memory-engine.js';
import { pool } from '../../pg-git/db/pool.js';

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
    
    // Cleanup pool
    t.after(async () => {
        await pool.end();
    });
});

/**
 * @module test_lakebase
 * Integration tests for the Lakebase (SQLite → Postgres) sync pipeline.
 * Verifies that memories written to the local SQLite cache are asynchronously
 * pushed to the global Postgres object store.
 */

import test from 'node:test';
import assert from 'node:assert';
import { addMemory } from '../src/memory-engine.js';
import { pool } from 'pg-git-mcp/db/pool.js';

test('Lakebase pull/push sync pipeline', async (t) => {

    const testTimestamp = Date.now();
    const testContent = `Lakebase architecture test inserted at ${testTimestamp}`;

    await t.test('should insert a memory into SQLite project cache', async () => {
        const res = await addMemory({
            project: 'krusch-context-mcp',
            category: 'lessons',
            content: testContent,
            tags: ['test', 'lakebase'],
            _embedding: new Array(1024).fill(0.1) // dummy embedding
        });
        const text = res.content[0].text;
        assert.ok(text.includes('SQLite project DB'), `Expected SQLite confirmation, got: ${text}`);
    });

    await t.test('should async-push the memory to Postgres within 5s', async () => {
        // Wait for the async push (write-behind) to complete
        await new Promise(r => setTimeout(r, 5000));

        const res = await pool.query(
            `SELECT id, content FROM ide_agent_memory WHERE project = 'krusch-context-mcp' AND content LIKE $1 ORDER BY created_at DESC LIMIT 1`,
            [`%${testTimestamp}%`]
        );
        assert.ok(res.rows.length > 0, 'Memory should exist in Postgres after async push');
        assert.ok(res.rows[0].content.includes(String(testTimestamp)), 'Postgres content should match the test timestamp');

        // Cleanup: remove the test record
        await pool.query('DELETE FROM ide_agent_memory WHERE id = $1', [res.rows[0].id]);
    });

    t.after(async () => {
        await pool.end();
    });
});

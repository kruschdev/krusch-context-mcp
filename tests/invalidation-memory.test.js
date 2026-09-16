/**
 * @module test_invalidation_memory
 * Unit and integration tests for MobileMem Temporal Fact Superseding and Invalidation (arXiv: 2608.13606).
 */

import test from 'node:test';
import assert from 'node:assert';
import { addMemory, searchMemory, supersedeMemory, invalidateMemory } from '../src/memory-engine.js';
import { getProjectDb } from '../src/sqlite-engine.js';
import { pool } from 'pg-git-mcp/db/pool.js';

const mockEmbedding = new Array(1024).fill(0.1);
const testProject = 'krusch-nexus';
const runId = Date.now();
const keywordMarker = `rule_${runId}`;

test('MobileMem Memory Invalidation & Superseding Engine', async (t) => {
    let initialId = null;
    let newId = null;

    await t.test('1. Should add an initial fact', async () => {
        const res = await addMemory({
            category: 'lessons',
            content: `Initial Rate Rule (${keywordMarker}): Hourly rate for ad-hoc maintenance is $45/hour.`,
            project: testProject,
            tags: ['billing', 'rates', 'v1'],
            _embedding: mockEmbedding
        });
        assert.ok(res.content[0].text.includes('Successfully saved memory to SQLite'));

        const db = await getProjectDb(testProject);
        const row = db.prepare(`SELECT id FROM ide_agent_memory WHERE content LIKE ? ORDER BY id DESC LIMIT 1`).get(`%${keywordMarker}%`);
        assert.ok(row, 'Row should be in SQLite');
        initialId = row.id;
    });

    await t.test('2. Should supersede the initial fact with updated knowledge', async () => {
        const supersedeRes = await addMemory({
            category: 'lessons',
            content: `Updated Rate Rule (${keywordMarker}): Hourly rate for ad-hoc maintenance is $50/hour as of August 2026.`,
            project: testProject,
            tags: ['billing', 'rates', 'v2'],
            supersedes_id: initialId,
            _embedding: mockEmbedding
        });

        assert.ok(supersedeRes.content[0].text.includes('supersedes ID'), 'Should confirm superseding');

        // Verify status in DB
        const db = await getProjectDb(testProject);
        const oldRow = db.prepare("SELECT status, superseded_by FROM ide_agent_memory WHERE id = ?").get(initialId);
        assert.strictEqual(oldRow.status, 'SUPERSEDED');
        assert.ok(oldRow.superseded_by, 'Should point to the new superseded_by ID');
        newId = oldRow.superseded_by;
    });

    await t.test('3. Search should exclude SUPERSEDED records by default', async () => {
        const res = await searchMemory({
            category: 'lessons',
            query: keywordMarker,
            project: testProject,
            active_project: testProject,
            search_type: 'keyword',
            limit: 5,
            include_superseded: false,
            _embedding: mockEmbedding
        });

        const text = res.content[0].text;
        assert.ok(text.includes('$50/hour'), 'Should contain the active v2 fact');
        assert.ok(!text.includes('$45/hour'), 'Should NOT contain the superseded $45/hour fact');
    });

    await t.test('4. Search should include SUPERSEDED records when include_superseded=true', async () => {
        const res = await searchMemory({
            category: 'lessons',
            query: keywordMarker,
            project: testProject,
            active_project: testProject,
            search_type: 'keyword',
            limit: 5,
            include_superseded: true,
            _embedding: mockEmbedding
        });

        const text = res.content[0].text;
        assert.ok(text.includes('$50/hour'), 'Should contain the active fact');
        assert.ok(text.includes('$45/hour'), 'Should contain the superseded fact when audit mode requested');
        assert.ok(text.includes('[SUPERSEDED]'), 'Should badge superseded status');
    });

    await t.test('5. Should invalidate a fact and exclude it from active retrieval', async () => {
        const invRes = await invalidateMemory({
            id: newId,
            project: testProject,
            reason: 'Deprecated by user policy'
        });

        assert.ok(invRes.content[0].text.includes('INVALIDATED'));

        // Search again with active filter
        const searchAfterInv = await searchMemory({
            category: 'lessons',
            query: keywordMarker,
            project: testProject,
            active_project: testProject,
            search_type: 'keyword',
            limit: 5,
            include_superseded: false,
            _embedding: mockEmbedding
        });

        assert.ok(
            searchAfterInv.content[0].text.includes('No active results found') ||
            !searchAfterInv.content[0].text.includes('$50/hour'),
            'Invalidated fact should not be retrieved'
        );
    });

    t.after(async () => {
        await pool.end();
    });
});

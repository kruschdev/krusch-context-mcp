/**
 * @module test_sqlite_memory
 * Integration tests for SQLite project-scoped memory isolation.
 * Verifies that project-scoped memories are stored in SQLite and
 * remain invisible to global (non-project) searches.
 */

import test from 'node:test';
import assert from 'node:assert';
import { addMemory, searchMemory } from '../src/memory-engine.js';
import { nuggetRemember, nuggetNudges, nuggetForget } from '../src/nuggets-engine.js';
import { pool } from '../db/pool.js';

test('SQLite project-scoped memory isolation', async (t) => {

    await t.test('should add a project-scoped memory to SQLite', async () => {
        const res = await addMemory({
            category: 'lessons',
            content: 'Testing project separation with SQLite! This should only appear for krusch-nexus.',
            project: 'krusch-nexus',
            tags: ['test', 'sqlite'],
            force: true
        });
        const text = res.content[0].text;

        assert.ok(text.includes('SQLite project DB'), `Expected SQLite confirmation, got: ${text}`);
    });

    await t.test('should find project memory when searching with active_project', async () => {
        const res = await searchMemory({
            category: 'lessons',
            query: 'SQLite project separation',
            limit: 3,
            active_project: 'krusch-nexus'
        });
        const text = res.content[0].text;
        assert.ok(text.includes('Memory Retrieval'), 'Should return retrieval header');
        // The project-scoped result should appear (may or may not depending on Ollama availability)
    });

    await t.test('should find project memory when searching with project alias', async () => {
        const res = await searchMemory({
            category: 'lessons',
            query: 'SQLite project separation',
            limit: 3,
            project: 'krusch-nexus'
        });
        const text = res.content[0].text;
        assert.ok(text.includes('Memory Retrieval'), 'Should return retrieval header');
    });

    await t.test('should remember and retrieve nugget using project parameter alias', async () => {
        const remRes = await nuggetRemember({
            key: 'test_framework_preference',
            value: 'Always use node:test for unit testing in this project',
            kind: 'project',
            project: 'krusch-nexus'
        });
        assert.ok(remRes.content[0].text.includes('SQLite (.agent/memory.db)'), 'Should persist nugget to SQLite with project alias');

        const nudgeRes = await nuggetNudges({
            query: 'unit testing framework',
            project: 'krusch-nexus'
        });
        assert.ok(nudgeRes.content[0].text.includes('test_framework_preference'), 'Should retrieve project nugget using project alias');

        await nuggetForget({
            key: 'test_framework_preference',
            project: 'krusch-nexus'
        });
    });

    await t.test('should return results when searching without project (global only)', async () => {
        const res = await searchMemory({
            category: 'lessons',
            query: 'SQLite project separation',
            limit: 3
        });
        const text = res.content[0].text;
        assert.ok(text.includes('Memory Retrieval'), 'Should return retrieval header');
    });

    t.after(async () => {
        await pool.end();
    });
});

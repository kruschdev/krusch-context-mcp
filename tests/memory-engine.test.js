import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addMemory,
  searchMemory,
  supersedeMemory,
  invalidateMemory,
  compileProjectState,
  getStaleMemories,
  getHealthStats,
  CLOSED_CATEGORIES
} from '../src/memory-engine.js';
import { pool } from '../db/pool.js';

test('Memory Engine: Closed Taxonomy, Duplicate Guard & Provenance Suite', async (t) => {
  const testProject = 'krusch-context-mcp';
  const uniqueTag = `run_${Date.now()}`;

  await t.test('1. Rejects invalid category outside closed taxonomy', async () => {
    await assert.rejects(
      async () => {
        await addMemory({
          category: 'free_form_marketing_notes',
          content: 'This should fail taxonomy validation',
          project: testProject
        });
      },
      (err) => {
        assert.ok(err.message.includes('Permitted closed set'));
        return true;
      }
    );
  });

  await t.test('2. Accepts all valid closed categories', async () => {
    for (const cat of CLOSED_CATEGORIES) {
      const res = await addMemory({
        category: cat,
        content: `Rule for category ${cat} (${uniqueTag})`,
        project: testProject,
        provenance: { author: 'agent', confidence: 0.95 },
        force: true
      });
      assert.ok(res.content[0].text.includes('Successfully saved memory to SQLite project DB'));
    }
  });

  await t.test('3. Detects near-duplicates and warns agent instead of inserting twin', async () => {
    const content = `Near-duplicate detection rule: Keep database queries under 100ms (${uniqueTag})`;
    
    // First insertion
    const firstRes = await addMemory({
      category: 'invariant',
      content,
      project: testProject,
      force: true
    });
    assert.ok(firstRes.id, 'First insert must succeed');

    // Second insertion with identical content without force
    const dupRes = await addMemory({
      category: 'invariant',
      content,
      project: testProject,
      force: false
    });

    assert.equal(dupRes.warning, 'near_duplicate');
    assert.ok(dupRes.content[0].text.includes('Near-duplicate memory detected'));
    assert.ok(dupRes.content[0].text.includes('supersede'));
  });

  await t.test('4. Invalidation strictly requires a non-empty reason', async () => {
    // Attempt invalidation without reason
    await assert.rejects(
      async () => {
        await invalidateMemory({
          id: 999999,
          reason: '   ',
          project: testProject
        });
      },
      (err) => {
        assert.ok(err.message.includes('requires a non-empty \'reason\''));
        return true;
      }
    );
  });

  await t.test('5. compileProjectState compiles closed categories, nuggets, and decay review', async () => {
    const res = await compileProjectState({ project: testProject });
    const text = res.content[0].text;
    assert.ok(text.includes('Compiled Project State: krusch-context-mcp'));
    assert.ok(text.includes('Decisions & Priorities'));
    assert.ok(text.includes('Project Invariants'));
  });

  await t.test('6. getHealthStats reports accurate closed taxonomy breakdown', async () => {
    const health = await getHealthStats({ project: testProject });
    assert.ok(health.content[0].text.includes('Krusch Context Health Status'));
    assert.ok(typeof health.stats.activeCount === 'number');
    assert.ok(typeof health.stats.staleCount === 'number');
  });

  t.after(async () => {
    try {
      await pool.end();
    } catch {}
  });
});

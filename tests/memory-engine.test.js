import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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
import { closeAllDatabases } from '../src/sqlite-engine.js';
import { pool } from '../db/pool.js';

test('Memory Engine: Closed Taxonomy, Duplicate Guard & Provenance Suite', async (t) => {
  const uniqueTag = `run_${Date.now()}`;
  const testProject = `test_mem_${uniqueTag}`;

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
    assert.ok(text.includes(`Compiled Project State: ${testProject}`));
    assert.ok(text.includes('Decisions & Priorities'));
    assert.ok(text.includes('Project Invariants'));
  });

  await t.test('6. getHealthStats reports accurate closed taxonomy breakdown', async () => {
    const health = await getHealthStats({ project: testProject });
    assert.ok(health.content[0].text.includes('Krusch Context Health Status'));
    assert.ok(typeof health.stats.activeCount === 'number');
    assert.ok(typeof health.stats.staleCount === 'number');
  });

  await t.test('7. KruschNexus INV-12 Span-Grounded Provenance: auto-healing vs drift detection', async () => {
    const { resolveProjectPath } = await import('../src/sqlite-engine.js');
    const { handleProactiveNudge } = await import('../src/proactive-engine.js');
    const projRoot = resolveProjectPath(testProject);
    fs.mkdirSync(projRoot, { recursive: true });
    const fixtureFile = path.join(projRoot, 'config.js');

    // Step A: Write initial file and anchor an invariant with verbatim quoted_sentence
    fs.writeFileSync(fixtureFile, `// App Config\nexport const MAX_POOL_SIZE = 20;\nexport const TIMEOUT_MS = 5000;\n`, 'utf8');

    const memRes = await addMemory({
      category: 'invariant',
      content: 'Database pool size must remain capped at 20 connections.',
      project: testProject,
      provenance: {
        file: 'config.js',
        locator: 'Pool Limits',
        quoted_sentence: 'export const MAX_POOL_SIZE = 20;'
      },
      force: true,
      _embedding: new Array(1024).fill(0.05)
    });
    assert.ok(memRes.id);

    let health = await getHealthStats({ project: testProject });
    assert.equal(health.stats.anchoredCount, 1);
    assert.equal(health.stats.driftedCount, 0);

    // Step B: Edit file above the quote (shifts line from L2 to L4), quote stays verbatim -> Auto-Heal!
    fs.writeFileSync(fixtureFile, `// App Config\n// Added header comment\n// Another comment\nexport const MAX_POOL_SIZE = 20;\nexport const TIMEOUT_MS = 5000;\n`, 'utf8');

    health = await getHealthStats({ project: testProject });
    assert.equal(health.stats.anchoredCount, 1);
    assert.equal(health.stats.driftedCount, 0, 'Unchanged verbatim quote must auto-heal across line shifts');

    // Step C: Mutate the anchored line -> Flags STALE_DRIFT (is_drifted = true)!
    fs.writeFileSync(fixtureFile, `// App Config\nexport const MAX_POOL_SIZE = 100;\nexport const TIMEOUT_MS = 5000;\n`, 'utf8');

    health = await getHealthStats({ project: testProject });
    assert.equal(health.stats.driftedCount, 1, 'Mutated quoted_sentence must flag memory as drifted');

    const stateRes = await compileProjectState({ project: testProject });
    assert.ok(stateRes.content[0].text.includes('Span-Grounded Drift Review'));
    assert.ok(stateRes.content[0].text.includes('DRIFTED: config.js'));

    // Step D: Proactive nudge deterministically matches file_path anchor
    const nudgeRes = await handleProactiveNudge({
      trigger: 'pre_commit',
      file_path: 'config.js',
      code: 'export const MAX_POOL_SIZE = 100;',
      project: testProject
    });
    assert.ok(nudgeRes.content[0].text.includes('DRIFTED: config.js'));
  });

  t.after(async () => {
    closeAllDatabases();
    try {
      fs.rmSync(path.join(os.homedir(), '.krusch-context', 'projects', testProject), { recursive: true, force: true });
    } catch {}
    try {
      await pool.end();
    } catch {}
  });
});

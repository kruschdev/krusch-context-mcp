import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addMemory, invalidateMemory } from '../src/memory-engine.js';
import { unifiedRetrieve } from '../src/unified-retrieval.js';
import { getSqliteDb } from '../src/storage-adapter.js';

describe('Offline Smoke Test Suite (Zero-Docker, Zero-Embedding-Service)', () => {
  const testProject = `smoke_test_${Date.now()}`;
  const dummyEmbedding = new Array(1024).fill(0.05);

  it('1. remember invariant -> retrieve finds it', async () => {
    const invariantText = `Invariant: Always validate user permissions before executing financial transactions.`;

    const rememberRes = await addMemory({
      category: 'invariant',
      content: invariantText,
      project: testProject,
      force: true,
      _embedding: dummyEmbedding
    });

    assert.ok(rememberRes.id, 'Memory must be assigned an ID upon insertion');

    // Retrieve via unifiedRetrieve with query matching keyword
    const retrieveRes = await unifiedRetrieve({
      query: 'permissions financial transactions',
      mode: 'memory',
      category: 'invariant',
      project: testProject,
      _embedding: dummyEmbedding
    });

    assert.ok(retrieveRes.content[0].text.includes('permissions before executing financial transactions'), 
      'Retrieved text must include the remembered invariant');
    assert.ok(retrieveRes.citations && retrieveRes.citations.length > 0, 
      'Retrieve must include structured citations');
  });

  it('2. revise invalidate with empty reason -> throws error', async () => {
    // Attempt invalidation with empty/whitespace reason
    await assert.rejects(
      async () => {
        await invalidateMemory({
          id: 1,
          reason: '   ',
          project: testProject
        });
      },
      (err) => {
        assert.ok(err.message.includes("requires a non-empty 'reason'"),
          `Expected reason error, got: ${err.message}`);
        return true;
      }
    );
  });

  it('3. remember near-dup -> returns candidate id + supersede suggestion without blocking', async () => {
    const projectDup = `smoke_dup_${Date.now()}`;
    const dupEmbedding = new Array(1024).fill(0).map((_, i) => i === 0 ? 1.0 : 0.0);
    const text = 'Near-duplicate invariant: Service workers must register within 500ms of boot.';

    // Insert first record
    const firstRes = await addMemory({
      category: 'invariant',
      content: text,
      project: projectDup,
      force: true,
      _embedding: dupEmbedding
    });
    assert.ok(firstRes.id, 'First insert must succeed');

    // Insert second identical record without force: true
    const dupRes = await addMemory({
      category: 'invariant',
      content: text,
      project: projectDup,
      force: false,
      _embedding: dupEmbedding
    });

    // Must return candidate id, warning, and supersede suggestion
    assert.equal(dupRes.warning, 'near_duplicate', 'Must return near_duplicate warning');
    assert.equal(dupRes.candidate_id, firstRes.id, 'Must reference the first record ID as candidate');
    assert.ok(dupRes.similarity >= 0.85, 'Cosine similarity must meet or exceed 0.85 threshold');
    assert.ok(dupRes.suggested_action, 'Must provide suggested action');
    assert.equal(dupRes.suggested_action.action, 'supersede', 'Suggested action must be supersede');
    assert.equal(dupRes.suggested_action.target_id, firstRes.id, 'Suggested action target must be candidate ID');
    assert.ok(dupRes.id, 'Non-blocking: must assign new ID and not abort the write');
  });
});

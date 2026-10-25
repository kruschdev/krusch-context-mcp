import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { addMemory, backfillMissingEmbeddings } from '../src/memory-engine.js';
import {
  getProjectDb,
  resolveProjectPath,
  closeAllDatabases,
  encodeEmbeddingBlob,
  decodeEmbeddingBlob,
  getParsedEmbedding,
  searchMemoryFts,
  withTransaction
} from '../src/sqlite-engine.js';
import { unifiedRetrieve, detectTemporalUpdates } from '../src/unified-retrieval.js';
import { computeCorpusUnattestedTerms } from '../src/retrieval-epistemic.js';
import { pool } from '../db/pool.js';

function makeUnitVec(sharedWeight, uniqueIdx, dim = 1024) {
  const v = new Array(dim).fill(0);
  v[0] = sharedWeight;
  v[uniqueIdx % dim] = Math.sqrt(Math.max(0, 1 - sharedWeight * sharedWeight));
  return v;
}

test('Phase 2 (v1.9.0) Retrieval, FTS5 Scale, Binary Embeddings & Epistemic Suite', async (t) => {
  const runId = Date.now();
  const blobProj = `test_v190_blob_${runId}`;
  const ftsProj = `test_v190_fts_${runId}`;
  const kuProj = `test_v190_ku_${runId}`;
  const rankProj = `test_v190_rank_${runId}`;
  const groundProj = `test_v190_ground_${runId}`;

  await t.test('1. Binary Float32 embedding_blob: unaligned slice safety, persistence, and zero-JSON decode', async () => {
    const orig = Array.from({ length: 1024 }, (_, i) => Math.sin(i * 0.05));
    const encoded = encodeEmbeddingBlob(orig);
    assert.ok(encoded instanceof Uint8Array);
    assert.equal(encoded.byteLength, 1024 * 4);

    // Simulate unaligned SQLite Buffer slice (byteOffset % 4 !== 0)
    const padded = Buffer.alloc(encoded.byteLength + 7);
    Buffer.from(encoded.buffer, encoded.byteOffset, encoded.byteLength).copy(padded, 3);
    const unalignedSlice = padded.subarray(3, 3 + encoded.byteLength);
    assert.notEqual(unalignedSlice.byteOffset % 4, 0, 'Test slice must be intentionally 4-byte unaligned');

    const decoded = decodeEmbeddingBlob(unalignedSlice);
    assert.ok(decoded instanceof Float32Array);
    assert.equal(decoded.length, 1024);
    for (let i = 0; i < 32; i++) {
      assert.ok(Math.abs(decoded[i] - orig[i]) < 1e-6);
    }

    // Verify addMemory writes embedding_blob and getParsedEmbedding decodes directly from binary blob
    await addMemory({
      category: 'decision',
      content: 'Use Float32 binary embedding blobs for O(1) vector similarity scans.',
      project: blobProj,
      force: true,
      _embedding: orig
    });

    const db = await getProjectDb(blobProj);
    const row = db.prepare(`SELECT id, embedding, embedding_blob FROM ide_agent_memory LIMIT 1`).get();
    assert.ok(row.embedding_blob, 'addMemory must persist embedding_blob');
    assert.equal(row.embedding_blob.byteLength, 4096);

    const parsedFromBlobOnly = getParsedEmbedding(null, row.embedding_blob);
    assert.ok(parsedFromBlobOnly && parsedFromBlobOnly.length === 1024);
    assert.ok(Math.abs(parsedFromBlobOnly[7] - orig[7]) < 1e-6);

    // Verify backfillMissingEmbeddings populates both embedding and embedding_blob
    db.prepare(`INSERT INTO ide_agent_memory (category, content, status, embedding, embedding_blob, project) VALUES ('lesson', 'Offline row awaiting backfill', 'ACTIVE', NULL, NULL, ?)`).run(blobProj);
    const bf = await backfillMissingEmbeddings({
      project: blobProj,
      _embedFn: async () => makeUnitVec(0.75, 9)
    });
    assert.equal(bf.updated, 1);
    const bfRow = db.prepare(`SELECT embedding, embedding_blob FROM ide_agent_memory WHERE category = 'lesson' LIMIT 1`).get();
    assert.ok(bfRow.embedding && bfRow.embedding_blob && bfRow.embedding_blob.byteLength === 4096);
  });

  await t.test('2. SQLite FTS5 external-content index: triggers + deep-store recall beyond KRUSCH_MAX_ACTIVE_SCAN', async () => {
    const db = await getProjectDb(ftsProj);

    // Insert 425 rows where row #2 (outside a 400-row active vector scan) holds an inflected technical decision
    withTransaction(db, () => {
      const stmt = db.prepare(`
        INSERT INTO ide_agent_memory (category, content, tags, status, project)
        VALUES ('decision', ?, ?, 'ACTIVE', ?)
      `);
      stmt.run('Warmup anchor entry 1', '["init"]', ftsProj);
      stmt.run(
        '[Session 1 | Date: Jan 2, 2026 | Turn #2/425] USER: We are authenticating hardware sessions via WebAuthn passkeys and rotating FIDO2 attestations. | ASSISTANT: Configured WebAuthn passkey verification.',
        '["security","session-1"]',
        ftsProj
      );
      for (let i = 3; i <= 425; i++) {
        stmt.run(
          `[Session 5 | Date: Feb 10, 2026 | Turn #${i}/425] USER: Routine telemetry heartbeat check #${i} on worker pool metrics. | ASSISTANT: Worker pool #${i} nominal.`,
          '["telemetry"]',
          ftsProj
        );
      }
    });

    // Verify FTS5 Porter stemming matches inflected query terms directly
    const ftsHits = searchMemoryFts(db, ['authenticate', 'passkey', 'attestation'], {
      includeAllActive: true,
      limit: 5
    });
    assert.ok(Array.isArray(ftsHits) && ftsHits.length >= 1, 'FTS5 Porter stemmer must match inflected forms');
    assert.equal(Number(ftsHits[0].id), 2);

    // Verify UPDATE trigger updates FTS5 index and DELETE trigger removes deleted rows
    db.prepare(`UPDATE ide_agent_memory SET content = 'Updated hardware YubiKey PIV смарт-card configuration' WHERE id = 1`).run();
    const updHits = searchMemoryFts(db, ['yubikey'], { includeAllActive: true, limit: 5 });
    assert.equal(updHits.length, 1);
    assert.equal(Number(updHits[0].id), 1);

    db.prepare(`DELETE FROM ide_agent_memory WHERE id = 1`).run();
    const afterDelHits = searchMemoryFts(db, ['yubikey'], { includeAllActive: true, limit: 5 });
    assert.equal(afterDelHits.length, 0, 'FTS5 AFTER DELETE trigger must purge deleted row from index');

    // Verify unifiedRetrieve surfaces row #2 even when KRUSCH_MAX_ACTIVE_SCAN=400 excludes it from Step 3a
    const prevScan = process.env.KRUSCH_MAX_ACTIVE_SCAN;
    process.env.KRUSCH_MAX_ACTIVE_SCAN = '400';
    try {
      const res = await unifiedRetrieve({
        query: 'How do we authenticate hardware sessions with WebAuthn passkey attestation?',
        project: ftsProj,
        include_state: false,
        limit_tokens: 4000,
        _embedding: makeUnitVec(0.5, 3)
      });
      assert.ok(
        res.content[0].text.includes('WebAuthn passkeys'),
        'Step 3b FTS5 scan must retrieve deep ACTIVE memories beyond KRUSCH_MAX_ACTIVE_SCAN'
      );
    } finally {
      if (prevScan === undefined) delete process.env.KRUSCH_MAX_ACTIVE_SCAN;
      else process.env.KRUSCH_MAX_ACTIVE_SCAN = prevScan;
    }
  });

  await t.test('3. Passive Chronological State Evolution: tracks updates across long dialogue turns and ranks latest first', async () => {
    const pad = 'We also reviewed hydration intervals, cadence sensors, and recovery sleep targets for the race. '.repeat(3);
    const qVec = makeUnitVec(1.0, 1);

    await addMemory({
      category: 'decision',
      content: `[Session 1 | Date: Mar 1, 2026 | Turn #4/40] USER: Right now my weekly running mileage volume is 15km per week on flat trails. ${pad} | ASSISTANT: Logged 15km weekly running mileage baseline.`,
      project: kuProj,
      force: true,
      _embedding: makeUnitVec(0.76, 4)
    });
    await addMemory({
      category: 'decision',
      content: `[Session 4 | Date: Mar 22, 2026 | Turn #28/40] USER: Quick update — I actually switched my weekly running mileage volume to 32km per week now that my knee recovered! ${pad} | ASSISTANT: Awesome progress bumping your weekly running mileage volume to 32km per week.`,
      project: kuProj,
      force: true,
      _embedding: makeUnitVec(0.76, 5)
    });

    const res = await unifiedRetrieve({
      query: 'What is my current weekly running mileage volume now?',
      project: kuProj,
      include_state: false,
      limit_tokens: 4000,
      _embedding: qVec
    });

    assert.equal(res.epistemic_status, 'SUPPORTED', 'Passive state evolution must remain SUPPORTED (not false CONFLICTED)');
    assert.ok(Array.isArray(res.temporal_updates) && res.temporal_updates.length >= 1, 'Must expose temporal_updates metadata');
    assert.equal(res.temporal_updates[0].newer_id > res.temporal_updates[0].older_id, true);
    assert.ok(res.content[0].text.includes('Chronological State Evolution'), 'Must render Chronological State Evolution banner');
    assert.equal(
      Number(res.citations[0].id),
      res.temporal_updates[0].newer_id,
      'Latest state-transition turn must rank #1 ahead of earlier superseded mention'
    );
  });

  await t.test('4. Top-K Stratification: surfaces standing directives in Top 10 on topical queries, abstains on ungrounded queries, and places sequence timeline at top without duplicate Turn tags', async () => {
    const qVec = makeUnitVec(1.0, 1);

    // Turn #1: Standing directive with moderate BGE cosine (0.44) and zero lexical overlap with SQL query
    await addMemory({
      category: 'decision',
      content: `[Session 1 | Date: Apr 1, 2026 | Turn #1/34] USER: Moving forward, always include explicit error handling and JSDoc type annotations in every code snippet you write for me. | ASSISTANT: Understood, I will always include explicit error handling and JSDoc annotations.`,
      project: rankProj,
      force: true,
      _embedding: makeUnitVec(0.44, 2)
    });

    // 33 multi-session turns across Sessions 1..6
    for (let i = 2; i <= 34; i++) {
      const sess = ((i - 2) % 6) + 1;
      const isSql = i >= 10 && i <= 22;
      await addMemory({
        category: 'decision',
        content: isSql
          ? `[Session ${sess} | Date: Apr ${sess}, 2026 | Turn #${i}/34] USER: In Session ${sess} step ${i}, we optimized PostgreSQL composite B-tree index queries for invoice reporting. | ASSISTANT: Verified PostgreSQL composite index query plan #${i} in Session ${sess}.`
          : `[Session ${sess} | Date: Apr ${sess}, 2026 | Turn #${i}/34] USER: In Session ${sess} milestone ${i}, we deployed service module ${i} to staging cluster ${sess}. | ASSISTANT: Completed staging milestone ${i} in Session ${sess}.`,
        project: rankProj,
        force: true,
        _embedding: makeUnitVec(isSql ? 0.78 : 0.58, 10 + i)
      });
    }

    // 4a. Topical coding query -> Standing directive (#1) must appear inside Top 10!
    const topRes = await unifiedRetrieve({
      query: 'Write a PostgreSQL query helper for invoice reporting',
      project: rankProj,
      include_state: false,
      limit_tokens: 8000,
      _embedding: qVec
    });
    const top10Ids = topRes.citations.slice(0, 10).map(c => Number(c.id));
    assert.ok(top10Ids.includes(1), `Standing directive must rank inside Top 10 on topical queries (got Top 10: ${top10Ids.join(', ')})`);

    // 4b. Completely ungrounded query -> Guarded directive floor must NOT block NO_KNOWN_SUPPORT abstention
    const ungroundedVec = new Array(1024).fill(0);
    ungroundedVec[999] = 1.0; // Orthogonal to all stored turns (cosine = 0)
    const absRes = await unifiedRetrieve({
      query: 'What telescope aperture did we select for lunar astrophotography?',
      project: rankProj,
      include_state: false,
      limit_tokens: 4000,
      _embedding: ungroundedVec
    });
    assert.equal(absRes.epistemic_status, 'NO_KNOWN_SUPPORT', 'Orthogonal ungrounded query must abstain cleanly');

    // 4c. Explicit sequence-ordering query -> Chronological Event Sequence placed above [MEMORY] blocks with zero '| Turn #' duplicates
    const seqRes = await unifiedRetrieve({
      query: 'List the chronological order of staging milestones from earliest to latest across all sessions',
      project: rankProj,
      include_state: false,
      limit_tokens: 8000,
      _embedding: qVec
    });
    const seqText = seqRes.content[0].text;
    const timelinePos = seqText.indexOf('### 📅 Chronological Event Sequence (Oldest → Newest)');
    const firstMemoryPos = seqText.indexOf('### [MEMORY]');
    assert.ok(timelinePos > 0 && firstMemoryPos > 0 && timelinePos < firstMemoryPos, 'Sequence-order query must render Chronological Event Sequence above raw [MEMORY] blocks');

    const preMemorySlice = seqText.slice(0, firstMemoryPos);
    assert.equal(
      /\| Turn #\d+\/\d+\]/.test(preMemorySlice),
      false,
      'Compact timeline header above [MEMORY] blocks must never emit duplicate | Turn #X/Y] citations'
    );
  });

  await t.test('5. Corpus-Level Lexical Grounding Note: flags query terms absent across entire store without dropping context', async () => {
    const qVec = makeUnitVec(1.0, 1);
    await addMemory({
      category: 'decision',
      content: '[Session 1 | Date: May 1, 2026 | Turn #1/4] USER: We configured Redis Sentinel automatic failover with TLS mutual authentication across three nodes. | ASSISTANT: Redis Sentinel failover with mTLS is active.',
      project: groundProj,
      force: true,
      _embedding: makeUnitVec(0.74, 2)
    });

    const res = await unifiedRetrieve({
      query: 'Did we configure Redis Sentinel failover using Kerberos keytabs?',
      project: groundProj,
      include_state: false,
      limit_tokens: 4000,
      _embedding: qVec
    });

    assert.equal(res.epistemic_status, 'SUPPORTED');
    assert.ok(res.content[0].text.includes('Redis Sentinel automatic failover'), 'Retrieved context must remain intact');
    assert.ok(res.content[0].text.includes('Lexical Grounding Note'), 'Must emit Lexical Grounding Note when query contains corpus-unattested terms');
    assert.ok(res.content[0].text.toLowerCase().includes('kerberos'));
    assert.ok(res.content[0].text.toLowerCase().includes('keytabs'));
  });

  t.after(async () => {
    closeAllDatabases();
    for (const p of [blobProj, ftsProj, kuProj, rankProj, groundProj]) {
      try {
        fs.rmSync(resolveProjectPath(p), { recursive: true, force: true });
      } catch {}
    }
    try {
      await pool.end();
    } catch {}
  });
});

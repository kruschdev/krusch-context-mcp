import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  addMemory,
  compileProjectState,
  getStaleMemories,
  getHealthStats,
  touchMemory,
  backfillMissingEmbeddings
} from '../src/memory-engine.js';
import { nuggetRemember, nuggetNudges } from '../src/nuggets-engine.js';
import { unifiedRetrieve } from '../src/unified-retrieval.js';
import { handleProactiveNudge } from '../src/proactive-engine.js';
import {
  getEmbedding,
  getEmbeddingProvider,
  isEmbeddingProviderConfigured
} from '../src/embedding-helper.js';
import { ollamaQueue } from '../src/llm-queue.js';
import {
  getProjectDb,
  resolveProjectPath,
  closeAllDatabases
} from '../src/sqlite-engine.js';
import { pool } from '../db/pool.js';

const EMBED_ENV_KEYS = [
  'OPENROUTER_API_KEY',
  'EMBEDDING_URL',
  'EMBEDDING_API_KEY',
  'EMBED_MODEL',
  'EMBED_DIMS',
  'OLLAMA_URL',
  'OLLAMA_BASE_URL',
  'OLLAMA_FLEET_URLS',
  'OLLAMA_NODES',
  'MOCK_EMBEDDINGS',
  'KRUSCH_FORCE_REAL_OFFLINE'
];

function snapshotEnv(keys) {
  const snap = {};
  for (const k of keys) {
    snap[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
  }
  return snap;
}

function restoreEnv(snap) {
  for (const [k, v] of Object.entries(snap)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

test('Phase 1 Production Hardening Suite (Zero-GPU Offline, Token Budget, Hybrid Nudge, Inode Self-Heal)', async (t) => {
  const uniqueTag = `p1_${Date.now()}`;
  const createdProjects = new Set();

  const makeTestProject = (prefix) => {
    const name = `test_${prefix}_${uniqueTag}`;
    createdProjects.add(name);
    return name;
  };

  await t.test('1. Zero-GPU Offline Lifecycle: fast null embed, offline remember/nugget, lexical dedup, retrieval & backfill', async () => {
    const proj = makeTestProject('offline');
    const envSnap = snapshotEnv(EMBED_ENV_KEYS);
    const savedEndpoints = [...ollamaQueue.endpoints];

    try {
      for (const k of EMBED_ENV_KEYS) delete process.env[k];
      process.env.KRUSCH_FORCE_REAL_OFFLINE = '1';
      ollamaQueue.endpoints = [];

      assert.equal(isEmbeddingProviderConfigured(), false);
      const provider = getEmbeddingProvider();
      assert.equal(provider.provider, 'offline');

      const t0 = Date.now();
      const emb = await getEmbedding('Zero-GPU offline embedding probe');
      const elapsedMs = Date.now() - t0;
      assert.equal(emb, null, 'getEmbedding must return null cleanly in real offline mode');
      assert.ok(elapsedMs < 250, `Offline getEmbedding should fast-bypass network timeouts (took ${elapsedMs}ms)`);

      // Offline addMemory succeeds with embedding = NULL
      const memText = 'Zero-GPU offline invariant: enforce SQLite WAL journal_mode and synchronous NORMAL.';
      const first = await addMemory({
        category: 'invariant',
        content: memText,
        project: proj
      });
      assert.ok(first.id, 'Offline addMemory must persist and return row id');
      assert.equal(first.offline, true);

      // Offline near-duplicate guard via token Jaccard
      const dup = await addMemory({
        category: 'invariant',
        content: 'Zero-GPU offline invariant: enforce SQLite WAL journal_mode and synchronous NORMAL!',
        project: proj,
        force: false
      });
      assert.equal(dup.warning, 'near_duplicate', 'Offline lexical Jaccard guard must catch near-duplicate');

      // Offline nuggetRemember + lexical nuggetNudges fallback
      const nug = await nuggetRemember({
        key: 'sqlite-wal-policy',
        content: 'Always configure SQLite journal_mode = WAL and busy_timeout = 5000 on local stores.',
        project: proj
      });
      assert.ok(nug.content[0].text.includes('Nugget remembered natively in SQLite'));

      const nugSearch = await nuggetNudges({
        context: 'configuring SQLite journal_mode WAL and busy_timeout for local database',
        project: proj
      });
      assert.ok(nugSearch.content[0].text.includes('sqlite-wal-policy'), 'Lexical nugget fallback must surface matching nugget');

      // Offline unifiedRetrieve finds unembedded memory via lexical + IDF engine
      const retrieved = await unifiedRetrieve({
        query: 'SQLite WAL journal_mode synchronous NORMAL',
        project: proj,
        include_state: false,
        limit_tokens: 2000
      });
      assert.ok(retrieved.content[0].text.includes('enforce SQLite WAL journal_mode'), 'Offline unifiedRetrieve must surface unembedded memory');

      // Health stats tracks unembeddedCount (both first and non-blocking near-dup saved offline)
      const healthBefore = await getHealthStats({ project: proj });
      assert.equal(healthBefore.stats.unembeddedCount, 2);

      // Backfill populates missing embeddings when provider becomes available
      const backfill = await backfillMissingEmbeddings({
        project: proj,
        _embedFn: async () => new Array(1024).fill(0.025)
      });
      assert.equal(backfill.updated, 2);
      assert.equal(backfill.remaining, 0);

      const healthAfter = await getHealthStats({ project: proj });
      assert.equal(healthAfter.stats.unembeddedCount, 0);
    } finally {
      ollamaQueue.endpoints = savedEndpoints;
      restoreEnv(envSnap);
    }
  });

  await t.test('1b. Long-text Ollama multi-window chunked centroid embedding (>2000 chars)', async () => {
    const envSnap = snapshotEnv(EMBED_ENV_KEYS);
    const savedEndpoints = [...ollamaQueue.endpoints];
    const originalFetch = globalThis.fetch;
    const chunkLengths = [];

    try {
      for (const k of EMBED_ENV_KEYS) delete process.env[k];
      process.env.OLLAMA_URL = 'http://mock-ollama-local:11434';
      ollamaQueue.endpoints = ['http://mock-ollama-local:11434'];

      globalThis.fetch = async (_url, options) => {
        const body = JSON.parse(options.body);
        chunkLengths.push(body.prompt.length);
        const fillVal = chunkLengths.length === 1 ? 0.2 : 0.6;
        return {
          ok: true,
          json: async () => ({ embedding: new Array(1024).fill(fillVal) })
        };
      };

      const longDocument = Array.from(
        { length: 45 },
        (_, idx) => `Section ${idx + 1}: Deterministic schema migration and pgvector index verification check.`
      ).join(' ');
      assert.ok(longDocument.length > 2600);

      const centroid = await getEmbedding(longDocument);
      assert.ok(Array.isArray(centroid));
      assert.equal(centroid.length, 1024);
      assert.ok(chunkLengths.length >= 2, `Expected >=2 overlapping chunks for ${longDocument.length} chars, got ${chunkLengths.length}`);
      assert.ok(chunkLengths.every((len) => len <= 2000), 'Every chunk sent to Ollama must respect MAX_EMBED_CHARS');
    } finally {
      globalThis.fetch = originalFetch;
      ollamaQueue.endpoints = savedEndpoints;
      restoreEnv(envSnap);
    }
  });

  await t.test('2. Bounded compileProjectState & Project-Affinity Sorting under 4,000-token Turn-1 budget', async () => {
    const proj = makeTestProject('budget');

    // Insert 12 verbose sibling-project memories that previously crowded out target state & blew past 4,000 tokens
    for (let i = 1; i <= 12; i++) {
      await addMemory({
        category: i % 2 === 0 ? 'decision' : 'invariant',
        content: `In projects/other-sibling-app/src/module${i}.js: ${'Verbose architectural narrative and historical context padding '.repeat(18)}(#${i})`,
        project: proj,
        tags: ['other-sibling-app'],
        force: true
      });
    }

    // Insert target-project invariant & decision explicitly referencing proj
    await addMemory({
      category: 'invariant',
      content: `Critical ${proj} invariant: preserve strict 5-verb MCP contract and zero-leakage SHA-256 verification.`,
      project: proj,
      tags: [proj, 'mcp-contract'],
      force: true
    });
    await addMemory({
      category: 'decision',
      content: `Primary ${proj} architecture decision: enforce bounded Turn-1 state compilation under 2400 tokens.`,
      project: proj,
      tags: [proj, 'turn-1-budget'],
      force: true
    });

    const stateRes = await compileProjectState({ project: proj, max_tokens: 2400 });
    const stateText = stateRes.content[0].text;
    const stateEstTokens = Math.ceil(stateText.length / 4);
    assert.ok(stateEstTokens <= 2400, `compileProjectState must stay <= 2400 tokens (got ${stateEstTokens})`);

    // Target-project records must appear ahead of sibling-project records in their sections
    const targetInvIdx = stateText.indexOf(`Critical ${proj} invariant`);
    const siblingInvIdx = stateText.indexOf('projects/other-sibling-app/src/module1.js');
    assert.ok(targetInvIdx !== -1, 'Target-project invariant must be present in compiled state');
    if (siblingInvIdx !== -1) {
      assert.ok(targetInvIdx < siblingInvIdx, 'Target-project invariant must rank ahead of sibling-project noise');
    }

    // Full Turn-1 retrieve(query: "*", include_state: true, limit_tokens: 4000) must respect 4,000-token ceiling
    const turn1 = await unifiedRetrieve({
      query: '*',
      project: proj,
      include_state: true,
      limit_tokens: 4000
    });
    const turn1Text = turn1.content[0].text;
    const turn1EstTokens = Math.ceil(turn1Text.length / 4);
    assert.ok(turn1EstTokens <= 4050, `Turn-1 retrieve(include_state: true) must respect 4000-token budget (got ${turn1EstTokens})`);
    assert.ok(Array.isArray(turn1.citations) && turn1.citations.length >= 2, `Turn-1 retrieve should leave budget for multiple memory items beyond stateHeader (packed ${turn1.citations?.length})`);
  });

  await t.test('3. Hybrid handleProactiveNudge Precision: suppresses >4-char noise words while catching real technical overlaps', async () => {
    const proj = makeTestProject('nudge');

    await addMemory({
      category: 'invariant',
      content: 'Never run `rsync --delete` on deployment targets without excluding `postgres/` and `redis/` data directories.',
      project: proj,
      tags: ['rsync', 'deployment-safety'],
      force: true
    });

    await addMemory({
      category: 'invariant',
      content: 'All custom authentication routes must validate bearer tokens via `verifySessionJwt` before mutating records.',
      project: proj,
      tags: ['auth', 'jwt'],
      force: true
    });

    // Generic diff full of >4-char words ("files", "table", "error", "records", "before", "without") that used to false-positive
    const genericDiff = await handleProactiveNudge({
      trigger: 'pre_commit',
      project: proj,
      code: `export function formatTableSummary(files, records) {\n  if (!files || !records) throw new Error('Missing input before formatting without header');\n  return files.length + records.length;\n}`
    });
    assert.equal(
      genericDiff.content[0].text,
      'NO_NUDGES_REQUIRED',
      `Generic >4-char code words must NOT trigger unrelated invariants, got:\n${genericDiff.content[0].text}`
    );

    // Diff with genuine technical command (`rsync --delete`) MUST surface the rsync invariant
    const rsyncDiff = await handleProactiveNudge({
      trigger: 'pre_commit',
      project: proj,
      code: `await execAsync('rsync --delete -avz ./dist/ server:/opt/app/');`
    });
    assert.ok(rsyncDiff.content[0].text.includes('rsync --delete'), 'Genuine technical symbol match must trigger proactive nudge');
    assert.ok(!rsyncDiff.content[0].text.includes('verifySessionJwt'), 'Unrelated auth invariant must not co-fire on rsync diff');
  });

  await t.test('4. SQLite Inode FD Rotation Self-Healing & touchMemory 30-day Decay Refresh', async () => {
    const proj = makeTestProject('inode');
    const db1 = await getProjectDb(proj);
    const projPath = resolveProjectPath(proj);
    const dbFile = path.join(projPath, '.agent', 'context.db');

    await addMemory({
      category: 'lesson',
      content: 'Initial memory written to original inode before DB file rotation.',
      project: proj,
      force: true
    });

    const inoBefore = fs.statSync(dbFile).ino;

    // Simulate external backup/restore or atomic file replacement while dbCache still holds db1 open
    fs.rmSync(dbFile, { force: true });
    try { fs.rmSync(`${dbFile}-wal`, { force: true }); } catch {}
    try { fs.rmSync(`${dbFile}-shm`, { force: true }); } catch {}

    // Re-request DB: getProjectDb must detect missing/changed inode, close stale FD, and initialize fresh DB
    const db2 = await getProjectDb(proj);
    assert.notEqual(db2, db1, 'getProjectDb must replace cached DatabaseSync handle when underlying file was unlinked/rotated');
    assert.ok(fs.existsSync(dbFile), 'Re-initialized SQLite file must exist on disk');

    const memRes = await addMemory({
      category: 'decision',
      content: 'Durable decision written after automatic inode self-healing.',
      project: proj,
      force: true
    });
    assert.ok(memRes.id);

    // Backdate created_at & updated_at to 45 days ago to simulate aged active memory
    db2.prepare(
      `UPDATE ide_agent_memory
       SET created_at = datetime('now', '-45 days'),
           updated_at = datetime('now', '-45 days'),
           last_accessed_at = NULL
       WHERE id = ?`
    ).run(memRes.id);

    const staleBefore = await getStaleMemories({ project: proj, days: 30 });
    assert.equal(staleBefore.length, 1, 'Backdated 45-day memory must appear in 30-day decay candidates');

    // Confirm/touch memory without rewriting content or re-embedding
    const touched = await touchMemory({ id: memRes.id, project: proj });
    assert.equal(touched.touched, true);

    const staleAfter = await getStaleMemories({ project: proj, days: 30 });
    assert.equal(staleAfter.length, 0, 'touchMemory must refresh last_accessed_at and clear 30-day decay flag');
    void inoBefore;
  });

  t.after(async () => {
    closeAllDatabases();
    for (const proj of createdProjects) {
      try {
        fs.rmSync(path.join(os.homedir(), '.krusch-context', 'projects', proj), { recursive: true, force: true });
      } catch {}
    }
    try {
      await pool.end();
    } catch {}
  });
});

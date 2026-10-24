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

  await t.test('8. Secret Refusal, Fleet Attribution, Handoff/Blocker Priority & State Deduplication', async () => {
    const { nuggetRemember } = await import('../src/nuggets-engine.js');
    const { unifiedRetrieve } = await import('../src/unified-retrieval.js');
    const dummyEmb = new Array(1024).fill(0.05);

    // 8a. Secret refusal blocks raw API keys in addMemory and nuggetRemember
    // SEC-01: Never hard-code raw secret literals in source; use env or runtime-assembled fixture
    const syntheticOpenAiKey = ['sk', 'proj', '1234567890abcdefghijklmnop'].join('-');
    const syntheticGithubToken = process.env.TEST_GITHUB_TOKEN || ['ghp', '1234567890abcdefghijklmnopqrstuvwxyz'].join('_');

    await assert.rejects(
      async () => {
        await addMemory({
          category: 'lesson',
          content: `Never commit key ${syntheticOpenAiKey} to git`,
          project: testProject,
          _embedding: dummyEmb
        });
      },
      (err) => {
        assert.ok(err.message.includes('Secret refusal'));
        assert.equal(err.message.includes(syntheticOpenAiKey), false);
        return true;
      }
    );

    await assert.rejects(
      async () => {
        await nuggetRemember({
          key: 'api_token',
          value: syntheticGithubToken,
          project: testProject,
          _embedding: dummyEmb
        });
      },
      (err) => {
        assert.ok(err.message.includes('Secret refusal'));
        assert.equal(err.message.includes(syntheticGithubToken), false);
        return true;
      }
    );

    // 8b. Handoff nugget renders at top of compileProjectState, and blockers surface before bugs
    await nuggetRemember({
      key: 'handoff',
      value: 'Paused after migrating schema; next step is running integration suite.',
      project: testProject,
      _embedding: dummyEmb
    });

    // Add 5 resolved bug records, then 1 active blocker
    for (let i = 1; i <= 5; i++) {
      await addMemory({
        category: 'bug',
        content: `Resolved historical bug #${i} (${uniqueTag})`,
        tags: ['test'],
        project: testProject,
        force: true,
        _embedding: dummyEmb
      });
    }
    const blockerRes = await addMemory({
      category: 'blocker',
      content: `Critical active blocker: port 5432 firewall rule pending (${uniqueTag})`,
      tags: ['test'],
      project: testProject,
      provenance: { client: 'antigravity', model: 'gemini-4-argon' },
      force: true,
      _embedding: dummyEmb
    });

    const stateRes = await compileProjectState({ project: testProject });
    const stateText = stateRes.content[0].text;
    assert.ok(stateText.includes('## 🤝 Active Session Handoff'), 'Must render Active Session Handoff banner');
    assert.ok(stateText.includes('Paused after migrating schema'), 'Must include handoff note');
    const blockerPos = stateText.indexOf(`#${blockerRes.id}** [blocker]`);
    assert.ok(blockerPos !== -1, 'Active blocker must not be crowded out by resolved bugs');

    // 8c. unifiedRetrieve with include_state=true does not re-pack items already in stateHeader
    const extraDecision = await addMemory({
      category: 'decision',
      content: `Older decision #0 beyond top-5 state slice (${uniqueTag})`,
      tags: ['test'],
      project: testProject,
      force: true,
      _embedding: dummyEmb
    });
    for (let i = 1; i <= 5; i++) {
      await addMemory({
        category: 'decision',
        content: `Top-5 decision #${i} in state header (${uniqueTag})`,
        tags: ['test'],
        project: testProject,
        force: true,
        _embedding: dummyEmb
      });
    }

    const freshStateRes = await compileProjectState({ project: testProject });
    const retRes = await unifiedRetrieve({
      query: '*',
      include_state: true,
      limit_tokens: 4000,
      project: testProject,
      _embedding: dummyEmb
    });
    const citedIds = new Set(retRes.citations.filter(c => c.type === 'memory').map(c => c.id));
    for (const packedId of freshStateRes.packedIds) {
      assert.ok(!citedIds.has(packedId), `Memory #${packedId} already in stateHeader must not be duplicated in packed items`);
    }
    assert.ok(citedIds.has(extraDecision.id), 'Unpacked memory outside top-5 state slice should be packed in retrieval section');
  });

  await t.test('9. Expanded Secret Refusal (OpenRouter, DB URLs, updateMemory) & Vector Cache Optimization', async () => {
    const { updateMemory, scanForSecretLeak } = await import('../src/memory-engine.js');
    const { getParsedEmbedding } = await import('../src/sqlite-engine.js');
    const dummyEmb = new Array(1024).fill(0.05);

    assert.equal(scanForSecretLeak('sk-or-v1-1234567890abcdefghijklmnop'), 'OpenRouter API Key');
    assert.equal(scanForSecretLeak('postgresql://admin:superSecretProdPass99@db.internal:5432/prod'), 'Database Connection URL Secret');
    assert.equal(scanForSecretLeak('postgresql://kdcode:password@localhost:5432/kdcode'), null, 'Placeholder password should be allowed');

    const cleanMem = await addMemory({
      category: 'lesson',
      content: `Clean record before update (${uniqueTag})`,
      project: testProject,
      force: true,
      _embedding: dummyEmb
    });

    await assert.rejects(
      async () => {
        await updateMemory({
          id: cleanMem.id,
          content: 'Leaked OpenRouter key sk-or-v1-1234567890abcdefghijklmnop',
          project: testProject,
          _embedding: dummyEmb
        });
      },
      (err) => {
        assert.ok(err.message.includes('Secret refusal'));
        return true;
      }
    );

    // Verify getParsedEmbedding caches identical JSON string into same Float64Array reference
    const rawJson = JSON.stringify([0.25, 0.5, 0.75]);
    const parsedA = getParsedEmbedding(rawJson);
    const parsedB = getParsedEmbedding(rawJson);
    assert.ok(parsedA instanceof Float64Array, 'Must parse into Float64Array');
    assert.strictEqual(parsedA, parsedB, 'Must return cached Float64Array reference on second call');
  });

  await t.test('10. Audit Remediations: Weight Decay (CTX-02), Symlink/Dotfile Guard (CTX-03), Deep Secret Scan (CTX-04), Lineage Validation (CTX-05), Retrieval Filtering (CTX-07), Quote Drift (CTX-08), Stale Count (CTX-09), & Path Boundary Nudge (CTX-10)', async () => {
    const { resolveAnchoredFilePath, anchorProvenanceToFile, scanForSecretLeak } = await import('../src/memory-engine.js');
    const { resolveProjectPath, getProjectDb } = await import('../src/sqlite-engine.js');
    const { handleProactiveNudge, recordNudgeFeedback } = await import('../src/proactive-engine.js');
    const { nuggetRemember } = await import('../src/nuggets-engine.js');
    const { unifiedRetrieve } = await import('../src/unified-retrieval.js');
    const dummyEmb = new Array(1024).fill(0.05);
    const ctxProject = `test_ctx_remed_${uniqueTag}`;
    const projRoot = resolveProjectPath(ctxProject);
    fs.mkdirSync(projRoot, { recursive: true });

    // CTX-03: Reject sensitive dotfiles and symlinks escaping projectRoot
    fs.writeFileSync(path.join(projRoot, '.env'), 'SECRET=123\n', 'utf8');
    fs.writeFileSync(path.join(projRoot, '.env.local'), 'SECRET=456\n', 'utf8');
    fs.writeFileSync(path.join(projRoot, 'id_rsa'), 'PRIVATE KEY\n', 'utf8');
    fs.writeFileSync(path.join(projRoot, 'cert.pem'), 'CERT\n', 'utf8');
    assert.equal(resolveAnchoredFilePath('.env', ctxProject), null);
    assert.equal(resolveAnchoredFilePath('.env.local', ctxProject), null);
    assert.equal(resolveAnchoredFilePath('id_rsa', ctxProject), null);
    assert.equal(resolveAnchoredFilePath('id_ed25519', ctxProject), null);
    assert.equal(resolveAnchoredFilePath('cert.pem', ctxProject), null);

    const outsideFile = path.join(os.tmpdir(), `outside_${uniqueTag}.txt`);
    fs.writeFileSync(outsideFile, 'outside content\n', 'utf8');
    const symlinkPath = path.join(projRoot, 'escape_link.txt');
    try {
      fs.symlinkSync(outsideFile, symlinkPath);
      assert.equal(resolveAnchoredFilePath('escape_link.txt', ctxProject), null, 'Symlink escaping projectRoot must be rejected');
    } finally {
      try { fs.unlinkSync(symlinkPath); } catch {}
      try { fs.unlinkSync(outsideFile); } catch {}
    }

    // CTX-04: Broadened sk- regex & secret scans across provenance, tags, reason, and nugget key
    assert.equal(scanForSecretLeak('sk-svcacct-1234567890abcdefghijklmnop'), 'OpenAI/Anthropic API Key');
    assert.equal(scanForSecretLeak('sk-1234567890abcdefghijklmnop'), 'OpenAI/Anthropic API Key');

    await assert.rejects(
      () => addMemory({
        category: 'lesson',
        content: 'Clean content',
        provenance: { quoted_sentence: 'const k = "sk-svcacct-1234567890abcdefghijklmnop";' },
        project: ctxProject,
        _embedding: dummyEmb
      }),
      (err) => err.message.includes('Secret refusal')
    );

    await assert.rejects(
      () => addMemory({
        category: 'lesson',
        content: 'Clean content',
        tags: ['sk-1234567890abcdefghijklmnop'],
        project: ctxProject,
        _embedding: dummyEmb
      }),
      (err) => err.message.includes('Secret refusal')
    );

    await assert.rejects(
      () => nuggetRemember({
        key: 'sk-1234567890abcdefghijklmnop',
        value: 'clean value',
        project: ctxProject,
        _embedding: dummyEmb
      }),
      (err) => err.message.includes('Secret refusal')
    );

    // CTX-05: supersedeMemory and invalidateMemory validate target_id existence & category inheritance
    await assert.rejects(
      () => supersedeMemory({
        id: 999999,
        content: 'Should fail because target does not exist',
        project: ctxProject,
        _embedding: dummyEmb
      }),
      (err) => err.message.includes('not found')
    );

    await assert.rejects(
      () => invalidateMemory({
        id: 999999,
        reason: 'Valid non-empty reason',
        project: ctxProject
      }),
      (err) => err.message.includes('not found')
    );

    const baseInv = await addMemory({
      category: 'invariant',
      content: 'Original invariant rule before supersede',
      project: ctxProject,
      force: true,
      _embedding: dummyEmb
    });

    await assert.rejects(
      () => invalidateMemory({
        id: baseInv.id,
        reason: 'Deprecated key sk-1234567890abcdefghijklmnop',
        project: ctxProject
      }),
      (err) => err.message.includes('Secret refusal')
    );

    // Supersede without passing category -> inherits 'invariant' from baseInv
    const supRes = await supersedeMemory({
      target_id: baseInv.id,
      content: 'Superseded invariant rule inheriting category automatically',
      project: ctxProject,
      _embedding: dummyEmb
    });
    assert.ok(supRes.content[0].text.includes('(invariant)'));

    // CTX-08: anchorProvenanceToFile marks missing quoted_sentence as drifted & normalizes CRLF
    const crlfFile = path.join(projRoot, 'auth.js');
    fs.writeFileSync(crlfFile, 'export function verifyAuth() {\r\n  return true;\r\n}\r\n', 'utf8');
    const crlfAnchor = anchorProvenanceToFile({
      file: 'auth.js',
      quoted_sentence: 'export function verifyAuth() {\n  return true;\n}'
    }, ctxProject);
    assert.equal(crlfAnchor.is_drifted, false, 'CRLF file should match LF multi-line quote');
    assert.equal(crlfAnchor.start_line, 1);
    assert.equal(crlfAnchor.end_line, 3);

    const missingQuoteAnchor = anchorProvenanceToFile({
      file: 'auth.js',
      quoted_sentence: 'export function nonExistentFunction() {}'
    }, ctxProject);
    assert.equal(missingQuoteAnchor.is_drifted, true, 'Missing quote at creation time must mark is_drifted=true');
    assert.equal(missingQuoteAnchor.drift_reason, 'quoted_span_not_found');

    // CTX-10: Path boundary matching in handleProactiveNudge & unrelated drifted rule filtering
    const driftedOtherFile = path.join(projRoot, 'unrelated.js');
    fs.writeFileSync(driftedOtherFile, 'export const X = 1;\n', 'utf8');
    await addMemory({
      category: 'invariant',
      content: 'Unrelated invariant anchored to unrelated.js',
      project: ctxProject,
      provenance: { file: 'unrelated.js', quoted_sentence: 'export const X = 999;' },
      force: true,
      _embedding: dummyEmb
    });
    const authRule = await addMemory({
      category: 'invariant',
      content: 'Auth verification must validate token signatures',
      project: ctxProject,
      provenance: { file: 'auth.js', quoted_sentence: 'export function verifyAuth() {' },
      force: true,
      _embedding: dummyEmb
    });

    // Auditing 'src/oauth.js' with unrelated code must NOT match 'auth.js' or unrelated drifted 'unrelated.js'
    const oauthNudge = await handleProactiveNudge({
      trigger: 'pre_commit',
      file_path: 'src/oauth.js',
      code: 'const y = 42;',
      project: ctxProject
    });
    assert.equal(oauthNudge.content[0].text, 'NO_NUDGES_REQUIRED');

    // Auditing 'src/auth.js' MUST match 'auth.js' boundary
    const authNudge = await handleProactiveNudge({
      trigger: 'pre_commit',
      file_path: 'src/auth.js',
      code: 'const y = 42;',
      project: ctxProject
    });
    assert.ok(authNudge.content[0].text.includes(`Rule #${authRule.id}`));

    // CTX-02: Repeated 'unhelpful' feedback decays weight below 0.2 threshold (1.0 -> 0.7 -> 0.4 -> 0.1)
    await recordNudgeFeedback({ rule_id: String(authRule.id), feedback: 'unhelpful', project: ctxProject });
    await recordNudgeFeedback({ rule_id: String(authRule.id), feedback: 'unhelpful', project: ctxProject });
    await recordNudgeFeedback({ rule_id: String(authRule.id), feedback: 'unhelpful', project: ctxProject });

    const suppressedNudge = await handleProactiveNudge({
      trigger: 'pre_commit',
      file_path: 'src/auth.js',
      code: 'const y = 42;',
      project: ctxProject
    });
    assert.equal(suppressedNudge.content[0].text, 'NO_NUDGES_REQUIRED', 'Rule decayed to 0.1 must be suppressed');

    // CTX-07: unifiedRetrieve normalizes category and skips nuggets when mode==='memory' or category is set
    await nuggetRemember({
      key: 'style_guide',
      value: 'Use 2 spaces for indentation',
      project: ctxProject,
      _embedding: dummyEmb
    });
    const catRet = await unifiedRetrieve({
      query: '*',
      category: 'invariants',
      project: ctxProject,
      _embedding: dummyEmb
    });
    assert.ok(catRet.citations.every(c => c.type === 'memory' && c.category === 'invariant'), 'Category retrieve must normalize plural and exclude nuggets');

    // CTX-09: True staleCount > 10 in getHealthStats and non-invariant prioritization in getStaleMemories
    const db = await getProjectDb(ctxProject);
    for (let i = 1; i <= 12; i++) {
      db.prepare(`
        INSERT INTO ide_agent_memory (category, content, status, created_at, updated_at)
        VALUES (?, ?, 'ACTIVE', datetime('now', '-45 days'), datetime('now', '-45 days'))
      `).run(i <= 6 ? 'invariant' : 'lesson', `Stale item #${i}`);
    }
    const staleList = await getStaleMemories({ project: ctxProject, days: 30 });
    assert.equal(staleList.length, 10);
    assert.equal(staleList[0].category, 'lesson', 'Non-invariant records must be prioritized first in decay review');
    const ctxHealth = await getHealthStats({ project: ctxProject });
    assert.equal(ctxHealth.stats.staleCount, 12, 'getHealthStats must report true total staleCount beyond LIMIT 10');

    // BUG-01: Concurrent readAnchoredFileCachedAsync invocations return consistent SHA-256 hash
    const { readAnchoredFileCached, readAnchoredFileCachedAsync, computeNormalizedSpanHash, evaluateMemorySpanDrift } = await import('../src/memory-engine.js');
    fs.mkdirSync(projRoot, { recursive: true });
    const targetFile = path.join(projRoot, 'concurrent_anchor.js');
    fs.writeFileSync(targetFile, 'export function verifyAuth() { return true; }\n', 'utf8');
    const expectedHash = computeNormalizedSpanHash(fs.readFileSync(targetFile, 'utf8'));
    const concurrentReads = await Promise.all(
      Array.from({ length: 10 }, () => readAnchoredFileCachedAsync(targetFile))
    );
    for (const r of concurrentReads) {
      assert.ok(r);
      assert.equal(r.currentHash, expectedHash);
    }

    // BUG-01 (Pass #6): readAnchoredFileCached logs and propagates filesystem I/O errors
    const failingFs = {
      statSync() {
        const ioErr = new Error('Synthetic EIO permission/disk failure');
        ioErr.code = 'EIO';
        throw ioErr;
      }
    };
    assert.throws(
      () => readAnchoredFileCached(targetFile, { fsImpl: failingFs }),
      /Synthetic EIO permission\/disk failure/
    );

    // BUG-02: evaluateMemorySpanDrift logs and rethrows provenance DB update errors instead of silently swallowing
    const brokenDb = {
      prepare() {
        return {
          run() {
            throw new Error('Synthetic SQLite disk I/O error');
          }
        };
      }
    };
    assert.throws(
      () => evaluateMemorySpanDrift(
        { id: 999, provenance: JSON.stringify({ file: 'missing_file.js', is_drifted: false }) },
        ctxProject,
        brokenDb
      ),
      /Synthetic SQLite disk I\/O error/
    );

    try {
      fs.rmSync(projRoot, { recursive: true, force: true });
    } catch {}
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

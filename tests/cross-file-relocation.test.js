import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  addMemory,
  compileProjectState,
  evaluateMemorySpanDrift,
  findRelocatedSpanCandidate
} from '../src/memory-engine.js';
import {
  handleProactiveNudge,
  runProactiveNudge
} from '../src/proactive-engine.js';
import {
  getProjectDb,
  resolveProjectPath,
  closeAllDatabases
} from '../src/sqlite-engine.js';
import { pool } from '../db/pool.js';

const DUMMY_EMBEDDING = new Array(1024).fill(0.05);

test('Cross-File Relocation Hints on STALE_DRIFT (INV-RELOC-01..04)', async (t) => {
  const prevHome = process.env.HOME;
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-reloc-suite-'));
  process.env.HOME = tmpHome;

  t.after(async () => {
    closeAllDatabases();
    if (prevHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = prevHome;
    }
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {}
    try {
      await pool.end();
    } catch {}
  });

  await t.test('1. Cross-file function move (quoted_span_mutated + file_missing) stays fail-closed and attaches moved_candidate', async () => {
    const tmpProj = `test_reloc_move_${Date.now()}`;
    const projRoot = resolveProjectPath(tmpProj);
    const guardPath = path.join(projRoot, 'src', 'policy', 'guard.js');
    const sharedPath = path.join(projRoot, 'src', 'shared', 'guard-utils.js');
    fs.mkdirSync(path.dirname(guardPath), { recursive: true });
    fs.mkdirSync(path.dirname(sharedPath), { recursive: true });

    const quotedSig = 'export function enforceTenantIsolation(req, tenantId) {';
    fs.writeFileSync(
      guardPath,
      [
        '// Tenant policy boundary',
        quotedSig,
        '  if (!tenantId || req.tenantId !== tenantId) throw new Error("Forbidden");',
        '}'
      ].join('\n') + '\n',
      'utf8'
    );

    const saved = await addMemory({
      category: 'invariant',
      content: 'Tenant isolation check must remain enforced inside the policy boundary.',
      project: tmpProj,
      provenance: {
        file: 'src/policy/guard.js',
        quoted_sentence: quotedSig
      },
      force: true,
      _embedding: DUMMY_EMBEDDING
    });
    assert.ok(saved.id);

    const db = await getProjectDb(tmpProj);
    let row = db.prepare('SELECT id, provenance FROM ide_agent_memory WHERE id = ?').get(saved.id);
    let initialDrift = evaluateMemorySpanDrift(row, tmpProj, db);
    assert.equal(initialDrift.is_drifted, false);
    assert.equal(initialDrift.provenance.file, 'src/policy/guard.js');
    assert.equal(initialDrift.provenance.citation, 'src/policy/guard.js#L2');

    // Step A: Move function to src/shared/guard-utils.js while leaving src/policy/guard.js without it (quoted_span_mutated)
    fs.writeFileSync(
      guardPath,
      '// Policy module refactored to delegate helper\nexport const POLICY_VERSION = 2;\n',
      'utf8'
    );
    fs.writeFileSync(
      sharedPath,
      [
        '// Shared guard utilities',
        'export const SHARED_HEADER = true;',
        quotedSig,
        '  if (!tenantId || req.tenantId !== tenantId) throw new Error("Forbidden");',
        '}'
      ].join('\n') + '\n',
      'utf8'
    );

    row = db.prepare('SELECT id, provenance FROM ide_agent_memory WHERE id = ?').get(saved.id);
    const mutatedDrift = evaluateMemorySpanDrift(row, tmpProj, db);
    assert.equal(mutatedDrift.is_drifted, true, 'INV-RELOC-01: cross-file move must fail closed');
    assert.equal(mutatedDrift.drift_reason, 'quoted_span_mutated');
    assert.equal(mutatedDrift.provenance.file, 'src/policy/guard.js', 'INV-RELOC-01: original provenance.file must not be overwritten');
    assert.deepEqual(mutatedDrift.provenance.moved_candidate, {
      file: 'src/shared/guard-utils.js',
      locator: 'L3',
      start_line: 3,
      end_line: 3,
      citation: 'src/shared/guard-utils.js#L3',
      match_kind: 'workspace_exact_quote',
      candidate_count: 1
    });

    let stateRes = await compileProjectState({ project: tmpProj });
    let stateText = stateRes.content[0].text;
    assert.ok(
      stateText.includes('⚠️ *[DRIFTED: src/policy/guard.js#L2 -> moved_candidate: src/shared/guard-utils.js#L3]*'),
      `Expected moved_candidate badge in compiled state, got:\n${stateText}`
    );

    // Step B: Delete src/policy/guard.js completely (file_missing)
    fs.unlinkSync(guardPath);

    row = db.prepare('SELECT id, provenance FROM ide_agent_memory WHERE id = ?').get(saved.id);
    const missingFileDrift = evaluateMemorySpanDrift(row, tmpProj, db);
    assert.equal(missingFileDrift.is_drifted, true, 'INV-RELOC-01: missing original file must remain drifted');
    assert.equal(missingFileDrift.drift_reason, 'file_missing');
    assert.equal(missingFileDrift.provenance.file, 'src/policy/guard.js');
    assert.equal(missingFileDrift.provenance.moved_candidate?.citation, 'src/shared/guard-utils.js#L3');

    stateRes = await compileProjectState({ project: tmpProj });
    stateText = stateRes.content[0].text;
    assert.ok(
      stateText.includes('⚠️ *[DRIFTED: src/policy/guard.js#L2 -> moved_candidate: src/shared/guard-utils.js#L3]*'),
      `Expected moved_candidate badge when original file is deleted, got:\n${stateText}`
    );

    // Step C: Verify Pre-commit / pre-edit nudge catches edits to the NEW destination file!
    assert.equal(runProactiveNudge, handleProactiveNudge);
    const nudgeOnDest = await runProactiveNudge({
      project: tmpProj,
      file_path: 'src/shared/guard-utils.js',
      code: '// editing moved helper',
      trigger: 'pre_edit'
    });
    const nudgeText = nudgeOnDest.content[0].text;
    assert.ok(nudgeText.includes(`Rule #${saved.id}`), 'Nudge must match rule via moved_candidate.file');
    assert.ok(
      nudgeText.includes('⚠️ *[DRIFTED: src/policy/guard.js#L2 -> moved_candidate: src/shared/guard-utils.js#L3]*'),
      `Expected moved_candidate badge in nudge output, got:\n${nudgeText}`
    );

    // Also matches when destination file path appears inside a unified diff query without file_path
    const nudgeOnDiff = await runProactiveNudge({
      project: tmpProj,
      code: '--- a/src/shared/guard-utils.js\n+++ b/src/shared/guard-utils.js\n+// touch helper',
      trigger: 'pre_commit'
    });
    assert.ok(nudgeOnDiff.content[0].text.includes(`Rule #${saved.id}`));

    // Unrelated file edit must still produce NO_NUDGES_REQUIRED
    const nudgeOnUnrelated = await runProactiveNudge({
      project: tmpProj,
      file_path: 'src/unrelated/noop.js',
      code: '// completely unrelated comment',
      trigger: 'pre_edit'
    });
    assert.equal(nudgeOnUnrelated.content[0].text, 'NO_NUDGES_REQUIRED');
  });

  await t.test('2. Multi-step refactor persistence: cut -> check (null) -> paste (b.js) -> move again (c.js) -> restore in-place heal', async () => {
    const tmpProj = `test_reloc_multistep_${Date.now()}`;
    const projRoot = resolveProjectPath(tmpProj);
    fs.mkdirSync(projRoot, { recursive: true });

    const fileA = path.join(projRoot, 'a.js');
    const fileB = path.join(projRoot, 'b.js');
    const fileC = path.join(projRoot, 'c.js');
    const fnQuote = 'export function validateSessionLease(leaseToken) {';

    fs.writeFileSync(fileA, `// Module A\n${fnQuote}\n  return Boolean(leaseToken);\n}\n`, 'utf8');

    const mem = await addMemory({
      category: 'invariant',
      content: 'Session lease validation must enforce non-empty token checks.',
      project: tmpProj,
      provenance: {
        file: 'a.js',
        quoted_sentence: fnQuote
      },
      force: true,
      _embedding: DUMMY_EMBEDDING
    });
    const db = await getProjectDb(tmpProj);

    // Phase 1: Cut function from a.js (not pasted anywhere yet)
    fs.writeFileSync(fileA, '// Module A emptied during cut\nexport const A_EMPTY = true;\n', 'utf8');
    let row = db.prepare('SELECT id, provenance FROM ide_agent_memory WHERE id = ?').get(mem.id);
    let drift = evaluateMemorySpanDrift(row, tmpProj, db);
    assert.equal(drift.is_drifted, true);
    assert.equal(drift.provenance.moved_candidate, null);

    let persistedProv = JSON.parse(
      db.prepare('SELECT provenance FROM ide_agent_memory WHERE id = ?').get(mem.id).provenance
    );
    assert.equal(persistedProv.is_drifted, true);
    assert.equal(persistedProv.moved_candidate, null);

    // Phase 2: Paste function into b.js -> SQLite provenance.moved_candidate updates to b.js#L4
    fs.writeFileSync(
      fileB,
      `// Module B\nconst HEADER_1 = 1;\nconst HEADER_2 = 2;\n${fnQuote}\n  return Boolean(leaseToken);\n}\n`,
      'utf8'
    );
    row = db.prepare('SELECT id, provenance FROM ide_agent_memory WHERE id = ?').get(mem.id);
    drift = evaluateMemorySpanDrift(row, tmpProj, db);
    assert.equal(drift.is_drifted, true);
    assert.equal(drift.provenance.file, 'a.js');
    assert.equal(drift.provenance.moved_candidate?.citation, 'b.js#L4');

    persistedProv = JSON.parse(
      db.prepare('SELECT provenance FROM ide_agent_memory WHERE id = ?').get(mem.id).provenance
    );
    assert.equal(persistedProv.is_drifted, true);
    assert.equal(persistedProv.file, 'a.js');
    assert.equal(persistedProv.moved_candidate?.citation, 'b.js#L4');

    // Phase 3: Move function again from b.js to c.js -> SQLite provenance.moved_candidate updates to c.js#L2
    fs.unlinkSync(fileB);
    fs.writeFileSync(
      fileC,
      `// Module C\n${fnQuote}\n  return Boolean(leaseToken);\n}\n`,
      'utf8'
    );
    row = db.prepare('SELECT id, provenance FROM ide_agent_memory WHERE id = ?').get(mem.id);
    drift = evaluateMemorySpanDrift(row, tmpProj, db);
    assert.equal(drift.is_drifted, true);
    assert.equal(drift.provenance.moved_candidate?.citation, 'c.js#L2');

    persistedProv = JSON.parse(
      db.prepare('SELECT provenance FROM ide_agent_memory WHERE id = ?').get(mem.id).provenance
    );
    assert.equal(persistedProv.moved_candidate?.citation, 'c.js#L2');

    // Phase 4: Restore function back into a.js -> heals is_drifted: false and clears moved_candidate: null!
    fs.unlinkSync(fileC);
    fs.writeFileSync(
      fileA,
      `// Module A restored with extra banner\n// Banner line\n${fnQuote}\n  return Boolean(leaseToken);\n}\n`,
      'utf8'
    );
    row = db.prepare('SELECT id, provenance FROM ide_agent_memory WHERE id = ?').get(mem.id);
    drift = evaluateMemorySpanDrift(row, tmpProj, db);
    assert.equal(drift.is_drifted, false);
    assert.equal(drift.healed, true);
    assert.equal(drift.provenance.file, 'a.js');
    assert.equal(drift.provenance.citation, 'a.js#L3');
    assert.equal(drift.provenance.moved_candidate, null);

    persistedProv = JSON.parse(
      db.prepare('SELECT provenance FROM ide_agent_memory WHERE id = ?').get(mem.id).provenance
    );
    assert.equal(persistedProv.is_drifted, false);
    assert.equal(persistedProv.moved_candidate, null);

    // Editing c.js after a.js healed must no longer match via stale moved_candidate
    const postHealNudge = await runProactiveNudge({
      project: tmpProj,
      file_path: 'c.js',
      code: '// unrelated post-heal edit',
      trigger: 'pre_edit'
    });
    assert.equal(postHealNudge.content[0].text, 'NO_NUDGES_REQUIRED');
  });

  await t.test('3. Specificity, boilerplate ambiguity (>5 files), sibling-closest ranking & CRLF multi-line range (INV-RELOC-02)', async () => {
    const tmpProj = `test_reloc_specificity_${Date.now()}`;
    const projRoot = resolveProjectPath(tmpProj);
    fs.mkdirSync(path.join(projRoot, 'src', 'auth', 'handlers'), { recursive: true });
    fs.mkdirSync(path.join(projRoot, 'src', 'utils'), { recursive: true });
    fs.mkdirSync(path.join(projRoot, 'lib'), { recursive: true });

    // 3a. Short quote (<10 non-whitespace chars) -> null
    fs.writeFileSync(path.join(projRoot, 'src', 'utils', 'short.js'), 'const x = 1;\n', 'utf8');
    assert.equal(findRelocatedSpanCandidate('x = 1;', 'src/auth/login.js', tmpProj), null);
    assert.equal(findRelocatedSpanCandidate('   a + b   ', 'src/auth/login.js', tmpProj), null);

    // 3b. Sibling-closest tie-breaking across <= 5 candidate files + CRLF multi-line normalization
    const multiLineQuote = 'export async function verifySessionSignature(\n  token,\n  publicKey\n) {';
    const crlfBody = [
      '// File header',
      'export async function verifySessionSignature(',
      '  token,',
      '  publicKey',
      ') {',
      '  return Boolean(token && publicKey);',
      '}'
    ].join('\r\n') + '\r\n';

    // Write 3 matching candidates at varying directory distances from 'src/auth/handlers/login.js'
    fs.writeFileSync(path.join(projRoot, 'lib', 'alpha.js'), crlfBody, 'utf8');
    fs.writeFileSync(path.join(projRoot, 'src', 'utils', 'beta.js'), crlfBody, 'utf8');
    fs.writeFileSync(path.join(projRoot, 'src', 'auth', 'handlers', 'token-helper.js'), crlfBody, 'utf8');

    const ranked = findRelocatedSpanCandidate(multiLineQuote, 'src/auth/handlers/login.js', tmpProj);
    assert.deepEqual(ranked, {
      file: 'src/auth/handlers/token-helper.js',
      locator: 'L2-L5',
      start_line: 2,
      end_line: 5,
      citation: 'src/auth/handlers/token-helper.js#L2-L5',
      match_kind: 'workspace_exact_quote',
      candidate_count: 3
    });

    // 3c. Boilerplate ambiguity (>5 matching files -> null)
    const boilerplateQuote = 'export const MODULE_SCHEMA_VERSION = 1;';
    for (let i = 1; i <= 6; i++) {
      fs.writeFileSync(path.join(projRoot, 'lib', `mod_${i}.js`), `${boilerplateQuote}\n`, 'utf8');
    }
    assert.equal(
      findRelocatedSpanCandidate(boilerplateQuote, 'src/auth/handlers/login.js', tmpProj),
      null,
      'Snippet appearing in >5 distinct files must return null'
    );
  });

  await t.test('4. Workspace containment, symlink escape, secret dotfile exclusion, NUL-byte & >512KB skip (INV-RELOC-03)', async () => {
    const tmpProj = `test_reloc_security_${Date.now()}`;
    const projRoot = resolveProjectPath(tmpProj);
    fs.mkdirSync(path.join(projRoot, 'src'), { recursive: true });

    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-reloc-outside-'));
    try {
      const secretQuote = 'export function rotateSigningMaterial(keyId) {';

      // Sensitive files inside workspace that MUST NEVER be suggested
      fs.writeFileSync(path.join(projRoot, '.env'), `# ${secretQuote}\n`, 'utf8');
      fs.writeFileSync(path.join(projRoot, '.env.production'), `# ${secretQuote}\n`, 'utf8');
      fs.writeFileSync(path.join(projRoot, 'id_rsa'), `${secretQuote}\n`, 'utf8');
      fs.writeFileSync(path.join(projRoot, 'server.pem'), `${secretQuote}\n`, 'utf8');
      fs.writeFileSync(path.join(projRoot, 'signing.key'), `${secretQuote}\n`, 'utf8');
      fs.writeFileSync(path.join(projRoot, 'credentials.json'), JSON.stringify({ note: secretQuote }), 'utf8');

      // Ignored directories that MUST NEVER be scanned
      for (const ignored of ['node_modules', '.git', '.agent', 'benchmarks', 'dist']) {
        const dir = path.join(projRoot, ignored);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'leaked.js'), `${secretQuote}\n`, 'utf8');
      }

      // Binary NUL-byte file and >512KB oversized file that MUST be skipped
      fs.writeFileSync(
        path.join(projRoot, 'src', 'binary.dat'),
        Buffer.concat([Buffer.from(`${secretQuote}\n`, 'utf8'), Buffer.from([0x00, 0x01, 0x02])])
      );
      fs.writeFileSync(
        path.join(projRoot, 'src', 'oversized.js'),
        `${'//'.repeat(270 * 1024)}\n${secretQuote}\n`,
        'utf8'
      );

      // Symlink file & symlink directory pointing OUTSIDE projRoot
      const outsideFile = path.join(outsideDir, 'escaped.js');
      fs.writeFileSync(outsideFile, `${secretQuote}\n  return keyId;\n}\n`, 'utf8');
      fs.symlinkSync(outsideFile, path.join(projRoot, 'src', 'escape-file.js'));
      fs.symlinkSync(outsideDir, path.join(projRoot, 'src', 'escape-dir'));

      const readPaths = [];
      const origReadFileSync = fs.readFileSync;
      fs.readFileSync = function patchedReadFileSync(target, ...rest) {
        readPaths.push(String(target));
        return origReadFileSync.call(fs, target, ...rest);
      };

      let blockedResult;
      try {
        blockedResult = findRelocatedSpanCandidate(secretQuote, 'src/origin.js', tmpProj);
      } finally {
        fs.readFileSync = origReadFileSync;
      }

      assert.equal(blockedResult, null, 'Sensitive files, ignored dirs, NUL/oversized files, and escaping symlinks must all return null');
      const envAbs = fs.realpathSync(path.join(projRoot, '.env'));
      const outsideReal = fs.realpathSync(outsideFile);
      assert.equal(readPaths.some((p) => p === envAbs || p.endsWith('/.env')), false, '.env must never be read');
      assert.equal(readPaths.some((p) => p === outsideReal || p.startsWith(outsideDir)), false, 'Symlink target outside workspace must never be read');

      // Sibling-first priority under 250-file cap + readAnchoredFileCached cache hit across multiple evaluations
      const aaaDir = path.join(projRoot, 'aaa_bulk');
      fs.mkdirSync(aaaDir, { recursive: true });
      for (let i = 1; i <= 260; i++) {
        fs.writeFileSync(path.join(aaaDir, `filler_${String(i).padStart(3, '0')}.js`), `export const FILLER_${i} = ${i};\n`, 'utf8');
      }
      const legitPath = path.join(projRoot, 'src', 'legit.js');
      fs.writeFileSync(legitPath, `${secretQuote}\n  return keyId;\n}\n`, 'utf8');

      // Path-traversal in originalFile itself must also return null safely
      assert.equal(findRelocatedSpanCandidate(secretQuote, '../outside.js', tmpProj), null);

      const firstCandidate = findRelocatedSpanCandidate(secretQuote, 'src/origin.js', tmpProj);
      assert.equal(firstCandidate?.citation, 'src/legit.js#L1', 'Sibling directory src/ must be scanned before lexicographically earlier aaa_bulk/');

      // Second evaluation must hit readAnchoredFileCached (zero extra fs.readFileSync calls on unchanged workspace files)
      const realProjRoot = fs.realpathSync(projRoot);
      const secondRunReads = [];
      fs.readFileSync = function patchedSecondRead(target, ...rest) {
        const p = String(target);
        if (p.startsWith(realProjRoot)) {
          secondRunReads.push(p);
        }
        return origReadFileSync.call(fs, target, ...rest);
      };
      try {
        const cachedCandidate = findRelocatedSpanCandidate(secretQuote, 'src/origin.js', tmpProj);
        assert.equal(cachedCandidate?.citation, 'src/legit.js#L1');
      } finally {
        fs.readFileSync = origReadFileSync;
      }
      assert.equal(secondRunReads.length, 0, 'Unchanged workspace files must hit readAnchoredFileCached without re-reading disk');
    } finally {
      try {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      } catch {}
    }
  });

  await t.test('5. Unnormalized originalFile paths, internal symlink alias self-exclusion & standalone CR (\\r) line ranges', async () => {
    const tmpProj = `test_reloc_canonical_${Date.now()}`;
    const projRoot = resolveProjectPath(tmpProj);
    const policyDir = path.join(projRoot, 'src', 'policy');
    const sharedDir = path.join(projRoot, 'src', 'shared');
    fs.mkdirSync(policyDir, { recursive: true });
    fs.mkdirSync(sharedDir, { recursive: true });

    const selfQuote = 'export function enforceCanonicalSelfExclusion(req) {';
    fs.writeFileSync(
      path.join(policyDir, 'guard.js'),
      `// Policy guard\n${selfQuote}\n  return Boolean(req);\n}\n`,
      'utf8'
    );

    // Internal symlink directory inside workspace: src/policy-alias -> src/policy
    fs.symlinkSync(policyDir, path.join(projRoot, 'src', 'policy-alias'));

    // Unnormalized originalFile ('src//policy/./guard.js') must self-exclude src/policy/guard.js
    assert.equal(
      findRelocatedSpanCandidate(selfQuote, 'src//policy/./guard.js', tmpProj),
      null,
      'Unnormalized originalFile path must normalize and self-exclude its own canonical file'
    );

    // Internal symlinked originalFile ('src/policy-alias/guard.js') must also self-exclude src/policy/guard.js via origRealRel
    assert.equal(
      findRelocatedSpanCandidate(selfQuote, 'src/policy-alias/guard.js', tmpProj),
      null,
      'Internal symlink alias for originalFile must self-exclude canonical realpath target'
    );

    // Standalone CR (\r) line endings in destination file normalize cleanly against LF multi-line quote
    const lfMultiQuote = 'export function verifyStandaloneCrLineRange(\n  payload\n) {';
    const crOnlyTarget = [
      '// CR-only header',
      'export function verifyStandaloneCrLineRange(',
      '  payload',
      ') {',
      '  return payload;',
      '}'
    ].join('\r');
    fs.writeFileSync(path.join(sharedDir, 'cr-target.js'), crOnlyTarget, 'utf8');

    const crCandidate = findRelocatedSpanCandidate(lfMultiQuote, 'src//policy/./guard.js', tmpProj);
    assert.deepEqual(crCandidate, {
      file: 'src/shared/cr-target.js',
      locator: 'L2-L4',
      start_line: 2,
      end_line: 4,
      citation: 'src/shared/cr-target.js#L2-L4',
      match_kind: 'workspace_exact_quote',
      candidate_count: 1
    });
  });
});

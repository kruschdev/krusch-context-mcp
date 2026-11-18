import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
    addMemory,
    supersedeMemory,
    getHealthStats
} from '../src/memory-engine.js';
import { nuggetRemember, nuggetForget } from '../src/nuggets-engine.js';
import { handleProactiveNudge } from '../src/proactive-engine.js';
import { closeAllDatabases } from '../src/sqlite-engine.js';
import {
    parseDiffOldHunks,
    extractDiffTouchedFiles,
    compileSafeCoChangeGlob,
    evaluateCoChangeRules,
    coalesceLineRanges,
    formatLineRangesLabel,
    resolvePreEditSnippetRanges,
    extractCommitCausalRationale
} from '../src/git-alignment-guard.js';

function runGit(cwd, args) {
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'kruschdev',
            GIT_AUTHOR_EMAIL: 'kruschdev@users.noreply.github.com',
            GIT_COMMITTER_NAME: 'kruschdev',
            GIT_COMMITTER_EMAIL: 'kruschdev@users.noreply.github.com'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
}

test('Zero-LLM Git & Co-Change Alignment Guards (INV-ALIGN-BLAME-01 / STALE-02 / COCHANGE-03)', async (t) => {
    const tmpHomelab = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-align-guards-'));
    const projName = `test_align_${Date.now()}`;
    const repoDir = path.join(tmpHomelab, 'projects', projName);
    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'openapi'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'docs'), { recursive: true });

    const prevHomelabPath = process.env.HOMELAB_PATH;
    const prevOffline = process.env.KRUSCH_FORCE_REAL_OFFLINE;
    process.env.HOMELAB_PATH = tmpHomelab;
    process.env.KRUSCH_FORCE_REAL_OFFLINE = '1';

    t.after(() => {
        try { closeAllDatabases(); } catch {}
        if (prevHomelabPath === undefined) delete process.env.HOMELAB_PATH;
        else process.env.HOMELAB_PATH = prevHomelabPath;
        if (prevOffline === undefined) delete process.env.KRUSCH_FORCE_REAL_OFFLINE;
        else process.env.KRUSCH_FORCE_REAL_OFFLINE = prevOffline;
        fs.rmSync(tmpHomelab, { recursive: true, force: true });
    });

    // Initialize isolated real git repository
    runGit(repoDir, ['init']);
    runGit(repoDir, ['config', 'commit.gpgsign', 'false']);

    const errorStatusPath = path.join(repoDir, 'src', 'error-status.js');
    fs.writeFileSync(
        errorStatusPath,
        [
            'export function normalizeErrorStatus(code) {',
            '    if (typeof code !== "number") return 500;',
            '    if (code < 400 || code > 599) return 500;',
            '    return code;',
            '}',
            ''
        ].join('\n'),
        'utf8'
    );
    runGit(repoDir, ['add', 'src/error-status.js']);
    runGit(repoDir, ['commit', '-m', 'fix(http): clamp error handler status codes to 400-599 (#7089)']);
    const commit1Sha = runGit(repoDir, ['rev-parse', 'HEAD']);

    // Commit a whitespace-only re-indentation of src/error-status.js to verify `-w -M` sees through formatting commits!
    fs.writeFileSync(
        errorStatusPath,
        [
            'export function normalizeErrorStatus(code) {',
            '  if (typeof code !== "number") return 500;',
            '  if (code < 400 || code > 599) return 500;',
            '  return code;',
            '}',
            ''
        ].join('\n'),
        'utf8'
    );
    runGit(repoDir, ['add', 'src/error-status.js']);
    runGit(repoDir, ['commit', '-m', 'style(fmt): reindent error-status to 2 spaces (#12)']);

    const poolPath = path.join(repoDir, 'src', 'pool-config.js');
    fs.writeFileSync(
        poolPath,
        [
            'export const APP_NAME = "demo-service";',
            'export const POOL_CONFIG = {',
            '    maxConnections: 5,',
            '    idleTimeoutMs: 10000',
            '};',
            'export function getAppName() {',
            '    return APP_NAME;',
            '}',
            ''
        ].join('\n'),
        'utf8'
    );
    runGit(repoDir, ['add', 'src/pool-config.js']);
    runGit(repoDir, ['commit', '-m', 'feat(db): cap initial pool maxConnections at 5']);
    const oldPoolCommitSha = runGit(repoDir, ['rev-parse', 'HEAD']);

    await t.test('Unit primitives: hunk parser, quoted spaces, rename/copy extraction, multi-range labels, and snippet spans', () => {
        assert.deepEqual(coalesceLineRanges([14, 3, 4, 5, 9, 10, 4]), [[3, 5], [9, 10], [14, 14]]);
        assert.equal(
            formatLineRangesLabel('src/a.js', [[1, 3], [8, 8], [12, 15], [20, 22]]),
            'src/a.js#L1-L3,L8,L12-L15 (+1 more)'
        );
        assert.equal(compileSafeCoChangeGlob('openapi/**').valid, true);
        assert.equal(compileSafeCoChangeGlob('src/{a,b}.js').valid, false);
        assert.equal(compileSafeCoChangeGlob('!src/secret.js').valid, false);

        const quotedAndRenameDiff = [
            'diff --git "a/openapi/my spec.yaml" "b/openapi/my spec v2.yaml"',
            'similarity index 98%',
            'rename from "openapi/my spec.yaml"',
            'rename to "openapi/my spec v2.yaml"',
            'diff --git a/src/base.js b/src/copied.js',
            'copy from src/base.js',
            'copy to src/copied.js'
        ].join('\n');
        assert.deepEqual(extractDiffTouchedFiles(quotedAndRenameDiff), [
            'openapi/my spec.yaml',
            'openapi/my spec v2.yaml',
            'src/base.js',
            'src/copied.js'
        ]);

        const sampleFile = ['line 1', 'const limit = 400;', 'const max = 599;', 'line 4'].join('\n');
        assert.deepEqual(resolvePreEditSnippetRanges(sampleFile, 'const limit = 400;\nconst max = 599;'), [[2, 3]]);
        assert.deepEqual(
            resolvePreEditSnippetRanges(sampleFile, ['line 1', 'const limit = 100;', 'const max = 599;', 'line 4'].join('\n')),
            [[2, 2]]
        );

        const pureInsertDiff = [
            'diff --git a/dev/null b/src/brand-new.js',
            '--- /dev/null',
            '+++ b/src/brand-new.js',
            '@@ -0,0 +1,4 @@',
            '+export const x = 1;'
        ].join('\n');
        assert.equal(parseDiffOldHunks(pureInsertDiff).size, 0);

        const ruleCheck = evaluateCoChangeRules({
            diff: quotedAndRenameDiff,
            rules: [{ id: 'api-doc', whenGlobs: ['openapi/**'], requireGlobs: ['docs/changelog.md'] }]
        });
        assert.equal(ruleCheck.passed, false);
        assert.equal(ruleCheck.violations.length, 1);
    });

    await t.test('Cherry-Pick #1: Old-hunk & pre_edit snippet git blame -w -M sees through style commits and avoids bare #N / cross-project collisions', async () => {
        // Distractor 1: Unrelated memory mentioning bare `#12` (matches style commit `(#12)` if unguarded!)
        await addMemory({
            project: projName,
            category: 'decision',
            content: 'Unrelated note referencing Memory #12 from an earlier sprint.',
            force: true
        });

        // Distractor 2: Sibling project memory referencing commit1Sha in a DIFFERENT project (`projects/other-service/...`)
        await addMemory({
            project: projName,
            category: 'decision',
            content: `Other project note for projects/other-service/server.js at ${commit1Sha.slice(0, 10)}.`,
            provenance: {
                file: 'projects/other-service/server.js',
                commit: commit1Sha
            },
            force: true
        });

        // Real decision anchored to commit1Sha
        const res = await addMemory({
            project: projName,
            category: 'decision',
            content: 'HTTP responses below 400 must never flow through the error serializer because proxies cache 2xx/3xx error bodies.',
            provenance: {
                commit: commit1Sha.slice(0, 10),
                pr: '#7089',
                author: 'human'
            },
            force: true
        });
        const matchId = /#(\d+)/.exec(res.content[0].text)?.[1];
        assert.ok(matchId, 'Expected persisted decision memory ID');

        // A. `pre_edit` snippet (no unified diff header!) resolves line 3 and sees through `style(fmt)` via `-w -M`
        const preEditNudge = await handleProactiveNudge({
            project: projName,
            trigger: 'pre_edit',
            file_path: 'src/error-status.js',
            code: '  if (code < 400 || code > 599) return 500;'
        });
        assert.match(preEditNudge.content[0].text, new RegExp(`Rule #${matchId}`));
        assert.doesNotMatch(preEditNudge.content[0].text, /Unrelated note referencing Memory #12/);
        assert.doesNotMatch(preEditNudge.content[0].text, /other-service/);

        // B. Unified diff on `pre_commit` also attributes cleanly through the whitespace commit
        const proposedDiff = [
            'diff --git a/src/error-status.js b/src/error-status.js',
            '--- a/src/error-status.js',
            '+++ b/src/error-status.js',
            '@@ -2,3 +2,3 @@ export function normalizeErrorStatus(code) {',
            '   if (typeof code !== "number") return 500;',
            '-  if (code < 400 || code > 599) return 500;',
            '+  if (code < 100 || code > 599) return 500;',
            '   return code;'
        ].join('\n');

        const nudgeRes = await handleProactiveNudge({
            project: projName,
            trigger: 'pre_commit',
            code: proposedDiff
        });
        const text = nudgeRes.content[0].text;
        assert.match(text, new RegExp(`Rule #${matchId}`));
        assert.match(text, /Blame src\/error-status\.js#L2-L4 @ /);
        assert.doesNotMatch(text, /Unrelated note referencing Memory #12/);

        // Feedback loop (`false_positive`) silences blamed decisions cleanly
        await handleProactiveNudge({
            project: projName,
            action: 'feedback',
            rule_id: String(matchId),
            feedback: 'false_positive'
        });
        await handleProactiveNudge({
            project: projName,
            action: 'feedback',
            rule_id: String(matchId),
            feedback: 'false_positive'
        });
        const silencedRes = await handleProactiveNudge({
            project: projName,
            trigger: 'pre_commit',
            code: proposedDiff
        });
        assert.equal(silencedRes.content[0].text, 'NO_NUDGES_REQUIRED');
    });

    await t.test('Cherry-Pick #2: Span-scoped stale-code scan & re-ratified replacement exemption (#1072 -> #1073 guard)', async () => {
        // 1. Re-ratified milestone rollup: replacement keeps exact same file + quoted_sentence -> 0 stale findings!
        const wave1 = await addMemory({
            project: projName,
            category: 'decision',
            content: 'Wave 1: establish APP_NAME constant.',
            provenance: {
                file: 'src/pool-config.js',
                commit: oldPoolCommitSha,
                quoted_sentence: 'export const APP_NAME = "demo-service";',
                author: 'human'
            },
            force: true
        });
        const wave1Id = Number(/#(\d+)/.exec(wave1.content[0].text)[1]);
        await supersedeMemory({
            project: projName,
            id: wave1Id,
            category: 'decision',
            content: 'Wave 2: keep APP_NAME constant and expand telemetry.',
            provenance: {
                file: 'src/pool-config.js',
                commit: 'ffffffffffffffffffffffffffffffffffffffff',
                quoted_sentence: 'export const APP_NAME = "demo-service";',
                author: 'human'
            }
        });

        const healthReRatified = await getHealthStats({ project: projName });
        assert.equal(healthReRatified.stats.staleCodeFindings, 0);

        // 2. Span-scoped superseded decision on `maxConnections: 5` (lines 2-5 only, NOT lines 1 or 6-8!)
        const oldDec = await addMemory({
            project: projName,
            category: 'decision',
            content: 'Cap database pool at 5 connections during single-worker alpha.',
            provenance: {
                file: 'src/pool-config.js',
                commit: oldPoolCommitSha,
                quoted_sentence: '    maxConnections: 5,',
                author: 'human'
            },
            force: true
        });
        const oldId = Number(/#(\d+)/.exec(oldDec.content[0].text)[1]);

        await supersedeMemory({
            project: projName,
            id: oldId,
            category: 'decision',
            content: 'Raise database pool maxConnections to 24 across all production workers.'
        });

        const healthBefore = await getHealthStats({ project: projName });
        assert.equal(healthBefore.stats.staleCodeFindings, 1);
        assert.equal(healthBefore.stats.staleCodeLines, 1, 'Must blame ONLY the span-anchored line L3, not unrelated lines in pool-config.js');
        assert.match(healthBefore.content[0].text, /src\/pool-config\.js#L3\b/);

        // Update ONLY line 3 (`maxConnections: 24`) while leaving lines 1 and 6-8 untouched under oldPoolCommitSha!
        fs.writeFileSync(
            poolPath,
            [
                'export const APP_NAME = "demo-service";',
                'export const POOL_CONFIG = {',
                '    maxConnections: 24,',
                '    idleTimeoutMs: 10000',
                '};',
                'export function getAppName() {',
                '    return APP_NAME;',
                '}',
                ''
            ].join('\n'),
            'utf8'
        );
        runGit(repoDir, ['add', 'src/pool-config.js']);
        runGit(repoDir, ['commit', '-m', 'feat(db): raise pool maxConnections to 24']);

        const healthAfter = await getHealthStats({ project: projName });
        assert.equal(healthAfter.stats.staleCodeFindings, 0, 'Unrelated surviving lines in pool-config.js must not trigger false stale-code alerts');
        assert.equal(healthAfter.stats.staleCodeLines, 0);
    });

    await t.test('Cherry-Pick #3: Co-change companion-file gate catches missing companions, skips pre_edit, and surfaces malformed rule syntax', async () => {
        // Malformed rule with `{a,b}` braces must surface explicitly on pre_commit rather than failing silently!
        await nuggetRemember({
            active_project: projName,
            key: 'cochange:bad-glob',
            value: 'when: openapi/{v1,v2}/*.yaml | require: docs/changelog.md | Invalid brace glob'
        });

        const sampleDiff = [
            'diff --git a/openapi/orders.yaml b/openapi/orders.yaml',
            '--- /dev/null',
            '+++ b/openapi/orders.yaml',
            '@@ -0,0 +1,3 @@',
            '+openapi: 3.1.0'
        ].join('\n');

        const malformedRes = await handleProactiveNudge({
            project: projName,
            trigger: 'pre_commit',
            code: sampleDiff
        });
        assert.match(malformedRes.content[0].text, /Invalid co-change rule syntax in 'cochange:bad-glob'/);
        await nuggetForget({ key: 'cochange:bad-glob', project: projName });

        await nuggetRemember({
            active_project: projName,
            key: 'cochange:openapi-changelog',
            value: 'when: openapi/** | require: docs/changelog.md | Every OpenAPI spec edit must update docs/changelog.md'
        });

        // 1. Single-file `pre_edit` trigger must NOT false-positive on same-PR co-change rules
        const preEditRes = await handleProactiveNudge({
            project: projName,
            trigger: 'pre_edit',
            code: sampleDiff
        });
        assert.equal(preEditRes.content[0].text, 'NO_NUDGES_REQUIRED');

        // 2. `pre_commit` diff missing docs/changelog.md triggers deterministic co-change nudge
        const preCommitFail = await handleProactiveNudge({
            project: projName,
            trigger: 'pre_commit',
            code: sampleDiff
        });
        assert.match(preCommitFail.content[0].text, /cochange:openapi-changelog/);
        assert.match(preCommitFail.content[0].text, /missing companion update in docs\/changelog\.md/);

        // 3. `pre_commit` diff touching BOTH openapi/orders.yaml AND docs/changelog.md passes cleanly
        const completeDiff = [
            sampleDiff,
            'diff --git a/docs/changelog.md b/docs/changelog.md',
            '--- /dev/null',
            '+++ b/docs/changelog.md',
            '@@ -0,0 +1,2 @@',
            '+- Added orders OpenAPI spec'
        ].join('\n');
        const preCommitPass = await handleProactiveNudge({
            project: projName,
            trigger: 'pre_commit',
            code: completeDiff
        });
        assert.equal(preCommitPass.content[0].text, 'NO_NUDGES_REQUIRED');
    });

    await t.test('Cherry-Pick #4: Day-0 zero-setup git show causal commit rationale fallback & anti-zombie guard', async () => {
        assert.equal(
            extractCommitCausalRationale(
                'chore(deps): bump undici from 6.19.0 to 6.20.0',
                'Bumps undici from 6.19.0 to 6.20.0 because of upstream release.'
            ),
            null
        );

        const retryPath = path.join(repoDir, 'src', 'retry-backoff.js');
        fs.writeFileSync(
            retryPath,
            [
                'export function nextRetryDelayMs(attempt) {',
                '    return Math.min(30000, 250 * (2 ** attempt));',
                '}',
                ''
            ].join('\n'),
            'utf8'
        );
        runGit(repoDir, ['add', 'src/retry-backoff.js']);
        runGit(repoDir, [
            'commit',
            '-m',
            'fix(rpc): cap exponential backoff at 30s',
            '-m',
            'We cap retry backoff at 30s because unbounded delays exceed the 45s load-balancer idle timeout.\n\nFixes #901'
        ]);
        const retryShortSha = runGit(repoDir, ['rev-parse', 'HEAD']).slice(0, 7);

        // ZERO memories stored for retry-backoff.js in SQLite! Nudge still extracts the commit rationale live!
        const zeroSetupNudge = await handleProactiveNudge({
            project: projName,
            trigger: 'pre_edit',
            file_path: 'src/retry-backoff.js',
            code: '    return Math.min(30000, 250 * (2 ** attempt));'
        });
        const nudgeText = zeroSetupNudge.content[0].text;
        assert.match(nudgeText, new RegExp(`Rule #git:${retryShortSha}`));
        assert.match(nudgeText, /unbounded delays exceed the 45s load-balancer idle timeout/);
        assert.doesNotMatch(nudgeText, /Fixes #901/);

        // Developer can still silence `git:<shortSha>` via standard false_positive feedback!
        await handleProactiveNudge({
            project: projName,
            action: 'feedback',
            rule_id: `git:${retryShortSha}`,
            feedback: 'false_positive'
        });
        await handleProactiveNudge({
            project: projName,
            action: 'feedback',
            rule_id: `git:${retryShortSha}`,
            feedback: 'false_positive'
        });
        const silencedGitNudge = await handleProactiveNudge({
            project: projName,
            trigger: 'pre_edit',
            file_path: 'src/retry-backoff.js',
            code: '    return Math.min(30000, 250 * (2 ** attempt));'
        });
        assert.equal(silencedGitNudge.content[0].text, 'NO_NUDGES_REQUIRED');
    });
});

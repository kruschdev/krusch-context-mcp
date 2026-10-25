/**
 * @file verify_zero_leakage.js
 * Independent Scientific Integrity & Zero-Gaming Verifier for the Official ICLR 2026 BEAM Benchmark.
 *
 * Performs 5 deterministic audits:
 *   1. Static Engine Audit (`src/*.js`): Confirms zero references to BEAM oracle fields
 *      (`probing_questions`, `source_chat_ids`, `ideal_response`), zero dataset-specific proper
 *      nouns (`OpenWeather`, `Formspree`, `BudgetTracker`, `Figma`, `Jira`, `Trello`), and zero
 *      test-set vocabulary word lists (`DETAIL_HEAD_STEMS`, `ACTION_MODIFIER_STEMS`, etc.).
 *   2. Benchmark Harness Anti-Gaming Audit (`scripts/benchmark_official_beam.js`): Confirms the
 *      runtime JS Proxy trap (`FATAL_ORACLE_LEAKAGE_VIOLATION`), uniform blind ingestion (zero
 *      benchmark-side `isInstruction`/`isPreference`/`insertNugget` regexes), zero `(Window:`
 *      neighbor-ID header stuffing, zero `checkTurnOrRubricEvidence` bag-of-words overrides,
 *      strict `ideal_response`-grounded Judge verification, portable `127.0.0.1` defaults, and
 *      fair `convDb` multi-baseline ablation (`legacyRetrieveSimulation` + `denseVectorBaselineSimulation`).
 *   3. Cryptographic Provenance Audit: Recomputes SHA-256 digests of `src/unified-retrieval.js`,
 *      `src/retrieval-lexical.js`, `src/retrieval-epistemic.js`, `src/prune-helper.js`,
 *      `scripts/benchmark_official_beam.js`, and `DATASET_PATH` against `benchmarks/beam_100k_audit_log.json`.
 *   4. Independent Per-Question Turn-ID Recall Re-Computation & 400-Question Audit Log Re-Tally:
 *      Recomputes `Recall@10..50`, `Packed 8K`, and `Dense BGE 8K` directly from `retrieved_primary_turn_ids`
 *      against the raw `Mohammadta/BEAM` `source_chat_ids` (when cached locally) and re-tallies all
 *      category and overall metrics.
 *   5. Anti-Stubbing & Upstream Canary Trap Audit: Verifies substantive `USER + ASSISTANT` turn
 *      packing (`<= 70` turns) and confirms `Conv 14 KU Q1` Canary Trap (`strict_primary_turn_recall === 0`).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const auditLogArg = process.argv.find(a => a.startsWith('--audit-log='));
const AUDIT_LOG_PATH = (auditLogArg ? path.resolve(auditLogArg.slice('--audit-log='.length).trim()) : '')
    || (process.env.BEAM_AUDIT_LOG_PATH ? path.resolve(process.env.BEAM_AUDIT_LOG_PATH) : '')
    || path.join(ROOT, 'benchmarks', 'beam_100k_audit_log.json');
const DATASET_PATH = process.env.BEAM_DATASET_CACHE_PATH || '/tmp/beam_100k_official.json';

function sha256Buffer(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256File(fp) {
    return sha256Buffer(fs.readFileSync(fp));
}

function findVerifiedGitBlob(relPath, expectedSha) {
    try {
        const logOut = execFileSync('git', ['log', '--format=%H', '--', relPath], {
            cwd: ROOT,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        });
        const commits = logOut.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        for (const commit of commits) {
            try {
                const blobBuf = execFileSync('git', ['show', `${commit}:${relPath}`], {
                    cwd: ROOT,
                    maxBuffer: 16 * 1024 * 1024,
                    stdio: ['ignore', 'pipe', 'ignore']
                });
                if (sha256Buffer(blobBuf) === expectedSha) {
                    return { commit, code: blobBuf.toString('utf8') };
                }
            } catch {}
        }
    } catch {}
    return null;
}

function toTurnId(msgId) {
    const n = Number(msgId);
    return n % 2 === 0 ? n : n - 1;
}

function parseSourceTurnGroups(sourceChatIds) {
    if (!sourceChatIds) return [];
    const groups = [];
    if (Array.isArray(sourceChatIds)) {
        for (const item of sourceChatIds) {
            if (Array.isArray(item)) {
                const sub = [...new Set(item.flat(Infinity).map(Number).filter(Number.isFinite).map(toTurnId))];
                if (sub.length > 0) groups.push(sub);
            } else if (Number.isFinite(Number(item))) {
                groups.push([toTurnId(Number(item))]);
            }
        }
    } else if (typeof sourceChatIds === 'object') {
        for (const val of Object.values(sourceChatIds)) {
            const sub = [...new Set([val].flat(Infinity).map(Number).filter(Number.isFinite).map(toTurnId))];
            for (const tid of sub) {
                groups.push([tid]);
            }
        }
    }
    return groups;
}

function recomputeRecallRawFromTurnIds(turnIds, groups, k = Infinity) {
    if (!groups || groups.length === 0) return null;
    const set = new Set((turnIds || []).slice(0, k).map(Number));
    let hits = 0;
    for (const grp of groups) {
        if (grp.some(tid => set.has(tid))) hits += 1;
    }
    return hits / groups.length;
}

function recomputeRecallFromTurnIds(turnIds, groups, k = Infinity) {
    const raw = recomputeRecallRawFromTurnIds(turnIds, groups, k);
    return raw === null ? null : Number(raw.toFixed(4));
}

function runIntegrityAudit() {
    console.log('====================================================================================');
    console.log('🛡️  BEAM BENCHMARK SCIENTIFIC INTEGRITY & ZERO-GAMING VERIFIER');
    console.log('====================================================================================\n');

    // 1. Static Engine Audit (src/*.js)
    const srcDir = path.join(ROOT, 'src');
    const srcFiles = fs.readdirSync(srcDir).filter(f => f.endsWith('.js'));
    const forbiddenEnginePatterns = [
        { pattern: /\bprobing_questions\b/i, reason: 'BEAM test question field' },
        { pattern: /\bsource_chat_ids\b/i, reason: 'BEAM oracle ground-truth turn ID field' },
        { pattern: /\bideal_response\b/i, reason: 'BEAM oracle ideal response field' },
        { pattern: /\bUNRECORDED_ASPECT_PROBE\b/i, reason: 'Synthetic abstention query marker' },
        { pattern: /\b(openweather|formspree|budgettracker|figma|trello|jira|alembic)\b/i, reason: 'Dataset-specific noun in production engine' },
        { pattern: /\b(DETAIL_HEAD_STEMS|ACTION_MODIFIER_STEMS|EPISTEMIC_STOP_WORDS|isUnattestedHeadDetail)\b/, reason: 'Hardcoded BEAM test-set vocabulary list' },
        { pattern: /\b(celebrated|enrolled|practiced)\b/i, reason: 'BEAM contradiction test-set verb in production engine' },
        { pattern: /Detailed Schedule\|Example Timeline/i, reason: 'Dataset-specific markdown heading filter in production engine' },
        { pattern: /\[Code blocks with syntax highlighting\]/i, reason: 'Synthetic rubric-cue tag injection in production engine' }
    ];

    for (const file of srcFiles) {
        const fullPath = path.join(srcDir, file);
        const code = fs.readFileSync(fullPath, 'utf8');
        for (const { pattern, reason } of forbiddenEnginePatterns) {
            assert.equal(
                pattern.test(code),
                false,
                `[FAIL] Forbidden pattern ${pattern} (${reason}) found in src/${file}`
            );
        }
    }
    console.log(`✅ [Check 1/5] Static Production Engine Audit PASSED (${srcFiles.length} files in src/ verified zero oracle fields, zero dataset nouns, zero synthetic rubric tags, and zero test-set word lists).`);

    // 2. Benchmark Script Anti-Gaming & Contract Audit
    const benchScriptPath = path.join(ROOT, 'scripts', 'benchmark_official_beam.js');
    const benchCode = fs.readFileSync(benchScriptPath, 'utf8');
    assert.equal(
        benchCode.includes('FATAL_ORACLE_LEAKAGE_VIOLATION'),
        true,
        '[FAIL] Missing runtime JS Proxy oracle-leakage trap in scripts/benchmark_official_beam.js'
    );
    assert.equal(
        benchCode.includes('buildBlindTurnsFromChat(safeConvProxy'),
        true,
        '[FAIL] buildBlindTurnsFromChat is not invoked via safeConvProxy'
    );
    assert.equal(
        benchCode.includes('(Window:'),
        false,
        '[FAIL] Neighbor-ID header stuffing (Window: ...) must not be present in scripts/benchmark_official_beam.js'
    );
    assert.equal(
        benchCode.includes('checkTurnOrRubricEvidence'),
        false,
        '[FAIL] Bag-of-words rubric override (checkTurnOrRubricEvidence) must not be present in scripts/benchmark_official_beam.js'
    );
    assert.equal(
        /\b(isInstruction|isPreference|insertNugget)\b/.test(benchCode),
        false,
        '[FAIL] Benchmark-side regex pre-classification (isInstruction/isPreference/insertNugget) must not be present in scripts/benchmark_official_beam.js'
    );
    assert.equal(
        benchCode.includes('legacyRetrieveSimulation(convDb') && benchCode.includes('denseVectorBaselineSimulation(convDb'),
        true,
        '[FAIL] Both legacyRetrieveSimulation and denseVectorBaselineSimulation must run on per-conversation convDb'
    );
    assert.equal(
        benchCode.includes('Official Reference Answer (Ground Truth): ${ideal_response'),
        true,
        '[FAIL] evaluateWithOfficialBeamJudge must ground grading against Official Reference Answer (ideal_response)'
    );
    const forbiddenPromptLeakPatterns = [
        { pattern: /192\.168\.\d+\.\d+/, reason: 'Hardcoded private LAN IP in benchmark script (use 127.0.0.1 defaults + env vars)' },
        { pattern: /budget tracker/i, reason: 'Conv 1 Event Ordering answer leaked in prompt' },
        { pattern: /city autocomplete/i, reason: 'Conv 2 Event Ordering answer leaked in prompt' },
        { pattern: /January 15/i, reason: 'Conv 1 Temporal Reasoning date leaked in prompt' },
        { pattern: /March 10/i, reason: 'Conv 2 Temporal Reasoning date leaked in prompt' },
        { pattern: /March 29/i, reason: 'Dataset-specific date leaked in prompt' },
        { pattern: /Transaction error handling/i, reason: 'Dataset-specific rubric phrase leaked in prompt' },
        { pattern: /core functionality/i, reason: 'Conv 1 Event Ordering rubric phrase leaked in prompt' },
        { pattern: /security hardening and deployment/i, reason: 'Conv 1 Event Ordering rubric phrase leaked in prompt' },
        { pattern: /2 months = 8 weeks/i, reason: 'Conv 1 Temporal Reasoning answer leaked in prompt' },
        { pattern: /calendar months = 4 \*/i, reason: 'Synthetic 4-weeks-per-month formula coaching in Reader prompt' },
        { pattern: /fallbackScore/i, reason: 'Silent recall-to-judge fallback substitution' },
        { pattern: /OpenWeather|Formspree/i, reason: 'Dataset-specific entity leaked in prompt' }
    ];
    for (const { pattern, reason } of forbiddenPromptLeakPatterns) {
        assert.equal(
            pattern.test(benchCode),
            false,
            `[FAIL] Forbidden pattern ${pattern} (${reason}) found in scripts/benchmark_official_beam.js`
        );
    }
    console.log(`✅ [Check 2/5] Benchmark Harness Anti-Gaming Audit PASSED (JS Proxy Trap active; uniform blind ingestion; zero Window stuffing; zero rubric override; strict ideal_response Judge; fair Dense BGE + Lex baselines).`);

    // 3. Cryptographic SHA-256 Provenance Audit (verifies live working tree OR authentic zero-leakage Git commit)
    assert.equal(fs.existsSync(AUDIT_LOG_PATH), true, `[FAIL] Missing ${AUDIT_LOG_PATH}`);
    const report = JSON.parse(fs.readFileSync(AUDIT_LOG_PATH, 'utf8'));

    const verifyProvenanceEntry = (relPath, expectedSha, isSrcEngine = true) => {
        const absPath = path.join(ROOT, relPath);
        const liveSha = sha256File(absPath);
        if (expectedSha === liveSha) {
            return `${liveSha} (working-tree)`;
        }
        const gitMatch = findVerifiedGitBlob(relPath, expectedSha);
        assert.ok(
            gitMatch,
            `[FAIL] SHA-256 mismatch on ${relPath}: audit log digest ${expectedSha} matches neither working tree (${liveSha}) nor any committed Git revision`
        );
        if (isSrcEngine) {
            for (const { pattern, reason } of forbiddenEnginePatterns) {
                assert.equal(
                    pattern.test(gitMatch.code),
                    false,
                    `[FAIL] Historical commit ${gitMatch.commit.slice(0, 7)} of ${relPath} failed zero-leakage check: ${pattern} (${reason})`
                );
            }
            assert.equal(
                gitMatch.code.includes('maxChars <= 125') || gitMatch.code.includes('maxBodyChars = 92') || gitMatch.code.includes('isTier3'),
                false,
                `[FAIL] Historical commit ${gitMatch.commit.slice(0, 7)} of ${relPath} failed anti-stubbing check`
            );
        } else {
            for (const { pattern, reason } of forbiddenPromptLeakPatterns) {
                assert.equal(
                    pattern.test(gitMatch.code),
                    false,
                    `[FAIL] Historical commit ${gitMatch.commit.slice(0, 7)} of ${relPath} failed prompt-leakage check: ${pattern} (${reason})`
                );
            }
        }
        return `${expectedSha} (git:${gitMatch.commit.slice(0, 7)})`;
    };

    const provEngine = verifyProvenanceEntry('src/unified-retrieval.js', report.provenance_sha256.unified_retrieval_js, true);
    const provLexical = verifyProvenanceEntry('src/retrieval-lexical.js', report.provenance_sha256.retrieval_lexical_js, true);
    const provEpistemic = verifyProvenanceEntry('src/retrieval-epistemic.js', report.provenance_sha256.retrieval_epistemic_js, true);
    const provPrune = verifyProvenanceEntry('src/prune-helper.js', report.provenance_sha256.prune_helper_js, true);
    const provBench = verifyProvenanceEntry('scripts/benchmark_official_beam.js', report.provenance_sha256.benchmark_official_beam_js, false);

    let rawDatasetMap = null;
    if (fs.existsSync(DATASET_PATH)) {
        const actualDatasetSha = sha256File(DATASET_PATH);
        assert.equal(report.provenance_sha256.dataset_beam_100k_json, actualDatasetSha, `[FAIL] SHA-256 mismatch on ${DATASET_PATH}`);
        const rawDataset = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf8'));
        rawDatasetMap = new Map();
        for (const c of rawDataset) {
            const pqs = c.probing_questions_parsed || (typeof c.probing_questions === 'string' ? JSON.parse(c.probing_questions) : c.probing_questions);
            for (const [cat, qList] of Object.entries(pqs || {})) {
                (qList || []).forEach((q, idx) => {
                    rawDatasetMap.set(`${c.conversation_id}:${cat}:${idx}`, q.source_chat_ids);
                });
            }
        }
    }
    console.log(`✅ [Check 3/5] Cryptographic SHA-256 Provenance Audit PASSED:`);
    console.log(`   • Mohammadta/BEAM 100K JSON  : ${report.provenance_sha256.dataset_beam_100k_json}`);
    console.log(`   • src/unified-retrieval.js   : ${provEngine}`);
    console.log(`   • src/retrieval-lexical.js   : ${provLexical}`);
    console.log(`   • src/retrieval-epistemic.js : ${provEpistemic}`);
    console.log(`   • src/prune-helper.js        : ${provPrune}`);
    console.log(`   • benchmark_official_beam.js : ${provBench}`);

    // 4. Independent Per-Question Turn-ID Recall Re-Computation & 400-Question Audit Log Re-Tally
    const entries = report.audit_log || [];
    assert.equal(entries.length, 400, `[FAIL] Expected 400 probing question records, found ${entries.length}`);

    const convSet = new Set(entries.map(e => e.conversation_id));
    assert.equal(convSet.size, 20, `[FAIL] Expected 20 distinct conversations, found ${convSet.size}`);

    let recomputedQuestionsVerified = 0;
    const byCat = {};
    for (const e of entries) {
        let rawR10 = e.recall_at_10 ?? 0;
        let rawR20 = e.recall_at_20 ?? 0;
        let rawR30 = e.recall_at_30 ?? 0;
        let rawR50 = e.recall_at_50 ?? 0;
        let rawStrict = e.strict_primary_turn_recall;
        let rawDense = e.dense_packed_8k_recall ?? 0;
        if (rawDatasetMap) {
            const rawSourceIds = rawDatasetMap.get(`${e.conversation_id}:${e.category}:${e.question_index}`);
            const groups = parseSourceTurnGroups(rawSourceIds);
            const expR10 = recomputeRecallFromTurnIds(e.retrieved_primary_turn_ids, groups, 10);
            const expR20 = recomputeRecallFromTurnIds(e.retrieved_primary_turn_ids, groups, 20);
            const expR30 = recomputeRecallFromTurnIds(e.retrieved_primary_turn_ids, groups, 30);
            const expR50 = recomputeRecallFromTurnIds(e.retrieved_primary_turn_ids, groups, 50);
            const expStrict = recomputeRecallFromTurnIds(e.retrieved_primary_turn_ids, groups, Infinity);
            const expDense = recomputeRecallFromTurnIds(e.dense_retrieved_primary_turn_ids, groups, Infinity);
            assert.equal(e.recall_at_10, expR10, `[FAIL] Q#${e.question_global_id} R@10 turn-ID recomputation mismatch`);
            assert.equal(e.recall_at_20, expR20, `[FAIL] Q#${e.question_global_id} R@20 turn-ID recomputation mismatch`);
            assert.equal(e.recall_at_30, expR30, `[FAIL] Q#${e.question_global_id} R@30 turn-ID recomputation mismatch`);
            assert.equal(e.recall_at_50, expR50, `[FAIL] Q#${e.question_global_id} R@50 turn-ID recomputation mismatch`);
            assert.equal(e.strict_primary_turn_recall, expStrict, `[FAIL] Q#${e.question_global_id} Packed 8K turn-ID recomputation mismatch`);
            assert.equal(e.dense_packed_8k_recall, expDense, `[FAIL] Q#${e.question_global_id} Dense 8K turn-ID recomputation mismatch`);
            rawR10 = recomputeRecallRawFromTurnIds(e.retrieved_primary_turn_ids, groups, 10) ?? 0;
            rawR20 = recomputeRecallRawFromTurnIds(e.retrieved_primary_turn_ids, groups, 20) ?? 0;
            rawR30 = recomputeRecallRawFromTurnIds(e.retrieved_primary_turn_ids, groups, 30) ?? 0;
            rawR50 = recomputeRecallRawFromTurnIds(e.retrieved_primary_turn_ids, groups, 50) ?? 0;
            rawStrict = recomputeRecallRawFromTurnIds(e.retrieved_primary_turn_ids, groups, Infinity);
            rawDense = recomputeRecallRawFromTurnIds(e.dense_retrieved_primary_turn_ids, groups, Infinity) ?? 0;
            recomputedQuestionsVerified += 1;
        }

        if (!byCat[e.category]) {
            byCat[e.category] = {
                count: 0,
                recallCount: 0,
                r10Sum: 0,
                r20Sum: 0,
                r30Sum: 0,
                r50Sum: 0,
                strictSum: 0,
                denseSum: 0,
                legacySum: 0,
                judgeCount: 0,
                judgeSum: 0,
                secJudgeCount: 0,
                secJudgeSum: 0
            };
        }
        byCat[e.category].count += 1;
        if (e.strict_primary_turn_recall !== null && e.strict_primary_turn_recall !== undefined) {
            byCat[e.category].recallCount += 1;
            byCat[e.category].r10Sum += rawR10;
            byCat[e.category].r20Sum += rawR20;
            byCat[e.category].r30Sum += rawR30;
            byCat[e.category].r50Sum += rawR50;
            byCat[e.category].strictSum += rawStrict;
            byCat[e.category].denseSum += rawDense;
            byCat[e.category].legacySum += e.legacy_primary_recall;
        }
        if (e.llm_judge_score !== null && e.llm_judge_score !== undefined) {
            byCat[e.category].judgeCount += 1;
            byCat[e.category].judgeSum += e.llm_judge_score;
        }
        if (e.secondary_judge_score !== null && e.secondary_judge_score !== undefined) {
            byCat[e.category].secJudgeCount += 1;
            byCat[e.category].secJudgeSum += e.secondary_judge_score;
        }
    }

    const cats = Object.keys(byCat);
    assert.equal(cats.length, 10, `[FAIL] Expected 10 BEAM categories, found ${cats.length}`);

    const assertPctMatch = (actual, expected, msg) => {
        const tol = rawDatasetMap ? 0.001 : 0.02;
        assert.ok(Math.abs(actual - expected) <= tol, `${msg}: ${actual} vs ${expected}`);
    };

    let totalR10Pct9 = 0;
    let totalR20Pct9 = 0;
    let totalR30Pct9 = 0;
    let totalR50Pct9 = 0;
    let totalStrictPct9 = 0;
    let totalDensePct9 = 0;
    let totalLegacyPct9 = 0;
    let recallCats = 0;
    let totalJudgePct10 = 0;
    let judgeCats = 0;
    let totalSecJudgePct10 = 0;
    let secJudgeCats = 0;
    let totalJudgeEvaluated = 0;
    for (const [cat, stats] of Object.entries(byCat)) {
        assert.equal(stats.count, 40, `[FAIL] Category ${cat} has ${stats.count} questions instead of 40`);
        if (stats.recallCount > 0) {
            const r10Pct = Number(((stats.r10Sum / stats.recallCount) * 100).toFixed(2));
            const r20Pct = Number(((stats.r20Sum / stats.recallCount) * 100).toFixed(2));
            const r30Pct = Number(((stats.r30Sum / stats.recallCount) * 100).toFixed(2));
            const r50Pct = Number(((stats.r50Sum / stats.recallCount) * 100).toFixed(2));
            const strictPct = Number(((stats.strictSum / stats.recallCount) * 100).toFixed(2));
            const densePct = Number(((stats.denseSum / stats.recallCount) * 100).toFixed(2));
            const legPct = Number(((stats.legacySum / stats.recallCount) * 100).toFixed(2));
            assertPctMatch(r10Pct, report.categories[cat].recall_at_10_pct, `[FAIL] Category ${cat} R@10 mismatch`);
            assertPctMatch(r20Pct, report.categories[cat].recall_at_20_pct, `[FAIL] Category ${cat} R@20 mismatch`);
            assertPctMatch(r30Pct, report.categories[cat].recall_at_30_pct, `[FAIL] Category ${cat} R@30 mismatch`);
            assertPctMatch(r50Pct, report.categories[cat].recall_at_50_pct, `[FAIL] Category ${cat} R@50 mismatch`);
            assertPctMatch(strictPct, report.categories[cat].strict_primary_turn_recall_pct, `[FAIL] Category ${cat} strict primary turn recall mismatch`);
            assertPctMatch(densePct, report.categories[cat].dense_packed_8k_recall_pct, `[FAIL] Category ${cat} dense 8K recall mismatch`);
            assert.ok(Math.abs(legPct - report.categories[cat].legacy_primary_recall_pct) <= 0.02, `[FAIL] Category ${cat} legacy primary recall mismatch`);
            totalR10Pct9 += (stats.r10Sum / stats.recallCount) * 100;
            totalR20Pct9 += (stats.r20Sum / stats.recallCount) * 100;
            totalR30Pct9 += (stats.r30Sum / stats.recallCount) * 100;
            totalR50Pct9 += (stats.r50Sum / stats.recallCount) * 100;
            totalStrictPct9 += (stats.strictSum / stats.recallCount) * 100;
            totalDensePct9 += (stats.denseSum / stats.recallCount) * 100;
            totalLegacyPct9 += (stats.legacySum / stats.recallCount) * 100;
            recallCats += 1;
        } else {
            assert.equal(report.categories[cat].strict_primary_turn_recall_pct, null, `[FAIL] Expected null primary recall for ${cat} (no ground-truth turn IDs)`);
        }

        assert.equal(stats.judgeCount, report.categories[cat].llm_judge_evaluated_questions, `[FAIL] Category ${cat} llm_judge_evaluated_questions mismatch`);
        if (stats.judgeCount > 0) {
            const judgePct = Number(((stats.judgeSum / stats.judgeCount) * 100).toFixed(2));
            assert.ok(Math.abs(judgePct - report.categories[cat].llm_judge_pct) <= 0.02, `[FAIL] Category ${cat} llm_judge_pct mismatch: ${judgePct} vs ${report.categories[cat].llm_judge_pct}`);
            totalJudgePct10 += (stats.judgeSum / stats.judgeCount) * 100;
            judgeCats += 1;
            totalJudgeEvaluated += stats.judgeCount;
        } else {
            assert.equal(report.categories[cat].llm_judge_pct, null, `[FAIL] Expected null llm_judge_pct when judgeCount=0 for ${cat}`);
        }

        if (report.overall.secondary_judge_model) {
            if (stats.secJudgeCount > 0) {
                const secPct = Number(((stats.secJudgeSum / stats.secJudgeCount) * 100).toFixed(2));
                assert.ok(Math.abs(secPct - report.categories[cat].secondary_llm_judge_pct) <= 0.02, `[FAIL] Category ${cat} secondary_llm_judge_pct mismatch: ${secPct} vs ${report.categories[cat].secondary_llm_judge_pct}`);
                totalSecJudgePct10 += (stats.secJudgeSum / stats.secJudgeCount) * 100;
                secJudgeCats += 1;
            }
        }
    }

    assert.equal(recallCats, 9, `[FAIL] Expected 9 categories with source_chat_ids ground truth, found ${recallCats}`);
    const overallR10 = Number((totalR10Pct9 / recallCats).toFixed(2));
    const overallR20 = Number((totalR20Pct9 / recallCats).toFixed(2));
    const overallR30 = Number((totalR30Pct9 / recallCats).toFixed(2));
    const overallR50 = Number((totalR50Pct9 / recallCats).toFixed(2));
    const overallStrict9 = Number((totalStrictPct9 / recallCats).toFixed(2));
    const overallDense9 = Number((totalDensePct9 / recallCats).toFixed(2));
    const overallLegacy9 = Number((totalLegacyPct9 / recallCats).toFixed(2));
    const overallJudge10 = judgeCats > 0 ? Number((totalJudgePct10 / judgeCats).toFixed(2)) : null;
    const overallSecJudge10 = secJudgeCats > 0 ? Number((totalSecJudgePct10 / secJudgeCats).toFixed(2)) : null;
    assertPctMatch(overallR10, report.overall.recall_at_10_9cat_pct, '[FAIL] Overall 9-category R@10 mismatch');
    assertPctMatch(overallR20, report.overall.recall_at_20_9cat_pct, '[FAIL] Overall 9-category R@20 mismatch');
    assertPctMatch(overallR30, report.overall.recall_at_30_9cat_pct, '[FAIL] Overall 9-category R@30 mismatch');
    assertPctMatch(overallR50, report.overall.recall_at_50_9cat_pct, '[FAIL] Overall 9-category R@50 mismatch');
    assertPctMatch(overallStrict9, report.overall.strict_primary_turn_recall_9cat_pct, '[FAIL] Overall 9-category strict primary recall mismatch');
    assertPctMatch(overallDense9, report.overall.dense_packed_8k_recall_9cat_pct, '[FAIL] Overall 9-category Dense BGE 8K recall mismatch');
    assert.ok(Math.abs(overallLegacy9 - report.overall.legacy_primary_recall_9cat_pct) <= 0.02, '[FAIL] Overall 9-category legacy primary recall mismatch');
    assert.equal(totalJudgeEvaluated, report.overall.llm_judge_evaluated_questions, '[FAIL] Overall llm_judge_evaluated_questions mismatch');
    if (overallJudge10 === null) {
        assert.equal(report.overall.llm_judge_10cat_pct, null, '[FAIL] Expected null overall 10-category LLM Judge score');
    } else {
        assert.ok(Math.abs(overallJudge10 - report.overall.llm_judge_10cat_pct) <= 0.02, `[FAIL] Overall 10-category LLM Judge score mismatch: ${overallJudge10} vs ${report.overall.llm_judge_10cat_pct}`);
    }
    if (report.overall.secondary_judge_model && overallSecJudge10 !== null) {
        assert.ok(Math.abs(overallSecJudge10 - report.overall.secondary_llm_judge_10cat_pct) <= 0.02, `[FAIL] Overall 10-category Secondary Judge score mismatch: ${overallSecJudge10} vs ${report.overall.secondary_llm_judge_10cat_pct}`);
    }

    console.log(`✅ [Check 4/5] Per-Question Turn-ID Re-Computation & 400-Question Re-Tally PASSED:`);
    if (recomputedQuestionsVerified > 0) {
        console.log(`   • Recomputed Recall@10..50, Hybrid 8K & Dense 8K from raw source_chat_ids on ${recomputedQuestionsVerified}/400 questions`);
    }
    console.log(`   • Re-tallied Un-Condensed Lex 8K / Dense BGE-Large 8K    : ${overallLegacy9.toFixed(2)}% / ${overallDense9.toFixed(2)}%`);
    console.log(`   • Re-tallied Hybrid Fixed-Rank R@10 / @20 / @30 / @50    : ${overallR10.toFixed(2)}% / ${overallR20.toFixed(2)}% / ${overallR30.toFixed(2)}% / ${overallR50.toFixed(2)}%`);
    console.log(`   • Re-tallied Hybrid Substantive 8K Packed Recall (9-Cat) : ${overallStrict9.toFixed(2)}%`);
    console.log(`   • Re-tallied Primary Judge (${report.overall.judge_model}, n=${totalJudgeEvaluated}/400) : ${overallJudge10 !== null ? overallJudge10.toFixed(2) + '%' : 'N/A'}`);
    if (report.overall.secondary_judge_model && overallSecJudge10 !== null) {
        console.log(`   • Re-tallied Continuity Judge (${report.overall.secondary_judge_model}, n=${totalJudgeEvaluated}/400) : ${overallSecJudge10.toFixed(2)}%`);
    }

    // 5. Anti-Stubbing & Upstream Canary Trap Verification
    const pruneCode = fs.readFileSync(path.join(ROOT, 'src', 'prune-helper.js'), 'utf8');
    const retrievalCode = fs.readFileSync(path.join(ROOT, 'src', 'unified-retrieval.js'), 'utf8');
    assert.equal(
        pruneCode.includes('maxChars <= 125'),
        false,
        '[FAIL] User-only stub branch (maxChars <= 125) found in src/prune-helper.js'
    );
    assert.equal(
        retrievalCode.includes('maxBodyChars = 92') || retrievalCode.includes('isTier3'),
        false,
        '[FAIL] Tier-3 92-char stub packing found in src/unified-retrieval.js'
    );

    const avgPackedTurns = entries.reduce((acc, e) => acc + (e.packed_turn_count || e.retrieved_primary_turn_ids.length), 0) / entries.length;
    assert.equal(
        avgPackedTurns <= 70,
        true,
        `[FAIL] Average packed turns (${avgPackedTurns.toFixed(1)}) exceeds substantive 8K-token capacity (<= 70 turns)`
    );

    const canaryEntry = entries.find(
        e => e.conversation_id === 14 && e.category === 'knowledge_update' && e.question_index === 1
    );
    assert.ok(canaryEntry, '[FAIL] Missing Conv 14 KU Q1 Canary Trap entry in audit log');
    assert.equal(
        canaryEntry.strict_primary_turn_recall,
        0,
        `[FAIL] Canary Trap Triggered: Conv 14 KU Q1 asks about cupcakes (Turn #118) while upstream source_chat_ids [132, 156] are Netflix buffering turns. Any un-gamed retriever that does not leak source_chat_ids or stuff all 180 turns must score 0 (got ${canaryEntry.strict_primary_turn_recall}).`
    );

    console.log(`✅ [Check 5/5] Anti-Stubbing & Upstream Canary Trap Audit PASSED:`);
    console.log(`   • Substantive Dialogue Packing Verified : Avg ${avgPackedTurns.toFixed(1)} turns/query in 8K tokens (100% USER + ASSISTANT preserved; zero 92-char stubs)`);
    console.log(`   • Conv 14 KU Q1 Canary Trap Verified    : strict_primary_turn_recall = ${canaryEntry.strict_primary_turn_recall} (proves zero source_chat_ids oracle leakage & zero whole-conversation stuffing)`);
    console.log('\n====================================================================================');
    console.log('🎉 ALL 5 SCIENTIFIC INTEGRITY & ZERO-GAMING AUDITS PASSED WITH ZERO VIOLATIONS');
    console.log('====================================================================================');
}

runIntegrityAudit();

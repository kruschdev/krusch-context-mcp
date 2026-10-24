import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { addMemory } from '../src/memory-engine.js';
import { getProjectDb, resolveProjectPath, closeAllDatabases } from '../src/sqlite-engine.js';
import {
  unifiedRetrieve,
  detectActiveConflicts,
  extractQueryTokens,
  estimateTokens
} from '../src/unified-retrieval.js';
import { pool } from '../db/pool.js';

test('Round 2 Scientific Honesty & Epistemic Regression Suite (BUG-07, BUG-08, ARCH-05)', async (t) => {
  const uniqueTag = `r2_${Date.now()}`;
  const budgetProject = `test_beam_budget_${uniqueTag}`;
  const brokenProject = `test_beam_broken_${uniqueTag}`;
  const directiveProject = `test_beam_dir_${uniqueTag}`;

  await t.test('1. BUG-07: Suppresses false conflict storms on single-stem coding queries ("Could you show me how to implement a login feature?")', () => {
    const extracted = extractQueryTokens('Could you show me how to implement a login feature?');
    assert.deepEqual(extracted.domainTerms, ['login'], 'Pronouns ("you") and meta verbs ("implement", "feature") must be excluded from domainTerms');

    const padding = 'We also reviewed error handling, pagination, logging middleware, and deployment containers in detail. '.repeat(4);
    const turnA = {
      id: 12,
      type: 'memory',
      status: 'ACTIVE',
      content: `[Session 1 | Date: 10:00 AM, Mar 1, 2024 | Turn #12] USER: Can you help me wire the login button to our React router dashboard view and check session cookies? ${padding} | ASSISTANT: Sure, here is how to connect the login button.`
    };
    const turnB = {
      id: 44,
      type: 'memory',
      status: 'ACTIVE',
      content: `[Session 3 | Date: 02:15 PM, Mar 5, 2024 | Turn #44] USER: Honestly I have never built a login rate limiter with Redis token buckets before, though our React dashboard works well. ${padding} | ASSISTANT: Let us walk through Redis token buckets step by step.`
    };

    const conflicts = detectActiveConflicts([turnA, turnB], extracted.domainTerms);
    assert.equal(conflicts.length, 0, 'Single-stem coding query with low subject Jaccard must not emit false polarity conflicts');
  });

  await t.test('2. BUG-07: Detects true past-participle negation contradictions across multi-clause queries ("worked with Flask routes and handled HTTP requests")', () => {
    const extracted = extractQueryTokens('Have I worked with Flask routes and handled HTTP requests in this project?');
    const padding = 'Let us make sure our JSON serializers and status codes follow REST conventions across endpoints. '.repeat(4);
    const turnAffirmative = {
      id: 24,
      type: 'memory',
      status: 'ACTIVE',
      content: `[Session 1 | Date: 09:30 AM, Apr 2, 2024 | Turn #24] USER: I am trying to implement the basic homepage route with Flask, and I have managed to return static HTML. ${padding} | ASSISTANT: Great job organizing that Flask route.`
    };
    const turnNegated = {
      id: 58,
      type: 'memory',
      status: 'ACTIVE',
      content: `[Session 4 | Date: 04:10 PM, Apr 12, 2024 | Turn #58] USER: I have never written any Flask routes or handled HTTP requests in this project, so I am starting from scratch. ${padding} | ASSISTANT: No problem at all, let us start from the basics of Flask routing.`
    };

    const conflicts = detectActiveConflicts([turnAffirmative, turnNegated], extracted.domainTerms);
    assert.equal(conflicts.length, 1, 'Multi-clause experience negation within 150-char window must flag polarity contradiction');
    assert.equal(conflicts[0].conflict_type, 'polarity_contradiction');
    assert.deepEqual(conflicts[0].memory_ids, [24, 58]);
  });

  await t.test('3. BUG-08: Enforces strict token budget ceiling including timelineSection on small budgets (limit_tokens=600)', async () => {
    for (let s = 1; s <= 6; s++) {
      await addMemory({
        category: 'decision',
        content: `[Session ${s} | Date: 10:00 AM, May ${s}, 2024 | Turn #${s * 3}] USER: In Session ${s} we completed milestone ${s} of the timeline architecture migration, refactored module ${s}, and verified latency metrics across cluster ${s}. | ASSISTANT: Milestone ${s} recorded with full verification logs and latency benchmarks.`,
        project: budgetProject,
        force: true
      });
    }

    const budget = 600;
    const res = await unifiedRetrieve({
      query: 'chronological order timeline across sessions milestones',
      project: budgetProject,
      include_state: false,
      limit_tokens: budget
    });

    const text = res.content[0].text;
    const match = text.match(/\*\*Tokens\*\*:\s*~(\d+)\s*\/\s*Budget:\s*(\d+)/);
    assert.ok(match, 'Unified retrieval header must report token count and budget');
    const reportedTokens = Number(match[1]);
    const reportedBudget = Number(match[2]);
    assert.equal(reportedBudget, budget);
    assert.ok(
      reportedTokens <= budget,
      `Reported tokens (${reportedTokens}) must not exceed requested budget (${budget})`
    );
    assert.ok(
      estimateTokens(text) <= budget + 15,
      `Actual payload token estimate (${estimateTokens(text)}) must remain tightly bounded by budget (${budget})`
    );
  });

  await t.test('4. BUG-08: Emits STORAGE_ERROR instead of NO_KNOWN_SUPPORT when SQLite query throws', async () => {
    const db = await getProjectDb(brokenProject);
    db.exec('DROP TABLE ide_agent_memory;');

    const res = await unifiedRetrieve({
      query: 'authentication session timeout configuration',
      project: brokenProject,
      include_state: false,
      limit_tokens: 2000
    });

    assert.equal(res.epistemic_status, 'STORAGE_ERROR');
    assert.ok(res.storage_error, 'Response should expose storage_error diagnostic message');
    assert.ok(res.content[0].text.includes('STORAGE WARNING'));
    assert.ok(!res.content[0].text.includes('ABSTENTION (NO_KNOWN_SUPPORT)'));
  });

  await t.test('5. ARCH-05: Uniform category="decision" turns still preserve standing user directives via _isStandingDirective', async () => {
    const makeUnitVec = (sharedWeight, uniqueIdx) => {
      const v = new Array(1024).fill(0);
      v[0] = sharedWeight;
      v[uniqueIdx] = Math.sqrt(Math.max(0, 1 - sharedWeight * sharedWeight));
      return v;
    };
    const queryVec = makeUnitVec(1.0, 1); // unit vector along axis 0
    // Baseline coding-domain semantic similarity ~0.46 (realistic BGE baseline, independent of live Ollama / CI=true hash vectors)
    const directiveVec = makeUnitVec(0.46, 2);

    await addMemory({
      category: 'decision',
      content: `[Session 1 | Date: 08:00 AM, Jun 1, 2024 | Turn #1] USER: From now on, always format code examples using TypeScript strict mode and never use var declarations. | ASSISTANT: Understood, I will always use TypeScript strict mode.`,
      project: directiveProject,
      force: true,
      _embedding: directiveVec
    });
    for (let i = 2; i <= 8; i++) {
      await addMemory({
        category: 'decision',
        content: `[Session 2 | Date: 09:00 AM, Jun 2, 2024 | Turn #${i}] USER: Can you write a helper function to parse CSV invoices? | ASSISTANT: Here is a CSV invoice parser implementation.`,
        project: directiveProject,
        force: true,
        _embedding: makeUnitVec(0.78, 10 + i)
      });
    }

    const res = await unifiedRetrieve({
      query: 'write a helper function to parse CSV invoices',
      project: directiveProject,
      include_state: false,
      limit_tokens: 4000,
      _embedding: queryVec
    });

    assert.ok(
      res.content[0].text.includes('TypeScript strict mode'),
      'Standing directive stored uniformly as category="decision" must still be surfaced via content-level _isStandingDirective detection'
    );
  });

  t.after(async () => {
    closeAllDatabases();
    for (const p of [budgetProject, brokenProject, directiveProject]) {
      try {
        fs.rmSync(resolveProjectPath(p), { recursive: true, force: true });
      } catch {}
    }
    try {
      await pool.end();
    } catch {}
  });
});

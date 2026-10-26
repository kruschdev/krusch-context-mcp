import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { extractQueryTokens, stemToken } from '../src/retrieval-lexical.js';
import {
    buildMemoryLineageChain,
    detectActiveConflicts,
    detectTemporalUpdates,
    computeUnattestedQueryTerms,
    computeCorpusUnattestedTerms,
    evaluateAttributeGrounding
} from '../src/retrieval-epistemic.js';

test('Pillar 3: Compositional Attribute-Level Epistemic Grounding Suite (evaluateAttributeGrounding)', async (t) => {
    await t.test('0. Exports contract: preserves all 5 v1.9.0 exports plus evaluateAttributeGrounding', () => {
        assert.equal(typeof buildMemoryLineageChain, 'function');
        assert.equal(typeof detectActiveConflicts, 'function');
        assert.equal(typeof detectTemporalUpdates, 'function');
        assert.equal(typeof computeUnattestedQueryTerms, 'function');
        assert.equal(typeof computeCorpusUnattestedTerms, 'function');
        assert.equal(typeof evaluateAttributeGrounding, 'function');
    });

    await t.test('1. Entity attested in USER:, attribute word ONLY mentioned in ASSISTANT: suggestion (rawCosine = 0.43) -> UNATTESTED_ATTRIBUTE', () => {
        const candidateRows = [
            {
                id: 4,
                category: 'decision',
                status: 'ACTIVE',
                content: '[Session 1 | Date: Jan 10, 2026 | Turn #4/24] USER: My golden retriever Max loves swimming at the lake every Saturday morning. | ASSISTANT: That sounds great! Have you considered entering Max in a regional agility championship or getting a microchip passport?'
            },
            {
                id: 5,
                category: 'decision',
                status: 'ACTIVE',
                content: '[Session 1 | Date: Jan 10, 2026 | Turn #5/24] USER: Mostly we just stick to long trail hikes and beach fetch sessions. | ASSISTANT: Trail hikes and fetch are wonderful low-impact exercise.'
            }
        ];
        const packedItems = [
            { type: 'memory', id: 4, content: candidateRows[0].content }
        ];
        const { distinctiveTerms } = extractQueryTokens(
            'when did max enter the regional agility championship?'.toLowerCase()
        );

        const res = evaluateAttributeGrounding(distinctiveTerms, packedItems, candidateRows, {
            maxRawCosine: 0.43,
            isGenerativeAdvisory: false
        });

        assert.equal(res.status, 'UNATTESTED_ATTRIBUTE');
        assert.ok(res.attested_anchors.includes('max'), 'Entity "max" from USER: must be an attested anchor');
        assert.ok(
            res.unattested_user_terms.includes('agility') && res.unattested_user_terms.includes('championship'),
            'Words spoken ONLY by ASSISTANT: must be flagged in unattested_user_terms'
        );
        assert.ok(res.max_joint_user_coverage < 0.65);
        assert.equal(res.max_raw_cosine, 0.43);
    });

    await t.test('2. Disjoint-turn split ("Max" in Session 1 Turn #2 about dog diet; "registry" in Session 5 Turn #30 about Docker registry; rawCosine = 0.44) -> UNATTESTED_ATTRIBUTE & unlinked_attribute_terms flags "registry"', () => {
        const candidateRows = [
            {
                id: 2,
                category: 'decision',
                status: 'ACTIVE',
                content: '[Session 1 | Date: Jan 3, 2026 | Turn #2/40] USER: My dog Max is currently eating a grain-free salmon kibble diet twice daily. | ASSISTANT: Salmon kibble is a solid choice for coat health.'
            },
            {
                id: 3,
                category: 'decision',
                status: 'ACTIVE',
                content: '[Session 1 | Date: Jan 3, 2026 | Turn #3/40] USER: Max also gets freeze-dried liver treats after evening walks. | ASSISTANT: Noted!'
            },
            {
                id: 30,
                category: 'decision',
                status: 'ACTIVE',
                content: '[Session 5 | Date: Feb 19, 2026 | Turn #30/40] USER: We configured our private Docker container registry on port 5000 with mutual TLS. | ASSISTANT: Private container registry verified.'
            }
        ];

        // Even when BOTH Session 1 Turn #2 and Session 5 Turn #30 are packed and "registry" precedes "Max" in query order
        const packedItems = [
            { type: 'memory', id: 2, content: candidateRows[0].content },
            { type: 'memory', id: 30, content: candidateRows[2].content }
        ];
        const { distinctiveTerms } = extractQueryTokens('which registry is max in?'.toLowerCase());

        const res = evaluateAttributeGrounding(distinctiveTerms, packedItems, candidateRows, {
            maxRawCosine: 0.44,
            isGenerativeAdvisory: false
        });

        assert.equal(res.status, 'UNATTESTED_ATTRIBUTE');
        assert.ok(res.attested_anchors.includes('max'));
        assert.deepEqual(res.unlinked_attribute_terms, ['registry']);
        assert.equal(res.unattested_user_terms.length, 0);
        assert.equal(res.max_joint_user_coverage, 0.5);
        assert.equal(res.max_raw_cosine, 0.44);
    });

    await t.test('3. Genuine +-1 adjacent same-session turn answer (Turn #5 USER: names "Project Aurora", Turn #6 USER: sets budget to "$4,500") -> GROUNDED', () => {
        const candidateRows = [
            {
                id: 5,
                category: 'decision',
                status: 'ACTIVE',
                content: '[Session 2 | Date: Mar 8, 2026 | Turn #5/20] USER: Let us kick off Project Aurora for the Q3 analytics pipeline overhaul. | ASSISTANT: Great! Have you settled on a cloud budget for it yet?'
            },
            {
                id: 6,
                category: 'decision',
                status: 'ACTIVE',
                content: '[Session 2 | Date: Mar 8, 2026 | Turn #6/20] USER: Yes, we approved a total budget of $4,500 for compute and storage. | ASSISTANT: Logged $4,500 budget for Project Aurora.'
            }
        ];
        const packedItems = [
            { type: 'memory', id: 5, content: candidateRows[0].content },
            { type: 'memory', id: 6, content: candidateRows[1].content }
        ];
        const { distinctiveTerms } = extractQueryTokens(
            'what budget did we approve for project aurora?'.toLowerCase()
        );

        const res = evaluateAttributeGrounding(distinctiveTerms, packedItems, candidateRows, {
            maxRawCosine: 0.44,
            isGenerativeAdvisory: false
        });

        assert.equal(res.status, 'GROUNDED');
        assert.equal(res.unattested_user_terms.length, 0);
        assert.equal(res.unlinked_attribute_terms.length, 0);
        assert.equal(res.max_joint_user_coverage, 1);
    });

    await t.test('4. High raw cosine (rawCosine = 0.54 >= 0.50) zero-lexical-overlap paraphrase -> GROUNDED', () => {
        const candidateRows = [
            {
                id: 11,
                category: 'invariant',
                status: 'ACTIVE',
                content: '[Session 3 | Date: Apr 2, 2026 | Turn #11/30] USER: Every microservice endpoint emits RFC 7807 problem-details payloads whenever schema validation fails. | ASSISTANT: Recorded.'
            }
        ];
        const packedItems = [
            { type: 'memory', id: 11, content: candidateRows[0].content }
        ];
        const { distinctiveTerms } = extractQueryTokens(
            'how are http error responses formatted across backend apis?'.toLowerCase()
        );

        const res = evaluateAttributeGrounding(distinctiveTerms, packedItems, candidateRows, {
            maxRawCosine: 0.54,
            isGenerativeAdvisory: false
        });

        assert.equal(res.status, 'GROUNDED');
        assert.equal(res.max_raw_cosine, 0.54);
    });

    await t.test('5. isGenerativeAdvisory: true coding request -> GROUNDED early exit', () => {
        const candidateRows = [
            {
                id: 1,
                category: 'invariant',
                status: 'ACTIVE',
                content: '[Session 1 | Date: Apr 1, 2026 | Turn #1/10] USER: Always prefer pure ESM modules and strict JSDoc types. | ASSISTANT: Understood.'
            }
        ];
        const packedItems = [
            { type: 'memory', id: 1, content: candidateRows[0].content }
        ];
        const { distinctiveTerms } = extractQueryTokens(
            'please write an exponential backoff retry helper with jitter'.toLowerCase()
        );

        const res = evaluateAttributeGrounding(distinctiveTerms, packedItems, candidateRows, {
            maxRawCosine: 0.29,
            isGenerativeAdvisory: true
        });

        assert.equal(res.status, 'GROUNDED');
        assert.deepEqual(res.attested_anchors, []);
        assert.deepEqual(res.unattested_user_terms, []);
        assert.deepEqual(res.unlinked_attribute_terms, []);
        assert.equal(res.max_joint_user_coverage, 1);
        assert.equal(res.max_raw_cosine, 0.29);
    });

    await t.test('6. Completely unattested multi-term topic (rawCosine = 0.31, 0 anchors) -> UNSUPPORTED', () => {
        const candidateRows = [
            {
                id: 1,
                category: 'decision',
                status: 'ACTIVE',
                content: '[Session 1 | Date: May 1, 2026 | Turn #1/12] USER: Store embeddings as 4096-byte Float32Array blobs inside SQLite WAL tables. | ASSISTANT: Stored.'
            },
            {
                id: 2,
                category: 'decision',
                status: 'ACTIVE',
                content: '[Session 1 | Date: May 1, 2026 | Turn #2/12] USER: Authenticate hardware sessions via WebAuthn passkeys. | ASSISTANT: Configured.'
            }
        ];
        const packedItems = [
            { type: 'memory', id: 1, content: candidateRows[0].content }
        ];
        const { distinctiveTerms } = extractQueryTokens(
            'what kubernetes helm chart values did we configure for kafka brokers?'.toLowerCase()
        );

        const res = evaluateAttributeGrounding(distinctiveTerms, packedItems, candidateRows, {
            maxRawCosine: 0.31,
            isGenerativeAdvisory: false
        });

        assert.equal(res.status, 'UNSUPPORTED');
        assert.deepEqual(res.attested_anchors, []);
        assert.ok(res.unattested_user_terms.includes('kubernetes'));
        assert.ok(res.unattested_user_terms.includes('kafka'));
        assert.equal(res.max_joint_user_coverage, 0);
        assert.equal(res.max_raw_cosine, 0.31);
    });

    await t.test('7. Session boundary isolation & precomputed _userStems: adjacent row IDs in DIFFERENT sessions never merge into W_k', () => {
        const rowSess1 = {
            id: 10,
            _sessionId: 1,
            _userStems: new Set(['aurora', 'kick'].map(stemToken)),
            _userRaw: 'kick off project aurora',
            content: '[Session 1 | Turn #10] USER: Kick off Project Aurora. | ASSISTANT: Ready.'
        };
        const rowSess2 = {
            id: 11,
            _sessionId: 2,
            _userStems: new Set(['budget', 'hosting'].map(stemToken)),
            _userRaw: 'set hosting budget',
            content: '[Session 2 | Turn #11] USER: Set hosting budget. | ASSISTANT: Ok.'
        };
        const packedItems = [
            { type: 'memory', id: 10, _userStems: rowSess1._userStems, _userRaw: rowSess1._userRaw, content: rowSess1.content },
            { type: 'memory', id: 11, _userStems: rowSess2._userStems, _userRaw: rowSess2._userRaw, content: rowSess2.content }
        ];

        const res = evaluateAttributeGrounding(['aurora', 'budget'], packedItems, [rowSess1, rowSess2], {
            maxRawCosine: 0.44,
            isGenerativeAdvisory: false
        });

        assert.equal(res.status, 'UNATTESTED_ATTRIBUTE');
        assert.deepEqual(res.unlinked_attribute_terms, ['budget']);
        assert.equal(res.max_joint_user_coverage, 0.5);
    });

    await t.test('8. Ubiquitous stem exclusion (>40% dfUser) & INV-V2-03 static zero-leakage check on src/retrieval-epistemic.js', () => {
        const candidateRows = [];
        // Row 1 (Session 1): specific entity "nebula" + ubiquitous word "dashboard"
        candidateRows.push({
            id: 1,
            content: '[Session 1 | Turn #1] USER: Nebula analytics dashboard initialized with dark theme. | ASSISTANT: Ready.'
        });
        // Rows 2..7 (Sessions 2..3): ubiquitous word "dashboard" (>40% of 10 rows -> 8/10 rows)
        for (let i = 2; i <= 8; i++) {
            candidateRows.push({
                id: i,
                content: `[Session 2 | Turn #${i}] USER: Updated dashboard widget layout spacing #${i}. | ASSISTANT: Done.`
            });
        }
        // Row 9 (Session 4): ubiquitous word "dashboard" + unrelated "graphql federation"
        candidateRows.push({
            id: 9,
            content: '[Session 4 | Turn #9] USER: Configured graphql federation on the admin dashboard. | ASSISTANT: Configured.'
        });
        candidateRows.push({
            id: 10,
            content: '[Session 4 | Turn #10] USER: Checked build pipeline logs. | ASSISTANT: Clean.'
        });

        const packedItems = [
            { type: 'memory', id: 1, content: candidateRows[0].content },
            { type: 'memory', id: 9, content: candidateRows[8].content }
        ];

        const res = evaluateAttributeGrounding(
            ['nebula', 'analytics', 'dashboard', 'graphql', 'federation'],
            packedItems,
            candidateRows,
            { maxRawCosine: 0.44, isGenerativeAdvisory: false }
        );

        assert.equal(res.status, 'UNATTESTED_ATTRIBUTE');
        assert.equal(res.attested_anchors.at(-1), 'dashboard', 'Ubiquitous "dashboard" (dfUser=9) must sort last in attested_anchors');
        assert.ok(
            res.attested_anchors.indexOf('nebula') < res.attested_anchors.indexOf('dashboard'),
            'Highest-IDF anchor "nebula" must sort ahead of ubiquitous "dashboard"'
        );
        assert.deepEqual(res.unattested_user_terms, []);
        assert.equal(res.max_joint_user_coverage, 0.6);
        assert.ok(
            res.unlinked_attribute_terms.includes('graphql') && res.unlinked_attribute_terms.includes('federation'),
            'Ubiquitous "dashboard" (>40% dfUser) must not bridge unrelated Session 4 "graphql federation" to Session 1 "nebula"'
        );

        // Verify INV-V2-03 zero-leakage patterns on src/retrieval-epistemic.js
        const srcCode = fs.readFileSync(
            path.resolve(import.meta.dirname, '..', 'src', 'retrieval-epistemic.js'),
            'utf8'
        );
        const forbidden = [
            /\bprobing_questions\b/i,
            /\bsource_chat_ids\b/i,
            /\bideal_response\b/i,
            /\bUNRECORDED_ASPECT_PROBE\b/i,
            /\b(openweather|formspree|budgettracker|figma|trello|jira|alembic)\b/i,
            /\b(DETAIL_HEAD_STEMS|ACTION_MODIFIER_STEMS|EPISTEMIC_STOP_WORDS|isUnattestedHeadDetail)\b/,
            /\b(celebrated|enrolled|practiced)\b/i
        ];
        for (const pat of forbidden) {
            assert.equal(pat.test(srcCode), false, `src/retrieval-epistemic.js must not match forbidden pattern ${pat}`);
        }
    });

    await t.test('9. Sparse non-adjacent rescued turns in same session (Turn #2 vs Turn #58) do NOT merge into ±1 window W_k -> UNATTESTED_ATTRIBUTE', () => {
        // Simulates >KRUSCH_MAX_ACTIVE_SCAN rescue where only Turn #2 and Turn #58 of Session 1 are in allCandidateRows
        const sparseRescuedRows = [
            {
                id: 2,
                category: 'decision',
                status: 'ACTIVE',
                content: '[Session 1 | Date: Jan 02, 2026 | Turn #2/80] USER: Our dog Max eats salmon kibble twice daily. | ASSISTANT: Logged salmon kibble diet.'
            },
            {
                id: 58,
                category: 'decision',
                status: 'ACTIVE',
                content: '[Session 1 | Date: Jan 02, 2026 | Turn #58/80] USER: Pushed our container image to the Harbor registry endpoint. | ASSISTANT: Harbor registry push verified.'
            }
        ];
        const packedItems = [
            { type: 'memory', id: 2, content: sparseRescuedRows[0].content }
        ];
        const { distinctiveTerms } = extractQueryTokens(
            'which kennel registry is max registered with?'.toLowerCase()
        );
        const res = evaluateAttributeGrounding(distinctiveTerms, packedItems, sparseRescuedRows, {
            maxRawCosine: 0.44
        });
        assert.equal(res.status, 'UNATTESTED_ATTRIBUTE');
        assert.ok(
            res.unlinked_attribute_terms.includes('registry') || res.unattested_user_terms.includes('kennel'),
            'Non-adjacent Turn #2 and Turn #58 in Session 1 must not form a false ±1 co-occurrence window'
        );
    });

    await t.test('10. Interleaved atomic/concurrent-session rows & tags-based session IDs still preserve ±1 same-session window W_k -> GROUNDED', () => {
        // Turn #5 (id: 5) and Turn #6 (id: 8) in Session 1 are separated by an atomic IDE invariant (id: 6)
        // and a concurrent Session 2 row (id: 7), AND use paired Turn #8/9 + #10/11 / tags fallback.
        const interleavedRows = [
            {
                id: 5,
                category: 'decision',
                status: 'ACTIVE',
                tags: '["session-1"]',
                content: '[Date: Mar 12, 2026 | Turn #8/9] USER: We launched Project Hyperion for telemetry analytics. | ASSISTANT: Noted Project Hyperion.'
            },
            {
                id: 6,
                category: 'invariant',
                status: 'ACTIVE',
                content: 'Always validate incoming JSON payloads at the HTTP router boundary.'
            },
            {
                id: 7,
                category: 'decision',
                status: 'ACTIVE',
                tags: '["session-2"]',
                content: '[Session 2 | Date: Mar 12, 2026 | Turn #0/1] USER: Checked dark mode CSS tokens. | ASSISTANT: Clean.'
            },
            {
                id: 8,
                category: 'decision',
                status: 'ACTIVE',
                tags: '["session-1"]',
                content: '[Date: Mar 12, 2026 | Turn #10/11] USER: Set the monthly budget cap to 4800 dollars. | ASSISTANT: Budget cap 4800 dollars recorded.'
            }
        ];
        const packedItems = [
            { type: 'memory', id: 5, tags: '["session-1"]', content: interleavedRows[0].content },
            { type: 'memory', id: 8, tags: '["session-1"]', content: interleavedRows[3].content }
        ];
        const { distinctiveTerms } = extractQueryTokens(
            'what monthly budget cap did we set for project hyperion?'.toLowerCase()
        );
        const res = evaluateAttributeGrounding(distinctiveTerms, packedItems, interleavedRows, {
            maxRawCosine: 0.44
        });
        assert.equal(res.status, 'GROUNDED');
        assert.equal(res.unlinked_attribute_terms.length, 0);
        assert.ok(res.max_joint_user_coverage >= 0.75);
    });

    await t.test('11. Multi-step superseded lineage chain preserves USER clauses from Steps 1..N while excluding ASSISTANT suggestions', () => {
        const step1 = '[Session 1 | Turn #1/10] USER: Adopted Project Hyperion for analytics. | ASSISTANT: Great, you might also consider Snowflake warehousing.';
        const step2 = '[Session 2 | Turn #4/10] USER: Updated Project Hyperion retention policy to 90 days. | ASSISTANT: Retention policy updated.';
        const rowWithLineage = {
            id: 20,
            category: 'decision',
            status: 'ACTIVE',
            content: step2,
            lineage: [{ id: 10, content: step1 }, { id: 20, content: step2 }],
            _lineageText: `${step1} ${step2}`
        };
        const packedItems = [{
            type: 'memory',
            id: 20,
            content: step2,
            lineage: rowWithLineage.lineage,
            lineageText: rowWithLineage._lineageText
        }];

        // Step 2 USER ("retention", "policy") + Step 1 USER ("analytics") must BOTH be grounded!
        const groundedRes = evaluateAttributeGrounding(
            ['hyperion', 'analytics', 'retention', 'policy'],
            packedItems,
            [rowWithLineage],
            { maxRawCosine: 0.44 }
        );
        assert.equal(groundedRes.status, 'GROUNDED');
        assert.equal(groundedRes.unattested_user_terms.length, 0);

        // Step 1 ASSISTANT-only word ("snowflake") must STILL be flagged as unattested in USER clauses!
        const unattestedRes = evaluateAttributeGrounding(
            ['hyperion', 'snowflake', 'warehousing'],
            packedItems,
            [rowWithLineage],
            { maxRawCosine: 0.44 }
        );
        assert.equal(unattestedRes.status, 'UNATTESTED_ATTRIBUTE');
        assert.ok(unattestedRes.unattested_user_terms.includes('snowflake'));
    });

    await t.test('12. Shared-stem morphological variants preserve unique-stem coverage & status invariance', () => {
        const rows = [
            {
                id: 1,
                category: 'decision',
                status: 'ACTIVE',
                content: '[Session 1 | Turn #1/8] USER: Logged morning workout routine with kettlebells. | ASSISTANT: Recorded.'
            },
            {
                id: 2,
                category: 'decision',
                status: 'ACTIVE',
                content: '[Session 2 | Turn #2/8] USER: Completed cardio workout session at home. | ASSISTANT: Noted.'
            }
        ];
        const packed = [{ type: 'memory', id: 1, content: rows[0].content }];

        // Attested inflection pair ("workout", "workouts") + 1 unattested stem ("deadlift") must NOT inflate coverage to 2/3 >= 0.65
        const inflectedAnchor = evaluateAttributeGrounding(
            ['workout', 'workouts', 'deadlift'],
            packed,
            rows,
            { maxRawCosine: 0.45 }
        );
        assert.equal(inflectedAnchor.max_joint_user_coverage, 0.5);
        assert.equal(inflectedAnchor.status, 'UNATTESTED_ATTRIBUTE');

        // Unattested inflection pair ("deadlift", "deadlifts") + 1 attested stem ("workout") at rawCos 0.40 must stay UNATTESTED_ATTRIBUTE (not false UNSUPPORTED)
        const inflectedUnattested = evaluateAttributeGrounding(
            ['workout', 'deadlift', 'deadlifts'],
            packed,
            rows,
            { maxRawCosine: 0.40 }
        );
        assert.equal(inflectedUnattested.max_joint_user_coverage, 0.5);
        assert.equal(inflectedUnattested.status, 'UNATTESTED_ATTRIBUTE');

        // Single-stem morphological pair ("deadlift", "deadlifts") must hit the < 2 unique stems guard -> GROUNDED
        const singleStemPair = evaluateAttributeGrounding(
            ['deadlift', 'deadlifts'],
            packed,
            rows,
            { maxRawCosine: 0.35 }
        );
        assert.equal(singleStemPair.status, 'GROUNDED');
        assert.equal(singleStemPair.max_joint_user_coverage, 1);
    });

    await t.test('13. Extreme-value log10(N) cosine scaling on large multi-session stores (N >= 1000) flags isotropic neighbor distractors at rawCos ~ 0.56 while keeping small stores at 0.50', () => {
        const largeStoreRows = [];
        largeStoreRows.push({
            id: 1,
            category: 'decision',
            status: 'ACTIVE',
            content: '[Session 1 | Date: Jan 03, 2026 | Turn #1/20] USER: Adopted Helios gateway proxy for edge routing. | ASSISTANT: Helios gateway proxy configured.'
        });
        for (let i = 2; i <= 1000; i++) {
            const sess = 2 + Math.floor(i / 25);
            largeStoreRows.push({
                id: i,
                category: 'decision',
                status: 'ACTIVE',
                content: `[Session ${sess} | Date: Feb ${(i % 27) + 1}, 2026 | Turn #${i}/1000] USER: Completed routine worker pool health check #${i}. | ASSISTANT: Worker pool check #${i} clean.`
            });
        }
        const packed = [{ type: 'memory', id: 1, content: largeStoreRows[0].content }];
        const { distinctiveTerms } = extractQueryTokens(
            'what hardware HSM enclave slot did we assign to helios gateway?'.toLowerCase()
        );

        // On N=1000 (unattestedAttrCosCeiling = 0.50 + 0.045 * log10(40) ~= 0.5721), rawCos=0.56 is flagged as UNATTESTED_ATTRIBUTE
        const largeRes = evaluateAttributeGrounding(distinctiveTerms, packed, largeStoreRows, {
            maxRawCosine: 0.56
        });
        assert.equal(largeRes.status, 'UNATTESTED_ATTRIBUTE');
        assert.ok(largeRes.attested_anchors.includes('helios'));
        assert.ok(largeRes.unattested_user_terms.includes('enclave'));

        // Genuine high-similarity paraphrase above scaled ceiling (rawCos=0.61) stays GROUNDED
        const highCosRes = evaluateAttributeGrounding(distinctiveTerms, packed, largeStoreRows, {
            maxRawCosine: 0.61
        });
        assert.equal(highCosRes.status, 'GROUNDED');
    });
});



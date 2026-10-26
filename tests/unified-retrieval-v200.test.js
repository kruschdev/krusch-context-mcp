import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
    getProjectDb,
    resolveProjectPath,
    closeAllDatabases,
    encodeEmbeddingBlob,
    withTransaction
} from '../src/sqlite-engine.js';
import { unifiedRetrieve, estimateTokens } from '../src/unified-retrieval.js';
import { getHealthStats, consolidateMemories } from '../src/memory-engine.js';
import { VERSION, CORE_TOOLS } from '../src/index.js';
import { CLOSED_CATEGORIES } from '../src/memory-engine.js';
import { pool } from '../db/pool.js';

/**
 * Builds a deterministic, dense, L2-normalized 1024-dim vector so `_isSparseSyntheticVector`
 * is false (exercising full snowflake-arctic-embed2 isotropic calibration & Float32Array blobs).
 */
function makeDenseVec(components = [], seed = 1, dim = 1024) {
    const raw = new Float64Array(dim);
    for (let i = 0; i < dim; i++) {
        raw[i] = 0.0015 * Math.sin((i + 1) * (seed + 0.41));
    }
    for (const [axis, weight] of components) {
        raw[axis % dim] += weight;
    }
    let sq = 0;
    for (let i = 0; i < dim; i++) sq += raw[i] * raw[i];
    const norm = Math.sqrt(sq) || 1;
    const out = new Array(dim);
    for (let i = 0; i < dim; i++) out[i] = raw[i] / norm;
    return out;
}

test('krusch-context-mcp v2.0.0 End-to-End Unified Retrieval Suite (Pillars 1, 2 & 3)', async (t) => {
    const runId = Date.now();
    const rollupBridgeProj = `test_v200_e2e_macro_${runId}`;
    const epistemicProj = `test_v200_e2e_epistemic_${runId}`;
    const ephemeralProjects = [rollupBridgeProj, epistemicProj];
    const prevMaxScan = process.env.KRUSCH_MAX_ACTIVE_SCAN;

    t.after(async () => {
        if (prevMaxScan === undefined) {
            delete process.env.KRUSCH_MAX_ACTIVE_SCAN;
        } else {
            process.env.KRUSCH_MAX_ACTIVE_SCAN = prevMaxScan;
        }
        closeAllDatabases();
        for (const p of ephemeralProjects) {
            try {
                fs.rmSync(resolveProjectPath(p), { recursive: true, force: true });
            } catch {}
        }
        try {
            await pool.end();
        } catch {}
    });

    await t.test('0. v2.0.0 surface invariants (INV-V2-01): VERSION === 2.0.0, 5 canonical verbs, 5 closed categories', () => {
        assert.equal(VERSION, '2.0.0');
        assert.equal(CORE_TOOLS.size, 5);
        assert.equal(CLOSED_CATEGORIES.size, 5);
    });

    await t.test('1. Pillar 1 E2E: Hierarchical Episode Panorama, deep pre-scan directive pinning, health rollupCount, and consolidation rebuild', async () => {
        // Set active vector scan ceiling to 400 so rows #1..#30 sit strictly outside initial Step 3a scan
        process.env.KRUSCH_MAX_ACTIVE_SCAN = '400';
        const db = await getProjectDb(rollupBridgeProj);

        const directiveVec = makeDenseVec([[10, 0.90], [11, 0.42]], 10);
        const bridgeHop2Vec = makeDenseVec([[4, 0.97], [0, 0.10]], 11);
        const bridgeHop1Vec = makeDenseVec([[0, 0.75], [4, 0.66]], 12);
        const macroVec = makeDenseVec([[20, 0.85], [21, 0.50]], 13);

        withTransaction(db, () => {
            const stmt = db.prepare(`
                INSERT INTO ide_agent_memory (category, content, tags, status, embedding, embedding_blob, project)
                VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?)
            `);

            // Row #1 (Session 1 Opener - deep pre-scan)
            stmt.run(
                'decision',
                '[Session 1 | Date: Jan 05, 2026 | Turn #1/70] USER: Kick off Phase 1 storage engine architecture using embedded SQLite WAL journals. | ASSISTANT: Initialized Phase 1 SQLite WAL journal layout.',
                '["session-1"]',
                JSON.stringify(macroVec),
                encodeEmbeddingBlob(macroVec),
                rollupBridgeProj
            );

            // Row #2 (Session 1 Standing Directive - deep pre-scan, zero rare noun overlap with generic DDL prompt)
            stmt.run(
                'decision',
                '[Session 1 | Date: Jan 05, 2026 | Turn #2/70] USER: Always wrap DDL migrations in strict idempotent savepoints and never drop legacy audit columns. | ASSISTANT: Understood, I will enforce idempotent savepoints on every DDL migration.',
                '["session-1"]',
                JSON.stringify(directiveVec),
                encodeEmbeddingBlob(directiveVec),
                rollupBridgeProj
            );

            // Row #3 (Session 1 Disjoint Entity Bridge Target - zero query words from Session 7 lag query!)
            stmt.run(
                'decision',
                '[Session 1 | Date: Jan 05, 2026 | Turn #3/70] USER: On zephyr-broker we capped Redpanda partition ring buffers at 256 megabytes per core. | ASSISTANT: Applied 256 MB Redpanda ring buffer cap on zephyr-broker.',
                '["session-1"]',
                JSON.stringify(bridgeHop2Vec),
                encodeEmbeddingBlob(bridgeHop2Vec),
                rollupBridgeProj
            );

            // Rows #4..#428 across Sessions 1..7 (total 430 rows; rows #1..#30 are below minVecId = 31 when KRUSCH_MAX_ACTIVE_SCAN=400)
            for (let id = 4; id <= 428; id++) {
                const sess = Math.min(7, 1 + Math.floor((id - 1) / 62));
                const axisA = 60 + (id % 920);
                const axisB = 60 + ((id * 13) % 920);
                const fVec = makeDenseVec([[axisA, 0.88], [axisB, 0.44], [20, 0.16]], 100 + id);
                stmt.run(
                    'decision',
                    `[Session ${sess} | Date: Feb ${(id % 27) + 1}, 2026 | Turn #${id}/430] USER: Completed subsystem verification checkpoint #${id} for module-${sess} telemetry pipeline. | ASSISTANT: Checkpoint #${id} passed in module-${sess}.`,
                    `["session-${sess}"]`,
                    JSON.stringify(fVec),
                    encodeEmbeddingBlob(fVec),
                    rollupBridgeProj
                );
            }

            // Row #429 (Session 7 Hop-1 seed for Pillar 2 cross-session entity bridge)
            stmt.run(
                'decision',
                '[Session 7 | Date: Mar 22, 2026 | Turn #429/430] USER: Consumer backpressure spiked yesterday after we routed ingestion traffic through zephyr-broker and Redpanda partitions. | ASSISTANT: Let us inspect consumer backpressure metrics.',
                '["session-7"]',
                JSON.stringify(bridgeHop1Vec),
                encodeEmbeddingBlob(bridgeHop1Vec),
                rollupBridgeProj
            );

            // Row #430 (Exact vector duplicate of Row #428 for consolidateMemories rollup-refresh verification)
            const dupAxisA = 60 + (428 % 920);
            const dupAxisB = 60 + ((428 * 13) % 920);
            const dupVec = makeDenseVec([[dupAxisA, 0.88], [dupAxisB, 0.44], [20, 0.16]], 100 + 428);
            stmt.run(
                'decision',
                '[Session 7 | Date: Feb 21, 2026 | Turn #430/430] USER: Completed subsystem verification checkpoint #428 for module-7 telemetry pipeline duplicate. | ASSISTANT: Checkpoint #428 duplicate.',
                '["session-7"]',
                JSON.stringify(dupVec),
                encodeEmbeddingBlob(dupVec),
                rollupBridgeProj
            );
        });

        // 1a. Broad summarization query triggers Stage 1B Hierarchical Episode Panorama & respects token budget
        const broadQueryVec = makeDenseVec([[20, 0.95], [21, 0.30]], 201);
        const macroRes = await unifiedRetrieve({
            query: 'Summarize our architecture progress across all sessions',
            project: rollupBridgeProj,
            limit_tokens: 3200,
            _embedding: broadQueryVec
        });

        const macroText = macroRes.content[0].text;
        assert.equal(macroRes.epistemic_status, 'SUPPORTED');
        assert.ok(
            macroText.includes('#### 🗂️ Hierarchical Episode Panorama'),
            'Broad summarization on >=240-row store must render Hierarchical Episode Panorama'
        );

        // INV-V2-02: Verify panorama block contains zero `| Turn #X/Y]` citation headers
        const panoSplit = macroText.split('### [MEMORY]')[0];
        assert.equal(
            /\|\s*Turn\s*#\s*\d+/i.test(panoSplit),
            false,
            'Panorama header block must strip all `| Turn #X/Y]` strings (INV-V2-02)'
        );

        // INV-V2-06: Verify strict token budget ceiling
        assert.ok(
            estimateTokens(macroText) <= 3200,
            `Returned payload tokens (${estimateTokens(macroText)}) must not exceed limit_tokens=3200`
        );

        // 1b. Deep pre-scan standing directive rescue on generative/advisory query (Row #2 is < minVecId=31!)
        const advisoryVec = makeDenseVec([[10, 0.62], [45, 0.78]], 202);
        const advRes = await unifiedRetrieve({
            query: 'Write a new database schema migration script for user accounts',
            project: rollupBridgeProj,
            limit_tokens: 4000,
            _embedding: advisoryVec
        });
        assert.ok(
            advRes.citations.some(c => Number(c.id) === 2),
            'Deep pre-scan standing directive (Memory #2 in Session 1) must be rescued and pinned via Episode Rollup directiveMemoryIds'
        );

        // 1c. Health stats report rollupCount > 0
        const health = await getHealthStats({ project: rollupBridgeProj });
        assert.ok(health.stats.rollupCount >= 7, `Expected >= 7 episode rollups, got ${health.stats.rollupCount}`);
        assert.ok(health.content[0].text.includes('* **Episode Rollups**:'));

        // 1d. consolidateMemories refreshes ide_episode_rollups atomically so SUM(turn_count) matches ACTIVE rows
        await consolidateMemories({
            category: 'decision',
            project: rollupBridgeProj,
            threshold: 0.02
        });
        const activeAfter = db.prepare(`SELECT COUNT(*) AS c FROM ide_agent_memory WHERE status = 'ACTIVE'`).get().c;
        const rollupTurnSum = db.prepare(`SELECT COALESCE(SUM(turn_count), 0) AS s FROM ide_episode_rollups`).get().s;
        assert.equal(
            rollupTurnSum,
            activeAfter,
            `Rollup turn_count sum (${rollupTurnSum}) must match ACTIVE row count (${activeAfter}) after consolidateMemories`
        );
    });

    await t.test('2. Pillar 2 E2E: 2-Hop Multi-Session Bridge rescues disjoint Session 1 turn (#3) from Session 7 Hop-1 seed (#429)', async () => {
        process.env.KRUSCH_MAX_ACTIVE_SCAN = '400';
        const lagQueryVec = makeDenseVec([[0, 1.0]], 301);

        // Notice: Query mentions ONLY "consumer backpressure ingestion traffic" (matches Row #429 in Session 7).
        // Row #3 in Session 1 (< minVecId!) has ZERO query words — only bridge entities "zephyr-broker" + "Redpanda" along residual axis 4!
        const bridgeRes = await unifiedRetrieve({
            query: 'Why did consumer backpressure spike on ingestion traffic?',
            project: rollupBridgeProj,
            limit_tokens: 4000,
            _embedding: lagQueryVec
        });

        assert.equal(bridgeRes.epistemic_status, 'SUPPORTED');
        const citedIds = bridgeRes.citations.map(c => Number(c.id));
        assert.ok(citedIds.includes(429), 'Hop-1 seed turn #429 (Session 7) must be cited');
        assert.ok(
            citedIds.includes(3),
            `Disjoint Session 1 turn #3 (outside initial 400-row scan, zero query words) must be rescued by 2-hop residual + FTS5 bridge; got top IDs: ${citedIds.slice(0, 12).join(', ')}`
        );
    });

    await t.test('3. Pillar 3 E2E: Attribute-Level Abstention Calibration (UNSUPPORTED -> NO_KNOWN_SUPPORT, UNATTESTED_ATTRIBUTE note, and state contract)', async () => {
        const db = await getProjectDb(epistemicProj);

        // Entity "Chronos" is attested in USER:, while "Kubernetes" appears ONLY in ASSISTANT:'s hypothetical suggestion
        const chronosVec = makeDenseVec([[5, 0.82], [6, 0.57]], 401);
        const fillerBase = [12, 0.95];

        withTransaction(db, () => {
            const stmt = db.prepare(`
                INSERT INTO ide_agent_memory (category, content, tags, status, embedding_blob, project)
                VALUES ('decision', ?, ?, 'ACTIVE', ?, ?)
            `);
            stmt.run(
                '[Session 1 | Date: Apr 02, 2026 | Turn #1/35] USER: We deployed the Chronos scheduler daemon on bare-metal systemd service units. | ASSISTANT: Chronos systemd unit active; you could optionally migrate it to Kubernetes namespaces in the future.',
                '["session-1"]',
                encodeEmbeddingBlob(chronosVec),
                epistemicProj
            );
            for (let i = 2; i <= 35; i++) {
                const fv = makeDenseVec([fillerBase, [13 + (i % 4), 0.31]], 410 + i);
                stmt.run(
                    `[Session ${1 + (i % 3)} | Date: Apr ${3 + (i % 15)}, 2026 | Turn #${i}/35] USER: Verified PostgreSQL connection pool timeout #${i} on replica node. | ASSISTANT: Replica timeout #${i} recorded.`,
                    `["session-${1 + (i % 3)}"]`,
                    encodeEmbeddingBlob(fv),
                    epistemicProj
                );
            }
        });

        // 3a. Entity attested ("Chronos"), queried attribute ("Kubernetes" / "namespace") unattested in USER: (rawCosine ~ 0.34 < 0.48)
        const unattestedAttrVec = makeDenseVec([[5, 0.41], [50, 0.91]], 501);
        const attrRes = await unifiedRetrieve({
            query: 'Which Kubernetes namespace runs our Chronos scheduler?',
            project: epistemicProj,
            limit_tokens: 4000,
            _embedding: unattestedAttrVec
        });

        assert.ok(attrRes.attribute_grounding, 'unifiedRetrieve must return structured attribute_grounding');
        assert.equal(attrRes.attribute_grounding.status, 'UNATTESTED_ATTRIBUTE');
        assert.ok(attrRes.attribute_grounding.attested_anchors.includes('chronos'));
        assert.ok(
            attrRes.attribute_grounding.unattested_user_terms.includes('kubernetes') ||
            attrRes.attribute_grounding.unattested_user_terms.includes('namespace'),
            `Expected kubernetes/namespace in unattested_user_terms, got ${JSON.stringify(attrRes.attribute_grounding.unattested_user_terms)}`
        );
        assert.ok(
            attrRes.content[0].text.includes('Attribute Grounding Note'),
            'UNATTESTED_ATTRIBUTE must emit `> ⚠️ **Attribute Grounding Note**` warning in retrieval header'
        );

        // 3b. Completely unattested multi-term topic with isotropic neighbor rawCosine ~ 0.18 (< 0.42) -> NO_KNOWN_SUPPORT
        const unsupportedVec = makeDenseVec([[5, 0.21], [88, 0.97]], 502);
        const unsupRes = await unifiedRetrieve({
            query: 'What cryogenic dilution millikelvin temperature did we calibrate?',
            project: epistemicProj,
            limit_tokens: 4000,
            _embedding: unsupportedVec
        });

        assert.equal(unsupRes.epistemic_status, 'NO_KNOWN_SUPPORT');
        assert.ok(unsupRes.content[0].text.includes('ABSTENTION (NO_KNOWN_SUPPORT)'));

        // 3c. mode === 'state' returns uniform attribute_grounding shape
        const stateRes = await unifiedRetrieve({
            query: '*',
            mode: 'state',
            project: epistemicProj
        });
        assert.equal(stateRes.epistemic_status, 'SUPPORTED');
        assert.equal(stateRes.attribute_grounding?.status, 'GROUNDED');
    });

    await t.test('4. INV-V2-06 strict token budget ceiling under tight budgets (110 & 180 tokens) across state, include_state, wildcard, conflicts & panorama', async () => {
        const db = await getProjectDb(epistemicProj);
        const conflictVec = makeDenseVec([[19, 0.94], [20, 0.30]], 601);
        db.prepare(`
            INSERT INTO ide_agent_memory (category, content, tags, status, embedding_blob, project)
            VALUES ('decision', ?, '["session-4"]', 'ACTIVE', ?, ?),
                   ('decision', ?, '["session-5"]', 'ACTIVE', ?, ?)
        `).run(
            '[Session 4 | Date: May 01, 2026 | Turn #1/10] USER: Enable strict TLS mutual authentication on internal gateway port 8443. | ASSISTANT: Enabled TLS mutual authentication on 8443.',
            encodeEmbeddingBlob(conflictVec),
            epistemicProj,
            '[Session 5 | Date: May 09, 2026 | Turn #2/10] USER: Disable TLS mutual authentication on internal gateway port 8443 for local loopback debugging. | ASSISTANT: Disabled TLS mutual authentication on 8443.',
            encodeEmbeddingBlob(conflictVec),
            epistemicProj
        );

        for (const tightBudget of [110, 180]) {
            const rState = await unifiedRetrieve({
                query: '*',
                mode: 'state',
                limit_tokens: tightBudget,
                project: rollupBridgeProj
            });
            assert.ok(
                estimateTokens(rState.content[0].text) <= tightBudget,
                `mode='state' tokens (${estimateTokens(rState.content[0].text)}) must be <= ${tightBudget}`
            );

            const rIncState = await unifiedRetrieve({
                query: 'Summarize our architecture progress across all sessions',
                include_state: true,
                limit_tokens: tightBudget,
                project: rollupBridgeProj,
                _embedding: makeDenseVec([[20, 0.95], [21, 0.30]], 201)
            });
            assert.ok(
                estimateTokens(rIncState.content[0].text) <= tightBudget,
                `include_state=true + panorama tokens (${estimateTokens(rIncState.content[0].text)}) must be <= ${tightBudget}`
            );

            const rWild = await unifiedRetrieve({
                query: '*',
                limit_tokens: tightBudget,
                project: rollupBridgeProj
            });
            assert.ok(
                estimateTokens(rWild.content[0].text) <= tightBudget,
                `wildcard query tokens (${estimateTokens(rWild.content[0].text)}) must be <= ${tightBudget}`
            );

            const rConflict = await unifiedRetrieve({
                query: 'Is TLS mutual authentication enabled on internal gateway port 8443?',
                limit_tokens: tightBudget,
                project: epistemicProj,
                _embedding: conflictVec
            });
            assert.ok(
                estimateTokens(rConflict.content[0].text) <= tightBudget,
                `CONFLICTED query tokens (${estimateTokens(rConflict.content[0].text)}) must be <= ${tightBudget}`
            );
        }
    });

    await t.test('5. Shared-stem query alignment (no entity double-count or undefined coercion), tag-anchor parity, and rescued mid-session _sessionPos accuracy', async () => {
        const stemProj = `test_v200_e2e_shared_stem_${runId}`;
        ephemeralProjects.push(stemProj);
        const db = await getProjectDb(stemProj);
        const neighborVec = makeDenseVec([[31, 0.90], [32, 0.43]], 701);
        const queryVec = makeDenseVec([[31, 0.49], [33, 0.87]], 702); // rawCos ~ 0.441 in [0.42, 0.48)

        db.prepare(`
            INSERT INTO ide_agent_memory (category, content, tags, status, embedding_blob, project)
            VALUES ('decision', ?, '["session-1", "orion_anchor"]', 'ACTIVE', ?, ?),
                   ('decision', ?, '["session-2"]', 'ACTIVE', ?, ?)
        `).run(
            '[Session 1 | Date: Jun 01, 2026 | Turn #1/12] USER: Checked Orion service logs where payload was undefined. | ASSISTANT: Logged Orion check.',
            encodeEmbeddingBlob(neighborVec),
            stemProj,
            '[Session 2 | Date: Jun 02, 2026 | Turn #2/12] USER: Routine build verification pass. | ASSISTANT: Clean.',
            encodeEmbeddingBlob(makeDenseVec([[40, 1.0]], 703)),
            stemProj
        );

        // "train" + "trained" share stem "train": distinctiveTerms = ['train', 'trained', 'orion', 'marathon'] (4 terms, 3 stems).
        // Memory #1 only mentions "Orion" (1 stem) + literal "undefined" -> MUST NOT double-count "Orion" or match undefined!
        const sharedStemRes = await unifiedRetrieve({
            query: 'Did we train or trained for the Orion marathon?',
            project: stemProj,
            limit_tokens: 4000,
            _embedding: queryVec
        });

        assert.equal(sharedStemRes.attribute_grounding?.status, 'UNATTESTED_ATTRIBUTE');
        assert.ok(
            sharedStemRes.attribute_grounding.unattested_user_terms.includes('marathon'),
            'Unattested marathon must be flagged on shared-stem query'
        );
        const orionCite = sharedStemRes.citations.find(c => c.title.includes('Memory #1'));
        if (orionCite) {
            assert.ok(orionCite.score < 0.55, `Isotropic entity-only neighbor must be damped (<0.55, got ${orionCite.score})`);
        }

        // Tag-attested anchor "orion_anchor" on packedItems must be preserved via scoreCandidateRow tags forwarding
        const tagAnchorRes = await unifiedRetrieve({
            query: 'What Orion orion_anchor marathon schedule did we set?',
            project: stemProj,
            limit_tokens: 4000,
            _embedding: queryVec
        });
        assert.ok(
            tagAnchorRes.attribute_grounding.attested_anchors.includes('orion_anchor'),
            `packedItems must preserve tags so tag-attested anchors appear in attested_anchors (got ${JSON.stringify(tagAnchorRes.attribute_grounding.attested_anchors)})`
        );

        // Rescued mid-session turn under KRUSCH_MAX_ACTIVE_SCAN=50 on rollupBridgeProj must NOT displace true session opener #1
        process.env.KRUSCH_MAX_ACTIVE_SCAN = '50';
        try {
            const broadRescued = await unifiedRetrieve({
                query: 'Summarize our architecture progress across all sessions',
                project: rollupBridgeProj,
                limit_tokens: 4000,
                _embedding: makeDenseVec([[20, 0.95], [21, 0.30]], 201)
            });
            assert.equal(broadRescued.epistemic_status, 'SUPPORTED');
            assert.ok(broadRescued.content[0].text.includes('Hierarchical Episode Panorama'));
        } finally {
            if (prevMaxScan === undefined) delete process.env.KRUSCH_MAX_ACTIVE_SCAN;
            else process.env.KRUSCH_MAX_ACTIVE_SCAN = prevMaxScan;
        }
    });

    await t.test('6. Post-assembly INV-V2-06 entry eviction keeps epistemic_status, statusSection, and attribute_grounding synchronized', async () => {
        const popProj = `test_v200_e2e_pop_sync_${runId}`;
        ephemeralProjects.push(popProj);
        const db = await getProjectDb(popProj);
        const v1 = makeDenseVec([[45, 0.96], [46, 0.25]], 801);

        db.prepare(`
            INSERT INTO ide_agent_memory (category, content, tags, status, embedding_blob, project)
            VALUES ('decision', ?, '["session-1"]', 'ACTIVE', ?, ?)
        `).run(
            '[Session 1 | Date: Jul 01, 2026 | Turn #1/4] USER: Enabled Zephyr cache compression in production cluster. | ASSISTANT: Enabled Zephyr cache compression.',
            encodeEmbeddingBlob(v1),
            popProj
        );

        // Tight include_state=true + limit_tokens=100 with long query evicts sole packed entry -> must synchronize to NO_KNOWN_SUPPORT
        const tightSolePop = await unifiedRetrieve({
            query: 'What specific Zephyr cache compression configuration parameter did we enable across production cluster nodes?',
            project: popProj,
            include_state: true,
            limit_tokens: 100,
            _embedding: v1
        });
        assert.ok(estimateTokens(tightSolePop.content[0].text) <= 100);
        if (tightSolePop.citations.length === 0) {
            assert.equal(tightSolePop.epistemic_status, 'NO_KNOWN_SUPPORT');
            assert.equal(tightSolePop.attribute_grounding.attested_anchors.length, 0);
            assert.ok(!tightSolePop.content[0].text.includes('**Epistemic Status**: SUPPORTED'));
        }

        // Conflicted store under tight budget: if post-assembly pops one side so conflicts === [], epistemic_status must not stay CONFLICTED
        db.prepare(`
            INSERT INTO ide_agent_memory (category, content, tags, status, embedding_blob, project)
            VALUES ('decision', ?, '["session-2"]', 'ACTIVE', ?, ?)
        `).run(
            '[Session 2 | Date: Jul 02, 2026 | Turn #2/4] USER: We never enabled Zephyr cache compression in production cluster. | ASSISTANT: Disabled Zephyr cache compression.',
            encodeEmbeddingBlob(v1),
            popProj
        );

        for (const budget of [100, 115, 130, 150]) {
            const tightConflict = await unifiedRetrieve({
                query: 'Did we enable Zephyr cache compression in production cluster?',
                project: popProj,
                limit_tokens: budget,
                _embedding: v1
            });
            assert.ok(estimateTokens(tightConflict.content[0].text) <= budget);
            if (tightConflict.conflicts.length === 0) {
                assert.notEqual(tightConflict.epistemic_status, 'CONFLICTED');
                assert.ok(!tightConflict.content[0].text.includes('Contradiction Resolution Alert'));
            }
            if (tightConflict.citations.length === 0) {
                assert.equal(tightConflict.epistemic_status, 'NO_KNOWN_SUPPORT');
            }
        }
    });
});



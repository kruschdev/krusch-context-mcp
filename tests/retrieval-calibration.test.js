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
import {
    unifiedRetrieve,
    stemToken,
    computeSpanProximityFeatures,
    extractRelationalGraphAnchors,
    calibrateMultiArmFusion
} from '../src/unified-retrieval.js';
import { pool } from '../db/pool.js';

function makeDenseVec(components = [], seed = 1, dim = 1024) {
    const raw = new Float64Array(dim);
    for (let i = 16; i < dim; i++) {
        raw[i] = 0.0014 * Math.sin((i + 1) * (seed + 0.37));
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

test('Pillar 4 (INV-V2-09): Zero-LLM Calibrated Feature Fusion (FERN) & Relational Graph Probing (SkinMind)', async (t) => {
    const runId = Date.now();
    const graphProj = `test_v209_graph_probe_${runId}`;
    const prevMaxScan = process.env.KRUSCH_MAX_ACTIVE_SCAN;

    t.after(async () => {
        if (prevMaxScan === undefined) {
            delete process.env.KRUSCH_MAX_ACTIVE_SCAN;
        } else {
            process.env.KRUSCH_MAX_ACTIVE_SCAN = prevMaxScan;
        }
        closeAllDatabases();
        try {
            fs.rmSync(resolveProjectPath(graphProj), { recursive: true, force: true });
        } catch {}
        try {
            await pool.end();
        } catch {}
    });

    await t.test('1. computeSpanProximityFeatures rewards tight non-adjacent stem windows over diluted scattered mentions', () => {
        const queryStems = ['deadlock', 'sqlite', 'checkpoint'].map(stemToken);

        // Non-adjacent (3 intervening words -> bigrams miss, but 6-token window is tight!)
        const tightText = 'resolved a critical deadlock inside embedded sqlite during wal checkpoint execution';
        const filler = Array.from({ length: 70 }, (_, i) => `telemetry_${i}`).join(' ');
        const scatteredText = `observed a deadlock early in morning logs ${filler} touched sqlite cache ${filler} scheduled nightly checkpoint`;

        const tight = computeSpanProximityFeatures(tightText, queryStems);
        const scattered = computeSpanProximityFeatures(scatteredText, queryStems);

        assert.equal(tight.matchedStemCount, 3);
        assert.equal(scattered.matchedStemCount, 3);
        assert.ok(tight.minWindowTokens <= 8, `Expected tight window <= 8 tokens, got ${tight.minWindowTokens}`);
        assert.ok(scattered.minWindowTokens > 120, `Expected scattered window > 120 tokens, got ${scattered.minWindowTokens}`);
        assert.ok(
            tight.spanTightness > scattered.spanTightness * 4,
            `Tight span (${tight.spanTightness}) must substantially exceed scattered span (${scattered.spanTightness})`
        );
    });

    await t.test('2. calibrateMultiArmFusion (FERN) separates saturated top ties while preserving INV-V2-09A abstention safety', () => {
        const stems = ['wal', 'deadlock', 'mutex'].map(stemToken);
        const filler = Array.from({ length: 65 }, (_, i) => `routine_word_${i}`).join(' ');

        const candidates = [
            // Candidate #100 (newer ID, scattered keywords, weaker raw cosine, saturated heuristic score 0.94)
            {
                id: 100,
                category: 'lesson',
                content: `wal notes ${filler} deadlock mention ${filler} mutex note`,
                rawScore: 0.94,
                score: 0.94,
                _unclampedScore: 0.94,
                rawSemanticScore: 0.31,
                semanticScore: 0.60,
                idfOverlap: 0.72,
                userOverlap: 0.40
            },
            // Candidate #12 (older ID, tight 5-token factual clause + high z-score raw cosine 0.64, heuristic score 0.93)
            {
                id: 12,
                category: 'bug',
                content: 'sqlite wal writer deadlock fixed via serialized mutex lock',
                rawScore: 0.93,
                score: 0.93,
                _unclampedScore: 0.93,
                rawSemanticScore: 0.64,
                semanticScore: 0.86,
                idfOverlap: 0.95,
                userOverlap: 0.95
            },
            // Candidate #999 (ungrounded noise below 0.46 epistemic floor - MUST NOT be boosted above 0.50!)
            {
                id: 999,
                category: 'lesson',
                content: 'unrelated CSS button border radius adjustment',
                rawScore: 0.34,
                score: 0.34,
                _unclampedScore: 0.34,
                rawSemanticScore: 0.19,
                semanticScore: 0.42,
                idfOverlap: 0,
                userOverlap: 0
            },
            // Candidate #998 (isotropic entity-only neighbor - MUST NOT receive positive boost!)
            {
                id: 998,
                category: 'decision',
                content: 'wal configuration initialized',
                rawScore: 0.49,
                score: 0.49,
                _unclampedScore: 0.49,
                rawSemanticScore: 0.38,
                semanticScore: 0.68,
                idfOverlap: 0.33,
                userOverlap: 0.33,
                _isEntityOnlyIsotropicNeighbor: true
            }
        ];

        const stats = calibrateMultiArmFusion(candidates, {
            evalStems: stems,
            distinctiveStems: stems,
            hasRealQueryEmbedding: true
        });

        assert.equal(stats.activeArms, 4);
        assert.ok(
            candidates[1].score > candidates[0].score,
            `FERN calibrated score of tight multi-arm needle #12 (${candidates[1].score}) must beat scattered #100 (${candidates[0].score})`
        );
        assert.equal(candidates[2].score, 0.34, 'INV-V2-09A: Ungrounded candidate (< 0.46) must receive zero upward boost');
        assert.equal(candidates[3].score, 0.49, 'INV-V2-09A: Entity-only isotropic neighbor must receive zero upward boost');
    });

    await t.test('3. extractRelationalGraphAnchors & probeRelationalMemoryGraph (SkinMind) rescue deep off-scan invariants via provenance.file & INV-* edges', async () => {
        process.env.KRUSCH_MAX_ACTIVE_SCAN = '400';
        const db = await getProjectDb(graphProj);

        // Row #16 (deep off-scan < minVecId=31, non-opener pos, NO [Session N] brackets!, ZERO axis-0 cosine with query!):
        // Lesson anchored to `src/ledger-writer.js` + `INV-LEDGER-04` along residual axis 7
        const invVec = makeDenseVec([[7, 1.0]], 701);
        // Row #17 (deep off-scan < minVecId=31, non-opener pos, ZERO axis-0 cosine with query!):
        // Explicit Memory #17 root-cause bug referenced by Row #430 along residual axis 8
        const bugVec = makeDenseVec([[8, 1.0]], 702);
        // Row #430 (in active scan): Recent decision matching query axis 0 + bridging to residual axes 7 & 8
        const hop1SeedVec = makeDenseVec([[0, 0.80], [7, 0.48], [8, 0.35]], 703);

        withTransaction(db, () => {
            const stmt = db.prepare(`
                INSERT INTO ide_agent_memory (category, content, tags, provenance, status, embedding, embedding_blob, project)
                VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?, ?)
            `);

            // Rows #1..#15: Unrelated early engineering memories
            for (let id = 1; id <= 15; id++) {
                const fv = makeDenseVec([[90 + id, 0.96]], 800 + id);
                stmt.run(
                    'lesson',
                    `Completed routine telemetry validation pass #${id} on metrics collector subsystem-${id}.`,
                    '["routine-telemetry"]',
                    null,
                    JSON.stringify(fv),
                    encodeEmbeddingBlob(fv),
                    graphProj
                );
            }

            // Row #16: Deep architectural lesson (zero lexical or direct vector overlap with query, linked ONLY via provenance.file JSON column + residual axis 7!)
            stmt.run(
                'lesson',
                'Every journal append must flush fsync descriptors before releasing the advisory mutex.',
                '["storage-integrity"]',
                JSON.stringify({ file: 'packages/core/src/ledger-writer.js', start_line: 42 }),
                JSON.stringify(invVec),
                encodeEmbeddingBlob(invVec),
                graphProj
            );

            // Row #17: Deep root-cause bug (zero lexical or direct vector overlap with query, explicitly cited as `#17` by Row #430!)
            stmt.run(
                'bug',
                'Root cause: buffered descriptor closed prematurely prior to kernel barrier completion.',
                '["descriptor-leak"]',
                JSON.stringify({ file: 'packages/core/src/descriptor-pool.js', start_line: 19 }),
                JSON.stringify(bugVec),
                encodeEmbeddingBlob(bugVec),
                graphProj
            );

            // Rows #18..#429: Unrelated engineering memories (pushing #16 and #17 outside the 400-row active scan!)
            for (let id = 18; id <= 429; id++) {
                const axis = 90 + (id % 850);
                const fv = makeDenseVec([[axis, 0.96]], 800 + id);
                stmt.run(
                    'lesson',
                    `Completed routine telemetry validation pass #${id} on metrics collector subsystem-${id % 11}.`,
                    '["routine-telemetry"]',
                    null,
                    JSON.stringify(fv),
                    encodeEmbeddingBlob(fv),
                    graphProj
                );
            }

            // Row #430: Hop-1 seed matching "settlement retry jitter", anchored via provenance JSON (`src/ledger-writer.js`) and short `#17` citation (not extractable by token>=4 lexical bridge!)
            stmt.run(
                'decision',
                'Hardened settlement batch retry jitter handler (ref #17).',
                '["settlement-engine"]',
                JSON.stringify({ file: 'packages/core/src/ledger-writer.js', start_line: 88 }),
                JSON.stringify(hop1SeedVec),
                encodeEmbeddingBlob(hop1SeedVec),
                graphProj
            );
        });

        const anchors = extractRelationalGraphAnchors({
            id: 430,
            content: 'Hardened settlement batch retry jitter handler in src/ledger-writer.js to comply with INV-LEDGER-04 after postmortem Memory #17.',
            provenance: JSON.stringify({ file: 'packages/core/src/ledger-writer.js' }),
            tags: '["settlement-engine"]'
        });
        assert.ok(anchors.provenanceFiles.includes('src/ledger-writer.js'));
        assert.ok(anchors.invariantCodes.includes('INV-LEDGER-04'));
        assert.ok(anchors.explicitMemoryIds.includes(17));

        const queryVec = makeDenseVec([[0, 1.0]], 901);

        // Baseline A/B check with calibrated fusion + relational graph probe DISABLED:
        // Note: Store has ZERO `[Session N]` brackets and #16/#17 share ZERO query words or axis-0 cosine with the query!
        const unprobedRes = await unifiedRetrieve({
            query: 'How does settlement retry jitter affect durability?',
            project: graphProj,
            limit_tokens: 2400,
            enable_calibrated_fusion: false,
            _embedding: queryVec
        });
        const unprobedCited = unprobedRes.citations.map(c => Number(c.id));
        assert.ok(unprobedCited.includes(430), 'Hop-1 seed #430 should appear in baseline');
        assert.equal(
            unprobedCited.includes(16),
            false,
            'Without SkinMind relational graph probing, deep off-scan Lesson #16 (zero query words, zero direct cosine) is missed'
        );
        assert.equal(
            unprobedCited.includes(17),
            false,
            'Without SkinMind relational graph probing, deep off-scan Memory #17 (zero query words, zero direct cosine) is missed'
        );

        // Enabled Pillar 4 (FERN + SkinMind): rescues BOTH deep lesson #16 (`INV-LEDGER-04` + `src/ledger-writer.js`) AND cited bug #17 (`Memory #17`) into Top 5!
        const probedRes = await unifiedRetrieve({
            query: 'How does settlement retry jitter affect durability?',
            project: graphProj,
            limit_tokens: 2400,
            enable_calibrated_fusion: true,
            _embedding: queryVec
        });
        const probedTop5 = probedRes.citations.slice(0, 5).map(c => Number(c.id));
        assert.equal(probedTop5[0], 430, 'Primary Hop-1 seed #430 remains Rank #1');
        assert.ok(
            probedTop5.includes(16),
            `Expected deep lesson #16 rescued into Top 5 via INV-LEDGER-04 + provenance.file; got ${probedTop5.join(', ')}`
        );
        assert.ok(
            probedTop5.includes(17),
            `Expected deep cited bug #17 rescued into Top 5 via EXPLICIT_ID_REF; got ${probedTop5.join(', ')}`
        );
    });
});

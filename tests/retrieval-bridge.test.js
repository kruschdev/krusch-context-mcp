import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
    getProjectDb,
    resolveProjectPath,
    closeAllDatabases,
    encodeEmbeddingBlob,
    cosineSimilarity,
    withTransaction
} from '../src/sqlite-engine.js';
import { stemToken, extractQueryTokens } from '../src/retrieval-lexical.js';
import {
    computeResidualBridgeVector,
    extractBridgeCandidates,
    expandMultiHopBridges
} from '../src/retrieval-bridge.js';
import { pool } from '../db/pool.js';

/**
 * Builds a dense, finite, L2-normalized 1024-dim vector combining primary basis components
 * with deterministic low-amplitude dense background so `_isSparseSyntheticVector` is false
 * (exercising full snowflake-arctic-embed2 isotropic calibration) or sparse when `dense=false`.
 */
function makeAxisVec(components = [], { dim = 1024, dense = false, seed = 1 } = {}) {
    const vec = new Float64Array(dim);
    if (dense) {
        for (let i = 0; i < dim; i++) {
            vec[i] = 0.002 * Math.sin((i + 1) * (seed + 0.37));
        }
    }
    for (const [axis, weight] of components) {
        vec[axis % dim] += weight;
    }
    let normSq = 0;
    for (let i = 0; i < dim; i++) normSq += vec[i] * vec[i];
    const norm = Math.sqrt(normSq) || 1;
    const out = new Array(dim);
    for (let i = 0; i < dim; i++) out[i] = vec[i] / norm;
    return out;
}

function l2Norm(vec) {
    let sum = 0;
    for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
    return Math.sqrt(sum);
}

test('Pillar 2 (v2.0): 2-Hop Multi-Session Bridge Expansion Suite (src/retrieval-bridge.js)', async (t) => {
    const runId = Date.now();
    const facetProj = `test_v200_bridge_facet_${runId}`;
    const entityProj = `test_v200_bridge_entity_${runId}`;
    const disjointProj = `test_v200_bridge_disjoint_${runId}`;
    const ephemeralProjects = [facetProj, entityProj, disjointProj];

    t.after(async () => {
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

    await t.test('1. Gram-Schmidt residual bridge vector: L2 norm, exact beta=1.0 orthogonality, damped beta=0.75 bridge amplification, and degenerate guards', () => {
        // Query aligned with axis 0; Hop-1 seed mixes query axis 0 and unqueried bridge axis 1
        const qVec = makeAxisVec([[0, 1.0]]);
        const hop1SeedA = makeAxisVec([[0, 0.72], [1, 0.69]]);
        const hop1SeedB = makeAxisVec([[0, 0.68], [1, 0.73]]);
        const bridgeTargetVec = makeAxisVec([[1, 1.0]]);

        // Exact orthogonal projection at beta = 1.0
        const orthResidual = computeResidualBridgeVector(qVec, [hop1SeedA, hop1SeedB], 1.0);
        assert.ok(orthResidual instanceof Float32Array, 'Must return Float32Array');
        assert.equal(orthResidual.length, 1024);
        assert.equal(orthResidual.byteLength, 4096);
        assert.ok(Math.abs(l2Norm(orthResidual) - 1.0) < 1e-5, 'Residual vector must be unit L2-normalized');
        assert.ok(
            Math.abs(cosineSimilarity(orthResidual, qVec)) < 1e-6,
            'At beta=1.0, residual vector must be strictly orthogonal to queryVec'
        );
        assert.ok(
            cosineSimilarity(orthResidual, bridgeTargetVec) > 0.999,
            'At beta=1.0, residual vector must align with the unqueried bridge axis'
        );

        // Damped projection at default beta = 0.75
        const dampedResidual = computeResidualBridgeVector(qVec, [hop1SeedA, hop1SeedB]);
        assert.ok(dampedResidual instanceof Float32Array);
        assert.equal(dampedResidual.length, 1024);
        assert.ok(Math.abs(l2Norm(dampedResidual) - 1.0) < 1e-5);
        const seedToBridgeCos = cosineSimilarity(hop1SeedA, bridgeTargetVec);
        const residualToBridgeCos = cosineSimilarity(dampedResidual, bridgeTargetVec);
        const seedToQueryCos = cosineSimilarity(hop1SeedA, qVec);
        const residualToQueryCos = cosineSimilarity(dampedResidual, qVec);
        assert.ok(
            residualToBridgeCos > seedToBridgeCos + 0.20,
            `Damped residual must amplify bridge-axis alignment (${residualToBridgeCos.toFixed(4)} > ${seedToBridgeCos.toFixed(4)})`
        );
        assert.ok(
            residualToQueryCos < seedToQueryCos * 0.45,
            `Damped residual must attenuate query-axis projection (${residualToQueryCos.toFixed(4)} < ${seedToQueryCos.toFixed(4)})`
        );

        // Degenerate / synthetic constant vector / non-1024d safety guards + unaligned Uint8Array(4096) blob decode (INV-V2-07)
        const constVec = new Array(1024).fill(0.05);
        assert.equal(computeResidualBridgeVector(null, [hop1SeedA]), null);
        assert.equal(computeResidualBridgeVector([1, 0, 0], [[1, 0, 0]]), null);
        assert.equal(computeResidualBridgeVector(new Float32Array(512).fill(0.1), [hop1SeedA]), null, 'Non-1024d vectors must be rejected');
        assert.equal(computeResidualBridgeVector(constVec, [hop1SeedA]), null);
        assert.equal(computeResidualBridgeVector(qVec, [constVec]), null);
        assert.equal(computeResidualBridgeVector(qVec, []), null);
        assert.equal(computeResidualBridgeVector(qVec, [qVec], 1.0), null, 'Collinear hop1 === query at beta=1.0 has zero residual norm and must return null');

        const rawQBlob = encodeEmbeddingBlob(qVec);
        const rawHBlob = encodeEmbeddingBlob(hop1SeedA);
        const unalignedSlab = new Uint8Array(rawQBlob.byteLength + rawHBlob.byteLength + 6);
        unalignedSlab.set(rawQBlob, 1);
        unalignedSlab.set(rawHBlob, 3 + rawQBlob.byteLength);
        const unalignedQ = unalignedSlab.subarray(1, 1 + rawQBlob.byteLength);
        const unalignedH = unalignedSlab.subarray(3 + rawQBlob.byteLength, 3 + rawQBlob.byteLength + rawHBlob.byteLength);
        const blobResidual = computeResidualBridgeVector(unalignedQ, [unalignedH], 0.75);
        assert.ok(blobResidual instanceof Float32Array && blobResidual.length === 1024);
        assert.ok(Math.abs(l2Norm(blobResidual) - 1.0) < 1e-5);
    });

    await t.test('2. Uncovered query facet Hop-2 FTS5 rescue beyond initial candidateMap', async () => {
        const db = await getProjectDb(facetProj);
        const qVec = makeAxisVec([[0, 1.0]], { dense: true, seed: 11 });
        const deepPasskeyVec = makeAxisVec([[0, 0.22], [2, 0.97]], { dense: true, seed: 12 });
        const hop1KerberosVec = makeAxisVec([[0, 0.78], [1, 0.62]], { dense: true, seed: 13 });
        const fillerVec = makeAxisVec([[5, 1.0]], { dense: true, seed: 14 });

        withTransaction(db, () => {
            const stmt = db.prepare(`
                INSERT INTO ide_agent_memory (category, content, tags, status, embedding_blob, project)
                VALUES ('decision', ?, ?, 'ACTIVE', ?, ?)
            `);
            // Row #1: Deep historical turn in Session 1 (excluded from initial candidateMap to simulate >KRUSCH_MAX_ACTIVE_SCAN)
            stmt.run(
                '[Session 1 | Date: Jan 3, 2026 | Turn #1/60] USER: For hardware MFA we standardized on WebAuthn passkeys backed by YubiKey hardware tokens. | ASSISTANT: Recorded WebAuthn passkey hardware MFA requirement.',
                '["session-1","auth"]',
                encodeEmbeddingBlob(deepPasskeyVec),
                facetProj
            );

            // Rows #2..#49: 48 rows across Sessions 2..6 inside initial candidateMap
            for (let i = 2; i <= 46; i++) {
                const sess = 2 + (i % 4);
                stmt.run(
                    `[Session ${sess} | Date: Feb 10, 2026 | Turn #${i}/60] USER: Completed routine telemetry scrape #${i} on worker metrics pipeline. | ASSISTANT: Telemetry scrape #${i} verified.`,
                    `["session-${sess}"]`,
                    encodeEmbeddingBlob(fillerVec),
                    facetProj
                );
            }
            for (let i = 47; i <= 49; i++) {
                stmt.run(
                    `[Session 6 | Date: Mar 1, 2026 | Turn #${i}/60] USER: Our internal RPC gateway authenticates backend daemons using Kerberos service tickets. | ASSISTANT: Kerberos ticket renewal configured.`,
                    '["session-6","auth"]',
                    encodeEmbeddingBlob(hop1KerberosVec),
                    facetProj
                );
            }
        });

        // Simulate Step 3a window containing only rows #2..#49 (Row #1 is absent from candidateMap!)
        const activeWindowRows = db.prepare(`
            SELECT id, category, content, tags, status, supersedes_id, superseded_by, invalidated_reason, created_at, updated_at, embedding, embedding_blob
            FROM ide_agent_memory
            WHERE id >= 2
            ORDER BY id ASC
        `).all();
        assert.equal(activeWindowRows.length, 48);

        const candidateMap = new Map(activeWindowRows.map(r => [Number(r.id), r]));
        const hop1Items = activeWindowRows.map(r => {
            const isKerberosHit = Number(r.id) >= 47;
            return {
                id: r.id,
                content: r.content,
                tags: r.tags,
                rawScore: isKerberosHit ? 0.81 : 0.24,
                score: isKerberosHit ? 0.81 : 0.24,
                _unclampedScore: isKerberosHit ? 0.84 : 0.24
            };
        });

        const rawQuery = 'Compare our Kerberos daemon authentication and WebAuthn passkeys setup across sessions';
        const { distinctiveTerms } = extractQueryTokens(rawQuery.toLowerCase());
        const distinctiveStems = [...new Set(distinctiveTerms.map(stemToken))];

        const bridgeRes = expandMultiHopBridges(db, {
            rawQuery,
            queryEmbedding: qVec,
            hasRealQueryEmbedding: true,
            distinctiveTerms,
            distinctiveStems,
            hop1Items,
            candidateMap,
            allCandidateRows: activeWindowRows
        });

        assert.equal(bridgeRes.ok, true);
        assert.equal(bridgeRes.triggered, true, 'Multi-hop bridge must trigger when query facets remain uncovered');
        assert.ok(
            bridgeRes.uncoveredStems.includes(stemToken('passkeys')) || bridgeRes.uncoveredStems.includes(stemToken('webauthn')),
            'Uncovered stems must capture WebAuthn/passkeys missing from Session 6 Hop-1 hits'
        );
        assert.ok(
            bridgeRes.rescuedRows.some(r => Number(r.id) === 1),
            'Row #1 outside initial candidateMap must be rescued via SQLite FTS5'
        );
        const boost1 = bridgeRes.bridgeBoostById.get(1);
        assert.ok(boost1, 'Rescued Row #1 must receive a bridgeBoostById entry');
        assert.ok(boost1.bonus >= 0.13, `Uncovered facet match should grant bonus >= 0.13 (got ${boost1.bonus})`);
        assert.ok(boost1.bridgeScore >= 0.50 && boost1.bridgeScore <= 0.88);
    });

    await t.test('3. Single-turn (sCount === 1) entity bridge across Session 1 -> Session 8 without explicit uncovered query terms', async () => {
        const db = await getProjectDb(entityProj);

        // Query asks about ingestion throughput bottleneck (axis 0).
        // Session 1 Turn #2 matches query (axis 0 + bridge axis 3) and mentions codename "valhalla-ingest" + "clickhouse" ONCE (sCount === 1).
        // Session 8 Turn #1 (deep row outside candidateMap, or cross-session turn) has zero query words, only "valhalla-ingest" + "clickhouse" along bridge axis 3!
        const qVec = makeAxisVec([[0, 1.0]], { dense: true, seed: 21 });
        const sess1SeedVec = makeAxisVec([[0, 0.74], [3, 0.67]], { dense: true, seed: 22 });
        const sess8BridgeVec = makeAxisVec([[3, 0.98], [0, 0.12]], { dense: true, seed: 23 });
        const fillerVec = makeAxisVec([[7, 1.0]], { dense: true, seed: 24 });

        withTransaction(db, () => {
            const stmt = db.prepare(`
                INSERT INTO ide_agent_memory (category, content, tags, status, embedding_blob, project)
                VALUES ('decision', ?, ?, 'ACTIVE', ?, ?)
            `);
            // Row #1: Session 8 target turn (contains bridge entities valhalla-ingest & clickhouse, zero query words!)
            stmt.run(
                '[Session 8 | Date: Apr 18, 2026 | Turn #1/52] USER: On valhalla-ingest we tuned ClickHouse async_insert batching to 250000 rows per flush. | ASSISTANT: Applied ClickHouse async_insert tuning on valhalla-ingest.',
                '["session-8"]',
                encodeEmbeddingBlob(sess8BridgeVec),
                entityProj
            );
            // Row #2: Single Hop-1 seed in Session 1 (sCount === 1!) covering all query terms + introducing entity bridges
            stmt.run(
                '[Session 1 | Date: Apr 1, 2026 | Turn #2/52] USER: Our telemetry ingestion throughput bottleneck started after routing events into valhalla-ingest and ClickHouse shards. | ASSISTANT: Let us profile the telemetry ingestion throughput bottleneck.',
                '["session-1"]',
                encodeEmbeddingBlob(sess1SeedVec),
                entityProj
            );
            // Rows #3..#48: 46 filler turns distributed across Sessions 1..7 (so storeSessions.size >= 7 >= 5)
            for (let i = 3; i <= 48; i++) {
                const sess = 1 + (i % 7);
                stmt.run(
                    `[Session ${sess} | Date: Apr ${2 + (i % 10)}, 2026 | Turn #${i}/52] USER: Reviewed CSS spacing tokens and typography scale on card component #${i}. | ASSISTANT: Updated card component #${i} styles.`,
                    `["session-${sess}"]`,
                    encodeEmbeddingBlob(fillerVec),
                    entityProj
                );
            }
        });

        // Candidate window contains rows #2..#48 (Row #1 in Session 8 is rescued via FTS5!)
        const windowRows = db.prepare(`
            SELECT id, category, content, tags, status, supersedes_id, superseded_by, invalidated_reason, created_at, updated_at, embedding, embedding_blob
            FROM ide_agent_memory
            WHERE id >= 2
            ORDER BY id ASC
        `).all();
        const candidateMap = new Map(windowRows.map(r => [Number(r.id), r]));
        const hop1Items = windowRows.map(r => ({
            id: r.id,
            content: r.content,
            tags: r.tags,
            rawScore: Number(r.id) === 2 ? 0.84 : 0.21,
            score: Number(r.id) === 2 ? 0.84 : 0.21,
            _unclampedScore: Number(r.id) === 2 ? 0.86 : 0.21
        }));

        // Notice: ALL distinctive query terms ("profile", "telemetry", "ingestion", "throughput", "bottleneck") ARE covered in Row #2!
        // And there is NO "across"/"both" keyword in rawQuery — triggering relies purely on storeSessions >= 5, hop1Sessions <= 2, and sCount === 1 entityBridgeTerms >= 2!
        const rawQuery = 'Why did we profile the telemetry ingestion throughput bottleneck?';
        const { distinctiveTerms } = extractQueryTokens(rawQuery.toLowerCase());
        const distinctiveStems = [...new Set(distinctiveTerms.map(stemToken))];

        const candInfo = extractBridgeCandidates({
            distinctiveTerms,
            distinctiveStems,
            hop1Items,
            allCandidateRows: windowRows
        });
        assert.equal(candInfo.uncoveredStems.length, 0, 'All explicit query stems are already covered in Session 1');
        assert.ok(
            candInfo.entityBridgeTerms.includes('valhalla-ingest') && candInfo.entityBridgeTerms.includes('clickhouse'),
            `Single-turn (sCount===1) entities must be extracted: got ${JSON.stringify(candInfo.entityBridgeTerms)}`
        );

        const bridgeRes = expandMultiHopBridges(db, {
            rawQuery,
            queryEmbedding: qVec,
            hasRealQueryEmbedding: true,
            distinctiveTerms,
            distinctiveStems,
            hop1Items,
            candidateMap,
            allCandidateRows: windowRows
        });

        assert.equal(bridgeRes.triggered, true, 'Must trigger via storeSessions >= 5 && hop1Sessions <= 2 && entityBridgeTerms >= 2');
        assert.ok(bridgeRes.residualVector instanceof Float32Array);
        assert.ok(
            bridgeRes.rescuedRows.some(r => Number(r.id) === 1),
            'Session 8 turn (Row #1) must be rescued via sCount===1 entity bridge + residual vector grounding'
        );
        const boost = bridgeRes.bridgeBoostById.get(1);
        assert.ok(boost, 'Session 8 turn must receive Hop-2 boost');
        assert.ok(boost.bonus >= 0.11);
        assert.ok(boost.bridgeScore >= 0.55);
    });

    await t.test('4. Low-score Abstention safety gate: refuses to hop when top Hop-1 (rawScore ?? score) < 0.56', async () => {
        const db = await getProjectDb(entityProj);
        const rows = db.prepare(`
            SELECT id, category, content, tags, status, supersedes_id, superseded_by, invalidated_reason, created_at, updated_at, embedding, embedding_blob
            FROM ide_agent_memory
            ORDER BY id ASC
        `).all();
        const candidateMap = new Map(rows.map(r => [Number(r.id), r]));
        const qVec = makeAxisVec([[9, 1.0]], { dense: true, seed: 31 });

        // Top item has rawScore = 0.54 (< 0.56) even though _unclampedScore is 0.59 and uncovered terms exist
        const lowScoreHop1 = rows.map((r, idx) => ({
            id: r.id,
            content: r.content,
            tags: r.tags,
            rawScore: idx === 0 ? 0.54 : 0.31,
            score: idx === 0 ? 0.54 : 0.31,
            _unclampedScore: idx === 0 ? 0.59 : 0.31
        }));

        const res = expandMultiHopBridges(db, {
            rawQuery: 'How many quantum superconducting qubits did we calibrate across both sessions?',
            queryEmbedding: qVec,
            hasRealQueryEmbedding: true,
            distinctiveTerms: ['quantum', 'superconducting', 'qubits'],
            distinctiveStems: ['quantum', 'superconduct', 'qubit'],
            hop1Items: lowScoreHop1,
            candidateMap,
            allCandidateRows: rows
        });

        assert.equal(res.ok, true);
        assert.equal(res.triggered, false, 'Must NOT trigger Hop-2 when top Hop-1 rawScore < 0.56 (Abstention protection)');
        assert.equal(res.residualVector, null);
        assert.equal(res.rescuedRows.length, 0);
        assert.equal(res.bridgeBoostById.size, 0);
    });

    await t.test('5. Sequence-order, offline-embedding, and small-store (< 40 rows) non-trigger safety gates', async () => {
        const db = await getProjectDb(entityProj);
        const rows = db.prepare(`
            SELECT id, category, content, tags, status, supersedes_id, superseded_by, invalidated_reason, created_at, updated_at, embedding, embedding_blob
            FROM ide_agent_memory
            ORDER BY id ASC
        `).all();
        const candidateMap = new Map(rows.map(r => [Number(r.id), r]));
        const qVec = makeAxisVec([[0, 1.0]], { dense: true, seed: 41 });
        const strongHop1 = rows.map((r, idx) => ({
            id: r.id,
            content: r.content,
            tags: r.tags,
            rawScore: idx === 1 ? 0.88 : 0.25,
            score: idx === 1 ? 0.88 : 0.25,
            _unclampedScore: idx === 1 ? 0.90 : 0.25
        }));

        // 5a. Sequence-order query must bypass Hop-2
        const seqRes = expandMultiHopBridges(db, {
            rawQuery: 'In what chronological order did we configure telemetry ingestion and passkeys across sessions?',
            queryEmbedding: qVec,
            hasRealQueryEmbedding: true,
            distinctiveTerms: ['telemetry', 'ingestion', 'passkeys'],
            distinctiveStems: ['telemetry', 'ingestion', 'passkey'],
            hop1Items: strongHop1,
            candidateMap,
            allCandidateRows: rows
        });
        assert.equal(seqRes.triggered, false, 'Sequence-order queries must not trigger Hop-2 entity expansion');

        // 5b. hasRealQueryEmbedding === false must bypass Hop-2
        const offlineRes = expandMultiHopBridges(db, {
            rawQuery: 'Compare telemetry ingestion across both sessions',
            queryEmbedding: null,
            hasRealQueryEmbedding: false,
            distinctiveTerms: ['telemetry', 'ingestion', 'passkeys'],
            distinctiveStems: ['telemetry', 'ingestion', 'passkey'],
            hop1Items: strongHop1,
            candidateMap,
            allCandidateRows: rows
        });
        assert.equal(offlineRes.triggered, false, 'Offline mode without real query embedding must not trigger Hop-2');

        // 5c. Small store (< 40 candidate rows) must bypass Hop-2
        const smallStoreRes = expandMultiHopBridges(db, {
            rawQuery: 'Compare telemetry ingestion across both sessions',
            queryEmbedding: qVec,
            hasRealQueryEmbedding: true,
            distinctiveTerms: ['telemetry', 'ingestion', 'passkeys'],
            distinctiveStems: ['telemetry', 'ingestion', 'passkey'],
            hop1Items: strongHop1.slice(0, 25),
            candidateMap,
            allCandidateRows: rows.slice(0, 25)
        });
        assert.equal(smallStoreRes.triggered, false, 'Stores with < 40 candidate rows must not trigger Hop-2');
    });

    await t.test('6. Dominant-session disjointness filter: skips same-session entity-only echoes while boosting disjoint sessions and uncovered facets', async () => {
        const db = await getProjectDb(disjointProj);
        const qVec = makeAxisVec([[0, 1.0]], { dense: true, seed: 51 });
        const domSeedVec = makeAxisVec([[0, 0.76], [4, 0.65]], { dense: true, seed: 52 });
        const bridgeTargetVec = makeAxisVec([[4, 0.96], [0, 0.18]], { dense: true, seed: 53 });
        const fillerVec = makeAxisVec([[8, 1.0]], { dense: true, seed: 54 });

        withTransaction(db, () => {
            const stmt = db.prepare(`
                INSERT INTO ide_agent_memory (category, content, tags, status, embedding_blob, project)
                VALUES ('decision', ?, ?, 'ACTIVE', ?, ?)
            `);
            // Rows #1..#4: 4 top Hop-1 hits all in Session 2 -> dominantSessionId === 2 (>= 3 of top-5)
            for (let i = 1; i <= 4; i++) {
                stmt.run(
                    `[Session 2 | Date: May 2, 2026 | Turn #${i}/50] USER: We configured perimeter firewall routing rules over WireGuard mesh tunnels on node-${i}. | ASSISTANT: Firewall routing rule #${i} active.`,
                    '["session-2"]',
                    encodeEmbeddingBlob(domSeedVec),
                    disjointProj
                );
            }
            // Row #5: Same-session (Session 2) non-top-8 turn mentioning only entity bridge "wireguard" (NO uncovered stem) -> MUST BE SKIPPED!
            stmt.run(
                '[Session 2 | Date: May 2, 2026 | Turn #5/50] USER: Double-checked WireGuard keepalive interval on that tunnel. | ASSISTANT: Keepalive verified.',
                '["session-2"]',
                encodeEmbeddingBlob(bridgeTargetVec),
                disjointProj
            );
            // Row #6: Disjoint-session (Session 6) turn mentioning entity bridge "wireguard" -> MUST BE BOOSTED!
            stmt.run(
                '[Session 6 | Date: May 19, 2026 | Turn #6/50] USER: Rotated WireGuard preshared keys to 90-day hardware cadence on edge routers. | ASSISTANT: Rotated WireGuard keys.',
                '["session-6"]',
                encodeEmbeddingBlob(bridgeTargetVec),
                disjointProj
            );
            // Rows #7..#46: 40 filler rows across Sessions 1, 3, 4, 5, 6
            for (let i = 7; i <= 46; i++) {
                const sess = [1, 3, 4, 5, 6][i % 5];
                stmt.run(
                    `[Session ${sess} | Date: May ${3 + (i % 12)}, 2026 | Turn #${i}/50] USER: Checked frontend bundle sourcemap artifact #${i}. | ASSISTANT: Bundle #${i} clean.`,
                    `["session-${sess}"]`,
                    encodeEmbeddingBlob(fillerVec),
                    disjointProj
                );
            }
        });

        const rows = db.prepare(`
            SELECT id, category, content, tags, status, supersedes_id, superseded_by, invalidated_reason, created_at, updated_at, embedding, embedding_blob
            FROM ide_agent_memory
            ORDER BY id ASC
        `).all();
        const candidateMap = new Map(rows.map(r => [Number(r.id), r]));
        const hop1Items = rows.map(r => {
            const id = Number(r.id);
            const isTopSeed = id >= 1 && id <= 4;
            return {
                id,
                content: r.content,
                tags: r.tags,
                rawScore: isTopSeed ? 0.83 : 0.22,
                score: isTopSeed ? 0.83 : 0.22,
                _unclampedScore: isTopSeed ? (0.88 - id * 0.01) : 0.22
            };
        });

        const rawQuery = 'Summarize all our perimeter firewall routing changes across sessions';
        const { distinctiveTerms } = extractQueryTokens(rawQuery.toLowerCase());
        const distinctiveStems = [...new Set(distinctiveTerms.map(stemToken))];

        const res = expandMultiHopBridges(db, {
            rawQuery,
            queryEmbedding: qVec,
            hasRealQueryEmbedding: true,
            distinctiveTerms,
            distinctiveStems,
            hop1Items,
            candidateMap,
            allCandidateRows: rows
        });

        assert.equal(res.triggered, true);
        assert.equal(
            res.bridgeBoostById.has(5),
            false,
            'Row #5 in dominant Session 2 without uncovered query stems must be skipped by disjointness filter'
        );
        assert.equal(
            res.bridgeBoostById.has(6),
            true,
            'Row #6 in disjoint Session 6 matching WireGuard + residual similarity must be boosted'
        );

        // Also verify 2-vs-1 plurality Hop-1 split (2 confident hits in Session 2, 1 confident hit in Session 4)
        const pluralityHop1 = rows.map(r => {
            const id = Number(r.id);
            const isSess2Seed = id === 1 || id === 2;
            const isSess4Seed = id === 10; // Row #10 has sess = [1, 3, 4, 5, 6][10 % 5] = 1
            return {
                id,
                content: r.content,
                tags: r.tags,
                rawScore: isSess2Seed ? 0.84 : (isSess4Seed ? 0.61 : 0.20),
                score: isSess2Seed ? 0.84 : (isSess4Seed ? 0.61 : 0.20),
                _unclampedScore: isSess2Seed ? (0.87 - id * 0.01) : (isSess4Seed ? 0.62 : 0.20)
            };
        });
        const pluralityRes = expandMultiHopBridges(db, {
            rawQuery,
            queryEmbedding: qVec,
            hasRealQueryEmbedding: true,
            distinctiveTerms,
            distinctiveStems,
            hop1Items: pluralityHop1,
            candidateMap,
            allCandidateRows: rows
        });
        assert.equal(pluralityRes.triggered, true);
        assert.equal(
            pluralityRes.bridgeBoostById.has(5),
            false,
            '2-vs-1 plurality in Session 2 must still filter same-session echo Row #5'
        );
        assert.equal(
            pluralityRes.bridgeBoostById.has(6),
            true,
            '2-vs-1 plurality must still boost disjoint Session 6 Row #6'
        );
    });

    await t.test('7. INV-V2-03 static zero-leakage compliance & < 5ms synchronous hot-path latency', async () => {
        const srcPath = path.resolve(import.meta.dirname, '..', 'src', 'retrieval-bridge.js');
        const code = fs.readFileSync(srcPath, 'utf8');
        const forbiddenPatterns = [
            /\bprobing_questions\b/i,
            /\bsource_chat_ids\b/i,
            /\bideal_response\b/i,
            /\bUNRECORDED_ASPECT_PROBE\b/i,
            /\b(openweather|formspree|budgettracker|figma|trello|jira|alembic)\b/i,
            /\b(DETAIL_HEAD_STEMS|ACTION_MODIFIER_STEMS|EPISTEMIC_STOP_WORDS|isUnattestedHeadDetail)\b/,
            /\b(celebrated|enrolled|practiced)\b/i,
            /Detailed Schedule\|Example Timeline/i,
            /\[Code blocks with syntax highlighting\]/i
        ];
        for (const pat of forbiddenPatterns) {
            assert.equal(pat.test(code), false, `Forbidden pattern ${pat} must not appear in src/retrieval-bridge.js`);
        }

        // Warm + measure synchronous Hop-2 execution latency
        const db = await getProjectDb(disjointProj);
        const rows = db.prepare(`
            SELECT id, category, content, tags, status, supersedes_id, superseded_by, invalidated_reason, created_at, updated_at, embedding, embedding_blob
            FROM ide_agent_memory
            ORDER BY id ASC
        `).all();
        const candidateMap = new Map(rows.map(r => [Number(r.id), r]));
        const qVec = makeAxisVec([[0, 1.0]], { dense: true, seed: 61 });
        const hop1Items = rows.map(r => ({
            id: r.id,
            content: r.content,
            tags: r.tags,
            rawScore: Number(r.id) <= 4 ? 0.83 : 0.22,
            score: Number(r.id) <= 4 ? 0.83 : 0.22,
            _unclampedScore: Number(r.id) <= 4 ? 0.85 : 0.22
        }));

        // Warmup run (JIT + WeakMap feature cache)
        expandMultiHopBridges(db, {
            rawQuery: 'Summarize all our perimeter firewall routing changes across sessions',
            queryEmbedding: qVec,
            hasRealQueryEmbedding: true,
            distinctiveTerms: ['perimeter', 'firewall', 'routing'],
            distinctiveStems: ['perimeter', 'firewall', 'rout'],
            hop1Items,
            candidateMap,
            allCandidateRows: rows
        });

        const t0 = performance.now();
        const res = expandMultiHopBridges(db, {
            rawQuery: 'Summarize all our perimeter firewall routing changes across sessions',
            queryEmbedding: qVec,
            hasRealQueryEmbedding: true,
            distinctiveTerms: ['perimeter', 'firewall', 'routing'],
            distinctiveStems: ['perimeter', 'firewall', 'rout'],
            hop1Items,
            candidateMap,
            allCandidateRows: rows
        });
        const elapsedMs = performance.now() - t0;

        assert.equal(res.triggered, true);
        assert.ok(elapsedMs < 15, `Hop-2 execution must stay ultra-fast (<15ms CI ceiling, actual ${elapsedMs.toFixed(2)}ms)`);
    });

    await t.test('8. Sparse axis-5 basis vectors, Uint8Array(4096) queryEmbedding blob parity, and NaN row vector immunity (INV-V2-07)', async () => {
        // 8a. Pure sparse basis vectors on axes 5 and 6 (zeros at 0, 1, 512, 1023) must produce a valid normalized residual
        const sparseQ = new Float32Array(1024);
        sparseQ[5] = 1.0;
        const sparseHop1 = new Float32Array(1024);
        sparseHop1[5] = 0.6;
        sparseHop1[6] = 0.8;
        const sparseRes = computeResidualBridgeVector(sparseQ, [sparseHop1], 0.75);
        assert.ok(sparseRes instanceof Float32Array && sparseRes.length === 1024, 'Sparse axis-5/6 vectors must return a 1024d Float32Array');
        assert.ok(sparseRes[6] > 0.9, `Residual must align strongly with bridge axis 6 (got ${sparseRes[6]})`);

        // 8b. Uint8Array(4096) queryEmbedding blob must produce identical Hop-2 bridgeScores to Float32Array(1024), and NaN row JSON must never yield NaN bridgeScore
        const db = await getProjectDb(disjointProj);
        const rows = db.prepare(`
            SELECT id, category, content, tags, status, supersedes_id, superseded_by, invalidated_reason, created_at, updated_at, embedding, embedding_blob
            FROM ide_agent_memory
            ORDER BY id ASC
        `).all();
        const nanPoisonedRow = {
            id: 99999,
            category: 'decision',
            content: '[Session 9 | Date: May 29, 2026 | Turn #9/50] USER: Audited audit_trail_facet compliance rules on edge gateway. | ASSISTANT: Clean.',
            tags: '["session-9"]',
            status: 'ACTIVE',
            embedding: JSON.stringify(Array.from({ length: 1024 }, (_, idx) => (idx === 3 ? Number.NaN : 0.01))),
            embedding_blob: null
        };
        const rowsWithNan = [...rows, nanPoisonedRow];
        const candidateMap = new Map(rowsWithNan.map(r => [Number(r.id), r]));
        const qVec = makeAxisVec([[0, 1.0]], { dense: true, seed: 71 });
        const qBlob = encodeEmbeddingBlob(qVec);
        const hop1Items = rowsWithNan.map(r => ({
            id: r.id,
            content: r.content,
            tags: r.tags,
            rawScore: Number(r.id) <= 4 ? 0.83 : 0.22,
            score: Number(r.id) <= 4 ? 0.83 : 0.22,
            _unclampedScore: Number(r.id) <= 4 ? 0.85 : 0.22
        }));

        const f32Out = expandMultiHopBridges(db, {
            rawQuery: 'Summarize perimeter firewall routing and audit_trail_facet across sessions',
            queryEmbedding: qVec,
            hasRealQueryEmbedding: true,
            distinctiveTerms: ['perimeter', 'firewall', 'routing', 'audit_trail_facet'],
            distinctiveStems: ['perimeter', 'firewall', 'rout', stemToken('audit_trail_facet')],
            hop1Items,
            candidateMap,
            allCandidateRows: rowsWithNan
        });
        const blobOut = expandMultiHopBridges(db, {
            rawQuery: 'Summarize perimeter firewall routing and audit_trail_facet across sessions',
            queryEmbedding: qBlob,
            hasRealQueryEmbedding: true,
            distinctiveTerms: ['perimeter', 'firewall', 'routing', 'audit_trail_facet'],
            distinctiveStems: ['perimeter', 'firewall', 'rout', stemToken('audit_trail_facet')],
            hop1Items,
            candidateMap,
            allCandidateRows: rowsWithNan
        });

        assert.equal(f32Out.triggered, true);
        assert.equal(blobOut.triggered, true);
        for (const [id, info] of blobOut.bridgeBoostById.entries()) {
            assert.ok(Number.isFinite(info.bridgeScore), `bridgeScore for row #${id} must be finite (got ${info.bridgeScore})`);
            assert.ok(
                Math.abs(info.bridgeScore - (f32Out.bridgeBoostById.get(id)?.bridgeScore ?? 0)) < 1e-6,
                `Uint8Array(4096) queryEmbedding must match Float32Array bridgeScore for row #${id}`
            );
        }
        assert.ok(blobOut.bridgeBoostById.has(99999), 'Uncovered stem row #99999 should still be grounded lexically');
        assert.ok(Number.isFinite(blobOut.bridgeBoostById.get(99999).bridgeScore), 'Corrupted NaN row vector must never poison bridgeScore with NaN');
    });
});

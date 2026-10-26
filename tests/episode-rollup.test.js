import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import {
    ensureRollupSchema,
    stripTurnCitations,
    ensureEpisodeRollups,
    searchEpisodeRollups
} from '../src/episode-rollup.js';
import {
    getProjectDb,
    withTransaction,
    encodeEmbeddingBlob,
    decodeEmbeddingBlob,
    cosineSimilarity,
    closeAllDatabases
} from '../src/sqlite-engine.js';
import {
    STOP_WORDS,
    TEMPORAL_CUE_WORDS,
    GENERIC_INFRA_WORDS,
    META_QUERY_WORDS,
    estimateTokens
} from '../src/retrieval-lexical.js';
import { pool } from '../db/pool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Generates a deterministic L2-normalized 1024-d Float32Array seeded by topic index + jitter seed.
 * Uses dense non-constant components across all 1024 dimensions so vectors behave like realistic
 * isotropic embeddings rather than sparse/constant stubs.
 */
function makeUnitVector(topicIdx, noiseSeed = 0, topicStrength = 5.5) {
    const vec = new Float32Array(1024);
    let sq = 0;
    const baseBand = (topicIdx * 37) % 960;
    for (let i = 0; i < 1024; i++) {
        const wave = Math.sin((i + 1) * 0.173 + (noiseSeed + 1) * 0.619 + topicIdx * 1.31) * 0.22;
        const bandSignal = (i >= baseBand && i < baseBand + 48)
            ? topicStrength * Math.cos((i - baseBand) * 0.11)
            : 0;
        vec[i] = wave + bandSignal;
        sq += vec[i] * vec[i];
    }
    const norm = Math.sqrt(sq) || 1;
    for (let i = 0; i < 1024; i++) {
        vec[i] /= norm;
    }
    return vec;
}

test('Pillar 1 — Two-Level Hierarchical Episode Rollups (src/episode-rollup.js)', async (t) => {
    const uniqueTag = `${Date.now()}_${process.pid}`;
    const createdProjects = new Set();
    const tempFiles = [];

    const makeProjectName = (slug) => {
        const name = `test_v200_${slug}_${uniqueTag}`;
        createdProjects.add(name);
        return name;
    };

    t.after(async () => {
        closeAllDatabases();
        for (const proj of createdProjects) {
            try {
                fs.rmSync(path.join(os.homedir(), '.krusch-context', 'projects', proj), {
                    recursive: true,
                    force: true
                });
            } catch {}
        }
        for (const fp of tempFiles) {
            try {
                fs.rmSync(fp, { recursive: true, force: true });
            } catch {}
        }
        try {
            await pool.end();
        } catch {}
    });

    await t.test('1. Small-store (< 240 rows) fast no-op & read-only DB graceful fallback (INV-V2-05)', async () => {
        const proj = makeProjectName('small_noop');
        const db = await getProjectDb(proj);

        const insertStmt = db.prepare(`
            INSERT INTO ide_agent_memory (category, content, tags, embedding_blob, status)
            VALUES (?, ?, ?, ?, 'ACTIVE')
        `);
        withTransaction(db, () => {
            for (let i = 0; i < 120; i++) {
                const vec = makeUnitVector(1, i);
                insertStmt.run(
                    'lesson',
                    `[Session 1 | Date: 2026-01-15 | Turn #${i * 2}/${i * 2 + 1}] USER: Discussing caching throughput metric ${i} | ASSISTANT: Logged throughput ${i}.`,
                    '["session-1"]',
                    encodeEmbeddingBlob(vec)
                );
            }
        });

        const firstEnsure = ensureEpisodeRollups(db);
        assert.deepEqual(firstEnsure, {
            ok: true,
            active: false,
            rollupCount: 0,
            directiveCount: 0,
            rebuilt: false
        });

        // Verifyide_episode_rollups was not even needed/populated on < 240 rows
        const tableCheck = db.prepare(
            `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ide_episode_rollups'`
        ).get();
        assert.equal(tableCheck, undefined, 'Small store (< 240 rows) must not create rollup tables unnecessarily');

        // Benchmark repeat no-op speed (< 0.1ms per call)
        const iterations = 100;
        const t0 = performance.now();
        for (let k = 0; k < iterations; k++) {
            const res = ensureEpisodeRollups(db);
            assert.equal(res.active, false);
        }
        const avgMs = (performance.now() - t0) / iterations;
        assert.ok(avgMs < 0.1, `Expected small-store no-op < 0.1ms, got ${avgMs.toFixed(4)}ms`);

        const searchRes = searchEpisodeRollups(db, {
            queryEmbedding: makeUnitVector(1, 999),
            evalTerms: ['caching', 'throughput']
        });
        assert.equal(searchRes.ok, true);
        assert.equal(searchRes.active, false);
        assert.deepEqual(searchRes.episodes, []);
        assert.deepEqual(searchRes.childMemoryIds, []);
        assert.deepEqual(searchRes.directiveMemoryIds, []);
        assert.equal(searchRes.parentScoreByMemoryId.size, 0);
        assert.equal(searchRes.panoramaMarkdown, '');

        // Read-only DB handle without rollup schema must return false gracefully without throwing
        const roDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch_ro_rollup_'));
        tempFiles.push(roDir);
        const roDbPath = path.join(roDir, 'readonly.db');
        const seedDb = new DatabaseSync(roDbPath);
        seedDb.exec(`CREATE TABLE sample (id INTEGER PRIMARY KEY);`);
        seedDb.close();

        const roDb = new DatabaseSync(roDbPath, { readOnly: true });
        try {
            assert.equal(ensureRollupSchema(roDb), false, 'Read-only DB must return false cleanly');
            const roEnsure = ensureEpisodeRollups(roDb);
            assert.equal(roEnsure.ok, false);
            assert.equal(roEnsure.active, false);
        } finally {
            roDb.close();
        }
    });

    await t.test('2. 280-row multi-session rollup build, window splitting, top_stems filtering & O(1) watermark cache hit', async () => {
        const proj = makeProjectName('multisess_280');
        const db = await getProjectDb(proj);

        // Session layout totaling 280 active rows:
        // Session 1: 90 turns -> splits into window_index 0 (64 turns) + window_index 1 (26 turns)
        // Session 2: 50 turns -> window_index 0
        // Session 3: 50 turns -> window_index 0
        // Session 4 (from tags "session-4" without header Session): 50 turns -> window_index 0
        // Null session run: 40 turns -> window_index 0
        const plan = [
            { session: 1, count: 90, topic: 'postgresql LogicalReplication WalSender', topicIdx: 2, viaTagOnly: false },
            { session: 2, count: 50, topic: 'redis SentinelFailover LuaScripting', topicIdx: 5, viaTagOnly: false },
            { session: 3, count: 50, topic: 'kubernetes IngressController MutatingWebhook', topicIdx: 8, viaTagOnly: false },
            { session: 4, count: 50, topic: 'clickhouse MaterializedView ColumnarCompression', topicIdx: 11, viaTagOnly: true },
            { session: null, count: 40, topic: 'opentelemetry SpanExporter TraceSampler', topicIdx: 14, viaTagOnly: false }
        ];

        const insertStmt = db.prepare(`
            INSERT INTO ide_agent_memory (category, content, tags, embedding_blob, status)
            VALUES (?, ?, ?, ?, 'ACTIVE')
        `);

        let turnCounter = 0;
        withTransaction(db, () => {
            for (const block of plan) {
                for (let i = 0; i < block.count; i++) {
                    turnCounter++;
                    const isDir = i === 3 && block.session !== null;
                    const isTrans = i === 12;
                    const vec = makeUnitVector(block.topicIdx, turnCounter);
                    const directiveClause = isDir
                        ? 'Please remember to always include deterministic retry backoff jitter.'
                        : '';
                    const transitionClause = isTrans
                        ? `We switched from legacy polling to streaming ${block.topic} pipelines.`
                        : '';
                    const header = block.session === null
                        ? `[Turn #${turnCounter * 2}/${turnCounter * 2 + 1}]`
                        : (block.viaTagOnly
                            ? `[Date: 2026-03-0${block.session} | Turn #${turnCounter * 2}/${turnCounter * 2 + 1}]`
                            : `[Session ${block.session} | Date: 2026-03-0${block.session} | Turn #${turnCounter * 2}/${turnCounter * 2 + 1}]`);
                    const tags = block.session !== null ? JSON.stringify([`session-${block.session}`]) : null;
                    const content = `${header} USER: Working on ${block.topic} architecture milestone ${i}. ${directiveClause} ${transitionClause} | ASSISTANT: Implemented ${block.topic} handler ${i} with 12345 metrics.`;

                    insertStmt.run(
                        isDir ? 'invariant' : 'decision',
                        content,
                        tags,
                        encodeEmbeddingBlob(vec)
                    );
                }
            }
        });

        assert.equal(turnCounter, 280);

        const buildRes = ensureEpisodeRollups(db, { project: proj, maxWindowTurns: 64 });
        assert.equal(buildRes.ok, true);
        assert.equal(buildRes.active, true);
        assert.equal(buildRes.rebuilt, true);
        assert.equal(buildRes.rollupCount, 6, '90+50+50+50+40 with maxWindowTurns=64 must produce 2+1+1+1+1 = 6 rollups');
        assert.equal(buildRes.directiveCount, 4, '4 sessions each had 1 standing directive');

        const dbRollups = db.prepare(`
            SELECT id, session_id, window_index, start_memory_id, end_memory_id,
                   turn_count, child_ids_json, directive_ids_json, time_range,
                   summary, top_stems_json, embedding_blob
            FROM ide_episode_rollups
            ORDER BY id ASC
        `).all();
        assert.equal(dbRollups.length, 6);
        assert.equal(dbRollups[0].session_id, 1);
        assert.equal(dbRollups[0].window_index, 0);
        assert.equal(dbRollups[0].turn_count, 64);
        assert.equal(dbRollups[1].session_id, 1);
        assert.equal(dbRollups[1].window_index, 1);
        assert.equal(dbRollups[1].turn_count, 26);
        assert.equal(dbRollups[4].session_id, 4, 'Must parse session_id from tags when absent in bracket header');
        assert.equal(dbRollups[5].session_id, null, 'Null session run must preserve session_id = null');

        const sumTurns = dbRollups.reduce((acc, r) => acc + Number(r.turn_count), 0);
        assert.equal(sumTurns, 280);

        for (const r of dbRollups) {
            const stems = JSON.parse(r.top_stems_json);
            assert.ok(Array.isArray(stems) && stems.length > 0 && stems.length <= 16);
            for (const s of stems) {
                assert.equal(/^\d+$/.test(s), false, `Pure digits must be excluded from top_stems_json: ${s}`);
                assert.equal(STOP_WORDS.has(s), false);
                assert.equal(TEMPORAL_CUE_WORDS.has(s), false);
                assert.equal(GENERIC_INFRA_WORDS.has(s), false);
                assert.equal(META_QUERY_WORDS.has(s), false);
            }
        }

        // Verify O(1) watermark cache hit (< 0.1ms average, rebuilt: false)
        const warmCheck = ensureEpisodeRollups(db, { project: proj, maxWindowTurns: 64 });
        assert.equal(warmCheck.rebuilt, false);

        const loops = 100;
        const tStart = performance.now();
        for (let k = 0; k < loops; k++) {
            const hit = ensureEpisodeRollups(db, { project: proj, maxWindowTurns: 64 });
            assert.equal(hit.rebuilt, false);
            assert.equal(hit.rollupCount, 6);
        }
        const avgHitMs = (performance.now() - tStart) / loops;
        assert.ok(avgHitMs < 0.1, `Watermark cache hit must be < 0.1ms (got ${avgHitMs.toFixed(4)}ms)`);

        // Adding a new row invalidates watermark and triggers atomic rebuild
        insertStmt.run(
            'lesson',
            '[Session 6 | Date: 2026-03-09 | Turn #900/901] USER: Added final observability check | ASSISTANT: Done.',
            '["session-6"]',
            encodeEmbeddingBlob(makeUnitVector(16, 999))
        );
        const afterInsert = ensureEpisodeRollups(db, { project: proj, maxWindowTurns: 64 });
        assert.equal(afterInsert.rebuilt, true);
        assert.equal(afterInsert.rollupCount, 7);
    });

    await t.test('3. Unaligned Uint8Array slice centroid safety & salience weighting (INV-V2-07)', async () => {
        const proj = makeProjectName('unaligned_f32');
        const db = await getProjectDb(proj);

        const directiveVec = makeUnitVector(3, 10, 8.0);
        const fillerVec = makeUnitVector(19, 20, 8.0);

        // Allocate a slab and create intentionally unaligned Uint8Array slices (byteOffset % 4 = 1, 2, 3)
        const makeUnalignedBlob = (f32Vec, oddOffset) => {
            const rawBytes = encodeEmbeddingBlob(f32Vec);
            const slab = new Uint8Array(rawBytes.byteLength + 8);
            slab.set(rawBytes, oddOffset);
            const unalignedView = slab.subarray(oddOffset, oddOffset + rawBytes.byteLength);
            assert.notEqual(unalignedView.byteOffset % 4, 0, 'Slice must be intentionally 4-byte unaligned');
            return unalignedView;
        };

        // Direct decode verification on odd byte offsets 1, 2, 3
        for (const offset of [1, 2, 3]) {
            const unaligned = makeUnalignedBlob(directiveVec, offset);
            const decoded = decodeEmbeddingBlob(unaligned);
            assert.ok(decoded instanceof Float32Array);
            assert.equal(decoded.length, 1024);
            assert.ok(Math.abs(cosineSimilarity(decoded, directiveVec) - 1) < 1e-6);
        }

        const insertStmt = db.prepare(`
            INSERT INTO ide_agent_memory (category, content, tags, embedding_blob, status)
            VALUES (?, ?, ?, ?, 'ACTIVE')
        `);

        // Insert 40 rows (using minRows: 30): 10 directives with directiveVec + 10 filler turns with fillerVec in Session 1,
        // and 20 filler turns in Session 2. Verify Session 1 centroid is L2-normalized and weighted 1.40x toward directiveVec!
        withTransaction(db, () => {
            for (let i = 0; i < 20; i++) {
                const isDir = i >= 2 && i < 12; // 10 directive turns vs 10 non-directive turns (2 openers at 1.35, 8 regular at 1.00)
                const srcVec = isDir ? directiveVec : fillerVec;
                const unalignedBlob = makeUnalignedBlob(srcVec, (i % 3) + 1);
                insertStmt.run(
                    isDir ? 'invariant' : 'lesson',
                    isDir
                        ? `[Session 1 | Date: 2026-04-01 | Turn #${i * 2}/${i * 2 + 1}] USER: Always enforce strict schema validation on payload ${i}. | ASSISTANT: Enforced.`
                        : `[Session 1 | Date: 2026-04-01 | Turn #${i * 2}/${i * 2 + 1}] USER: Routine telemetry ping ${i}. | ASSISTANT: Ack.`,
                    '["session-1"]',
                    unalignedBlob
                );
            }
            for (let i = 20; i < 40; i++) {
                const unalignedBlob = makeUnalignedBlob(fillerVec, (i % 3) + 1);
                insertStmt.run(
                    'lesson',
                    `[Session 2 | Date: 2026-04-02 | Turn #${i * 2}/${i * 2 + 1}] USER: Background batch sweep ${i}. | ASSISTANT: Completed.`,
                    '["session-2"]',
                    unalignedBlob
                );
            }
        });

        const res = ensureEpisodeRollups(db, { minRows: 30, maxWindowTurns: 64 });
        assert.equal(res.ok, true);
        assert.equal(res.active, true);
        assert.equal(res.rollupCount, 2);

        const row1 = db.prepare(`SELECT embedding_blob FROM ide_episode_rollups WHERE session_id = 1`).get();
        assert.ok(row1.embedding_blob, 'Rollup centroid blob must be persisted');
        assert.equal(row1.embedding_blob.byteLength, 4096, '1024d Float32Array centroid must be exactly 4,096 bytes');

        // Also slice the persisted rollup blob at an unaligned offset and verify decode + cosine norm == 1
        const unalignedRollupSlice = makeUnalignedBlob(decodeEmbeddingBlob(row1.embedding_blob), 3);
        const centroid1 = decodeEmbeddingBlob(unalignedRollupSlice);
        assert.ok(centroid1 instanceof Float32Array);
        assert.equal(centroid1.length, 1024);

        let normSq = 0;
        for (let d = 0; d < 1024; d++) {
            assert.ok(Number.isFinite(centroid1[d]));
            normSq += centroid1[d] * centroid1[d];
        }
        assert.ok(Math.abs(Math.sqrt(normSq) - 1.0) < 1e-4, `Centroid must be unit L2-normalized, got norm=${Math.sqrt(normSq)}`);

        // In Session 1: 10 directiveVec turns have total weight 10 * 1.40 = 14.0,
        // while 10 fillerVec turns have total weight 2 * 1.35 + 8 * 1.00 = 10.7 -> directive similarity must exceed filler similarity!
        const simToDirective = cosineSimilarity(centroid1, directiveVec);
        const simToFiller = cosineSimilarity(centroid1, fillerVec);
        assert.ok(
            simToDirective > simToFiller,
            `Salience weight 1.40 must bias centroid toward directives (${simToDirective.toFixed(4)} vs ${simToFiller.toFixed(4)})`
        );

        // Passing an unaligned Uint8Array query blob into searchEpisodeRollups must also succeed without RangeError
        const unalignedQuery = makeUnalignedBlob(directiveVec, 1);
        const searchOut = searchEpisodeRollups(db, {
            queryEmbedding: unalignedQuery,
            evalTerms: ['schema', 'validation'],
            minRows: 30
        });
        assert.equal(searchOut.ok, true);
        assert.equal(searchOut.episodes[0].sessionId, 1);
    });

    await t.test('4. Strict zero | Turn #X/Y] citation check in stripTurnCitations, summaries & panoramaMarkdown (INV-V2-02)', async () => {
        const noisySamples = [
            '[Session 7 | Date: 2026-05-12 | Turn #142/143] USER: Migrated auth tokens to Ed25519 | ASSISTANT: Updated JWT signer.',
            ' Truncated header | Turn #88/89] and inline reference Turn #12/13 plus (Turn #9) and | Turn #501 ',
            '[Turn #0/1] USER: See Turn #44 for details | ASSISTANT: Checked | Turn #44/45]'
        ];
        for (const sample of noisySamples) {
            const stripped = stripTurnCitations(sample);
            assert.equal(/\|\s*Turn\s*#\d+/i.test(stripped), false, `Must strip pipe turn citations from: ${stripped}`);
            assert.equal(/\bTurn\s*#\s*\d+/i.test(stripped), false, `Must strip standalone Turn # citations from: ${stripped}`);
        }

        const proj = makeProjectName('zero_citations');
        const db = await getProjectDb(proj);
        const insertStmt = db.prepare(`
            INSERT INTO ide_agent_memory (category, content, tags, embedding_blob, status)
            VALUES (?, ?, ?, ?, 'ACTIVE')
        `);

        withTransaction(db, () => {
            for (let s = 1; s <= 6; s++) {
                for (let tIdx = 0; tIdx < 45; tIdx++) {
                    const globalTurn = (s - 1) * 90 + tIdx * 2;
                    const vec = makeUnitVector(s * 2, globalTurn);
                    insertStmt.run(
                        'decision',
                        `[Session ${s} | Date: 2026-06-0${s} | Turn #${globalTurn}/${globalTurn + 1}] USER: In Session ${s} (ref | Turn #${globalTurn}/${globalTurn + 1}]) we implemented subsystem_${s} module_${tIdx} with zero-copy buffers. | ASSISTANT: Verified Turn #${globalTurn} implementation for subsystem_${s}.`,
                        JSON.stringify([`session-${s}`]),
                        encodeEmbeddingBlob(vec)
                    );
                }
            }
        });

        const built = ensureEpisodeRollups(db);
        assert.equal(built.active, true);
        assert.equal(built.rollupCount, 6);

        const allRollups = db.prepare(`SELECT summary, time_range FROM ide_episode_rollups`).all();
        for (const r of allRollups) {
            assert.ok(r.summary.length <= 420, `Summary length ${r.summary.length} must be <= 420 chars`);
            assert.equal(/\|\s*Turn\s*#\d+/i.test(r.summary), false, `Summary leaked Turn citation: ${r.summary}`);
            assert.equal(/\bTurn\s*#\s*\d+/i.test(r.summary), false, `Summary leaked Turn # token: ${r.summary}`);
            assert.equal(/\|\s*Turn\s*#\d+/i.test(r.time_range || ''), false);
        }

        const maxPanoramaTokens = 260;
        const macroSearch = searchEpisodeRollups(db, {
            queryEmbedding: makeUnitVector(2, 1),
            evalTerms: ['subsystem_1', 'subsystem_3', 'buffers'],
            isBroadQuery: true,
            sequenceOrderMode: true,
            maxPanoramaTokens
        });

        assert.equal(macroSearch.ok, true);
        assert.equal(macroSearch.active, true);
        assert.ok(macroSearch.panoramaMarkdown.startsWith('#### 🗂️ Hierarchical Episode Panorama\n'));
        assert.ok(macroSearch.panoramaMarkdown.includes('- **Episode #1 (Session 1 · 2026-06-01)**:'));
        assert.equal(
            /\|\s*Turn\s*#\d+/i.test(macroSearch.panoramaMarkdown),
            false,
            'panoramaMarkdown MUST NOT contain any | Turn #X/Y citation strings (INV-V2-02)'
        );
        assert.equal(
            /\bTurn\s*#\s*\d+/i.test(macroSearch.panoramaMarkdown),
            false,
            'panoramaMarkdown MUST NOT contain any Turn # tokens'
        );
        assert.ok(
            estimateTokens(macroSearch.panoramaMarkdown) <= maxPanoramaTokens,
            `panoramaMarkdown tokens (${estimateTokens(macroSearch.panoramaMarkdown)}) must respect maxPanoramaTokens (${maxPanoramaTokens})`
        );
    });

    await t.test('5. Deep pre-scan child ID rescue (pinpoint <= 180 vs broad <= 96) & parentScoreByMemoryId', async () => {
        const proj = makeProjectName('deep_rescue');
        const db = await getProjectDb(proj);
        const insertStmt = db.prepare(`
            INSERT INTO ide_agent_memory (category, content, tags, embedding_blob, status)
            VALUES (?, ?, ?, ?, 'ACTIVE')
        `);

        // 12 sessions * 50 turns = 600 turns. Plant a rare deep fact at Session 1 turn index 23 (early ID, far from tail)
        const rareTargetVec = makeUnitVector(24, 777, 9.0);
        let plantedMemoryId = null;

        withTransaction(db, () => {
            for (let s = 1; s <= 12; s++) {
                for (let i = 0; i < 50; i++) {
                    const isPlantedTarget = s === 1 && i === 23;
                    const vec = isPlantedTarget
                        ? rareTargetVec
                        : makeUnitVector(s === 1 ? 24 : s + 1, s * 100 + i, s === 1 ? 4.5 : 5.5);
                    const text = isPlantedTarget
                        ? `[Session 1 | Date: 2026-01-02 | Turn #46/47] USER: Set the Raft election quorum timeout to 425ms on storage shard zeta_quasar. | ASSISTANT: Applied 425ms Raft quorum timeout on zeta_quasar.`
                        : `[Session ${s} | Date: 2026-01-${String(s + 1).padStart(2, '0')} | Turn #${i * 2}/${i * 2 + 1}] USER: Iterating on servicegroup_${s} endpoint telemetry check ${i}. | ASSISTANT: Verified servicegroup_${s} step ${i}.`;
                    const info = insertStmt.run(
                        'decision',
                        text,
                        JSON.stringify([`session-${s}`]),
                        encodeEmbeddingBlob(vec)
                    );
                    if (isPlantedTarget) {
                        plantedMemoryId = Number(info.lastInsertRowid);
                    }
                }
            }
        });

        assert.ok(plantedMemoryId !== null && plantedMemoryId <= 30, 'Planted target must reside in deep early IDs');

        const pinpoint = searchEpisodeRollups(db, {
            queryEmbedding: rareTargetVec,
            evalTerms: ['raft', 'quorum', 'zeta_quasar'],
            isBroadQuery: false,
            sequenceOrderMode: false
        });

        assert.equal(pinpoint.ok, true);
        assert.equal(pinpoint.active, true);
        assert.equal(pinpoint.episodes.length, 8, 'Pinpoint mode must select top M = 8 episodes');
        assert.equal(pinpoint.episodes[0].sessionId, 1, 'Session 1 rollup must rank #1 for deep target query');
        assert.ok(pinpoint.childMemoryIds.length <= 180, `Pinpoint childMemoryIds (${pinpoint.childMemoryIds.length}) must be <= 180`);
        assert.ok(
            pinpoint.childMemoryIds.includes(plantedMemoryId),
            `Deep early turn #${plantedMemoryId} must be rescued in childMemoryIds`
        );
        assert.equal(
            pinpoint.parentScoreByMemoryId.get(plantedMemoryId),
            pinpoint.episodes[0].score,
            'parentScoreByMemoryId must map every child ID in top M episodes to its parent episode score'
        );
        assert.equal(pinpoint.panoramaMarkdown, '', 'Pinpoint queries must not emit panoramaMarkdown');

        const broad = searchEpisodeRollups(db, {
            queryEmbedding: rareTargetVec,
            evalTerms: ['servicegroup_1', 'telemetry'],
            isBroadQuery: true,
            sequenceOrderMode: false,
            maxPanoramaTokens: 360
        });
        assert.equal(broad.episodes.length, 12, 'All 12 episodes fit within M = 18');
        assert.ok(broad.childMemoryIds.length <= 96, `Broad childMemoryIds (${broad.childMemoryIds.length}) must be <= 96`);
        assert.ok(broad.childMemoryIds.length >= 48, 'Broad mode must sample spaced representatives across all 12 episodes');
        assert.ok(broad.panoramaMarkdown.length > 0);
    });

    await t.test('6. generativeAdvisoryMode standing-directive rescue across 300 turns in 10 sessions', async () => {
        const proj = makeProjectName('directives_300');
        const db = await getProjectDb(proj);
        const insertStmt = db.prepare(`
            INSERT INTO ide_agent_memory (category, content, tags, embedding_blob, status)
            VALUES (?, ?, ?, ?, 'ACTIVE')
        `);

        // 10 sessions * 30 turns = 300 turns.
        // Plant standing directives across all 10 sessions (1 per session = 10 directives total) with completely
        // disjoint topics so top-8 pinpoint episodes cannot cover all 10 sessions without generativeAdvisoryMode.
        const expectedDirectiveIds = [];
        const directivePrompts = [
            'Always use snake_case for SQLite column identifiers.',
            'Please remember to never commit plaintext credentials into repository configs.',
            'From now on, include JSDoc parameter annotations on exported helpers.',
            'I always prefer concise bulleted changelogs at the end of refactors.',
            'Make sure to validate integer bounds before allocating typed buffers.',
            'Whenever you write SQL migrations, wrap DDL changes inside explicit transactions.',
            'Do not ever use synchronous network calls on the request event loop.',
            'My preference is ISO-8601 UTC timestamps for all audit log entries.',
            'Be sure to close temporary database handles in test teardown hooks.',
            'Keep runtime modules minimal dependencies and pure ESM imports.'
        ];

        withTransaction(db, () => {
            for (let s = 1; s <= 10; s++) {
                for (let i = 0; i < 30; i++) {
                    const isDir = i === 14;
                    const vec = makeUnitVector(s * 2, s * 50 + i);
                    const content = isDir
                        ? `[Session ${s} | Date: 2026-07-${String(s).padStart(2, '0')} | Turn #${i * 2}/${i * 2 + 1}] USER: ${directivePrompts[s - 1]} | ASSISTANT: Understood, I will follow that rule.`
                        : `[Session ${s} | Date: 2026-07-${String(s).padStart(2, '0')} | Turn #${i * 2}/${i * 2 + 1}] USER: Implementing subsystem_alpha_${s} handler ${i}. | ASSISTANT: Completed subsystem_alpha_${s} step ${i}.`;

                    const info = insertStmt.run(
                        isDir && s % 2 === 0 ? 'invariant' : 'lesson',
                        content,
                        JSON.stringify([`session-${s}`]),
                        encodeEmbeddingBlob(vec)
                    );
                    if (isDir) {
                        expectedDirectiveIds.push(Number(info.lastInsertRowid));
                    }
                }
            }
        });

        assert.equal(expectedDirectiveIds.length, 10);

        // Non-advisory pinpoint query only inspects top M = 8 episodes (8 directives)
        const nonAdvisory = searchEpisodeRollups(db, {
            queryEmbedding: makeUnitVector(2, 999),
            evalTerms: ['subsystem_alpha_1'],
            generativeAdvisoryMode: false
        });
        assert.equal(nonAdvisory.episodes.length, 8);
        assert.equal(nonAdvisory.directiveMemoryIds.length, 8);

        // Generative/advisory query rescues standing directives across ALL 10 episodes (all 10 directives!)
        const advisory = searchEpisodeRollups(db, {
            queryEmbedding: makeUnitVector(2, 999),
            evalTerms: ['websocket', 'scheduler'],
            generativeAdvisoryMode: true
        });
        assert.equal(advisory.directiveMemoryIds.length, 10, 'generativeAdvisoryMode must union directive IDs across ALL rollups');
        for (const did of expectedDirectiveIds) {
            assert.ok(
                advisory.directiveMemoryIds.includes(did),
                `Standing directive ID #${did} must be rescued in generativeAdvisoryMode`
            );
        }
    });

    await t.test('7. Static zero-leakage & invariant compliance check on src/episode-rollup.js (INV-V2-01, INV-V2-03)', () => {
        const srcPath = path.resolve(__dirname, '..', 'src', 'episode-rollup.js');
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
            /\[Code blocks with syntax highlighting\]/i,
            /maxChars\s*<=\s*125/,
            /maxBodyChars\s*=\s*92/,
            /\bisTier3\b/
        ];

        for (const pat of forbiddenPatterns) {
            assert.equal(pat.test(code), false, `Forbidden pattern ${pat} must never appear in src/episode-rollup.js`);
        }
        assert.equal(
            /INSERT\s+INTO\s+ide_agent_memory\b/i.test(code),
            false,
            'INV-V2-01: episode-rollup.js must NEVER insert synthetic rows into ide_agent_memory'
        );
    });

    await t.test('8. sessionPos <= 1 window-1 opener parity, same-second in-place UPDATE rebuild, and < minRows stale rollup purge', async () => {
        const proj = makeProjectName('lifecycle_edge_cases');
        const db = await getProjectDb(proj);
        const openerTopicVec = makeUnitVector(7, 1, 9.0);
        const bodyTopicVec = makeUnitVector(18, 2, 9.0);

        const insertStmt = db.prepare(`
            INSERT INTO ide_agent_memory (category, content, tags, embedding_blob, status)
            VALUES ('lesson', ?, '["session-1"]', ?, 'ACTIVE')
        `);

        // 40 turns in Session 1 chunked into 2 windows of 20 turns (minRows: 30, maxWindowTurns: 20):
        // Window 0 has 2 true session openers (sessionPos 0,1) with openerTopicVec (1.35x) + 2 bodyTopicVec turns (1.00x) + 16 neutral turns.
        // Window 1 has its first 2 turns at sessionPos 20,21 with openerTopicVec (MUST get 1.00x, NOT 1.35x!) + 2 bodyTopicVec turns (1.00x).
        withTransaction(db, () => {
            for (let i = 0; i < 40; i++) {
                const inWinIdx = i % 20;
                const vec = inWinIdx < 2
                    ? openerTopicVec
                    : (inWinIdx < 4 ? bodyTopicVec : makeUnitVector(30 + inWinIdx, i, 1.0));
                insertStmt.run(
                    `[Session 1 | Date: 2026-08-01 | Turn #${i * 2}/${i * 2 + 1}] USER: Session progress note ${i} | ASSISTANT: Ack ${i}.`,
                    encodeEmbeddingBlob(vec)
                );
            }
        });

        const built = ensureEpisodeRollups(db, { project: proj, minRows: 30, maxWindowTurns: 20 });
        assert.equal(built.rebuilt, true);
        assert.equal(built.rollupCount, 2);

        const winRows = db.prepare(`SELECT project, window_index, summary, embedding_blob FROM ide_episode_rollups ORDER BY window_index ASC`).all();
        assert.equal(winRows[0].project, proj);
        const c0 = decodeEmbeddingBlob(winRows[0].embedding_blob);
        const c1 = decodeEmbeddingBlob(winRows[1].embedding_blob);
        const diffWin0 = cosineSimilarity(c0, openerTopicVec) - cosineSimilarity(c0, bodyTopicVec);
        const diffWin1 = cosineSimilarity(c1, openerTopicVec) - cosineSimilarity(c1, bodyTopicVec);
        assert.ok(diffWin0 > diffWin1 + 0.02, `Window 0 true session openers (sessionPos<=1) must receive 1.35x boost while Window 1 (sessionPos=20,21) gets 1.00x (${diffWin0.toFixed(4)} vs ${diffWin1.toFixed(4)})`);

        // Same-second in-place UPDATE (without changing cnt, min_id, max_id, or updated_at) must still rebuild!
        const firstId = db.prepare(`SELECT MIN(id) AS id FROM ide_agent_memory WHERE status = 'ACTIVE'`).get().id;
        db.prepare(`UPDATE ide_agent_memory SET content = ? WHERE id = ?`).run(
            '[Session 1 | Date: 2026-08-01 | Turn #0/1] USER: Updated primary goal to ZeroCopyQuicTransport | ASSISTANT: Updated.',
            firstId
        );
        const afterSameSecUpdate = ensureEpisodeRollups(db, { project: proj, minRows: 30, maxWindowTurns: 20 });
        assert.equal(afterSameSecUpdate.rebuilt, true, 'Same-second in-place content UPDATE must invalidate storeFingerprint and rebuild');
        const updatedWin0 = db.prepare(`SELECT summary FROM ide_episode_rollups WHERE window_index = 0`).get();
        assert.ok(updatedWin0.summary.toLowerCase().includes('zerocopyquictransport'));

        // Shrinking store below minRows (40 -> 20 active rows < minRows=30) must purge stale ide_episode_rollups rows!
        db.prepare(`UPDATE ide_agent_memory SET status = 'INVALIDATED' WHERE id IN (SELECT id FROM ide_agent_memory WHERE status = 'ACTIVE' ORDER BY id DESC LIMIT 20)`).run();
        const afterShrink = ensureEpisodeRollups(db, { project: proj, minRows: 30, maxWindowTurns: 20 });
        assert.equal(afterShrink.active, false);
        const remainingRollups = db.prepare(`SELECT COUNT(*) AS c FROM ide_episode_rollups`).get().c;
        assert.equal(remainingRollups, 0, 'Shrinking below minRows must purge stale ide_episode_rollups rows');
    });

    await t.test('9. Warm-cache minRows threshold increase purge, synthetic constant vector rejection, and non-1024d query vector guard (INV-V2-05, INV-V2-07)', async () => {
        const proj = makeProjectName('const_vec_and_minrows');
        const db = await getProjectDb(proj);
        const constVec = new Float32Array(1024).fill(0.03125);
        const realVec = makeUnitVector(11, 42, 8.0);

        const insertStmt = db.prepare(`
            INSERT INTO ide_agent_memory (category, content, tags, embedding_blob, status)
            VALUES ('lesson', ?, ?, ?, 'ACTIVE')
        `);

        withTransaction(db, () => {
            // Session 1 (20 rows): ONLY synthetic constant vectors -> rollup centroid MUST be null
            for (let i = 0; i < 20; i++) {
                insertStmt.run(
                    `[Session 1 | Date: 2026-09-01 | Turn #${i * 2}/${i * 2 + 1}] USER: Offline mock note ${i} | ASSISTANT: Stored.`,
                    '["session-1"]',
                    encodeEmbeddingBlob(constVec)
                );
            }
            // Session 2 (20 rows): real 1024d unit vectors -> rollup centroid MUST be 4,096 bytes
            for (let i = 0; i < 20; i++) {
                insertStmt.run(
                    `[Session 2 | Date: 2026-09-02 | Turn #${i * 2}/${i * 2 + 1}] USER: Real semantic note ${i} | ASSISTANT: Stored.`,
                    '["session-2"]',
                    encodeEmbeddingBlob(realVec)
                );
            }
        });

        const built = ensureEpisodeRollups(db, { project: proj, minRows: 30, maxWindowTurns: 64 });
        assert.equal(built.active, true);
        assert.equal(built.rollupCount, 2);

        const rollups = db.prepare(`SELECT session_id, embedding_blob FROM ide_episode_rollups ORDER BY session_id ASC`).all();
        assert.equal(rollups[0].embedding_blob, null, 'Synthetic constant 1024d vectors must never produce a rollup centroid blob');
        assert.equal(rollups[1].embedding_blob.byteLength, 4096);

        // Non-1024d query vector (e.g. 64d) must be ignored cleanly (semanticScore === 0)
        const wrongDimVec = new Float32Array(64);
        wrongDimVec[0] = 0.8;
        wrongDimVec[1] = 0.6;
        const badDimSearch = searchEpisodeRollups(db, {
            queryEmbedding: wrongDimVec,
            evalTerms: ['semantic'],
            minRows: 30
        });
        assert.equal(badDimSearch.ok, true);
        for (const ep of badDimSearch.episodes) {
            assert.equal(ep.semanticScore, 0, 'Non-1024d query vectors must never compute false semantic similarity');
        }

        // Calling ensureEpisodeRollups with default minRows=240 on a warm-cached 40-row DB (without DB mutations!) must purge stale rollups
        const warmPurge = ensureEpisodeRollups(db, { project: proj, minRows: 240, maxWindowTurns: 64 });
        assert.equal(warmPurge.active, false);
        assert.equal(
            db.prepare(`SELECT COUNT(*) AS c FROM ide_episode_rollups`).get().c,
            0,
            'Raising minRows above cached row count on warm DB must purge stale ide_episode_rollups rows'
        );
    });

    await t.test('10. Sparse axis-2..1022 basis vectors, interleaved session/atomic windowIndex continuity, and shared-stem evalTerms lexical alignment', async () => {
        const proj = makeProjectName('interleaved_and_sparse');
        const db = await getProjectDb(proj);

        // Sparse basis vectors strictly on axes 2 and 3 (zeros at indices 0, 1, 512, 1023!)
        const basisAxis2 = new Float32Array(1024);
        basisAxis2[2] = 1.0;
        const basisAxis3 = new Float32Array(1024);
        basisAxis3[3] = 1.0;

        const insertStmt = db.prepare(`
            INSERT INTO ide_agent_memory (category, content, tags, embedding_blob, status)
            VALUES ('lesson', ?, ?, ?, 'ACTIVE')
        `);

        withTransaction(db, () => {
            // Session 1 first run (15 rows)
            for (let i = 0; i < 15; i++) {
                insertStmt.run(
                    `[Session 1 | Date: 2026-10-01 | Turn #${i * 2}/${i * 2 + 1}] USER: Configured ingress gateway listener ${i} | ASSISTANT: Done.`,
                    '["session-1"]',
                    encodeEmbeddingBlob(basisAxis2)
                );
            }
            // Interleaved null-session atomic notes (4 rows: first 2 have basisAxis2, last 2 have basisAxis3 -> must have equal 1.00x weight, NOT 1.35x opener boost!)
            for (let i = 0; i < 4; i++) {
                insertStmt.run(
                    `Atomic architecture note ${i} without session bracket`,
                    '[]',
                    encodeEmbeddingBlob(i < 2 ? basisAxis2 : basisAxis3)
                );
            }
            // Session 1 second run (15 rows -> MUST continue at window_index = 1, NOT reset to 0!)
            for (let i = 15; i < 30; i++) {
                insertStmt.run(
                    `[Session 1 | Date: 2026-10-01 | Turn #${i * 2}/${i * 2 + 1}] USER: Tuned Pulsar broker partitions ${i} | ASSISTANT: Done.`,
                    '["session-1"]',
                    encodeEmbeddingBlob(basisAxis3)
                );
            }
        });

        const built = ensureEpisodeRollups(db, { project: proj, minRows: 25, maxWindowTurns: 15 });
        assert.equal(built.active, true);
        assert.equal(built.rollupCount, 3);

        const sess1Rollups = db.prepare(`
            SELECT window_index, embedding_blob FROM ide_episode_rollups WHERE session_id = 1 ORDER BY id ASC
        `).all();
        assert.deepEqual(
            sess1Rollups.map(r => r.window_index),
            [0, 1],
            'Interleaved Session 1 runs must increment window_index monotonically (0, 1) without duplicate 0'
        );
        assert.equal(sess1Rollups[0].embedding_blob.byteLength, 4096, 'Sparse axis-2 unit vector must persist valid 4096B centroid');

        const nullRollup = db.prepare(`SELECT embedding_blob FROM ide_episode_rollups WHERE session_id IS NULL`).get();
        const nullCentroid = decodeEmbeddingBlob(nullRollup.embedding_blob);
        assert.ok(
            Math.abs(cosineSimilarity(nullCentroid, basisAxis2) - cosineSimilarity(nullCentroid, basisAxis3)) < 1e-4,
            'Null-session atomic rows must NOT receive 1.35x session-opener boost on first 2 rows'
        );

        // Shared-stem evalTerms ['configure', 'configured', 'pulsar'] -> normStems = ['configur', 'pulsar']:
        // Window 0 contains "configured" ONLY (zero "pulsar"), while Window 1 contains "pulsar" ONLY.
        // Window 0 MUST NOT receive 100% lexical overlap from misaligned normTerms[1] = 'configured'!
        const searchSharedStem = searchEpisodeRollups(db, {
            queryEmbedding: null,
            evalTerms: ['configure', 'configured', 'pulsar'],
            minRows: 25
        });
        const epWin0 = searchSharedStem.episodes.find(e => e.sessionId === 1 && e.windowIndex === 0);
        assert.ok(epWin0, 'Window 0 episode must be returned');
        assert.ok(
            epWin0.lexicalScore < 0.85,
            `Episode matching only 1 of 2 unique stems ('configur' without 'pulsar') must not get 1.0 lexicalScore (got ${epWin0.lexicalScore})`
        );

        // Sparse axis-2 query vector must compute real semantic similarity > 0.5 against Window 0 centroid
        const sparseQuerySearch = searchEpisodeRollups(db, {
            queryEmbedding: basisAxis2,
            evalTerms: [],
            minRows: 25
        });
        const topEp = sparseQuerySearch.episodes[0];
        assert.equal(topEp.sessionId, 1);
        assert.equal(topEp.windowIndex, 0);
        assert.ok(topEp.semanticScore > 0.7, `Sparse axis-2 query vector must score > 0.7 semanticScore (got ${topEp.semanticScore})`);
    });
});


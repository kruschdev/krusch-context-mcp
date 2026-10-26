/**
 * @module episode-rollup
 * Two-Level Hierarchical Episode Rollups (Pillar 1 — krusch-context-mcp v2.0).
 *
 * Builds deterministic, zero-LLM session/window extractive digests, salience-weighted
 * 1024d Float32Array centroids, and an external-content Porter FTS5 index (`ide_episode_rollups_fts`)
 * to enable O(E) panorama synthesis, standing-directive pinning, and deep child-turn rescue
 * beyond `KRUSCH_MAX_ACTIVE_SCAN` while remaining a <0.05ms no-op on stores with <240 active rows.
 */

import {
    withTransaction,
    encodeEmbeddingBlob,
    decodeEmbeddingBlob,
    getParsedEmbedding,
    cosineSimilarity,
    buildFtsMatchQuery
} from './sqlite-engine.js';
import { calibrateQuerySimilarity } from './embedding-helper.js';
import { prunePreSynthesis } from './prune-helper.js';
import {
    STOP_WORDS,
    TEMPORAL_CUE_WORDS,
    GENERIC_INFRA_WORDS,
    META_QUERY_WORDS,
    DIRECTIVE_REGEX,
    STATE_TRANSITION_REGEX,
    fnv1a32,
    stemToken,
    estimateTokens,
    isSyntheticConstantVector
} from './retrieval-lexical.js';

const CENTROID_DIM = 1024;
const DEFAULT_MIN_ROWS = 240;
const DEFAULT_MAX_WINDOW_TURNS = 64;
const MAX_SUMMARY_CHARS = 420;
const TOP_STEM_LIMIT = 16;

const DIALOGUE_MARKER_WORDS = new Set(['user', 'assistant', 'date', 'turn']);

/** @type {WeakSet<object>} */
const initializedRollupDbs = new WeakSet();

/** @type {WeakMap<object, { counterKey: string|null, cnt: number, active: boolean, maxWindow: number, watermark: string, rollupCount: number, directiveCount: number }>} */
const rollupWatermarkCache = new WeakMap();

/** @type {WeakMap<object, { changeCounters?: object, activeStats?: object, rollupTotals?: object }>} */
const preparedStmtCache = new WeakMap();

function getCachedStatements(db) {
    let entry = preparedStmtCache.get(db);
    if (!entry) {
        entry = {};
        preparedStmtCache.set(db, entry);
    }
    return entry;
}

function readChangeCounters(db, stmts) {
    try {
        if (!stmts.changeCounters) {
            stmts.changeCounters = db.prepare(
                `SELECT total_changes() AS tc, (SELECT data_version FROM pragma_data_version) AS dv`
            );
        }
        const row = stmts.changeCounters.get();
        return row ? `${row.tc}:${row.dv}` : null;
    } catch {
        return null;
    }
}

/**
 * Strips bracketed headers containing `Turn #...` and any `| Turn #X/Y]` or `Turn #\d+(?:/\d+)?`
 * citations, collapsing whitespace cleanly (`INV-V2-02`).
 * @param {string} [text='']
 * @returns {string}
 */
export function stripTurnCitations(text = '') {
    if (typeof text !== 'string' || text.length === 0) return '';
    let out = text
        .replace(/\[[^\]]*\bTurn\s*#\s*\d+(?:\s*\/\s*\d+)?[^\]]*\]/gi, ' ')
        .replace(/\[[^\]]*\bTurn\s*#\s*\d*(?:\s*\/\s*\d*)?$/gi, ' ')
        .replace(/\|\s*Turn\s*#\s*\d+(?:\s*\/\s*\d+)?\s*\]?/gi, ' ')
        .replace(/\(?\bTurn\s*#\s*\d+(?:\s*\/\s*\d+)?\)?\s*\]?/gi, ' ')
        .replace(/\[\s*\]/g, ' ')
        .replace(/\s*\|\s*\|\s*/g, ' | ')
        .replace(/^\s*\|\s*|\s*\|\s*$/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (/\|\s*Turn\s*#\s*\d+/i.test(out)) {
        out = out
            .replace(/\|\s*Turn\s*#\s*\d+(?:\s*\/\s*\d+)?/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }
    return out;
}

/**
 * Idempotently creates `ide_episode_rollups`, bounds/session indexes, and the optional
 * external-content Porter FTS5 index (`ide_episode_rollups_fts`) with sync triggers.
 * Caches initialized `db` handles in a `WeakSet` for O(1) repeat checks and returns `false`
 * gracefully on invalid or read-only database handles.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {boolean}
 */
export function ensureRollupSchema(db) {
    if (!db || typeof db.exec !== 'function') return false;
    if (initializedRollupDbs.has(db)) return true;

    try {
        db.exec(`
            CREATE TABLE IF NOT EXISTS ide_episode_rollups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project TEXT,
                session_id INTEGER,
                window_index INTEGER NOT NULL DEFAULT 0,
                start_memory_id INTEGER NOT NULL,
                end_memory_id INTEGER NOT NULL,
                turn_count INTEGER NOT NULL,
                child_ids_json TEXT NOT NULL,
                directive_ids_json TEXT NOT NULL,
                time_range TEXT,
                summary TEXT NOT NULL,
                top_stems_json TEXT NOT NULL,
                embedding_blob BLOB,
                source_hash TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX IF NOT EXISTS idx_episode_rollups_bounds
                ON ide_episode_rollups(start_memory_id, end_memory_id);
            CREATE INDEX IF NOT EXISTS idx_episode_rollups_session
                ON ide_episode_rollups(session_id, window_index);
        `);
    } catch {
        return false;
    }

    try {
        const ftsExisted = Boolean(
            db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ide_episode_rollups_fts'`).get()
        );
        db.exec(`
            CREATE VIRTUAL TABLE IF NOT EXISTS ide_episode_rollups_fts USING fts5(
                summary,
                top_stems_json,
                content='ide_episode_rollups',
                content_rowid='id',
                tokenize='porter unicode61'
            );
            CREATE TRIGGER IF NOT EXISTS trg_episode_rollups_fts_ai AFTER INSERT ON ide_episode_rollups BEGIN
                INSERT INTO ide_episode_rollups_fts(rowid, summary, top_stems_json)
                VALUES (new.id, new.summary, new.top_stems_json);
            END;
            CREATE TRIGGER IF NOT EXISTS trg_episode_rollups_fts_ad AFTER DELETE ON ide_episode_rollups BEGIN
                INSERT INTO ide_episode_rollups_fts(ide_episode_rollups_fts, rowid, summary, top_stems_json)
                VALUES ('delete', old.id, old.summary, old.top_stems_json);
            END;
            CREATE TRIGGER IF NOT EXISTS trg_episode_rollups_fts_au AFTER UPDATE OF summary, top_stems_json ON ide_episode_rollups BEGIN
                INSERT INTO ide_episode_rollups_fts(ide_episode_rollups_fts, rowid, summary, top_stems_json)
                VALUES ('delete', old.id, old.summary, old.top_stems_json);
                INSERT INTO ide_episode_rollups_fts(rowid, summary, top_stems_json)
                VALUES (new.id, new.summary, new.top_stems_json);
            END;
        `);
        const rollupCount = db.prepare(`SELECT COUNT(*) AS c FROM ide_episode_rollups`).get()?.c || 0;
        const docsizeCount = db.prepare(`SELECT COUNT(*) AS c FROM ide_episode_rollups_fts_docsize`).get()?.c || 0;
        if ((!ftsExisted && rollupCount > 0) || docsizeCount !== rollupCount) {
            db.exec(`INSERT INTO ide_episode_rollups_fts(ide_episode_rollups_fts) VALUES ('rebuild');`);
        }
    } catch {
        // Gracefully degrade when SQLite runtime lacks FTS5 support
    }

    initializedRollupDbs.add(db);
    return true;
}

function isExcludedTopStemWord(word) {
    if (!word || word.length < 3) return true;
    if (/^\d+$/.test(word)) return true;
    if (
        STOP_WORDS.has(word) ||
        TEMPORAL_CUE_WORDS.has(word) ||
        GENERIC_INFRA_WORDS.has(word) ||
        META_QUERY_WORDS.has(word) ||
        DIALOGUE_MARKER_WORDS.has(word)
    ) {
        return true;
    }
    return false;
}

function extractInformativeStemCounts(text, weight = 1, targetMap = new Map()) {
    if (!text) return targetMap;
    const bounded = text.length <= 2400
        ? text
        : `${text.slice(0, 1600)} ${text.slice(-800)}`;
    const rawTokens = bounded.toLowerCase().split(/[^a-z0-9_]+/);
    for (let i = 0; i < rawTokens.length; i++) {
        const tok = rawTokens[i];
        if (isExcludedTopStemWord(tok)) continue;
        const stem = stemToken(tok);
        if (isExcludedTopStemWord(stem)) continue;
        targetMap.set(stem, (targetMap.get(stem) || 0) + weight);
    }
    return targetMap;
}

function parseRowMetadata(row) {
    const rawContent = String(row.content || '');
    const rawTags = row.tags ? String(row.tags) : '';

    let sessionId = null;
    let dateLabel = null;
    let bodyWithoutHeader = rawContent;

    const leadingBracket = rawContent.match(/^\[([^\]]+)\]\s*/);
    if (leadingBracket) {
        const headerInner = leadingBracket[1];
        const sessMatch = headerInner.match(/\bSession[\s_-]*(\d+)\b/i);
        if (sessMatch) {
            const parsed = Number(sessMatch[1]);
            if (Number.isFinite(parsed)) sessionId = parsed;
        }
        const dateMatch = headerInner.match(/\bDate:\s*([^|\]]+?)(?:\s*\||$)/i);
        if (dateMatch) {
            const cleanedDate = stripTurnCitations(dateMatch[1]).trim();
            if (cleanedDate && !/^session\s+\d+$/i.test(cleanedDate)) {
                dateLabel = cleanedDate;
            }
        }
        if (sessMatch || dateMatch || /\bTurn\s*#\s*\d+/i.test(headerInner)) {
            bodyWithoutHeader = rawContent.slice(leadingBracket[0].length);
        }
    }

    if (sessionId === null) {
        const inlineSess = rawContent.match(/\[[^\]]*\bSession[\s_-]*(\d+)\b[^\]]*\]/i);
        if (inlineSess) {
            const parsed = Number(inlineSess[1]);
            if (Number.isFinite(parsed)) sessionId = parsed;
        }
    }

    if (sessionId === null && rawTags) {
        const tagSess = rawTags.match(/\bsession[\s_-]*(\d+)\b/i);
        if (tagSess) {
            const parsed = Number(tagSess[1]);
            if (Number.isFinite(parsed)) sessionId = parsed;
        }
    }

    const sanitizedBody = stripTurnCitations(bodyWithoutHeader);
    const dialogueMatch = sanitizedBody.match(/^(?:[\s\S]*?\b)?USER:\s*([\s\S]*?)(?:\s*\|\s*ASSISTANT:\s*([\s\S]*))?$/i);
    const hasDialogue = Boolean(dialogueMatch);
    const userClause = hasDialogue ? dialogueMatch[1].trim() : sanitizedBody.trim();
    const assistantClause = (hasDialogue && dialogueMatch[2]) ? dialogueMatch[2].trim() : '';

    const isDirective = row.category === 'invariant' || (hasDialogue && DIRECTIVE_REGEX.test(userClause));
    const isStateTransition = STATE_TRANSITION_REGEX.test(userClause);

    const stemCounts = new Map();
    extractInformativeStemCounts(userClause, 1.5, stemCounts);
    if (assistantClause) {
        extractInformativeStemCounts(assistantClause, 0.85, stemCounts);
    }
    if (rawTags) {
        const cleanedTags = rawTags.replace(/\bsession[\s_-]*\d+\b/gi, ' ');
        extractInformativeStemCounts(cleanedTags, 1.0, stemCounts);
    }

    return {
        id: Number(row.id),
        category: row.category || 'lesson',
        sessionId,
        sessionPos: 0,
        dateLabel,
        createdAt: row.created_at ? String(row.created_at).trim() : null,
        sanitizedBody,
        hasDialogue,
        userClause,
        assistantClause,
        isDirective,
        isStateTransition,
        stemCounts,
        embedding: row.embedding,
        embeddingBlob: row.embedding_blob
    };
}

function extractMatchingSentence(text, regex, maxLen = 120) {
    const clean = stripTurnCitations(String(text || '').replace(/```[\s\S]*?```/g, ' '));
    if (!clean) return '';
    const sentences = clean
        .split(/(?<=[.!?])\s+|\s+\|\s+/)
        .map(s => s.trim())
        .filter(Boolean);
    for (const s of sentences) {
        if (regex.test(s)) {
            return s.length <= maxLen ? s : `${s.slice(0, maxLen - 3).trim()}...`;
        }
    }
    const pruned = stripTurnCitations(prunePreSynthesis(clean, { maxChars: maxLen }));
    return pruned.length <= maxLen ? pruned : `${pruned.slice(0, maxLen - 3).trim()}...`;
}

function stemSetOverlapRatio(setA, setB) {
    if (!setA || !setB || setA.size === 0 || setB.size === 0) return 0;
    let inter = 0;
    for (const s of setA) {
        if (setB.has(s)) inter++;
    }
    const denom = Math.min(setA.size, setB.size);
    return denom > 0 ? inter / denom : 0;
}

function truncateCleanly(text, maxLen) {
    const clean = stripTurnCitations(text);
    if (clean.length <= maxLen) return clean;
    const cut = clean.slice(0, Math.max(0, maxLen - 3));
    const lastSpace = cut.lastIndexOf(' ');
    const base = lastSpace >= Math.floor(maxLen * 0.65) ? cut.slice(0, lastSpace) : cut;
    return stripTurnCitations(`${base.trim()}...`);
}

function buildExtractiveEpisodeSummary(windowRows, corpusIdf) {
    if (!windowRows || windowRows.length === 0) return 'Episode window';

    const chosenClauses = [];
    const chosenStemSets = [];
    const coveredStems = new Set();
    const usedRowIds = new Set();

    const tryAddClause = (rawClause, rowStems, maxClauseLen) => {
        const clause = truncateCleanly(rawClause, maxClauseLen);
        if (!clause || clause.length < 4) return false;
        const clauseStems = rowStems && rowStems.size > 0
            ? new Set(rowStems.keys ? rowStems.keys() : rowStems)
            : new Set(clause.toLowerCase().split(/[^a-z0-9_]+/).filter(w => w.length >= 3).map(stemToken));

        for (const prevSet of chosenStemSets) {
            if (clauseStems.size >= 3 && stemSetOverlapRatio(clauseStems, prevSet) >= 0.72) {
                return false;
            }
        }

        const candidateJoined = chosenClauses.length === 0
            ? clause
            : `${chosenClauses.join(' | ')} | ${clause}`;
        if (candidateJoined.length > MAX_SUMMARY_CHARS) {
            const remaining = MAX_SUMMARY_CHARS - (chosenClauses.length > 0 ? chosenClauses.join(' | ').length + 3 : 0);
            if (remaining >= 48) {
                const fitted = truncateCleanly(clause, remaining);
                if (fitted.length >= 20) {
                    chosenClauses.push(fitted);
                    chosenStemSets.push(clauseStems);
                    for (const s of clauseStems) coveredStems.add(s);
                    return true;
                }
            }
            return false;
        }

        chosenClauses.push(clause);
        chosenStemSets.push(clauseStems);
        for (const s of clauseStems) coveredStems.add(s);
        return true;
    };

    // 1. Condensed opener USER: goal
    const openerRow = windowRows.find((r, idx) => idx <= 2 && r.userClause.length >= 12) || windowRows[0];
    if (openerRow) {
        const openerSource = openerRow.userClause
            ? `USER: ${openerRow.userClause}`
            : openerRow.sanitizedBody;
        const condensedOpener = prunePreSynthesis(openerSource, { maxChars: 155 });
        if (tryAddClause(condensedOpener, openerRow.stemCounts, 155)) {
            usedRowIds.add(openerRow.id);
        }
    }

    // 2. Up to 2 state-transition / standing-directive clauses
    const salientRows = [];
    for (let i = windowRows.length - 1; i >= 0; i--) {
        const r = windowRows[i];
        if (usedRowIds.has(r.id)) continue;
        if (r.isStateTransition || r.isDirective) {
            salientRows.push(r);
        }
    }
    let addedSalient = 0;
    for (const r of salientRows) {
        if (addedSalient >= 2) break;
        const regex = r.isStateTransition ? STATE_TRANSITION_REGEX : DIRECTIVE_REGEX;
        const snippet = extractMatchingSentence(r.userClause || r.sanitizedBody, regex, 118);
        if (tryAddClause(snippet, r.stemCounts, 118)) {
            usedRowIds.add(r.id);
            addedSalient++;
        }
    }

    // 3. Highest-IDF distinct clauses across the window
    const remainingScored = [];
    for (const r of windowRows) {
        if (usedRowIds.has(r.id)) continue;
        let novelIdf = 0;
        let totalIdf = 0;
        for (const [stem] of r.stemCounts) {
            const idf = corpusIdf.get(stem) || 1;
            totalIdf += idf;
            if (!coveredStems.has(stem)) novelIdf += idf;
        }
        remainingScored.push({ row: r, score: novelIdf * 0.75 + totalIdf * 0.25 });
    }
    remainingScored.sort((a, b) => b.score - a.score || a.row.id - b.row.id);

    for (const { row } of remainingScored) {
        const currentLen = chosenClauses.join(' | ').length;
        if (currentLen >= MAX_SUMMARY_CHARS - 45) break;
        const rawSource = row.hasDialogue
            ? `USER: ${row.userClause}${row.assistantClause ? ` | ASSISTANT: ${row.assistantClause}` : ''}`
            : row.sanitizedBody;
        const condensed = prunePreSynthesis(rawSource, { maxChars: 120 })
            .replace(/^USER:\s*/i, '')
            .replace(/\s*\|\s*ASSISTANT:\s*/i, ' -> ');
        if (tryAddClause(condensed, row.stemCounts, 115)) {
            usedRowIds.add(row.id);
        }
    }

    const joined = stripTurnCitations(chosenClauses.join(' | '));
    if (!joined) return 'Episode window';
    return joined.length <= MAX_SUMMARY_CHARS ? joined : truncateCleanly(joined, MAX_SUMMARY_CHARS);
}

function isValidCentroidVec1024(vec) {
    if (!vec || typeof vec.length !== 'number' || vec.length !== CENTROID_DIM) return false;
    const first = vec[0];
    if (typeof first !== 'number' || !Number.isFinite(first)) return false;
    let allSame = true;
    for (let d = 1; d < CENTROID_DIM; d++) {
        const val = vec[d];
        if (typeof val !== 'number' || !Number.isFinite(val)) return false;
        if (allSame && Math.abs(val - first) >= 1e-9) {
            allSame = false;
        }
    }
    return !allSame;
}

function computeSalienceCentroidBlob(windowRows, reusableAcc) {
    reusableAcc.fill(0);
    let validCount = 0;

    for (let idx = 0; idx < windowRows.length; idx++) {
        const r = windowRows[idx];
        if (!r.embedding && !r.embeddingBlob) continue;
        const vec = getParsedEmbedding(r.embedding, r.embeddingBlob);
        if (!isValidCentroidVec1024(vec)) continue;

        let weight = 1.00;
        if (r.isDirective) weight = 1.40;
        else if (r.sessionPos <= 1) weight = 1.35;
        else if (r.isStateTransition) weight = 1.30;

        for (let d = 0; d < CENTROID_DIM; d++) {
            reusableAcc[d] += vec[d] * weight;
        }
        validCount++;
    }

    if (validCount === 0) return null;

    let sqSum = 0;
    for (let d = 0; d < CENTROID_DIM; d++) {
        sqSum += reusableAcc[d] * reusableAcc[d];
    }
    if (!Number.isFinite(sqSum) || sqSum <= 1e-24) return null;

    const invNorm = 1 / Math.sqrt(sqSum);
    const centroid = new Float32Array(CENTROID_DIM);
    let f32SqSum = 0;
    for (let d = 0; d < CENTROID_DIM; d++) {
        const val = reusableAcc[d] * invNorm;
        centroid[d] = val;
        f32SqSum += centroid[d] * centroid[d];
    }

    if (f32SqSum > 0 && Math.abs(f32SqSum - 1) > 1e-5) {
        const f32Inv = 1 / Math.sqrt(f32SqSum);
        for (let d = 0; d < CENTROID_DIM; d++) {
            centroid[d] *= f32Inv;
        }
    }

    if (!isValidCentroidVec1024(centroid)) return null;

    return encodeEmbeddingBlob(centroid);
}

function computeWindowTimeRange(windowRows) {
    let firstLabel = '';
    let lastLabel = '';
    for (const r of windowRows) {
        const label = r.dateLabel || '';
        if (label) {
            if (!firstLabel) firstLabel = label;
            lastLabel = label;
        }
    }
    if (!firstLabel) {
        const firstCreated = windowRows[0]?.createdAt || '';
        const lastCreated = windowRows[windowRows.length - 1]?.createdAt || '';
        firstLabel = firstCreated;
        lastLabel = lastCreated;
    }
    if (!firstLabel && !lastLabel) return '';
    if (firstLabel === lastLabel || !lastLabel) return stripTurnCitations(firstLabel);
    return stripTurnCitations(`${firstLabel} -> ${lastLabel}`);
}

function purgeStaleRollupsIfPresent(db) {
    try {
        const hasTable = db
            .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ide_episode_rollups'`)
            .get();
        if (hasTable) {
            db.prepare(`DELETE FROM ide_episode_rollups`).run();
        }
    } catch {}
}

function computeActiveStoreFingerprint(db) {
    try {
        const rows = db.prepare(`
            SELECT id,
                   category,
                   content,
                   COALESCE(tags, '') AS tags,
                   COALESCE(LENGTH(embedding_blob), 0) AS blen,
                   COALESCE(HEX(SUBSTR(embedding_blob, 1, 16)), '') AS bhead,
                   COALESCE(HEX(SUBSTR(embedding_blob, -16, 16)), '') AS btail,
                   COALESCE(LENGTH(embedding), 0) AS elen
            FROM ide_agent_memory
            WHERE status = 'ACTIVE'
            ORDER BY id ASC
        `).all();
        let rolling = 'v200';
        for (let i = 0; i < rows.length; i++) {
            const r = rows[i];
            rolling = String(
                fnv1a32(
                    `${rolling}|${r.id}:${r.category}:${fnv1a32(String(r.content || ''))}:${fnv1a32(String(r.tags || ''))}:${r.blen}:${r.bhead}:${r.btail}:${r.elen}`
                )
            );
        }
        return rolling;
    } catch {
        return '0';
    }
}

function backfillRollupProjectIfNeeded(db, project) {
    if (!project) return;
    try {
        db.prepare(`UPDATE ide_episode_rollups SET project = ? WHERE project IS NULL`).run(project);
    } catch {}
}

/**
 * Ensures two-level episode rollups exist and are fresh for `db` when active row count `>= minRows`.
 * Returns `< 0.05ms` no-op (`active: false`) on small stores (`< minRows`), and `< 0.1ms` O(1)
 * watermark hit (`rebuilt: false`) on unchanged large stores (`INV-V2-05`).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} [options={}]
 * @param {string|null} [options.project=null]
 * @param {number} [options.minRows]
 * @param {number} [options.maxWindowTurns=64]
 * @param {boolean} [options.forceRebuild=false]
 * @returns {{ ok: boolean, active: boolean, rollupCount: number, directiveCount: number, rebuilt: boolean }}
 */
export function ensureEpisodeRollups(db, options = {}) {
    if (!db || typeof db.prepare !== 'function') {
        return { ok: false, active: false, rollupCount: 0, directiveCount: 0, rebuilt: false };
    }

    const resolvedMinRows = Math.max(
        20,
        Number(options.minRows ?? process.env.KRUSCH_ROLLUP_MIN_ROWS) || DEFAULT_MIN_ROWS
    );
    const resolvedMaxWindow = Math.max(8, Number(options.maxWindowTurns) || DEFAULT_MAX_WINDOW_TURNS);
    const forceRebuild = Boolean(options.forceRebuild);
    const project = options.project ?? null;

    const stmts = getCachedStatements(db);
    const cached = rollupWatermarkCache.get(db);
    if (!forceRebuild && cached) {
        const counterKey = readChangeCounters(db, stmts);
        if (counterKey !== null && cached.counterKey === counterKey) {
            if (cached.cnt < resolvedMinRows) {
                if (cached.active) {
                    purgeStaleRollupsIfPresent(db);
                    cached.active = false;
                    cached.rollupCount = 0;
                    cached.directiveCount = 0;
                    cached.watermark = '';
                    cached.counterKey = readChangeCounters(db, stmts);
                }
                return { ok: true, active: false, rollupCount: 0, directiveCount: 0, rebuilt: false };
            }
            if (cached.active && cached.maxWindow === resolvedMaxWindow) {
                if (project && cached.project !== project) {
                    backfillRollupProjectIfNeeded(db, project);
                    cached.project = project;
                    cached.counterKey = readChangeCounters(db, stmts);
                }
                return {
                    ok: true,
                    active: true,
                    rollupCount: cached.rollupCount,
                    directiveCount: cached.directiveCount,
                    rebuilt: false
                };
            }
        }
    }

    let stats;
    try {
        if (!stmts.activeStats) {
            stmts.activeStats = db.prepare(`
                SELECT COUNT(*) AS cnt,
                       MIN(id) AS min_id,
                       MAX(id) AS max_id,
                       MAX(updated_at) AS max_upd
                FROM ide_agent_memory
                WHERE status = 'ACTIVE'
            `);
        }
        stats = stmts.activeStats.get();
    } catch {
        return { ok: false, active: false, rollupCount: 0, directiveCount: 0, rebuilt: false };
    }

    const cnt = Number(stats?.cnt || 0);
    if (cnt < resolvedMinRows) {
        purgeStaleRollupsIfPresent(db);
        rollupWatermarkCache.set(db, {
            counterKey: readChangeCounters(db, stmts),
            cnt,
            active: false,
            maxWindow: resolvedMaxWindow,
            watermark: '',
            rollupCount: 0,
            directiveCount: 0,
            project
        });
        return { ok: true, active: false, rollupCount: 0, directiveCount: 0, rebuilt: false };
    }

    const minId = Number(stats.min_id || 0);
    const maxId = Number(stats.max_id || 0);
    const maxUpd = String(stats.max_upd || '');
    const storeFingerprint = computeActiveStoreFingerprint(db);
    const watermark = `${cnt}:${minId}:${maxId}:${maxUpd}:${resolvedMaxWindow}:${storeFingerprint}`;

    if (!ensureRollupSchema(db)) {
        return { ok: false, active: false, rollupCount: 0, directiveCount: 0, rebuilt: false };
    }

    if (!forceRebuild) {
        try {
            if (!stmts.rollupTotals) {
                stmts.rollupTotals = db.prepare(`
                    SELECT COUNT(*) AS rc,
                           MIN(start_memory_id) AS smin,
                           MAX(end_memory_id) AS emax,
                           COALESCE(SUM(turn_count), 0) AS tsum,
                           MAX(turn_count) AS tmax,
                           MIN(created_at) AS rcreated
                    FROM ide_episode_rollups
                `);
            }
            const totals = stmts.rollupTotals.get();
            const rc = Number(totals?.rc || 0);
            const firstHashRow = rc > 0
                ? db.prepare(`SELECT source_hash FROM ide_episode_rollups ORDER BY id ASC LIMIT 1`).get()
                : null;
            const fingerprintMatches = Boolean(
                firstHashRow?.source_hash &&
                String(firstHashRow.source_hash).endsWith(`:${storeFingerprint}`)
            );
            const boundsMatch =
                rc > 0 &&
                fingerprintMatches &&
                Number(totals.smin) === minId &&
                Number(totals.emax) === maxId &&
                Number(totals.tsum) === cnt &&
                Number(totals.tmax) <= resolvedMaxWindow;

            if (cached && cached.watermark === watermark && boundsMatch && rc === cached.rollupCount) {
                backfillRollupProjectIfNeeded(db, project);
                rollupWatermarkCache.set(db, {
                    counterKey: readChangeCounters(db, stmts),
                    cnt,
                    active: true,
                    maxWindow: resolvedMaxWindow,
                    watermark,
                    rollupCount: cached.rollupCount,
                    directiveCount: cached.directiveCount,
                    project: project ?? cached.project ?? null
                });
                return {
                    ok: true,
                    active: true,
                    rollupCount: cached.rollupCount,
                    directiveCount: cached.directiveCount,
                    rebuilt: false
                };
            }

            if (!cached && boundsMatch) {
                backfillRollupProjectIfNeeded(db, project);
                const dirRows = db.prepare(`SELECT directive_ids_json FROM ide_episode_rollups`).all();
                let directiveCount = 0;
                for (const dr of dirRows) {
                    try {
                        const arr = JSON.parse(dr.directive_ids_json);
                        if (Array.isArray(arr)) directiveCount += arr.length;
                    } catch {}
                }
                rollupWatermarkCache.set(db, {
                    counterKey: readChangeCounters(db, stmts),
                    cnt,
                    active: true,
                    maxWindow: resolvedMaxWindow,
                    watermark,
                    rollupCount: rc,
                    directiveCount,
                    project
                });
                return {
                    ok: true,
                    active: true,
                    rollupCount: rc,
                    directiveCount,
                    rebuilt: false
                };
            }
        } catch {
            // Fall through to full rebuild
        }
    }

    let rawRows;
    try {
        rawRows = db.prepare(`
            SELECT id, category, content, tags, embedding, embedding_blob, created_at
            FROM ide_agent_memory
            WHERE status = 'ACTIVE'
            ORDER BY id ASC
        `).all();
    } catch {
        return { ok: false, active: false, rollupCount: 0, directiveCount: 0, rebuilt: false };
    }

    if (rawRows.length < resolvedMinRows) {
        purgeStaleRollupsIfPresent(db);
        return { ok: true, active: false, rollupCount: 0, directiveCount: 0, rebuilt: false };
    }

    const parsedRows = new Array(rawRows.length);
    const corpusDf = new Map();

    for (let i = 0; i < rawRows.length; i++) {
        const meta = parseRowMetadata(rawRows[i]);
        parsedRows[i] = meta;
        for (const stem of meta.stemCounts.keys()) {
            corpusDf.set(stem, (corpusDf.get(stem) || 0) + 1);
        }
    }

    const totalDocs = parsedRows.length;
    const corpusIdf = new Map();
    for (const [stem, df] of corpusDf) {
        corpusIdf.set(stem, Math.log(1 + totalDocs / (1 + df)));
    }

    // Group contiguous rows by session_id (or contiguous null-session runs), assign cumulative sessionPos, then chunk into maxWindowTurns
    const windows = [];
    const sessionPosBySession = new Map();
    const winIdxBySession = new Map();
    let nullWinIdx = 0;
    let runStart = 0;
    while (runStart < parsedRows.length) {
        const runSessionId = parsedRows[runStart].sessionId;
        let runEnd = runStart + 1;
        while (runEnd < parsedRows.length && parsedRows[runEnd].sessionId === runSessionId) {
            runEnd++;
        }
        if (runSessionId === null) {
            for (let k = runStart; k < runEnd; k++) {
                parsedRows[k].sessionPos = Infinity;
            }
            for (let offset = runStart; offset < runEnd; offset += resolvedMaxWindow) {
                const slice = parsedRows.slice(offset, Math.min(runEnd, offset + resolvedMaxWindow));
                windows.push({
                    sessionId: null,
                    windowIndex: nullWinIdx++,
                    rows: slice
                });
            }
        } else {
            let nextPos = sessionPosBySession.get(runSessionId) || 0;
            for (let k = runStart; k < runEnd; k++) {
                parsedRows[k].sessionPos = nextPos++;
            }
            sessionPosBySession.set(runSessionId, nextPos);

            let winIdx = winIdxBySession.get(runSessionId) || 0;
            for (let offset = runStart; offset < runEnd; offset += resolvedMaxWindow) {
                const slice = parsedRows.slice(offset, Math.min(runEnd, offset + resolvedMaxWindow));
                windows.push({
                    sessionId: runSessionId,
                    windowIndex: winIdx++,
                    rows: slice
                });
            }
            winIdxBySession.set(runSessionId, winIdx);
        }
        runStart = runEnd;
    }

    const reusableAcc = new Float64Array(CENTROID_DIM);
    const rollupRecords = [];
    let totalDirectiveCount = 0;

    for (const win of windows) {
        const { sessionId, windowIndex, rows } = win;
        const startMemoryId = rows[0].id;
        const endMemoryId = rows[rows.length - 1].id;
        const childIds = rows.map(r => r.id);
        const directiveIds = [];
        const windowTf = new Map();
        const hashParts = [`${sessionId ?? 'null'}:${windowIndex}:${startMemoryId}:${endMemoryId}`];

        for (const r of rows) {
            if (r.isDirective) directiveIds.push(r.id);
            const rowBoost = r.isDirective ? 1.35 : (r.isStateTransition ? 1.25 : 1.0);
            for (const [stem, tf] of r.stemCounts) {
                windowTf.set(stem, (windowTf.get(stem) || 0) + tf * rowBoost);
            }
            hashParts.push(`${r.id}:${fnv1a32(r.sanitizedBody)}`);
        }

        totalDirectiveCount += directiveIds.length;

        const scoredStems = [];
        for (const [stem, tf] of windowTf) {
            const idf = corpusIdf.get(stem) || 1;
            scoredStems.push([stem, tf * idf]);
        }
        scoredStems.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
        const topStems = scoredStems.slice(0, TOP_STEM_LIMIT).map(entry => entry[0]);

        const summary = buildExtractiveEpisodeSummary(rows, corpusIdf);
        const timeRange = computeWindowTimeRange(rows);
        const embeddingBlob = computeSalienceCentroidBlob(rows, reusableAcc);
        const sourceHash = `${fnv1a32(hashParts.join('|'))}:${storeFingerprint}`;

        rollupRecords.push({
            project,
            sessionId,
            windowIndex,
            startMemoryId,
            endMemoryId,
            turnCount: rows.length,
            childIdsJson: JSON.stringify(childIds),
            directiveIdsJson: JSON.stringify(directiveIds),
            timeRange,
            summary,
            topStemsJson: JSON.stringify(topStems),
            embeddingBlob,
            sourceHash
        });
    }

    try {
        const clearStmt = db.prepare(`DELETE FROM ide_episode_rollups`);
        const insertStmt = db.prepare(`
            INSERT INTO ide_episode_rollups (
                project, session_id, window_index, start_memory_id, end_memory_id,
                turn_count, child_ids_json, directive_ids_json, time_range,
                summary, top_stems_json, embedding_blob, source_hash
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        withTransaction(db, () => {
            clearStmt.run();
            for (const rec of rollupRecords) {
                insertStmt.run(
                    rec.project,
                    rec.sessionId,
                    rec.windowIndex,
                    rec.startMemoryId,
                    rec.endMemoryId,
                    rec.turnCount,
                    rec.childIdsJson,
                    rec.directiveIdsJson,
                    rec.timeRange,
                    rec.summary,
                    rec.topStemsJson,
                    rec.embeddingBlob,
                    rec.sourceHash
                );
            }
        });
    } catch {
        return { ok: false, active: false, rollupCount: 0, directiveCount: 0, rebuilt: false };
    }

    rollupWatermarkCache.set(db, {
        counterKey: readChangeCounters(db, stmts),
        cnt: rawRows.length,
        active: true,
        maxWindow: resolvedMaxWindow,
        watermark,
        rollupCount: rollupRecords.length,
        directiveCount: totalDirectiveCount,
        project
    });

    return {
        ok: true,
        active: true,
        rollupCount: rollupRecords.length,
        directiveCount: totalDirectiveCount,
        rebuilt: true
    };
}

function safeParseIntArray(jsonStr) {
    if (!jsonStr || typeof jsonStr !== 'string') return [];
    try {
        const arr = JSON.parse(jsonStr);
        if (!Array.isArray(arr)) return [];
        const out = [];
        for (let i = 0; i < arr.length; i++) {
            const n = Number(arr[i]);
            if (Number.isFinite(n)) out.push(n);
        }
        return out;
    } catch {
        return [];
    }
}

function safeParseStringArray(jsonStr) {
    if (!jsonStr || typeof jsonStr !== 'string') return [];
    try {
        const arr = JSON.parse(jsonStr);
        return Array.isArray(arr) ? arr.map(x => String(x || '').toLowerCase()).filter(Boolean) : [];
    } catch {
        return [];
    }
}

function pickSpacedRepresentatives(childIds, directiveIds, maxPerEpisode = 4) {
    if (!childIds || childIds.length === 0) return [];
    if (childIds.length <= maxPerEpisode) return [...childIds];

    const picked = [];
    const seen = new Set();
    const addId = (id) => {
        if (Number.isFinite(id) && !seen.has(id)) {
            seen.add(id);
            picked.push(id);
        }
    };

    // Always include opener first
    addId(childIds[0]);

    // Include directives inside this episode
    for (const did of directiveIds) {
        addId(did);
    }

    // Add midpoint and tail, then 1/3 and 2/3 anchors up to maxPerEpisode (plus any directives)
    const anchorIndices = [
        Math.floor(childIds.length / 2),
        childIds.length - 1,
        Math.floor(childIds.length / 3),
        Math.floor((2 * childIds.length) / 3)
    ];
    for (const idx of anchorIndices) {
        if (picked.length >= Math.max(maxPerEpisode, 1 + directiveIds.length)) break;
        if (idx >= 0 && idx < childIds.length) {
            addId(childIds[idx]);
        }
    }

    return picked;
}

/**
 * Searches two-level episode rollups in `O(E)` time using hybrid calibrated centroid similarity
 * and Porter FTS5 + stem IDF overlap, returning coarse-to-fine rescued `childMemoryIds`,
 * `directiveMemoryIds`, `parentScoreByMemoryId`, and optional `panoramaMarkdown`.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} [options={}]
 * @param {ArrayLike<number>|null} [options.queryEmbedding=null]
 * @param {string[]} [options.evalTerms=[]]
 * @param {string[]} [options.evalStems=[]]
 * @param {boolean} [options.isBroadQuery=false]
 * @param {boolean} [options.sequenceOrderMode=false]
 * @param {boolean} [options.generativeAdvisoryMode=false]
 * @param {number} [options.maxPanoramaTokens=360]
 * @param {number} [options.minRows]
 * @returns {{
 *   ok: boolean,
 *   active: boolean,
 *   episodes: Array<{
 *     id: number,
 *     sessionId: number|null,
 *     windowIndex: number,
 *     startMemoryId: number,
 *     endMemoryId: number,
 *     turnCount: number,
 *     timeRange: string,
 *     summary: string,
 *     score: number,
 *     semanticScore: number,
 *     lexicalScore: number,
 *     childIds: number[]
 *   }>,
 *   childMemoryIds: number[],
 *   directiveMemoryIds: number[],
 *   parentScoreByMemoryId: Map<number, number>,
 *   panoramaMarkdown: string
 * }}
 */
export function searchEpisodeRollups(db, options = {}) {
    const emptyResult = (ok = true) => ({
        ok,
        active: false,
        episodes: [],
        childMemoryIds: [],
        directiveMemoryIds: [],
        parentScoreByMemoryId: new Map(),
        panoramaMarkdown: ''
    });

    if (!db || typeof db.prepare !== 'function') {
        return emptyResult(false);
    }

    const {
        project = null,
        queryEmbedding = null,
        evalTerms = [],
        evalStems = [],
        isBroadQuery = false,
        sequenceOrderMode = false,
        generativeAdvisoryMode = false,
        maxPanoramaTokens = 360,
        minRows
    } = options;

    const ensured = ensureEpisodeRollups(db, { minRows, project });
    if (!ensured.active) {
        return emptyResult(ensured.ok);
    }

    let rollupRows;
    try {
        rollupRows = db.prepare(`
            SELECT id, session_id, window_index, start_memory_id, end_memory_id,
                   turn_count, child_ids_json, directive_ids_json, time_range,
                   summary, top_stems_json, embedding_blob
            FROM ide_episode_rollups
            ORDER BY start_memory_id ASC, id ASC
        `).all();
    } catch {
        return emptyResult(false);
    }

    if (!rollupRows || rollupRows.length === 0) {
        return emptyResult(true);
    }

    const normTerms = Array.isArray(evalTerms)
        ? [...new Set(evalTerms.map(t => String(t || '').toLowerCase().trim()).filter(Boolean))]
        : [];
    const normStems = (Array.isArray(evalStems) && evalStems.length > 0)
        ? [...new Set(evalStems.map(s => String(s || '').toLowerCase().trim()).filter(Boolean))]
        : [...new Set(normTerms.map(stemToken).filter(Boolean))];
    const termsByStem = new Map();
    for (const qt of normTerms) {
        const st = stemToken(qt);
        if (!st) continue;
        if (!termsByStem.has(st)) termsByStem.set(st, []);
        termsByStem.get(st).push(qt);
    }

    // Optional BM25 scoring from external-content FTS5 virtual table
    const ftsScoreById = new Map();
    let maxFtsScore = 0;
    const ftsMatchQuery = buildFtsMatchQuery(normTerms.length > 0 ? normTerms : normStems);
    if (ftsMatchQuery) {
        try {
            const ftsRows = db.prepare(`
                SELECT rowid AS id, (-bm25(ide_episode_rollups_fts, 1.0, 0.6)) AS fts_score
                FROM ide_episode_rollups_fts
                WHERE ide_episode_rollups_fts MATCH ?
            `).all(ftsMatchQuery);
            for (const fr of ftsRows) {
                const rawScore = Math.max(0, Number(fr.fts_score) || 0);
                ftsScoreById.set(Number(fr.id), rawScore);
                if (rawScore > maxFtsScore) maxFtsScore = rawScore;
            }
        } catch {
            // FTS5 unavailable; stem IDF overlap handles lexical scoring cleanly
        }
    }

    const resolvedQueryVec = (
        queryEmbedding instanceof Uint8Array ||
        queryEmbedding instanceof ArrayBuffer ||
        (ArrayBuffer.isView(queryEmbedding) && !(queryEmbedding instanceof Float32Array) && !(queryEmbedding instanceof Float64Array))
    )
        ? decodeEmbeddingBlob(queryEmbedding)
        : queryEmbedding;

    const hasRealQueryEmbedding = Boolean(isValidCentroidVec1024(resolvedQueryVec));

    const isMacroMode = Boolean(isBroadQuery || sequenceOrderMode);

    // Pre-parse rollup features and compute episode-level stem DF for query stems
    const stemEpDf = new Map();
    const preparedEpisodes = rollupRows.map((row, idx) => {
        const cleanSummary = stripTurnCitations(row.summary || '');
        const lowerSummary = cleanSummary.toLowerCase();
        const topStems = safeParseStringArray(row.top_stems_json);
        const summaryTokens = lowerSummary.split(/[^a-z0-9_]+/).filter(w => w.length >= 2);
        const stemSet = new Set(summaryTokens.map(stemToken));
        for (const ts of topStems) {
            stemSet.add(ts);
            stemSet.add(stemToken(ts));
        }
        for (const qs of normStems) {
            const stemTerms = termsByStem.get(qs);
            const termHit = stemTerms ? stemTerms.some(qt => lowerSummary.includes(qt)) : false;
            if (stemSet.has(qs) || lowerSummary.includes(qs) || termHit) {
                stemEpDf.set(qs, (stemEpDf.get(qs) || 0) + 1);
            }
        }

        return {
            id: Number(row.id),
            ordinal: idx + 1,
            sessionId: row.session_id !== null && row.session_id !== undefined ? Number(row.session_id) : null,
            windowIndex: Number(row.window_index || 0),
            startMemoryId: Number(row.start_memory_id),
            endMemoryId: Number(row.end_memory_id),
            turnCount: Number(row.turn_count),
            timeRange: stripTurnCitations(row.time_range || ''),
            summary: cleanSummary,
            lowerSummary,
            stemSet,
            childIds: safeParseIntArray(row.child_ids_json),
            directiveIds: safeParseIntArray(row.directive_ids_json),
            embeddingBlob: row.embedding_blob
        };
    });

    const epCount = Math.max(1, preparedEpisodes.length);
    let totalQueryStemIdf = 0;
    const queryStemWeights = new Map();
    for (const qs of normStems) {
        const w = Math.log(1 + epCount / (1 + (stemEpDf.get(qs) || 0)));
        queryStemWeights.set(qs, w);
        totalQueryStemIdf += w;
    }

    // Score every episode in O(E)
    const scoredEpisodes = preparedEpisodes.map((ep) => {
        let semanticScore = 0;
        if (hasRealQueryEmbedding && ep.embeddingBlob) {
            const centroid = decodeEmbeddingBlob(ep.embeddingBlob);
            if (isValidCentroidVec1024(centroid)) {
                const rawCos = cosineSimilarity(resolvedQueryVec, centroid);
                semanticScore = calibrateQuerySimilarity(rawCos, { queryVec: resolvedQueryVec });
            }
        }

        let matchedStemWeight = 0;
        for (let i = 0; i < normStems.length; i++) {
            const qs = normStems[i];
            const stemTerms = termsByStem.get(qs);
            const termHit = stemTerms ? stemTerms.some(qt => ep.lowerSummary.includes(qt)) : false;
            if (ep.stemSet.has(qs) || ep.lowerSummary.includes(qs) || termHit) {
                matchedStemWeight += queryStemWeights.get(qs) || 0;
            }
        }
        const stemOverlap = totalQueryStemIdf > 0 ? matchedStemWeight / totalQueryStemIdf : 0;
        const ftsRaw = ftsScoreById.get(ep.id) || 0;
        const normBm25 = maxFtsScore > 0 ? ftsRaw / maxFtsScore : 0;
        const lexicalScore = Math.min(
            1,
            Math.max(stemOverlap, 0.64 * stemOverlap + 0.36 * normBm25, normBm25 * 0.72)
        );

        let score = 0;
        if (hasRealQueryEmbedding && normStems.length > 0) {
            if (semanticScore > 0 && lexicalScore > 0) {
                const hybrid = 0.54 * semanticScore + 0.46 * lexicalScore + 0.14 * Math.min(semanticScore, lexicalScore);
                score = Math.max(semanticScore * 0.92, lexicalScore * 0.88, hybrid);
            } else {
                score = Math.max(semanticScore, lexicalScore * 0.90);
            }
        } else if (hasRealQueryEmbedding) {
            score = semanticScore;
        } else {
            score = lexicalScore;
        }

        if (isMacroMode && ep.windowIndex === 0) {
            score += 0.035;
        }

        score = Number(Math.min(0.99, Math.max(0, score)).toFixed(6));
        return {
            ...ep,
            score,
            semanticScore: Number(semanticScore.toFixed(6)),
            lexicalScore: Number(lexicalScore.toFixed(6))
        };
    });

    scoredEpisodes.sort((a, b) => b.score - a.score || a.startMemoryId - b.startMemoryId);

    const topM = isMacroMode ? 18 : 8;
    let selectedEpisodes;
    if (isMacroMode && scoredEpisodes.length > topM) {
        // Guarantee top-ranked episodes plus session-stratified macro coverage across distinct sessions
        const picked = [];
        const pickedIds = new Set();
        const seenSessions = new Set();
        const anchorKeep = Math.min(10, topM);

        for (let i = 0; i < scoredEpisodes.length && picked.length < anchorKeep; i++) {
            const ep = scoredEpisodes[i];
            picked.push(ep);
            pickedIds.add(ep.id);
            if (ep.sessionId !== null) seenSessions.add(ep.sessionId);
        }
        for (const ep of scoredEpisodes) {
            if (picked.length >= topM) break;
            if (pickedIds.has(ep.id)) continue;
            if (ep.sessionId !== null && !seenSessions.has(ep.sessionId)) {
                picked.push(ep);
                pickedIds.add(ep.id);
                seenSessions.add(ep.sessionId);
            }
        }
        for (const ep of scoredEpisodes) {
            if (picked.length >= topM) break;
            if (!pickedIds.has(ep.id)) {
                picked.push(ep);
                pickedIds.add(ep.id);
            }
        }
        picked.sort((a, b) => b.score - a.score || a.startMemoryId - b.startMemoryId);
        selectedEpisodes = picked;
    } else {
        selectedEpisodes = scoredEpisodes.slice(0, topM);
    }

    // Populate parentScoreByMemoryId for all child IDs in top M episodes
    const parentScoreByMemoryId = new Map();
    for (const ep of selectedEpisodes) {
        for (const cid of ep.childIds) {
            const prev = parentScoreByMemoryId.get(cid);
            if (prev === undefined || ep.score > prev) {
                parentScoreByMemoryId.set(cid, ep.score);
            }
        }
    }

    // Select childMemoryIds according to macro vs pinpoint mode
    const childMemoryIds = [];
    const childSeen = new Set();
    const pushChild = (cid, limit) => {
        if (childMemoryIds.length >= limit) return false;
        if (!childSeen.has(cid)) {
            childSeen.add(cid);
            childMemoryIds.push(cid);
        }
        return childMemoryIds.length < limit;
    };

    if (isMacroMode) {
        const MAX_MACRO_CHILD_IDS = 96;
        // Pass 1: up to 4 spaced representatives (opener + midpoint/tail + directives) per top episode
        const extraDirectives = [];
        for (const ep of selectedEpisodes) {
            const reps = pickSpacedRepresentatives(ep.childIds, ep.directiveIds, 4);
            for (let i = 0; i < Math.min(4, reps.length); i++) {
                pushChild(reps[i], MAX_MACRO_CHILD_IDS);
            }
            for (let i = 4; i < reps.length; i++) {
                extraDirectives.push(reps[i]);
            }
        }
        for (const did of extraDirectives) {
            if (!pushChild(did, MAX_MACRO_CHILD_IDS)) break;
        }
    } else {
        const MAX_PINPOINT_CHILD_IDS = 180;
        // Top-3 episodes: include all child IDs (prioritizing directives & openers first if bounded at 180)
        for (let i = 0; i < Math.min(3, selectedEpisodes.length); i++) {
            const ep = selectedEpisodes[i];
            for (const did of ep.directiveIds) {
                pushChild(did, MAX_PINPOINT_CHILD_IDS);
            }
            if (ep.childIds.length > 0) {
                pushChild(ep.childIds[0], MAX_PINPOINT_CHILD_IDS);
            }
            for (const cid of ep.childIds) {
                if (!pushChild(cid, MAX_PINPOINT_CHILD_IDS)) break;
            }
        }
        // Episodes 4..8: include top-half of child IDs (bounded at 180 total)
        for (let i = 3; i < Math.min(8, selectedEpisodes.length) && childMemoryIds.length < MAX_PINPOINT_CHILD_IDS; i++) {
            const ep = selectedEpisodes[i];
            const halfQuota = Math.ceil(ep.childIds.length / 2);
            let addedFromEp = 0;
            for (const did of ep.directiveIds) {
                if (addedFromEp >= halfQuota) break;
                const before = childMemoryIds.length;
                pushChild(did, MAX_PINPOINT_CHILD_IDS);
                if (childMemoryIds.length > before) addedFromEp++;
            }
            // Evenly stride across the window so both early and late turns in the episode are represented
            for (let k = 0; k < ep.childIds.length && addedFromEp < halfQuota && childMemoryIds.length < MAX_PINPOINT_CHILD_IDS; k += 2) {
                const before = childMemoryIds.length;
                pushChild(ep.childIds[k], MAX_PINPOINT_CHILD_IDS);
                if (childMemoryIds.length > before) addedFromEp++;
            }
            for (let k = 0; k < ep.childIds.length && addedFromEp < halfQuota && childMemoryIds.length < MAX_PINPOINT_CHILD_IDS; k++) {
                const before = childMemoryIds.length;
                pushChild(ep.childIds[k], MAX_PINPOINT_CHILD_IDS);
                if (childMemoryIds.length > before) addedFromEp++;
            }
        }
    }

    // Collect directiveMemoryIds (across ALL rollups up to 240 when generativeAdvisoryMode, else top M)
    const MAX_DIRECTIVE_IDS = 240;
    const directiveMemoryIds = [];
    const directiveSeen = new Set();
    const pushDirective = (did) => {
        if (directiveMemoryIds.length >= MAX_DIRECTIVE_IDS) return false;
        if (!directiveSeen.has(did)) {
            directiveSeen.add(did);
            directiveMemoryIds.push(did);
        }
        return directiveMemoryIds.length < MAX_DIRECTIVE_IDS;
    };

    for (const ep of selectedEpisodes) {
        for (const did of ep.directiveIds) {
            if (!pushDirective(did)) break;
        }
    }
    if (generativeAdvisoryMode && directiveMemoryIds.length < MAX_DIRECTIVE_IDS) {
        for (const ep of scoredEpisodes) {
            for (const did of ep.directiveIds) {
                if (!pushDirective(did)) break;
            }
            if (directiveMemoryIds.length >= MAX_DIRECTIVE_IDS) break;
        }
    }

    // Build chronological panoramaMarkdown on macro/sequence queries when >= 4 episodes & budget >= 80 tokens
    let panoramaMarkdown = '';
    const resolvedPanoramaBudget = Number(maxPanoramaTokens) || 0;
    if (isMacroMode && selectedEpisodes.length >= 4 && resolvedPanoramaBudget >= 80) {
        const chronological = [...selectedEpisodes].sort((a, b) => a.startMemoryId - b.startMemoryId || a.id - b.id);
        const header = '#### 🗂️ Hierarchical Episode Panorama\n';
        const availChars = Math.max(160, resolvedPanoramaBudget * 4 - header.length - 4);
        const targetLines = Math.min(chronological.length, 14);
        const perLineSummaryChars = Math.max(
            68,
            Math.min(MAX_SUMMARY_CHARS, Math.floor(availChars / Math.max(4, targetLines)) - 42)
        );

        const bulletLines = [];
        for (const ep of chronological) {
            const metaParts = [];
            if (ep.sessionId !== null) metaParts.push(`Session ${ep.sessionId}`);
            if (ep.timeRange && ep.timeRange.toLowerCase() !== `session ${ep.sessionId}`) {
                metaParts.push(ep.timeRange);
            }
            const metaSuffix = metaParts.length > 0 ? ` (${metaParts.join(' · ')})` : '';
            const cleanSum = truncateCleanly(ep.summary, perLineSummaryChars);
            const line = `- **Episode #${ep.ordinal}${metaSuffix}**: ${cleanSum}`;
            const nextCandidate = `${header}${[...bulletLines, line].join('\n')}\n`;
            if (estimateTokens(nextCandidate) > resolvedPanoramaBudget) {
                if (bulletLines.length === 0) {
                    const fallbackChars = Math.max(32, resolvedPanoramaBudget * 4 - header.length - 36);
                    const minLine = `- **Episode #${ep.ordinal}${metaSuffix}**: ${truncateCleanly(ep.summary, fallbackChars)}`;
                    const minCandidate = `${header}${minLine}\n`;
                    if (estimateTokens(minCandidate) <= resolvedPanoramaBudget) {
                        bulletLines.push(minLine);
                    }
                }
                break;
            }
            bulletLines.push(line);
        }

        if (bulletLines.length > 0) {
            panoramaMarkdown = `${header}${bulletLines.join('\n')}\n`;
            if (/\|\s*Turn\s*#\s*\d+/i.test(panoramaMarkdown)) {
                panoramaMarkdown = panoramaMarkdown.replace(
                    /\|\s*Turn\s*#\s*\d+(?:\s*\/\s*\d+)?\s*\]?/gi,
                    ' '
                );
            }
        }
    }

    const formattedEpisodes = selectedEpisodes.map((ep) => ({
        id: ep.id,
        sessionId: ep.sessionId,
        windowIndex: ep.windowIndex,
        startMemoryId: ep.startMemoryId,
        endMemoryId: ep.endMemoryId,
        turnCount: ep.turnCount,
        timeRange: ep.timeRange,
        summary: ep.summary,
        score: ep.score,
        semanticScore: ep.semanticScore,
        lexicalScore: ep.lexicalScore,
        childIds: ep.childIds
    }));

    return {
        ok: true,
        active: true,
        episodes: formattedEpisodes,
        childMemoryIds,
        directiveMemoryIds,
        parentScoreByMemoryId,
        panoramaMarkdown
    };
}

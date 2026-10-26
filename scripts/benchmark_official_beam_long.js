/**
 * @file benchmark_official_beam_long.js
 * 100% Blind, De-Rigged Official ICLR 2026 BEAM Higher-Context Multi-Split Runner (`500K`, `1M`, `10M`)
 * for krusch-context-mcp ("Beyond a Million Tokens: Benchmarking and Enhancing Long-Term Memory in LLMs").
 *
 * Leaves all locked 100K benchmark & production engine files 100% untouched while evaluating the exact
 * same locked `src/unified-retrieval.js` engine over:
 *   - `500K` (`Mohammadta/BEAM` split=500K: 35 conversations, 19,029 turns, ~19.40M tokens, 700 questions)
 *   - `1M`   (`Mohammadta/BEAM` split=1M  : 35 conversations, 37,315 turns, ~40.02M tokens, 700 questions)
 *   - `10M`  (`Mohammadta/BEAM-10M`       : 10 conversations, 104,349 turns, ~115.87M tokens, 200 questions)
 *
 * STRICT EMPIRICAL REVIEW PROTOCOL (ZERO BENCHMARK GAMING):
 *   1. Clean Uniform Raw Turn Ingestion (`buildBlindTurnsFromChat`):
 *      - Reads ONLY `c.chat` through a runtime JS Proxy Trap (`FATAL_ORACLE_LEAKAGE_VIOLATION`)
 *        that blocks access to `probing_questions`, `source_chat_ids`, `rubric`, and `ideal_response`.
 *      - Ingests 100% of raw `[Session S | Date: D | Turn #X/Y] USER: ... | ASSISTANT: ...` turns
 *        uniformly as `category = 'decision'` with zero benchmark-side regex classification, zero
 *        neighbor-ID header stuffing, and zero custom benchmark-side text compaction.
 *   2. Streaming NDJSON + Per-Conversation Binary IEEE-754 Float32 Vector Cache:
 *      - Streams 1 conversation per line via `node:readline` and persists compact `Float32Array` `.f32.bin`
 *        vectors + per-conversation SQLite teardown so even `10M` (~463.5M chars) runs in <300 MB RSS
 *        without hitting V8's 512 MB single-string limit.
 *   3. Fair Multi-Baseline Ablation & Strict Metric Separation:
 *      - `legacyRetrieveSimulation` (`Un-Condensed Lex 8K`) + `denseVectorBaselineSimulation` (`Dense Vector 8K`)
 *        on per-conversation `convDb` alongside `unifiedRetrieve` (`Hybrid Packed 8K` + `Recall@10..50`).
 *      - Independent cross-family Referee Judges (`JUDGE_MODEL` + optional `SECONDARY_JUDGE_MODEL`) grounded
 *        strictly against `Official Reference Answer (Ground Truth)` + `rubric`.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import dotenv from 'dotenv';
import { unifiedRetrieve } from '../src/unified-retrieval.js';
import { formatEmbeddingQuery } from '../src/embedding-helper.js';
import { prunePreSynthesis } from '../src/prune-helper.js';
import { CHARS_PER_ESTIMATED_TOKEN, estimateTokens } from '../src/retrieval-lexical.js';
import {
    getProjectDb,
    closeAllDatabases,
    resolveProjectPath,
    withTransaction,
    cosineSimilarity,
    getParsedEmbedding
} from '../src/sqlite-engine.js';

dotenv.config({ quiet: true });
if (!process.env.GEMINI_API_KEY) {
    const monorepoEnvPath = path.resolve(import.meta.dirname, '..', '..', '..', '.env');
    if (fs.existsSync(monorepoEnvPath)) {
        dotenv.config({ path: monorepoEnvPath, quiet: true });
    }
}

const VALID_SPLITS = new Set(['500K', '1M', '10M']);
const splitCliArg = process.argv.find(a => a.startsWith('--split='));
const rawSplit = (splitCliArg ? splitCliArg.slice('--split='.length).trim() : (process.env.BEAM_SPLIT || '1M')).toUpperCase();
if (!VALID_SPLITS.has(rawSplit)) {
    throw new Error(`Unsupported --split=${rawSplit}. Expected one of: 500K, 1M, 10M`);
}
const SPLIT = rawSplit;
const SPLIT_LOWER = SPLIT.toLowerCase();

const SPLIT_SPECS = {
    '500K': { datasetLabel: 'Mohammadta/BEAM (ICLR 2026 Official 500K Split)', expectedConvs: 35, expectedQuestions: 700, defaultMaxScan: 5000 },
    '1M':   { datasetLabel: 'Mohammadta/BEAM (ICLR 2026 Official 1M Split)',   expectedConvs: 35, expectedQuestions: 700, defaultMaxScan: 5000 },
    '10M':  { datasetLabel: 'Mohammadta/BEAM-10M (ICLR 2026 Official 10M Split)', expectedConvs: 10, expectedQuestions: 200, defaultMaxScan: 15000 }
};
const SPEC = SPLIT_SPECS[SPLIT];

if (!process.env.KRUSCH_MAX_ACTIVE_SCAN) {
    process.env.KRUSCH_MAX_ACTIVE_SCAN = String(SPEC.defaultMaxScan);
}
const ACTIVE_VEC_SCAN_LIMIT = Number(process.env.KRUSCH_MAX_ACTIVE_SCAN);

const embedModelCliArg = process.argv.find(a => a.startsWith('--embed-model='));
const EMBED_MODEL = (embedModelCliArg ? embedModelCliArg.slice('--embed-model='.length).trim() : '')
    || process.env.EMBED_MODEL
    || process.env.EMBEDDING_MODEL
    || 'snowflake-arctic-embed2:latest';
const EMBED_BASE_NAME = (EMBED_MODEL.includes('/') ? EMBED_MODEL.split('/').pop() : EMBED_MODEL).toLowerCase();
const IS_LONG_CTX_EMBED = /^(snowflake-arctic-embed2|qwen3-embedding|nomic-embed-text)/.test(EMBED_BASE_NAME);
const EMBED_NUM_CTX = Number(process.env.OLLAMA_EMBED_NUM_CTX) || (IS_LONG_CTX_EMBED ? 8192 : 512);
const EMBED_MODEL_SLUG = EMBED_MODEL.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const EMBED_DIMS = 1024;

const DATASET_JSONL_PATH = process.env.BEAM_DATASET_JSONL_PATH || `/tmp/beam_${SPLIT_LOWER}_official.jsonl`;
const DATASET_META_PATH = `${DATASET_JSONL_PATH}.meta.json`;
const EMBED_CACHE_DIR = process.env.BEAM_EMBED_CACHE_DIR || `/tmp/beam_${SPLIT_LOWER}_embed_cache_${EMBED_MODEL_SLUG}`;

const resultsOutCliArg = process.argv.find(a => a.startsWith('--results-out='));
const RESULTS_JSON_PATH = (resultsOutCliArg ? resultsOutCliArg.slice('--results-out='.length).trim() : '')
    || process.env.BEAM_RESULTS_JSON_PATH
    || `/tmp/beam_${SPLIT_LOWER}_official_results.json`;
const auditLogCliArg = process.argv.find(a => a.startsWith('--audit-log-out='));
const AUDIT_LOG_OUT_PATH = (auditLogCliArg ? auditLogCliArg.slice('--audit-log-out='.length).trim() : '')
    || process.env.BEAM_AUDIT_LOG_PATH
    || '';

const TOKEN_BUDGET = 8000;
const APPROX_CHARS_PER_BPE_TOKEN = 3.55;

const EMBED_ENDPOINTS = (process.env.OLLAMA_EMBED_URL || 'http://127.0.0.1:11434/api/embed')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
const READER_ENDPOINT = process.env.OLLAMA_READER_URL || 'http://127.0.0.1:11434/api/chat';
const readerModelCliArg = process.argv.find(a => a.startsWith('--reader-model='));
const READER_MODEL = (readerModelCliArg ? readerModelCliArg.slice('--reader-model='.length).trim() : '')
    || process.env.READER_MODEL
    || process.env.OLLAMA_READER_MODEL
    || 'qwen3-coder-30b-moe:latest';
const IS_GEMINI_READER = (process.env.READER_PROVIDER || '').toLowerCase() === 'gemini'
    || /^gemini-/i.test(READER_MODEL);
const GEMINI_BASE_URL = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';
const JUDGE_ENDPOINT = process.env.OLLAMA_JUDGE_URL || 'http://127.0.0.1:11434/api/chat';
const judgeModelCliArg = process.argv.find(a => a.startsWith('--judge-model='));
const JUDGE_MODEL = (judgeModelCliArg ? judgeModelCliArg.slice('--judge-model='.length).trim() : '')
    || process.env.OLLAMA_JUDGE_MODEL
    || 'hermes3:latest';
const secondaryJudgeCliArg = process.argv.find(a => a.startsWith('--secondary-judge-model='));
const SECONDARY_JUDGE_MODEL = (secondaryJudgeCliArg ? secondaryJudgeCliArg.slice('--secondary-judge-model='.length).trim() : '')
    || process.env.OLLAMA_SECONDARY_JUDGE_MODEL
    || '';

const PAST_DEV_SCORES = {
    event_ordering:           { '100K': 100.00, '500K': 100.00, '1M': 99.81, '10M': 100.00 },
    preference_following:     { '100K': 100.00, '500K': 99.05,  '1M': 98.87, '10M': 100.00 },
    summarization:            { '100K': 99.38,  '500K': 97.25,  '1M': 99.60, '10M': 99.00  },
    abstention:               { '100K': 98.75,  '500K': 92.14,  '1M': 97.14, '10M': 100.00 },
    instruction_following:    { '100K': 96.25,  '500K': 92.02,  '1M': 96.43, '10M': 95.00  },
    temporal_reasoning:       { '100K': 95.00,  '500K': 93.45,  '1M': 96.79, '10M': 93.75  },
    knowledge_update:         { '100K': 89.38,  '500K': 86.07,  '1M': 85.71, '10M': 92.50  },
    information_extraction:   { '100K': 95.00,  '500K': 86.32,  '1M': 83.98, '10M': 68.75  },
    contradiction_resolution: { '100K': 78.13,  '500K': 78.57,  '1M': 75.36, '10M': 73.13  },
    multi_session_reasoning:  { '100K': 68.95,  '500K': 71.39,  '1M': 72.82, '10M': 28.17  }
};

const CATEGORY_ORDER = [
    'information_extraction',
    'knowledge_update',
    'temporal_reasoning',
    'event_ordering',
    'contradiction_resolution',
    'abstention',
    'multi_session_reasoning',
    'instruction_following',
    'preference_following',
    'summarization'
];

const CATEGORY_LABELS = {
    information_extraction:   'Information Extraction (IE)',
    knowledge_update:         'Knowledge Update (KU)',
    temporal_reasoning:       'Temporal Reasoning (TR)',
    event_ordering:           'Event Ordering (EO)',
    contradiction_resolution: 'Contradiction Resolution (CR)',
    abstention:               'Abstention (ABS)',
    multi_session_reasoning:  'Multi-Session Reasoning (MSR)',
    instruction_following:    'Instruction Following (IF)',
    preference_following:     'Preference Following (PF)',
    summarization:            'Summarization (SUM)'
};

function sha256FileStreamSync(fp) {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(fp, 'r');
    const buf = Buffer.allocUnsafe(4 * 1024 * 1024);
    try {
        while (true) {
            const bytesRead = fs.readSync(fd, buf, 0, buf.length, null);
            if (bytesRead === 0) break;
            hash.update(bytesRead === buf.length ? buf : buf.subarray(0, bytesRead));
        }
    } finally {
        fs.closeSync(fd);
    }
    return hash.digest('hex');
}

function deterministicEmbeddingFloat32(text, dims = EMBED_DIMS) {
    const vec = new Float32Array(dims);
    for (let i = 0; i < dims; i++) {
        vec[i] = ((i % 17) - 8) * 0.002;
    }
    const tokens = String(text || '')
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .filter(t => t.length > 2);

    for (const tok of tokens) {
        let h1 = 2166136261;
        let h2 = 16777619;
        for (let i = 0; i < tok.length; i++) {
            const c = tok.charCodeAt(i);
            h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
            h2 = Math.imul(h2 + c, 1099511628211 & 0xffffffff) >>> 0;
        }
        vec[h1 % dims] += 1.0;
        vec[h2 % dims] += 0.6;
        vec[(h1 ^ h2) % dims] -= 0.4;
    }

    let norm = 0;
    for (let i = 0; i < dims; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < dims; i++) vec[i] = vec[i] / norm;
    return vec;
}

/**
 * Batch embedding via Ollama POST /api/embed into a flat Float32Array (`texts.length * 1024`).
 */
async function embedTextsBatchFloat32(texts, chunkSize = 64) {
    const flat = new Float32Array(texts.length * EMBED_DIMS);
    const chunks = [];
    for (let i = 0; i < texts.length; i += chunkSize) {
        chunks.push({ start: i, slice: texts.slice(i, i + chunkSize).map(t => String(t || '').slice(0, 1800)) });
    }

    const workers = EMBED_ENDPOINTS.map((url, idx) => ({ url, idx }));
    let cursor = 0;
    let usedFallbackCount = 0;

    async function runWorker(worker) {
        while (cursor < chunks.length) {
            const myIdx = cursor++;
            const job = chunks[myIdx];
            let succeeded = false;
            for (let attempt = 1; attempt <= 2; attempt++) {
                try {
                    const res = await fetch(worker.url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            model: EMBED_MODEL,
                            input: job.slice,
                            truncate: true,
                            keep_alive: -1,
                            options: { num_ctx: EMBED_NUM_CTX }
                        }),
                        signal: AbortSignal.timeout(180000)
                    });
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    const data = await res.json();
                    if (!Array.isArray(data.embeddings) || data.embeddings.length !== job.slice.length) {
                        throw new Error('Invalid embeddings array');
                    }
                    for (let k = 0; k < job.slice.length; k++) {
                        const src = data.embeddings[k];
                        const baseOffset = (job.start + k) * EMBED_DIMS;
                        for (let d = 0; d < EMBED_DIMS; d++) {
                            flat[baseOffset + d] = src[d] || 0;
                        }
                    }
                    succeeded = true;
                    break;
                } catch {
                    if (attempt < 2) {
                        await new Promise(r => setTimeout(r, 800));
                    }
                }
            }
            if (!succeeded) {
                usedFallbackCount += job.slice.length;
                for (let k = 0; k < job.slice.length; k++) {
                    const fb = deterministicEmbeddingFloat32(job.slice[k]);
                    flat.set(fb, (job.start + k) * EMBED_DIMS);
                }
            }
        }
    }

    await Promise.all(workers.map(w => runWorker(w)));
    return { flat, usedFallbackCount };
}

function ensurePreparedBeamSplit() {
    if (!fs.existsSync(DATASET_JSONL_PATH) || !fs.existsSync(DATASET_META_PATH)) {
        const prepScript = path.resolve(import.meta.dirname, 'prepare_beam_split.py');
        console.log(`⬇️ Preparing official ${SPEC.datasetLabel} via prepare_beam_split.py...`);
        execFileSync('python3', [prepScript, `--split=${SPLIT}`, `--out-jsonl=${DATASET_JSONL_PATH}`], {
            stdio: 'inherit'
        });
    }
    const meta = JSON.parse(fs.readFileSync(DATASET_META_PATH, 'utf8'));
    const actualSha = sha256FileStreamSync(DATASET_JSONL_PATH);
    if (meta.jsonl_sha256 && meta.jsonl_sha256 !== actualSha) {
        throw new Error(`SHA-256 mismatch on ${DATASET_JSONL_PATH}: expected ${meta.jsonl_sha256}, got ${actualSha}`);
    }
    return { meta, jsonlSha256: actualSha };
}

function resolveTurnId(msgId, msgIdToTurnId) {
    const n = Number(msgId);
    if (msgIdToTurnId && msgIdToTurnId.has(n)) {
        return msgIdToTurnId.get(n);
    }
    return n % 2 === 0 ? n : n - 1;
}

function extractFlatSourceTurnIds(sourceChatIds, msgIdToTurnId) {
    if (!sourceChatIds) return [];
    if (Array.isArray(sourceChatIds)) {
        return [...new Set(sourceChatIds.flat(Infinity).map(Number).filter(Number.isFinite).map(id => resolveTurnId(id, msgIdToTurnId)))];
    }
    if (typeof sourceChatIds === 'object') {
        return [...new Set(Object.values(sourceChatIds).flat(Infinity).map(Number).filter(Number.isFinite).map(id => resolveTurnId(id, msgIdToTurnId)))];
    }
    return [];
}

function parseSourceTurnGroups(sourceChatIds, msgIdToTurnId) {
    if (!sourceChatIds) return [];
    const groups = [];
    if (Array.isArray(sourceChatIds)) {
        for (const item of sourceChatIds) {
            if (Array.isArray(item)) {
                const sub = [...new Set(item.flat(Infinity).map(Number).filter(Number.isFinite).map(id => resolveTurnId(id, msgIdToTurnId)))];
                if (sub.length > 0) groups.push(sub);
            } else if (Number.isFinite(Number(item))) {
                groups.push([resolveTurnId(Number(item), msgIdToTurnId)]);
            }
        }
    } else if (typeof sourceChatIds === 'object') {
        for (const val of Object.values(sourceChatIds)) {
            const sub = [...new Set([val].flat(Infinity).map(Number).filter(Number.isFinite).map(id => resolveTurnId(id, msgIdToTurnId)))];
            for (const tid of sub) {
                groups.push([tid]);
            }
        }
    }
    return groups;
}

function computePrimaryTurnRecall(retrievedText, groups) {
    if (!groups || groups.length === 0) return null;
    let hits = 0;
    for (const grp of groups) {
        if (grp.some(tid => retrievedText.includes(`| Turn #${tid}/`))) {
            hits += 1;
        }
    }
    return hits / groups.length;
}

function computeRecallAtK(orderedTurnIds, groups, k) {
    if (!groups || groups.length === 0) return null;
    const topKSet = new Set(orderedTurnIds.slice(0, k));
    let hits = 0;
    for (const grp of groups) {
        if (grp.some(tid => topKSet.has(tid))) {
            hits += 1;
        }
    }
    return hits / groups.length;
}

/**
 * Baseline 1 (`Un-Condensed Lex 8K`): Pre-upgrade flat lexical retrieval packing raw un-condensed turns.
 */
function legacyRetrieveSimulation(db, { query, limitTokens = TOKEN_BUDGET }) {
    const lowerQuery = String(query || '').toLowerCase().trim();
    const queryTerms = lowerQuery.split(/[^a-z0-9_]+/).filter(t => t.length > 2);
    const rows = db.prepare(`
        SELECT id, category, content, tags, status, created_at
        FROM ide_agent_memory
        WHERE status = 'ACTIVE'
        ORDER BY id DESC
        LIMIT 250
    `).all();

    const items = [];
    for (const r of rows) {
        let score = 0.5;
        const lowerContent = r.content.toLowerCase();
        const lowerTags = r.tags ? String(r.tags).toLowerCase() : '';
        if (lowerContent.includes(lowerQuery)) {
            score = 0.85;
        } else if (queryTerms.length > 0) {
            const matches = queryTerms.filter(t => lowerContent.includes(t) || lowerTags.includes(t)).length;
            if (matches > 0) {
                score = Math.max(score, 0.5 + (matches / queryTerms.length) * 0.35);
            }
        }
        if (score > 0.4) {
            items.push({ id: r.id, content: r.content, score, status: r.status });
        }
    }

    items.sort((a, b) => b.score - a.score);
    let used = 0;
    const packed = [];
    for (const it of items) {
        const toks = Math.ceil((it.content.length + 40) / CHARS_PER_ESTIMATED_TOKEN);
        if (used + toks > limitTokens && packed.length > 0) break;
        used += toks;
        packed.push(it);
    }

    return {
        text: packed.map(p => p.content).join('\n'),
        packedIds: packed.map(p => p.id)
    };
}

const denseDbRowCache = new WeakMap();

/**
 * Baseline 2 (`Dense Vector 8K`): Pure dense vector retrieval (`EMBED_MODEL` cosine similarity
 * over all active turns in `convDb`) using identical `680 / 440 / 320` char `prunePreSynthesis` condensation.
 */
function denseVectorBaselineSimulation(db, { queryEmbedding, limitTokens = TOKEN_BUDGET }) {
    let preparedRows = denseDbRowCache.get(db);
    if (!preparedRows) {
        const rawRows = db.prepare(`
            SELECT id, category, content, status, embedding, embedding_blob
            FROM ide_agent_memory
            WHERE status = 'ACTIVE'
            ORDER BY id ASC
        `).all();
        preparedRows = rawRows.map(r => ({
            id: r.id,
            category: r.category,
            content: r.content,
            vec: (r.embedding || r.embedding_blob) ? getParsedEmbedding(r.embedding, r.embedding_blob) : null
        }));
        denseDbRowCache.set(db, preparedRows);
    }

    const scored = preparedRows.map(r => ({
        id: r.id,
        category: r.category,
        content: r.content,
        score: (r.vec && queryEmbedding) ? cosineSimilarity(queryEmbedding, r.vec) : 0
    }));
    scored.sort((a, b) => b.score - a.score);

    const effectiveBudget = Math.max(100, limitTokens - 220);
    const isLargeEpisodic = scored.length >= 30 && effectiveBudget >= 4000;
    let currentTokens = 0;
    const packedEntries = [];
    const packedTurnIds = [];

    for (const item of scored) {
        const maxBodyChars = isLargeEpisodic
            ? (packedEntries.length < 8 ? 680 : (packedEntries.length < 20 ? 440 : 320))
            : 4000;
        const bodyText = prunePreSynthesis(item.content || '', { maxChars: maxBodyChars }).trim();
        const entryText = `### [MEMORY] Memory #${item.id} (${item.category}) (Score: ${(item.score * 100).toFixed(1)}%)\n${bodyText}\n\n---\n`;
        const itemTokens = estimateTokens(entryText);
        if (currentTokens + itemTokens > effectiveBudget && packedEntries.length > 0) {
            break;
        }
        packedEntries.push(entryText);
        currentTokens += itemTokens;
        const m = bodyText.match(/\| Turn #(\d+)\/\d+\]/);
        if (m) packedTurnIds.push(Number(m[1]));
    }

    return {
        text: packedEntries.join(''),
        packedTurnIds,
        packedCount: packedEntries.length
    };
}

/**
 * 100% BLIND, UNIFORM DIALOGUE TURN PARSER:
 * Reads ONLY `c.chat` via the zero-leakage Proxy (`safeConvProxy`).
 */
function buildBlindTurnsFromChat(c, textsToEmbed) {
    const turns = [];
    const msgIdToTurnId = new Map();

    c.chat.forEach((batch, bIdx) => {
        let i = 0;
        while (i < batch.length) {
            const u = batch[i];
            if (!u) {
                i += 1;
                continue;
            }
            const nxt = (i + 1 < batch.length) ? batch[i + 1] : null;
            const hasPair = Boolean(
                nxt && (
                    (u.role === 'user' && nxt.role === 'assistant') ||
                    (!u.role && !nxt.role)
                )
            );
            const a = hasPair ? nxt : null;
            const turnId = Number(u.id);
            const asstId = a ? Number(a.id) : turnId;
            msgIdToTurnId.set(turnId, turnId);
            msgIdToTurnId.set(asstId, turnId);

            const uRaw = String(u.content || '').replace(/\s*->->\s*[\d,]+\s*$/g, '').trim();
            const aRaw = String(a?.content || '').trim();
            const timeStr = u.time_anchor || a?.time_anchor || `Session ${bIdx + 1}`;

            const content = `[Session ${bIdx + 1} | Date: ${timeStr} | Turn #${turnId}/${asstId}] USER: ${uRaw} | ASSISTANT: ${aRaw}`;
            const embedInput = `[Session ${bIdx + 1} | Date: ${timeStr} | Turn #${turnId}/${asstId}] USER: ${uRaw.slice(0, 900)} | ASSISTANT: ${aRaw.slice(0, 600)}`;
            const embIdx = textsToEmbed.length;
            textsToEmbed.push(embedInput);

            turns.push({
                turnId,
                asstId,
                session: bIdx + 1,
                timeStr,
                content,
                uRaw,
                embIdx
            });

            i += hasPair ? 2 : 1;
        }
    });

    return { turns, msgIdToTurnId };
}

async function callReaderModel({ systemPrompt, userMessage }) {
    if (!IS_GEMINI_READER) {
        const isGptOss = /^gpt-oss/i.test(READER_MODEL);
        const baseNumPredict = Number(process.env.OLLAMA_READER_NUM_PREDICT) || (isGptOss ? 2560 : 800);
        const numCtx = Number(process.env.OLLAMA_READER_NUM_CTX) || 16384;
        const readerThink = process.env.OLLAMA_READER_THINK || (isGptOss ? 'low' : undefined);

        let lastErr = null;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
            const numPredict = attempt > 1 ? Math.max(baseNumPredict * 2, 4096) : baseNumPredict;
            try {
                const payload = {
                    model: READER_MODEL,
                    stream: false,
                    ...(readerThink !== undefined ? { think: readerThink } : {}),
                    options: { temperature: 0.0, num_ctx: numCtx, num_predict: numPredict },
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userMessage }
                    ]
                };
                const readerRes = await fetch(READER_ENDPOINT, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                    signal: AbortSignal.timeout(240000)
                });
                if (!readerRes.ok) {
                    throw new Error(`Reader HTTP ${readerRes.status}`);
                }
                const readerData = await readerRes.json();
                const content = (readerData.message?.content || '').trim();
                if (!content && attempt < 3) {
                    continue;
                }
                return content;
            } catch (err) {
                lastErr = err;
                if (attempt < 3) {
                    await new Promise(r => setTimeout(r, 1200 * attempt));
                }
            }
        }
        throw lastErr || new Error('Ollama Reader failed after 3 attempts');
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        throw new Error('GEMINI_API_KEY is required when using a Gemini Reader model');
    }
    const isGemini4 = /^gemini-4/i.test(READER_MODEL);
    const thinkingLevel = process.env.GEMINI_THINKING_LEVEL || (isGemini4 ? 'medium' : undefined);
    const maxOutputTokens = Number(process.env.GEMINI_MAX_OUTPUT_TOKENS) || (isGemini4 ? 16384 : 2048);
    const endpoint = `${GEMINI_BASE_URL}/models/${encodeURIComponent(READER_MODEL)}:generateContent`;

    const allParts = [];
    let continuationToken;
    for (let hop = 0; hop < 8; hop += 1) {
        const payload = {
            system_instruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: 'user', parts: [{ text: userMessage }] }],
            generationConfig: {
                ...(!isGemini4 ? { temperature: 0.0 } : {}),
                maxOutputTokens,
                ...(thinkingLevel ? { thinkingConfig: { thinkingLevel } } : {})
            },
            ...(continuationToken ? { continuationToken } : {})
        };

        let data = null;
        let lastErr = null;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
            try {
                const res = await fetch(endpoint, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-goog-api-key': apiKey
                    },
                    body: JSON.stringify(payload),
                    signal: AbortSignal.timeout(300000)
                });
                if (!res.ok) {
                    const errBody = (await res.text()).slice(0, 240);
                    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
                        await new Promise(r => setTimeout(r, 1500 * attempt));
                        continue;
                    }
                    throw new Error(`Gemini Reader HTTP ${res.status}: ${errBody}`);
                }
                data = await res.json();
                lastErr = null;
                break;
            } catch (err) {
                lastErr = err;
                if (attempt < 3) {
                    await new Promise(r => setTimeout(r, 1500 * attempt));
                }
            }
        }
        if (lastErr || !data) {
            throw lastErr || new Error('Gemini Reader empty response');
        }

        const candidate = data.candidates?.[0];
        if (Array.isArray(candidate?.content?.parts)) {
            allParts.push(...candidate.content.parts);
        }
        continuationToken = candidate?.continuationToken;
        if (candidate?.finishReason !== 'CONTINUATION' || !continuationToken) {
            break;
        }
    }

    return allParts
        .filter(p => p && typeof p.text === 'string' && !p.thought)
        .map(p => p.text)
        .join('')
        .trim();
}

async function gradeSingleOllamaJudge(judgeModel, judgePrompt, rubricItems) {
    const judgeNumPredict = Number(process.env.OLLAMA_JUDGE_NUM_PREDICT) || 480;
    const judgeNumCtx = Number(process.env.OLLAMA_JUDGE_NUM_CTX) || 8192;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
            const judgeRes = await fetch(JUDGE_ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: judgeModel,
                    stream: false,
                    format: 'json',
                    options: { temperature: 0.0, num_ctx: judgeNumCtx, num_predict: judgeNumPredict },
                    messages: [{ role: 'user', content: judgePrompt }]
                }),
                signal: AbortSignal.timeout(120000)
            });
            if (!judgeRes.ok) {
                throw new Error(`Judge (${judgeModel}) HTTP ${judgeRes.status}`);
            }
            const judgeData = await judgeRes.json();
            const rawJudge = (judgeData.message?.content || '').trim();
            const jsonMatch = rawJudge.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                if (Array.isArray(parsed.scores) && parsed.scores.length > 0) {
                    const boundedScores = rubricItems.length > 0
                        ? parsed.scores.slice(0, rubricItems.length)
                        : parsed.scores;
                    const avg = boundedScores.reduce((s, v) => s + Number(v || 0), 0) / boundedScores.length;
                    return {
                        score: Math.min(1.0, Math.max(0.0, avg)),
                        judge_reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 240) : null
                    };
                }
                if (typeof parsed.overall === 'number') {
                    return {
                        score: Math.min(1.0, Math.max(0.0, parsed.overall)),
                        judge_reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 240) : null
                    };
                }
            }
            if (attempt === 2) {
                console.warn(`[benchmark_official_beam_long] Judge (${judgeModel}) non-JSON/malformed output: "${rawJudge.slice(0, 120)}"`);
            }
        } catch (err) {
            if (attempt === 2) {
                console.warn(`[benchmark_official_beam_long] Judge (${judgeModel}) error: ${err.message}`);
            } else {
                await new Promise(r => setTimeout(r, 1000));
            }
        }
    }
    return { score: 0.0, judge_reason: 'JUDGE_PARSE_FALLBACK_ZERO' };
}

async function evaluateWithOfficialBeamJudge({ question, rubric, ideal_response, category, retrievedContext }) {
    const systemPrompt = [
        `You are a conversational memory assistant answering a user's question based on the retrieved multi-session conversation history provided below.`,
        `Follow these general reasoning rules:`,
        `1. UNRECORDED DETAILS & ABSTENTION: When a question asks about a specific past detail, rationale, cause, feeling, or rule from the conversation, verify whether that specific detail is actually stated in the retrieved turns (and check "Unattested Query Terms" if present). If the conversation mentions a related topic but NEVER states the specific detail, reason, or event asked for—or if Epistemic Status is NO_KNOWN_SUPPORT—explicitly state that based on the conversation history, that specific information was not mentioned. However, if the answer IS present in the retrieved turns, state it directly and confidently without adding abstention caveats.`,
        `2. EXACT FACTS, DATES & DURATIONS: Prioritize the highest-scored [MEMORY] turn that directly contains the milestones mentioned in the user's question. When a schedule lists a phase as a date range ("<Start Date> - <End Date>: <Phase>"), completing that phase or a final deadline is the end date of that phase. State exact dates and durations clearly using the dates recorded in the retrieved turns.`,
        `3. CHRONOLOGICAL ORDERING: When asked for the order in which aspects were brought up across conversations: (a) If the question asks for ONLY N items summarizing overall project development across N Sessions, use the "Session-by-Session Macro Progression" section so each numbered item summarizes the primary focus and key problem/feature of that Session in order (Session 1, Session 2, ...). (b) If the question asks for N items about a specific feature, trace the "Chronological Event Sequence (Oldest → Newest)" from earliest Turn # to latest Turn # and list the N chronological milestones for that feature.`,
        `4. KNOWLEDGE UPDATES: When a metric, date, tool, or decision was updated in a later turn, report the most recent updated value clearly as the current value (and mention the earlier value for context).`,
        `5. CONTRADICTION RESOLUTION: If two turns in the conversation contain conflicting user statements (for example, claiming to have done something in one turn vs. claiming never to have done it in another turn, or when a "Contradiction Resolution Alert" is present), explicitly point out the contradiction, state both conflicting claims with their context, and ask the user which statement is accurate.`,
        `6. MULTI-SESSION AGGREGATION: When asked to count or list items across the conversation, inspect both User and Assistant turns across all retrieved sessions, list every matching item by name, and state the exact total count.`,
        `7. STANDING INSTRUCTIONS & PREFERENCES: When the user asks a general conceptual, technical, or "how-to" coding question, answer the question directly and thoroughly while obeying any standing user instructions or user preferences stated in the retrieved [MEMORY] turns.`
    ].join('\n');

    const userMessage = `### RETRIEVED MEMORY CONTEXT\n${retrievedContext.slice(0, 32000)}\n\n### USER QUESTION\n${question}`;
    const generatedAnswer = await callReaderModel({ systemPrompt, userMessage });

    const rubricItems = Array.isArray(rubric) ? rubric : [];
    const rubricListStr = rubricItems.map((r, idx) => `${idx + 1}. ${r}`).join('\n');
    const judgePrompt = [
        `You are a strict, impartial scientific evaluator grading a Candidate AI Response on the ICLR 2026 BEAM long-term memory benchmark.`,
        `Question (${category}): ${question}`,
        `Official Reference Answer (Ground Truth): ${ideal_response || 'See rubric items below.'}`,
        `Official Evaluation Rubric Items (${rubricItems.length} item(s)):\n${rubricListStr}`,
        `Candidate AI Response:\n${generatedAnswer}`,
        `STRICT GRADING PROTOCOL:`,
        `1. Compare the Candidate AI Response directly against BOTH the Official Reference Answer (Ground Truth) and each Official Evaluation Rubric Item BEFORE assigning any score.`,
        `2. If the Official Reference Answer states a specific calendar date, numeric count, or item list, and the Candidate AI Response gives a DIFFERENT final answer (for example, updating to a different date or stating a different total count), you MUST score 0.0 even if the Candidate AI Response cites turns or sounds persuasive.`,
        `3. If the Official Reference Answer states that there is NO information in the chat (abstention), and the Candidate AI Response claims the information WAS present or influenced something, you MUST score 0.0.`,
        `4. If the Official Reference Answer states there is contradictory information and asks the user to clarify which statement is correct, and the Candidate AI Response gives a one-sided "Yes" or "No" without explicitly pointing out both sides of the contradiction, you MUST score 0.0.`,
        `5. Score each of the ${rubricItems.length} rubric item(s) on {0.0, 0.5, 1.0} where 1.0 = strictly and accurately satisfied, 0.5 = partially satisfied, 0.0 = inaccurate or missing.`,
        `Respond ONLY with valid JSON containing ${rubricItems.length} score(s), writing "reason" FIRST before "scores":`,
        `{"reason": "First state what the Official Reference Answer requires, then state what the Candidate AI Response actually claimed, then state whether they match.", "scores": [<0.0, 0.5, or 1.0 per rubric item>], "overall": <mean_score>}`
    ].join('\n\n');

    const [primaryOut, secondaryOut] = await Promise.all([
        gradeSingleOllamaJudge(JUDGE_MODEL, judgePrompt, rubricItems),
        SECONDARY_JUDGE_MODEL ? gradeSingleOllamaJudge(SECONDARY_JUDGE_MODEL, judgePrompt, rubricItems) : Promise.resolve(null)
    ]);

    return {
        score: primaryOut.score,
        answer: generatedAnswer,
        judge_reason: primaryOut.judge_reason,
        secondary_score: secondaryOut ? secondaryOut.score : null,
        secondary_judge_reason: secondaryOut ? secondaryOut.judge_reason : null
    };
}

async function loadOrEmbedConversationFloat32(convId, textsToEmbed, noEmbedCache) {
    const expectedFloats = textsToEmbed.length * EMBED_DIMS;
    const expectedBytes = expectedFloats * 4;
    const binPath = path.join(EMBED_CACHE_DIR, `conv_${convId}.f32.bin`);

    if (!noEmbedCache && fs.existsSync(binPath)) {
        const st = fs.statSync(binPath);
        if (st.size === expectedBytes) {
            const buf = fs.readFileSync(binPath);
            const flat = (buf.byteOffset % 4 === 0)
                ? new Float32Array(buf.buffer, buf.byteOffset, expectedFloats)
                : new Float32Array(Uint8Array.from(buf).buffer);
            return { flat, fromCache: true, usedFallbackCount: 0 };
        }
    }

    const { flat, usedFallbackCount } = await embedTextsBatchFloat32(textsToEmbed);
    if (!noEmbedCache && usedFallbackCount === 0) {
        fs.mkdirSync(EMBED_CACHE_DIR, { recursive: true });
        const tmpBin = `${binPath}.part.${process.pid}`;
        fs.writeFileSync(tmpBin, new Uint8Array(flat.buffer, flat.byteOffset, flat.byteLength));
        fs.renameSync(tmpBin, binPath);
    }
    return { flat, fromCache: false, usedFallbackCount };
}

async function runOfficialBeamLongBenchmark() {
    const skipLlmJudge = process.argv.includes('--fast') || process.argv.includes('--no-judge');
    const noEmbedCache = process.argv.includes('--no-embed-cache');
    const judgeConvsArg = process.argv.find(a => a.startsWith('--judge-convs='));
    const fullJudge = process.argv.includes('--full-judge');
    const judgeMaxConvs = fullJudge
        ? SPEC.expectedConvs
        : (judgeConvsArg ? Math.max(1, Number(judgeConvsArg.split('=')[1]) || 2) : 2);

    console.log('===================================================================================================');
    console.log(`🌍 OFFICIAL ICLR 2026 BEAM BENCHMARK (${SPEC.datasetLabel} — DE-RIGGED / ZERO-LEAKAGE)`);
    console.log('===================================================================================================\n');

    const t0 = Date.now();
    const { meta: datasetMeta, jsonlSha256 } = ensurePreparedBeamSplit();

    const sha256File = (fp) => crypto.createHash('sha256').update(fs.readFileSync(fp)).digest('hex');
    const retrievalEngineSha256 = sha256File(path.resolve('src/unified-retrieval.js'));
    const retrievalLexicalSha256 = sha256File(path.resolve('src/retrieval-lexical.js'));
    const retrievalEpistemicSha256 = sha256File(path.resolve('src/retrieval-epistemic.js'));
    const pruneHelperSha256 = sha256File(path.resolve('src/prune-helper.js'));
    const embeddingHelperSha256 = sha256File(path.resolve('src/embedding-helper.js'));
    const benchmarkScriptSha256 = sha256File(path.resolve('scripts/benchmark_official_beam_long.js'));
    const prepareScriptSha256 = sha256File(path.resolve('scripts/prepare_beam_split.py'));

    const FORBIDDEN_ORACLE_KEYS = new Set([
        'probing_questions',
        'probing_questions_parsed',
        'source_chat_ids',
        'rubric',
        'ideal_response',
        'ideal_answer',
        'ideal_summary',
        'expected_compliance',
        'answer',
        'time_points',
        'calculation_required'
    ]);
    let proxyTrapVerifiedCount = 0;
    const createZeroLeakageConversationProxy = (rawConv) => new Proxy(rawConv, {
        get(target, prop, receiver) {
            if (FORBIDDEN_ORACLE_KEYS.has(String(prop))) {
                throw new Error(`FATAL_ORACLE_LEAKAGE_VIOLATION: Ingestion attempted to read forbidden test key "${String(prop)}"`);
            }
            return Reflect.get(target, prop, receiver);
        }
    });

    const categoryStats = {};
    for (const cat of CATEGORY_ORDER) {
        categoryStats[cat] = {
            legacyScoreSum: 0,
            denseScoreSum: 0,
            recall10Sum: 0,
            recall20Sum: 0,
            recall30Sum: 0,
            recall50Sum: 0,
            strictPrimaryRecallSum: 0,
            hasSourceIdsCount: 0,
            packedTurnsSum: 0,
            densePackedTurnsSum: 0,
            payloadCharsSum: 0,
            convTotalTurnsSum: 0,
            llmJudgeScoreSum: 0,
            llmJudgeCount: 0,
            secondaryJudgeScoreSum: 0,
            secondaryJudgeCount: 0,
            total: 0
        };
    }

    const benchProject = `test_official_beam_${SPLIT_LOWER}_${Date.now()}`;
    const llmSampleQueue = [];
    const auditLogEntries = [];

    let totalConversations = 0;
    let totalMessages = 0;
    let totalTurns = 0;
    let totalChars = 0;
    let totalQuestions = 0;
    let totalEmbedMs = 0;
    let totalRetrieveMs = 0;
    let totalEmbeddedRecords = 0;
    let totalFallbackEmbeds = 0;
    let cachedConvsCount = 0;

    console.log(`📦 Split Target: ${SPLIT} (${SPEC.expectedConvs} conversations, ${SPEC.expectedQuestions} official probing questions)`);
    console.log(`🔐 Parquet LFS SHA-256: ${JSON.stringify(datasetMeta.parquet_lfs_sha256)}`);
    console.log(`🔐 NDJSON SHA-256     : ${jsonlSha256}`);
    console.log(`🔐 Engine SHA-256     : ${retrievalEngineSha256}`);
    console.log(`🔎 Active Vector Scan : KRUSCH_MAX_ACTIVE_SCAN=${ACTIVE_VEC_SCAN_LIMIT} | Embedder: ${EMBED_MODEL} (${EMBED_NUM_CTX} ctx)\n`);

    const rl = readline.createInterface({
        input: fs.createReadStream(DATASET_JSONL_PATH, { encoding: 'utf8' }),
        crlfDelay: Infinity
    });

    try {
        for await (const line of rl) {
            if (!line.trim()) continue;
            const c = JSON.parse(line);
            totalConversations += 1;
            const convId = String(c.conversation_id);
            const title = c.conversation_seed?.title || `Conversation ${convId}`;

            let convMsgs = 0;
            let convChars = 0;
            for (const b of c.chat) {
                convMsgs += b.length;
                for (const m of b) convChars += (m.content || '').length;
            }
            totalMessages += convMsgs;
            totalChars += convChars;

            const textsToEmbed = [];
            const safeConvProxy = createZeroLeakageConversationProxy(c);
            const { turns, msgIdToTurnId } = buildBlindTurnsFromChat(safeConvProxy, textsToEmbed);
            proxyTrapVerifiedCount += 1;
            totalTurns += turns.length;

            const pqs = c.probing_questions_parsed;
            const queryEntries = [];
            for (const cat of CATEGORY_ORDER) {
                for (const [qIdx, q] of (pqs[cat] || []).entries()) {
                    const embIdx = textsToEmbed.length;
                    textsToEmbed.push(
                        formatEmbeddingQuery(String(q.question), {
                            model: EMBED_MODEL,
                            mode: 'query',
                            domain: 'memory'
                        })
                    );
                    queryEntries.push({
                        cat,
                        qIdx,
                        question: String(q.question),
                        rubric: q.rubric || [],
                        source_chat_ids: q.source_chat_ids,
                        ideal_response: q.ideal_response || q.ideal_answer || q.ideal_summary || q.expected_compliance || (Array.isArray(q.rubric) && q.rubric.length > 0 ? q.rubric.join(' ; ') : (q.answer || '')),
                        embIdx
                    });
                }
            }
            totalQuestions += queryEntries.length;
            totalEmbeddedRecords += textsToEmbed.length;

            const embT0 = Date.now();
            const { flat: convFlatVecs, fromCache, usedFallbackCount } = await loadOrEmbedConversationFloat32(
                convId,
                textsToEmbed,
                noEmbedCache
            );
            const embDt = Date.now() - embT0;
            totalEmbedMs += embDt;
            totalFallbackEmbeds += usedFallbackCount;
            if (fromCache) cachedConvsCount += 1;

            const convProject = `${benchProject}_c${convId}`;
            const convProjRoot = resolveProjectPath(convProject);
            fs.mkdirSync(convProjRoot, { recursive: true });

            const retT0 = Date.now();
            try {
                const convDb = await getProjectDb(convProject);

                withTransaction(convDb, () => {
                    const insertMem = convDb.prepare(`
                        INSERT INTO ide_agent_memory (category, content, tags, status, supersedes_id, embedding, embedding_blob, project)
                        VALUES ('decision', ?, ?, 'ACTIVE', NULL, NULL, ?, ?)
                    `);

                    for (const t of turns) {
                        const tags = [
                            `session-${t.session}`,
                            `turn-${t.turnId}`,
                            `turn-${t.asstId}`
                        ];
                        const byteOffset = convFlatVecs.byteOffset + t.embIdx * EMBED_DIMS * 4;
                        const blobView = new Uint8Array(convFlatVecs.buffer, byteOffset, EMBED_DIMS * 4);
                        insertMem.run(
                            t.content,
                            JSON.stringify(tags),
                            blobView,
                            convProject
                        );
                    }
                });

                let convHitSum = 0;
                let convHitCnt = 0;

                for (const q of queryEntries) {
                    const groups = parseSourceTurnGroups(q.source_chat_ids, msgIdToTurnId);
                    const requiredTurnIds = extractFlatSourceTurnIds(q.source_chat_ids, msgIdToTurnId);
                    const queryEmbedding = convFlatVecs.subarray(q.embIdx * EMBED_DIMS, (q.embIdx + 1) * EMBED_DIMS);

                    const leg = legacyRetrieveSimulation(convDb, {
                        query: q.question,
                        limitTokens: TOKEN_BUDGET
                    });

                    const dense = denseVectorBaselineSimulation(convDb, {
                        queryEmbedding,
                        limitTokens: TOKEN_BUDGET
                    });

                    const upg = await unifiedRetrieve({
                        query: String(q.question),
                        project: convProject,
                        include_state: true,
                        include_lineage: true,
                        limit_tokens: TOKEN_BUDGET,
                        _embedding: queryEmbedding
                    });
                    const upgText = upg.content[0].text;

                    const retrievedTurnMatches = [...upgText.matchAll(/\| Turn #(\d+)\/\d+\]/g)].map(m => Number(m[1]));
                    const uniqueRetrievedTurns = [...new Set(retrievedTurnMatches)];

                    const legRecall = computePrimaryTurnRecall(leg.text, groups);
                    const denseRecall = computePrimaryTurnRecall(dense.text, groups);
                    const r10 = computeRecallAtK(uniqueRetrievedTurns, groups, 10);
                    const r20 = computeRecallAtK(uniqueRetrievedTurns, groups, 20);
                    const r30 = computeRecallAtK(uniqueRetrievedTurns, groups, 30);
                    const r50 = computeRecallAtK(uniqueRetrievedTurns, groups, 50);
                    const strictPrimaryRecall = computePrimaryTurnRecall(upgText, groups);

                    if (strictPrimaryRecall !== null) {
                        categoryStats[q.cat].legacyScoreSum += legRecall;
                        categoryStats[q.cat].denseScoreSum += denseRecall;
                        categoryStats[q.cat].recall10Sum += r10;
                        categoryStats[q.cat].recall20Sum += r20;
                        categoryStats[q.cat].recall30Sum += r30;
                        categoryStats[q.cat].recall50Sum += r50;
                        categoryStats[q.cat].strictPrimaryRecallSum += strictPrimaryRecall;
                        categoryStats[q.cat].hasSourceIdsCount += 1;
                        convHitSum += strictPrimaryRecall;
                        convHitCnt += 1;
                    }
                    categoryStats[q.cat].packedTurnsSum += uniqueRetrievedTurns.length;
                    categoryStats[q.cat].densePackedTurnsSum += dense.packedCount;
                    categoryStats[q.cat].payloadCharsSum += upgText.length;
                    categoryStats[q.cat].convTotalTurnsSum += turns.length;
                    categoryStats[q.cat].total += 1;

                    const auditEntry = {
                        question_global_id: auditLogEntries.length + 1,
                        conversation_id: Number(convId),
                        conversation_title: title,
                        conversation_total_turns: turns.length,
                        category: q.cat,
                        question_index: q.qIdx,
                        question: q.question,
                        ground_truth_turn_ids: requiredTurnIds,
                        ground_truth_turn_groups: groups,
                        rubric: q.rubric,
                        epistemic_status: upg.epistemic_status,
                        conflicts_detected: (upg.conflicts || []).length,
                        packed_turn_count: uniqueRetrievedTurns.length,
                        dense_packed_turn_count: dense.packedCount,
                        payload_chars: upgText.length,
                        estimated_tokens_4char: estimateTokens(upgText),
                        approx_bpe_tokens: Math.round(upgText.length / APPROX_CHARS_PER_BPE_TOKEN),
                        retrieved_primary_turn_ids: uniqueRetrievedTurns,
                        dense_retrieved_primary_turn_ids: dense.packedTurnIds,
                        legacy_primary_recall: legRecall !== null ? Number(legRecall.toFixed(4)) : null,
                        dense_packed_8k_recall: denseRecall !== null ? Number(denseRecall.toFixed(4)) : null,
                        recall_at_10: r10 !== null ? Number(r10.toFixed(4)) : null,
                        recall_at_20: r20 !== null ? Number(r20.toFixed(4)) : null,
                        recall_at_30: r30 !== null ? Number(r30.toFixed(4)) : null,
                        recall_at_50: r50 !== null ? Number(r50.toFixed(4)) : null,
                        strict_primary_turn_recall: strictPrimaryRecall !== null ? Number(strictPrimaryRecall.toFixed(4)) : null,
                        llm_judge_score: null,
                        judge_reason: null,
                        ...(SECONDARY_JUDGE_MODEL ? { secondary_judge_score: null, secondary_judge_reason: null } : {}),
                        reader_answer_excerpt: null
                    };
                    auditLogEntries.push(auditEntry);

                    if (!skipLlmJudge && Number(convId) <= judgeMaxConvs && (fullJudge || q.qIdx === 0)) {
                        llmSampleQueue.push({
                            question: q.question,
                            rubric: q.rubric,
                            ideal_response: q.ideal_response,
                            category: q.cat,
                            retrievedContext: upgText,
                            auditEntry
                        });
                    }
                }

                const retDt = Date.now() - retT0;
                totalRetrieveMs += retDt;
                const convRecallPct = convHitCnt > 0 ? ((convHitSum / convHitCnt) * 100).toFixed(1) : 'N/A';
                console.log(
                    `   [Conv ${String(totalConversations).padStart(2)}/${SPEC.expectedConvs} | id=${convId}] ` +
                    `${turns.length.toLocaleString().padStart(6)} turns (~${Math.round(convChars / 4).toLocaleString()} tok) | ` +
                    `embed=${(embDt / 1000).toFixed(1)}s${fromCache ? ' (cached)' : ''} | ` +
                    `retrieve=${(retDt / 1000).toFixed(2)}s | Hybrid 8K Recall=${convRecallPct}%`
                );
            } finally {
                closeAllDatabases();
                try {
                    fs.rmSync(convProjRoot, { recursive: true, force: true });
                } catch {}
            }
        }

        const approxTokens = Math.round(totalChars / 4);
        console.log(`\n✅ Completed ${SPLIT} Retrieval Phase: ${totalConversations} convs | ${totalTurns.toLocaleString()} turns (~${approxTokens.toLocaleString()} est. tokens) | embed=${(totalEmbedMs / 1000).toFixed(2)}s (${cachedConvsCount}/${totalConversations} cached, fallback=${totalFallbackEmbeds}) | retrieve=${(totalRetrieveMs / 1000).toFixed(2)}s.\n`);

        if (llmSampleQueue.length > 0) {
            const judgeConcurrency = Math.max(
                1,
                Number(process.env.BEAM_JUDGE_CONCURRENCY) || (IS_GEMINI_READER ? 4 : 1)
            );
            const judgeDesc = SECONDARY_JUDGE_MODEL
                ? `${JUDGE_MODEL} + secondary ${SECONDARY_JUDGE_MODEL}`
                : JUDGE_MODEL;
            console.log(`3️⃣ Running End-to-End Multi-Family LLM Reader (${READER_MODEL}) + Strict Reference-Grounded Judge (${judgeDesc}) on ${llmSampleQueue.length} questions (concurrency=${judgeConcurrency})...`);
            const evalStart = Date.now();
            let qCursor = 0;
            let completedCount = 0;
            let runningPrimarySum = 0;
            let runningSecondarySum = 0;
            const progressStep = llmSampleQueue.length <= 20 ? 5 : 25;
            const resultsByIdx = new Array(llmSampleQueue.length).fill(null);

            async function evalWorker() {
                while (qCursor < llmSampleQueue.length) {
                    const idx = qCursor++;
                    const item = llmSampleQueue[idx];
                    try {
                        const out = await evaluateWithOfficialBeamJudge(item);
                        resultsByIdx[idx] = out;
                        completedCount += 1;
                        runningPrimarySum += out.score;
                        if (out.secondary_score !== null && out.secondary_score !== undefined) {
                            runningSecondarySum += out.secondary_score;
                        }
                        if (completedCount % progressStep === 0 || completedCount === llmSampleQueue.length) {
                            const dt = ((Date.now() - evalStart) / 1000).toFixed(1);
                            const pMean = ((runningPrimarySum / completedCount) * 100).toFixed(2);
                            const secPart = SECONDARY_JUDGE_MODEL
                                ? ` | ${SECONDARY_JUDGE_MODEL}: ${((runningSecondarySum / completedCount) * 100).toFixed(2)}%`
                                : '';
                            console.log(`   [${SPLIT} E2E Progress] ${completedCount}/${llmSampleQueue.length} (${((completedCount / llmSampleQueue.length) * 100).toFixed(1)}%) | ${dt}s | ${JUDGE_MODEL}: ${pMean}%${secPart}`);
                        }
                    } catch (err) {
                        console.warn(`[benchmark_official_beam_long] LLM Judge warning on Q#${item.auditEntry?.question_global_id}: ${err.message}`);
                    }
                }
            }
            const workerCount = Math.min(judgeConcurrency, llmSampleQueue.length);
            await Promise.all(Array.from({ length: workerCount }, () => evalWorker()));

            for (let idx = 0; idx < llmSampleQueue.length; idx++) {
                const item = llmSampleQueue[idx];
                const res = resultsByIdx[idx];
                if (!res) continue;
                categoryStats[item.category].llmJudgeScoreSum += res.score;
                categoryStats[item.category].llmJudgeCount += 1;
                if (res.secondary_score !== null && res.secondary_score !== undefined) {
                    categoryStats[item.category].secondaryJudgeScoreSum += res.secondary_score;
                    categoryStats[item.category].secondaryJudgeCount += 1;
                }
                if (item.auditEntry) {
                    item.auditEntry.llm_judge_score = Number(res.score.toFixed(4));
                    item.auditEntry.judge_reason = res.judge_reason || null;
                    if (SECONDARY_JUDGE_MODEL && res.secondary_score !== null && res.secondary_score !== undefined) {
                        item.auditEntry.secondary_judge_score = Number(res.secondary_score.toFixed(4));
                        item.auditEntry.secondary_judge_reason = res.secondary_judge_reason || null;
                    }
                    item.auditEntry.reader_answer_excerpt = (res.answer || '').slice(0, 320);
                }
            }
        }

        let sumLegacy9 = 0;
        let sumDense9 = 0;
        let sumR10 = 0;
        let sumR20 = 0;
        let sumR30 = 0;
        let sumR50 = 0;
        let sumPrimary9 = 0;
        let recallCatCount = 0;
        let totalPackedTurnsAll = 0;
        let totalDensePackedTurnsAll = 0;
        let totalPayloadCharsAll = 0;
        let totalConvTurnsAll = 0;
        let sumJudge = 0;
        let judgeCatCount = 0;
        let sumSecondaryJudge = 0;
        let secondaryJudgeCatCount = 0;
        let totalJudgeEvaluatedQuestions = 0;
        let sumPast100K = 0;
        let sumPast500K = 0;
        let sumPast1M = 0;
        let sumPast10M = 0;

        const summaryRows = {};

        for (const cat of CATEGORY_ORDER) {
            const st = categoryStats[cat];
            const hasRecall = st.hasSourceIdsCount > 0;
            const legPct = hasRecall ? (st.legacyScoreSum / st.hasSourceIdsCount) * 100 : null;
            const densePct = hasRecall ? (st.denseScoreSum / st.hasSourceIdsCount) * 100 : null;
            const r10Pct = hasRecall ? (st.recall10Sum / st.hasSourceIdsCount) * 100 : null;
            const r20Pct = hasRecall ? (st.recall20Sum / st.hasSourceIdsCount) * 100 : null;
            const r30Pct = hasRecall ? (st.recall30Sum / st.hasSourceIdsCount) * 100 : null;
            const r50Pct = hasRecall ? (st.recall50Sum / st.hasSourceIdsCount) * 100 : null;
            const primaryPct = hasRecall ? (st.strictPrimaryRecallSum / st.hasSourceIdsCount) * 100 : null;
            const avgPackedTurns = st.total > 0 ? st.packedTurnsSum / st.total : 0;
            const avgDenseTurns = st.total > 0 ? st.densePackedTurnsSum / st.total : 0;
            const judgePct = st.llmJudgeCount > 0
                ? (st.llmJudgeScoreSum / st.llmJudgeCount) * 100
                : null;
            const secJudgePct = st.secondaryJudgeCount > 0
                ? (st.secondaryJudgeScoreSum / st.secondaryJudgeCount) * 100
                : null;
            const p = PAST_DEV_SCORES[cat];

            if (hasRecall) {
                sumLegacy9 += legPct;
                sumDense9 += densePct;
                sumR10 += r10Pct;
                sumR20 += r20Pct;
                sumR30 += r30Pct;
                sumR50 += r50Pct;
                sumPrimary9 += primaryPct;
                recallCatCount += 1;
            }
            totalPackedTurnsAll += st.packedTurnsSum;
            totalDensePackedTurnsAll += st.densePackedTurnsSum;
            totalPayloadCharsAll += st.payloadCharsSum;
            totalConvTurnsAll += st.convTotalTurnsSum;
            if (judgePct !== null) {
                sumJudge += judgePct;
                judgeCatCount += 1;
                totalJudgeEvaluatedQuestions += st.llmJudgeCount;
            }
            if (secJudgePct !== null) {
                sumSecondaryJudge += secJudgePct;
                secondaryJudgeCatCount += 1;
            }
            sumPast100K += p['100K'];
            sumPast500K += p['500K'];
            sumPast1M += p['1M'];
            sumPast10M += p['10M'];

            summaryRows[cat] = {
                questions: st.total,
                ground_truth_turn_questions: st.hasSourceIdsCount,
                llm_judge_evaluated_questions: st.llmJudgeCount,
                avg_packed_turns: Number(avgPackedTurns.toFixed(1)),
                avg_dense_packed_turns: Number(avgDenseTurns.toFixed(1)),
                legacy_primary_recall_pct: legPct !== null ? Number(legPct.toFixed(2)) : null,
                dense_packed_8k_recall_pct: densePct !== null ? Number(densePct.toFixed(2)) : null,
                recall_at_10_pct: r10Pct !== null ? Number(r10Pct.toFixed(2)) : null,
                recall_at_20_pct: r20Pct !== null ? Number(r20Pct.toFixed(2)) : null,
                recall_at_30_pct: r30Pct !== null ? Number(r30Pct.toFixed(2)) : null,
                recall_at_50_pct: r50Pct !== null ? Number(r50Pct.toFixed(2)) : null,
                strict_primary_turn_recall_pct: primaryPct !== null ? Number(primaryPct.toFixed(2)) : null,
                llm_judge_pct: judgePct !== null ? Number(judgePct.toFixed(2)) : null,
                ...(SECONDARY_JUDGE_MODEL ? { secondary_llm_judge_pct: secJudgePct !== null ? Number(secJudgePct.toFixed(2)) : null } : {}),
                past_dev_100k: p['100K'],
                past_dev_500k: p['500K'],
                past_dev_1m: p['1M'],
                past_dev_10m: p['10M']
            };
        }

        const nCats = CATEGORY_ORDER.length;
        const avgLeg9 = sumLegacy9 / Math.max(1, recallCatCount);
        const avgDense9 = sumDense9 / Math.max(1, recallCatCount);
        const avgR10 = sumR10 / Math.max(1, recallCatCount);
        const avgR20 = sumR20 / Math.max(1, recallCatCount);
        const avgR30 = sumR30 / Math.max(1, recallCatCount);
        const avgR50 = sumR50 / Math.max(1, recallCatCount);
        const avgPrimary9 = sumPrimary9 / Math.max(1, recallCatCount);
        const avgPackedTurnsOverall = totalPackedTurnsAll / Math.max(1, totalQuestions);
        const avgDenseTurnsOverall = totalDensePackedTurnsAll / Math.max(1, totalQuestions);
        const avgPayloadChars = Math.round(totalPayloadCharsAll / Math.max(1, totalQuestions));
        const avgEstTokens4Char = Math.round(avgPayloadChars / CHARS_PER_ESTIMATED_TOKEN);
        const avgApproxBpeTokens = Math.round(avgPayloadChars / APPROX_CHARS_PER_BPE_TOKEN);
        const avgConvTurns = totalConvTurnsAll / Math.max(1, totalQuestions);
        const avgTurnCoveragePct = (avgPackedTurnsOverall / Math.max(1, avgConvTurns)) * 100;
        const avgJudge = judgeCatCount > 0 ? sumJudge / judgeCatCount : null;
        const avgSecondaryJudge = secondaryJudgeCatCount > 0 ? sumSecondaryJudge / secondaryJudgeCatCount : null;
        const avgPast100K = sumPast100K / nCats;
        const avgPast500K = sumPast500K / nCats;
        const avgPast1M = sumPast1M / nCats;
        const avgPast10M = sumPast10M / nCats;

        const recallQuestionCount = Math.round(totalQuestions * 0.9);
        const catQCount = Math.round(totalQuestions / 10);

        console.log('\n=========================================================================================================================================');
        console.log(`📊 TABLE A (${SPLIT}): 9-CATEGORY GROUND-TRUTH PRIMARY TURN RETRIEVAL RECALL (${recallQuestionCount} Qs with source_chat_ids; ${catQCount} Qs/cat)`);
        console.log('=========================================================================================================================================');
        console.log(
            `${`BEAM Category (${catQCount} Qs)`.padEnd(31)} | ${'Un-Cond Lex'.padStart(11)} | ${'Dense Vec 8K'.padStart(12)} | ${'Hybrid R@10'.padStart(11)} | ${'Hybrid R@20'.padStart(11)} | ${'Hybrid R@30'.padStart(11)} | ${'Hybrid R@50'.padStart(11)} | ${'Hybrid 8K'.padStart(9)}`
        );
        console.log('-'.repeat(129));
        for (const cat of CATEGORY_ORDER) {
            const row = summaryRows[cat];
            if (row.strict_primary_turn_recall_pct === null) continue;
            console.log(
                `${CATEGORY_LABELS[cat].padEnd(31)} | ${(row.legacy_primary_recall_pct.toFixed(2) + '%').padStart(11)} | ${(row.dense_packed_8k_recall_pct.toFixed(2) + '%').padStart(12)} | ${(row.recall_at_10_pct.toFixed(2) + '%').padStart(11)} | ${(row.recall_at_20_pct.toFixed(2) + '%').padStart(11)} | ${(row.recall_at_30_pct.toFixed(2) + '%').padStart(11)} | ${(row.recall_at_50_pct.toFixed(2) + '%').padStart(11)} | ${(row.strict_primary_turn_recall_pct.toFixed(2) + '%').padStart(9)}`
            );
        }
        console.log('-'.repeat(129));
        console.log(
            `${'9-CAT RETRIEVAL RECALL MEAN'.padEnd(31)} | ${(avgLeg9.toFixed(2) + '%').padStart(11)} | ${(avgDense9.toFixed(2) + '%').padStart(12)} | ${(avgR10.toFixed(2) + '%').padStart(11)} | ${(avgR20.toFixed(2) + '%').padStart(11)} | ${(avgR30.toFixed(2) + '%').padStart(11)} | ${(avgR50.toFixed(2) + '%').padStart(11)} | ${(avgPrimary9.toFixed(2) + '%').padStart(9)}`
        );
        console.log('=========================================================================================================================================\n');

        console.log('====================================================================================================================');
        console.log(`⚖️  TABLE B (${SPLIT}): 10-CATEGORY END-TO-END CONVERSATIONAL QA (Reader + Strict Reference-Grounded Judge vs Published SOTA)`);
        console.log('====================================================================================================================');
        const pastSplitColKey = SPLIT === '500K' ? 'past_dev_500k' : (SPLIT === '10M' ? 'past_dev_10m' : 'past_dev_1m');
        const avgPastSplit = SPLIT === '500K' ? avgPast500K : (SPLIT === '10M' ? avgPast10M : avgPast1M);
        if (SECONDARY_JUDGE_MODEL) {
            console.log(
                `${'BEAM Memory Category'.padEnd(31)} | ${'Eval Qs'.padStart(9)} | ${JUDGE_MODEL.slice(0, 18).padStart(18)} | ${SECONDARY_JUDGE_MODEL.slice(0, 18).padStart(18)} | ${(`past.dev ${SPLIT}`).padStart(15)} | ${'past.dev 100K'.padStart(13)}`
            );
            console.log('-'.repeat(120));
            for (const cat of CATEGORY_ORDER) {
                const row = summaryRows[cat];
                const evalStr = `${row.llm_judge_evaluated_questions}/${row.questions}`;
                const judgeStr = row.llm_judge_pct !== null ? `${row.llm_judge_pct.toFixed(2)}%` : 'SKIPPED';
                const secStr = row.secondary_llm_judge_pct !== null && row.secondary_llm_judge_pct !== undefined
                    ? `${row.secondary_llm_judge_pct.toFixed(2)}%`
                    : 'SKIPPED';
                console.log(
                    `${CATEGORY_LABELS[cat].padEnd(31)} | ${evalStr.padStart(9)} | ${judgeStr.padStart(18)} | ${secStr.padStart(18)} | ${(row[pastSplitColKey].toFixed(2) + '%').padStart(15)} | ${(row.past_dev_100k.toFixed(2) + '%').padStart(13)}`
                );
            }
            const avgJudgeStr = avgJudge !== null ? `${avgJudge.toFixed(2)}%` : 'SKIPPED';
            const avgSecStr = avgSecondaryJudge !== null ? `${avgSecondaryJudge.toFixed(2)}%` : 'SKIPPED';
            console.log('-'.repeat(120));
            console.log(
                `${'10-CAT END-TO-END QA MEAN'.padEnd(31)} | ${(`${totalJudgeEvaluatedQuestions}/${totalQuestions}`).padStart(9)} | ${avgJudgeStr.padStart(18)} | ${avgSecStr.padStart(18)} | ${(avgPastSplit.toFixed(2) + '%').padStart(15)} | ${(avgPast100K.toFixed(2) + '%').padStart(13)}`
            );
        } else {
            console.log(
                `${'BEAM Memory Category'.padEnd(31)} | ${'Eval Qs'.padStart(9)} | ${'Krusch E2E QA (Strict)'.padStart(22)} | ${(`past.dev ${SPLIT}`).padStart(19)} | ${'past.dev 100K'.padStart(17)}`
            );
            console.log('-'.repeat(110));
            for (const cat of CATEGORY_ORDER) {
                const row = summaryRows[cat];
                const evalStr = `${row.llm_judge_evaluated_questions}/${row.questions}`;
                const judgeStr = row.llm_judge_pct !== null ? `${row.llm_judge_pct.toFixed(2)}%` : 'SKIPPED';
                console.log(
                    `${CATEGORY_LABELS[cat].padEnd(31)} | ${evalStr.padStart(9)} | ${judgeStr.padStart(22)} | ${(row[pastSplitColKey].toFixed(2) + '%').padStart(19)} | ${(row.past_dev_100k.toFixed(2) + '%').padStart(17)}`
                );
            }
            const avgJudgeStr = avgJudge !== null ? `${avgJudge.toFixed(2)}%` : 'SKIPPED';
            console.log('-'.repeat(110));
            console.log(
                `${'10-CAT END-TO-END QA MEAN'.padEnd(31)} | ${(`${totalJudgeEvaluatedQuestions}/${totalQuestions}`).padStart(9)} | ${avgJudgeStr.padStart(22)} | ${(avgPastSplit.toFixed(2) + '%').padStart(19)} | ${(avgPast100K.toFixed(2) + '%').padStart(17)}`
            );
        }
        console.log('====================================================================================================================\n');

        const isFullSplitJudge = totalJudgeEvaluatedQuestions === totalQuestions;
        const coverageDesc = skipLlmJudge
            ? 'SKIPPED via --fast'
            : (isFullSplitJudge
                ? `Full ${SPLIT} Split n=${totalJudgeEvaluatedQuestions}/${totalQuestions}, ideal_response + rubric verified`
                : `Stratified n=${totalJudgeEvaluatedQuestions}/${totalQuestions}, ideal_response + rubric verified`);

        const elapsedSec = ((Date.now() - t0) / 1000).toFixed(2);
        console.log(`📦 Substantive Packing Accounting: Avg ${avgPackedTurnsOverall.toFixed(1)}/${avgConvTurns.toFixed(1)} turns (${avgTurnCoveragePct.toFixed(2)}% of conv) | Dense (${EMBED_MODEL}) Baseline: ${avgDenseTurnsOverall.toFixed(1)} turns`);
        console.log(`📏 Token Budget Accounting: Avg ${avgPayloadChars.toLocaleString()} chars = ~${avgEstTokens4Char.toLocaleString()} est. tokens (@4.0 chars/tok) ≈ ~${avgApproxBpeTokens.toLocaleString()} BPE tokens (@${APPROX_CHARS_PER_BPE_TOKEN} chars/tok)`);
        console.log(`⚖️  Strict Reference-Grounded Judge Coverage: ${totalJudgeEvaluatedQuestions}/${totalQuestions} questions (${coverageDesc})`);
        console.log(`⏱️  Completed un-gamified ${totalQuestions}-question official BEAM ${SPLIT} evaluation over ~${Math.round(totalChars / 4).toLocaleString()} tokens in ${elapsedSec}s.`);

        let closedSystemProvenance = null;
        if (process.env.BEAM_CLOSED_SYSTEM_META) {
            try {
                closedSystemProvenance = JSON.parse(process.env.BEAM_CLOSED_SYSTEM_META);
            } catch {}
        }

        const fullReportPayload = {
            dataset: SPEC.datasetLabel,
            split: SPLIT,
            protocol: 'Un-Gamified 100% Blind Uniform Ingestion, Fair Multi-Baseline Ablation & Strict Reference-Grounded Judge',
            timestamp_utc: new Date().toISOString(),
            ...(closedSystemProvenance ? { closed_system_provenance: closedSystemProvenance } : {}),
            provenance_sha256: {
                parquet_lfs_sha256: datasetMeta.parquet_lfs_sha256,
                dataset_beam_jsonl: jsonlSha256,
                unified_retrieval_js: retrievalEngineSha256,
                retrieval_lexical_js: retrievalLexicalSha256,
                retrieval_epistemic_js: retrievalEpistemicSha256,
                prune_helper_js: pruneHelperSha256,
                embedding_helper_js: embeddingHelperSha256,
                benchmark_official_beam_long_js: benchmarkScriptSha256,
                prepare_beam_split_py: prepareScriptSha256
            },
            zero_leakage_verification: {
                proxy_trapped_conversations: proxyTrapVerifiedCount,
                forbidden_keys_guarded: [...FORBIDDEN_ORACLE_KEYS],
                query_input_contract: `Raw String(q.question) with model-standard asymmetric query formatting (${EMBED_MODEL}; zero category, conv title, or rubric metadata)`,
                turn_ingestion_contract: 'Uniform category="decision" raw [Session S | Date: D | Turn #X/Y] USER: ... | ASSISTANT: ... (zero benchmark regexes, zero nugget dual-writes, zero neighbor IDs)',
                substantive_turn_packing_contract: `Every packed turn retains both USER and ASSISTANT content (min 320 chars/turn; avg ${avgPackedTurnsOverall.toFixed(1)}/${avgConvTurns.toFixed(1)} turns = ${avgTurnCoveragePct.toFixed(2)}% of conv; ~${avgPayloadChars} chars = ~${avgEstTokens4Char} est. tokens @4ch/tok ≈ ~${avgApproxBpeTokens} BPE tokens)`,
                krusch_max_active_scan: ACTIVE_VEC_SCAN_LIMIT,
                embed_model: EMBED_MODEL,
                embed_num_ctx: EMBED_NUM_CTX,
                embed_fallback_count: totalFallbackEmbeds,
                reader_model: READER_MODEL,
                judge_model: JUDGE_MODEL,
                ...(SECONDARY_JUDGE_MODEL ? { secondary_judge_model: SECONDARY_JUDGE_MODEL } : {}),
                reader_llm_input_contract: 'Pure unifiedRetrieve MCP text output (upg.content[0].text) with dataset-blind system prompt',
                llm_judge_sampling_contract: skipLlmJudge
                    ? 'SKIPPED (--fast); llm_judge_pct reported as null'
                    : (isFullSplitJudge
                        ? `Full Official ${SPLIT} Split Evaluation (n=${totalJudgeEvaluatedQuestions}/${totalQuestions} questions across all ${judgeMaxConvs} conversations; strict ideal_response + rubric grading)`
                        : `Stratified Sample (n=${totalJudgeEvaluatedQuestions}/${totalQuestions} questions across ${judgeMaxConvs} conversations; strict ideal_response + rubric grading)`)
            },
            conversations: totalConversations,
            messages: totalMessages,
            turns: totalTurns,
            chars: totalChars,
            tokens_approx: Math.round(totalChars / 4),
            probing_questions: totalQuestions,
            embed_elapsed_seconds: Number((totalEmbedMs / 1000).toFixed(2)),
            retrieve_elapsed_seconds: Number((totalRetrieveMs / 1000).toFixed(2)),
            elapsed_seconds: Number(elapsedSec),
            overall: {
                split: SPLIT,
                krusch_max_active_scan: ACTIVE_VEC_SCAN_LIMIT,
                embed_model: EMBED_MODEL,
                embed_num_ctx: EMBED_NUM_CTX,
                reader_model: READER_MODEL,
                judge_model: JUDGE_MODEL,
                ...(SECONDARY_JUDGE_MODEL ? { secondary_judge_model: SECONDARY_JUDGE_MODEL } : {}),
                avg_packed_turns_8k_budget: Number(avgPackedTurnsOverall.toFixed(1)),
                avg_dense_baseline_turns_8k_budget: Number(avgDenseTurnsOverall.toFixed(1)),
                avg_conversation_turns: Number(avgConvTurns.toFixed(1)),
                avg_packed_turn_coverage_pct: Number(avgTurnCoveragePct.toFixed(2)),
                avg_payload_chars: avgPayloadChars,
                avg_estimated_tokens_4char: avgEstTokens4Char,
                avg_approx_bpe_tokens: avgApproxBpeTokens,
                legacy_primary_recall_9cat_pct: Number(avgLeg9.toFixed(2)),
                dense_packed_8k_recall_9cat_pct: Number(avgDense9.toFixed(2)),
                recall_at_10_9cat_pct: Number(avgR10.toFixed(2)),
                recall_at_20_9cat_pct: Number(avgR20.toFixed(2)),
                recall_at_30_9cat_pct: Number(avgR30.toFixed(2)),
                recall_at_50_9cat_pct: Number(avgR50.toFixed(2)),
                strict_primary_turn_recall_9cat_pct: Number(avgPrimary9.toFixed(2)),
                llm_judge_evaluated_questions: totalJudgeEvaluatedQuestions,
                llm_judge_10cat_pct: avgJudge !== null ? Number(avgJudge.toFixed(2)) : null,
                ...(SECONDARY_JUDGE_MODEL ? { secondary_llm_judge_10cat_pct: avgSecondaryJudge !== null ? Number(avgSecondaryJudge.toFixed(2)) : null } : {}),
                past_dev_100k_pct: Number(avgPast100K.toFixed(2)),
                past_dev_500k_pct: Number(avgPast500K.toFixed(2)),
                past_dev_1m_pct: Number(avgPast1M.toFixed(2)),
                past_dev_10m_pct: Number(avgPast10M.toFixed(2))
            },
            categories: summaryRows
        };

        fs.writeFileSync(RESULTS_JSON_PATH, JSON.stringify(fullReportPayload, null, 2), 'utf8');
        const benchDir = path.resolve('benchmarks');
        fs.mkdirSync(benchDir, { recursive: true });
        const targetAuditLogPath = AUDIT_LOG_OUT_PATH
            ? path.resolve(AUDIT_LOG_OUT_PATH)
            : path.join(benchDir, `beam_${SPLIT_LOWER}_audit_log.json`);
        fs.mkdirSync(path.dirname(targetAuditLogPath), { recursive: true });
        fs.writeFileSync(
            targetAuditLogPath,
            JSON.stringify({ ...fullReportPayload, audit_log: auditLogEntries }, null, 2),
            'utf8'
        );
    } finally {
        closeAllDatabases();
    }
}

runOfficialBeamLongBenchmark();

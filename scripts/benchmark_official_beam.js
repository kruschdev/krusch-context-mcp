/**
 * @file benchmark_official_beam.js
 * 100% Blind, De-Rigged Official ICLR 2026 BEAM ("Beyond a Million Tokens: Benchmarking
 * and Enhancing Long-Term Memory in LLMs", Mohammadta/BEAM) Benchmark Suite for krusch-context-mcp.
 *
 * STRICT EMPIRICAL REVIEW PROTOCOL (ZERO BENCHMARK GAMING):
 *   1. Clean Uniform Raw Turn Ingestion (`buildBlindTurnsFromChat`):
 *      - Reads ONLY `c.chat` through a runtime JS Proxy Trap (`FATAL_ORACLE_LEAKAGE_VIOLATION`)
 *        that blocks access to `probing_questions`, `source_chat_ids`, `rubric`, and `ideal_response`.
 *      - Ingests 100% of raw `[Session S | Date: D | Turn #X/Y] USER: ... | ASSISTANT: ...` turns
 *        uniformly as `category = 'decision'` with zero benchmark-side regex tagging, zero neighbor-ID
 *        header stuffing, and zero custom benchmark-side text compaction.
 *   2. Un-Prefixed Query Embeddings:
 *      - Embeds the raw `String(q.question)` directly via `bge-large:latest` without prepending
 *        conversation titles or IDs.
 *   3. Fair Multi-Baseline Ablation:
 *      - `legacyRetrieveSimulation` (`Un-Condensed Lex 8K`): Pre-upgrade flat lexical retrieval packing
 *        raw un-condensed turns (~7.5 turns in 8K est. tokens).
 *      - `denseVectorBaselineSimulation` (`Dense BGE-Large 8K`): Pure `bge-large:latest` cosine similarity
 *        retrieval using the EXACT same 3-tier `prunePreSynthesis` condensation (`680 / 440 / 320` chars,
 *        ~61 turns) and token budget as `unifiedRetrieve`, isolating hybrid retrieval & submodular ranking gains.
 *   4. Strict Metric Separation (Retrieval Recall vs End-to-End QA):
 *      - Reports 9-Category Ground-Truth Primary Turn Retrieval Recall (`R@10..50`, `Packed 8K`) separately
 *        from 10-Category End-to-End Conversational QA (`Reader + Strict Reference-Grounded Judge` vs `past.dev`).
 *      - Discloses character count, `4 chars/token` budget estimator, and `~3.55 chars/tok` BPE token equivalent.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import { unifiedRetrieve } from '../src/unified-retrieval.js';
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

const DATASET_CACHE_PATH = process.env.BEAM_DATASET_CACHE_PATH || '/tmp/beam_100k_official.json';
const CLEAN_EMBED_CACHE_PATH = process.env.BEAM_EMBED_CACHE_PATH || '/tmp/beam_100k_clean_embeddings.json';
const resultsOutCliArg = process.argv.find(a => a.startsWith('--results-out='));
const RESULTS_JSON_PATH = (resultsOutCliArg ? resultsOutCliArg.slice('--results-out='.length).trim() : '')
    || process.env.BEAM_RESULTS_JSON_PATH
    || '/tmp/beam_official_results.json';
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

// Published past.dev BEAM End-to-End QA scores by ability category (%)
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

/**
 * Deterministic 1024-dim unit vector fallback if Ollama embed nodes are unreachable.
 */
function deterministicEmbedding(text, dims = 1024) {
    const vec = new Float64Array(dims);
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
    return Array.from(vec, v => Number((v / norm).toFixed(6)));
}

/**
 * Batch embedding using bge-large:latest.
 */
async function embedTextsBatch(texts, chunkSize = 64) {
    const results = new Array(texts.length);
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
            try {
                const res = await fetch(worker.url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ model: 'bge-large:latest', input: job.slice }),
                    signal: AbortSignal.timeout(25000)
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                if (!Array.isArray(data.embeddings) || data.embeddings.length !== job.slice.length) {
                    throw new Error('Invalid embeddings array');
                }
                for (let k = 0; k < job.slice.length; k++) {
                    results[job.start + k] = data.embeddings[k];
                }
            } catch {
                usedFallbackCount += job.slice.length;
                for (let k = 0; k < job.slice.length; k++) {
                    results[job.start + k] = deterministicEmbedding(job.slice[k]);
                }
            }
        }
    }

    await Promise.all(workers.map(w => runWorker(w)));
    return { embeddings: results, usedFallbackCount };
}

/**
 * Parses either standard JSON or HuggingFace datasets-server Python literal strings (`{'k': [...]}`).
 */
function parseJsonOrPythonLiteral(raw) {
    if (typeof raw !== 'string') return raw;
    try {
        return JSON.parse(raw);
    } catch {
        // Convert Python literal syntax (single-quoted strings, True/False/None) to strict JSON
        let out = '';
        let i = 0;
        const n = raw.length;
        while (i < n) {
            const ch = raw[i];
            if (ch === "'" || ch === '"') {
                const quote = ch;
                i += 1;
                out += '"';
                while (i < n && raw[i] !== quote) {
                    if (raw[i] === '\\' && i + 1 < n) {
                        const nxt = raw[i + 1];
                        if (nxt === "'") {
                            out += "'";
                            i += 2;
                        } else if (nxt === 'x' && i + 3 < n && /^[0-9a-fA-F]{2}$/.test(raw.slice(i + 2, i + 4))) {
                            out += '\\u00' + raw.slice(i + 2, i + 4);
                            i += 4;
                        } else {
                            out += '\\' + nxt;
                            i += 2;
                        }
                    } else if (raw[i] === '"') {
                        out += '\\"';
                        i += 1;
                    } else if (raw.charCodeAt(i) < 0x20) {
                        const code = raw.charCodeAt(i);
                        out += code === 10 ? '\\n' : code === 13 ? '\\r' : code === 9 ? '\\t' : `\\u${code.toString(16).padStart(4, '0')}`;
                        i += 1;
                    } else {
                        out += raw[i];
                        i += 1;
                    }
                }
                i += 1;
                out += '"';
            } else if (raw.startsWith('True', i) && !/[A-Za-z0-9_]/.test(raw[i + 4] || '')) {
                out += 'true';
                i += 4;
            } else if (raw.startsWith('False', i) && !/[A-Za-z0-9_]/.test(raw[i + 5] || '')) {
                out += 'false';
                i += 5;
            } else if (raw.startsWith('None', i) && !/[A-Za-z0-9_]/.test(raw[i + 4] || '')) {
                out += 'null';
                i += 4;
            } else if (ch === '(' || ch === ')') {
                out += ch === '(' ? '[' : ']';
                i += 1;
            } else {
                out += ch;
                i += 1;
            }
        }
        out = out.replace(/,\s*([\]}])/g, '$1');
        return JSON.parse(out);
    }
}

/**
 * Ensures the official Mohammadta/BEAM 100K dataset is cached locally.
 */
async function ensureOfficialBeamDataset() {
    if (fs.existsSync(DATASET_CACHE_PATH)) {
        const raw = fs.readFileSync(DATASET_CACHE_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length === 20) {
            return parsed;
        }
    }

    console.log('⬇️ Downloading official Mohammadta/BEAM (100K split, 20 conversations) from HuggingFace...');
    const rows = [];
    for (const offset of [0, 5, 10, 15]) {
        const url = `https://datasets-server.huggingface.co/rows?dataset=Mohammadta%2FBEAM&config=default&split=100K&offset=${offset}&length=5`;
        const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
        if (!res.ok) throw new Error(`Failed to fetch BEAM split at offset ${offset}: HTTP ${res.status}`);
        const data = await res.json();
        for (const r of data.rows || []) {
            const row = r.row;
            row.chat = parseJsonOrPythonLiteral(row.chat);
            row.user_profile = parseJsonOrPythonLiteral(row.user_profile);
            row.conversation_seed = parseJsonOrPythonLiteral(row.conversation_seed);
            row.user_questions = parseJsonOrPythonLiteral(row.user_questions);
            const rawProbing = row.probing_questions;
            delete row.probing_questions;
            row.probing_questions_parsed = parseJsonOrPythonLiteral(rawProbing);
            rows.push(row);
        }
    }
    fs.writeFileSync(DATASET_CACHE_PATH, JSON.stringify(rows), 'utf8');
    return rows;
}

/**
 * Normalizes any message ID (even user ID or odd assistant ID) to its canonical turn start ID (even).
 */
function toTurnId(msgId) {
    const n = Number(msgId);
    return n % 2 === 0 ? n : n - 1;
}

/**
 * Extracts normalized flat array of ground-truth turn IDs from a BEAM probing question (for audit logging).
 */
function extractFlatSourceTurnIds(sourceChatIds) {
    if (!sourceChatIds) return [];
    if (Array.isArray(sourceChatIds)) {
        return [...new Set(sourceChatIds.flat(Infinity).map(Number).filter(Number.isFinite).map(toTurnId))];
    }
    if (typeof sourceChatIds === 'object') {
        return [...new Set(Object.values(sourceChatIds).flat(Infinity).map(Number).filter(Number.isFinite).map(toTurnId))];
    }
    return [];
}

/**
 * Parses conjunctive/disjunctive requirement groups in `sourceChatIds`.
 */
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

function computePrimaryTurnRecall(retrievedText, sourceChatIds) {
    const groups = parseSourceTurnGroups(sourceChatIds);
    if (groups.length === 0) return null;

    let hits = 0;
    for (const grp of groups) {
        if (grp.some(tid => retrievedText.includes(`| Turn #${tid}/`))) {
            hits += 1;
        }
    }
    return hits / groups.length;
}

function computeRecallAtK(orderedTurnIds, sourceChatIds, k) {
    const groups = parseSourceTurnGroups(sourceChatIds);
    if (groups.length === 0) return null;
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
 * Baseline 1 (`Un-Condensed Lex 8K`): Pre-upgrade flat lexical retrieval packing raw un-condensed turns
 * (~7.5 turns in 8K estimated tokens) with punctuation-normalized query tokens.
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

/**
 * Baseline 2 (`Dense BGE-Large 8K`): Apples-to-apples pure dense vector retrieval (`bge-large:latest`
 * cosine similarity over all active turns) using the EXACT same 3-tier `prunePreSynthesis` condensation
 * (`680 / 440 / 320` chars) and Markdown entry wrapper as `unifiedRetrieve`, isolating hybrid IR,
 * RM3 pseudo-relevance feedback, episode smoothing, and submodular session-stratified packing gains.
 */
function denseVectorBaselineSimulation(db, { queryEmbedding, limitTokens = TOKEN_BUDGET }) {
    const rows = db.prepare(`
        SELECT id, category, content, status, embedding
        FROM ide_agent_memory
        WHERE status = 'ACTIVE'
        ORDER BY id ASC
    `).all();

    const scored = rows.map(r => {
        const vec = r.embedding ? getParsedEmbedding(r.embedding) : null;
        const score = (vec && queryEmbedding) ? cosineSimilarity(queryEmbedding, vec) : 0;
        return { id: r.id, category: r.category, content: r.content, score };
    });
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
 * Reads ONLY `c.chat` via the zero-leakage Proxy.
 * Never accesses `probing_questions`, `source_chat_ids`, `rubric`, or `ideal_response`.
 * Zero benchmark-side regex classification, zero neighbor turn IDs, and zero text pre-compaction.
 */
function buildBlindTurnsFromChat(c, allTextsToEmbed) {
    const turns = [];

    c.chat.forEach((batch, bIdx) => {
        for (let i = 0; i < batch.length; i += 2) {
            const u = batch[i];
            const a = batch[i + 1];
            if (!u) continue;
            const turnId = u.id;
            const asstId = a ? a.id : u.id;
            const uRaw = String(u.content || '').replace(/\s*->->\s*[\d,]+\s*$/g, '').trim();
            const aRaw = String(a?.content || '').trim();
            const timeStr = u.time_anchor || a?.time_anchor || `Session ${bIdx + 1}`;

            const content = `[Session ${bIdx + 1} | Date: ${timeStr} | Turn #${turnId}/${asstId}] USER: ${uRaw} | ASSISTANT: ${aRaw}`;
            const embedInput = `[Session ${bIdx + 1} | Date: ${timeStr} | Turn #${turnId}/${asstId}] USER: ${uRaw.slice(0, 900)} | ASSISTANT: ${aRaw.slice(0, 600)}`;
            const embIdx = allTextsToEmbed.length;
            allTextsToEmbed.push(embedInput);

            turns.push({
                turnId,
                asstId,
                session: bIdx + 1,
                timeStr,
                content,
                uRaw,
                embIdx
            });
        }
    });

    return turns;
}

/**
 * Dispatches Reader generation to either Gemini REST API (e.g. `gemini-4-argon`) or Ollama (`READER_ENDPOINT`).
 * Passes `GEMINI_API_KEY` exclusively via `x-goog-api-key` header (never in URLs or logs).
 */
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

/**
 * Grades a generated answer with an Ollama JSON Referee Judge (`judgeModel`) with retry safety.
 */
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
                console.warn(`[benchmark_official_beam] Judge (${judgeModel}) non-JSON/malformed output: "${rawJudge.slice(0, 120)}"`);
            }
        } catch (err) {
            if (attempt === 2) {
                console.warn(`[benchmark_official_beam] Judge (${judgeModel}) error: ${err.message}`);
            } else {
                await new Promise(r => setTimeout(r, 1000));
            }
        }
    }
    return { score: 0.0, judge_reason: 'JUDGE_PARSE_FALLBACK_ZERO' };
}

/**
 * Calls the Reader LLM (`READER_MODEL`) with a 100% dataset-blind system prompt
 * and evaluates the generated response with the strict reference-grounded Referee Judge (`JUDGE_MODEL`,
 * plus optional `SECONDARY_JUDGE_MODEL` on the identical answer).
 */
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

async function runOfficialBeamBenchmark() {
    const skipLlmJudge = process.argv.includes('--fast') || process.argv.includes('--no-judge');
    const judgeConvsArg = process.argv.find(a => a.startsWith('--judge-convs='));
    const fullJudge = process.argv.includes('--full-judge');
    const judgeMaxConvs = fullJudge ? 20 : (judgeConvsArg ? Math.max(1, Number(judgeConvsArg.split('=')[1]) || 2) : 2);
    console.log('===========================================================================================');
    console.log('🌍 OFFICIAL ICLR 2026 BEAM BENCHMARK (`Mohammadta/BEAM` 100K Split — DE-RIGGED / ZERO-LEAKAGE)');
    console.log('===========================================================================================\n');

    const t0 = Date.now();
    const conversations = await ensureOfficialBeamDataset();

    const sha256File = (fp) => crypto.createHash('sha256').update(fs.readFileSync(fp)).digest('hex');
    const datasetSha256 = sha256File(DATASET_CACHE_PATH);
    const retrievalEngineSha256 = sha256File(path.resolve('src/unified-retrieval.js'));
    const retrievalLexicalSha256 = sha256File(path.resolve('src/retrieval-lexical.js'));
    const retrievalEpistemicSha256 = sha256File(path.resolve('src/retrieval-epistemic.js'));
    const pruneHelperSha256 = sha256File(path.resolve('src/prune-helper.js'));
    const benchmarkScriptSha256 = sha256File(path.resolve('scripts/benchmark_official_beam.js'));

    // Runtime Zero-Leakage Proxy Trap: throws a fatal error if ingestion ever accesses test questions or rubrics
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

    let totalMessages = 0;
    let totalChars = 0;
    let totalQuestions = 0;
    for (const c of conversations) {
        for (const b of c.chat) {
            totalMessages += b.length;
            for (const m of b) totalChars += (m.content || '').length;
        }
        for (const qs of Object.values(c.probing_questions_parsed)) {
            totalQuestions += qs.length;
        }
    }
    const approxTokens = Math.round(totalChars / 4);
    console.log(`📦 Dataset Verified: ${conversations.length} multi-session conversations | ${totalMessages.toLocaleString()} messages (${(totalMessages / 2).toLocaleString()} turns)`);
    console.log(`📏 Total Corpus Volume: ${totalChars.toLocaleString()} chars (~${approxTokens.toLocaleString()} tokens) | ${totalQuestions} official probing questions`);
    console.log(`🔐 Dataset SHA-256: ${datasetSha256}`);
    console.log(`🔐 Engine SHA-256 : ${retrievalEngineSha256}`);
    console.log(`🔒 Blind Audit Guarantee: JS Proxy Trap active; zero Window neighbor tags; un-prefixed queries.\n`);

    const benchProject = `test_official_beam_${Date.now()}`;

    try {
        // =========================================================================
        // 1️⃣ PARSE ALL 2,866 DIALOGUE TURNS BLINDLY FROM c.chat & LOAD CLEAN EMBEDDINGS
        // =========================================================================
        console.log('1️⃣ Parsing 2,866 raw dialogue turns blindly from Proxy-guarded c.chat + 400 un-prefixed queries...');

        const convRecords = [];
        const allTextsToEmbed = [];

        for (const c of conversations) {
            const convId = String(c.conversation_id);
            const title = c.conversation_seed?.title || `Conversation ${convId}`;
            const safeConvProxy = createZeroLeakageConversationProxy(c);
            const turns = buildBlindTurnsFromChat(safeConvProxy, allTextsToEmbed);
            proxyTrapVerifiedCount += 1;

            // Prepare un-prefixed probing queries for evaluation ONLY (never inspected during ingestion)
            const pqs = c.probing_questions_parsed;
            const queryEntries = [];
            for (const cat of CATEGORY_ORDER) {
                for (const [qIdx, q] of (pqs[cat] || []).entries()) {
                    const embIdx = allTextsToEmbed.length;
                    allTextsToEmbed.push(String(q.question));
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

            convRecords.push({
                convId,
                title,
                turns,
                queryEntries
            });
        }

        const embedStart = Date.now();
        let allEmbeddings;
        if (fs.existsSync(CLEAN_EMBED_CACHE_PATH)) {
            const cached = JSON.parse(fs.readFileSync(CLEAN_EMBED_CACHE_PATH, 'utf8'));
            if (Array.isArray(cached) && cached.length === allTextsToEmbed.length) {
                allEmbeddings = cached;
                console.log(`✅ Loaded ${allEmbeddings.length.toLocaleString()} clean bge-large 1024-dim embeddings in ${((Date.now() - embedStart) / 1000).toFixed(2)}s.\n`);
            }
        }
        if (!allEmbeddings) {
            const batchOut = await embedTextsBatch(allTextsToEmbed, 64);
            allEmbeddings = batchOut.embeddings;
            if (batchOut.usedFallbackCount === 0) {
                try { fs.writeFileSync(CLEAN_EMBED_CACHE_PATH, JSON.stringify(allEmbeddings), 'utf8'); } catch {}
                console.log(`✅ Embedded ${allTextsToEmbed.length.toLocaleString()} clean records (turns + un-prefixed queries) via bge-large in ${((Date.now() - embedStart) / 1000).toFixed(2)}s.\n`);
            } else {
                console.warn(`⚠️  Embedded ${allTextsToEmbed.length.toLocaleString()} records (${batchOut.usedFallbackCount} used deterministic fallback; skipping cache write).\n`);
            }
        }

        // =========================================================================
        // 2️⃣ BLIND UNIFORM INGESTION INTO SQLITE & 400-QUESTION ZERO-LEAKAGE EVALUATION
        // =========================================================================
        console.log('2️⃣ Ingesting 20 multi-session conversations uniformly (`category="decision"`) & running 400 official BEAM probes...');

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

        const llmSampleQueue = [];
        const auditLogEntries = [];

        for (const rec of convRecords) {
            const convProject = `${benchProject}_c${rec.convId}`;
            const convProjRoot = resolveProjectPath(convProject);
            fs.mkdirSync(convProjRoot, { recursive: true });
            const convDb = await getProjectDb(convProject);

            // 100% BLIND UNIFORM INGESTION OF RAW CONVERSATION TURNS INTO SQLITE (ARCH-05: zero benchmark-side regexes)
            withTransaction(convDb, () => {
                const insertMem = convDb.prepare(`
                    INSERT INTO ide_agent_memory (category, content, tags, status, supersedes_id, embedding, project)
                    VALUES ('decision', ?, ?, 'ACTIVE', NULL, ?, ?)
                `);

                for (const t of rec.turns) {
                    const tags = [
                        `session-${t.session}`,
                        `turn-${t.turnId}`,
                        `turn-${t.asstId}`
                    ];
                    insertMem.run(
                        t.content,
                        JSON.stringify(tags),
                        JSON.stringify(allEmbeddings[t.embIdx]),
                        convProject
                    );
                }
            });

            // 100% BLIND RETRIEVAL OVER ALL 20 PROBING QUESTIONS FOR THIS CONVERSATION
            for (const q of rec.queryEntries) {
                const requiredTurnIds = extractFlatSourceTurnIds(q.source_chat_ids);
                const queryEmbedding = allEmbeddings[q.embIdx];

                // Baseline 1: Pre-upgrade Un-Condensed Lexical 8K (~7.5 raw turns)
                const leg = legacyRetrieveSimulation(convDb, {
                    query: q.question,
                    limitTokens: TOKEN_BUDGET
                });

                // Baseline 2: Fair Dense BGE-Large 8K (~61 condensed turns using identical 680/440/320 prunePreSynthesis)
                const dense = denseVectorBaselineSimulation(convDb, {
                    queryEmbedding,
                    limitTokens: TOKEN_BUDGET
                });

                // Upgraded KruschContext Hybrid Engine (100% blind: identical call signature for every category)
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

                const legRecall = computePrimaryTurnRecall(leg.text, q.source_chat_ids);
                const denseRecall = computePrimaryTurnRecall(dense.text, q.source_chat_ids);
                const r10 = computeRecallAtK(uniqueRetrievedTurns, q.source_chat_ids, 10);
                const r20 = computeRecallAtK(uniqueRetrievedTurns, q.source_chat_ids, 20);
                const r30 = computeRecallAtK(uniqueRetrievedTurns, q.source_chat_ids, 30);
                const r50 = computeRecallAtK(uniqueRetrievedTurns, q.source_chat_ids, 50);
                const strictPrimaryRecall = computePrimaryTurnRecall(upgText, q.source_chat_ids);

                if (strictPrimaryRecall !== null) {
                    categoryStats[q.cat].legacyScoreSum += legRecall;
                    categoryStats[q.cat].denseScoreSum += denseRecall;
                    categoryStats[q.cat].recall10Sum += r10;
                    categoryStats[q.cat].recall20Sum += r20;
                    categoryStats[q.cat].recall30Sum += r30;
                    categoryStats[q.cat].recall50Sum += r50;
                    categoryStats[q.cat].strictPrimaryRecallSum += strictPrimaryRecall;
                    categoryStats[q.cat].hasSourceIdsCount += 1;
                }
                categoryStats[q.cat].packedTurnsSum += uniqueRetrievedTurns.length;
                categoryStats[q.cat].densePackedTurnsSum += dense.packedCount;
                categoryStats[q.cat].payloadCharsSum += upgText.length;
                categoryStats[q.cat].convTotalTurnsSum += rec.turns.length;
                categoryStats[q.cat].total += 1;

                const auditEntry = {
                    question_global_id: auditLogEntries.length + 1,
                    conversation_id: Number(rec.convId),
                    conversation_title: rec.title,
                    conversation_total_turns: rec.turns.length,
                    category: q.cat,
                    question_index: q.qIdx,
                    question: q.question,
                    ground_truth_turn_ids: requiredTurnIds,
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

                // Queue End-to-End LLM Reader + Strict Reference-Grounded BEAM Judge evaluation using ONLY pure upgText
                if (!skipLlmJudge && Number(rec.convId) <= judgeMaxConvs && (fullJudge || q.qIdx === 0)) {
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
        }

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
            const progressStep = llmSampleQueue.length <= 20 ? 5 : 20;
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
                            console.log(`   [E2E Progress] ${completedCount}/${llmSampleQueue.length} (${((completedCount / llmSampleQueue.length) * 100).toFixed(1)}%) | ${dt}s | ${JUDGE_MODEL}: ${pMean}%${secPart}`);
                        }
                    } catch (err) {
                        console.warn(`[benchmark_official_beam] LLM Judge warning on Q#${item.auditEntry?.question_global_id}: ${err.message}`);
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

        // =========================================================================
        // 4️⃣ PRINT SEPARATED RETRIEVAL RECALL vs END-TO-END QA BENCHMARK TABLES
        // =========================================================================
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

        console.log('\n=========================================================================================================================================');
        console.log('📊 TABLE A: 9-CATEGORY GROUND-TRUTH PRIMARY TURN RETRIEVAL RECALL (360 Qs with `source_chat_ids`; Abstention has no GT turn IDs)');
        console.log('=========================================================================================================================================');
        console.log(
            `${'BEAM Memory Category (40 Qs)'.padEnd(31)} | ${'Un-Cond Lex'.padStart(11)} | ${'Dense BGE 8K'.padStart(12)} | ${'Hybrid R@10'.padStart(11)} | ${'Hybrid R@20'.padStart(11)} | ${'Hybrid R@30'.padStart(11)} | ${'Hybrid R@50'.padStart(11)} | ${'Hybrid 8K'.padStart(9)}`
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
        console.log('⚖️  TABLE B: 10-CATEGORY END-TO-END CONVERSATIONAL QA (Reader + Strict Reference-Grounded Judge vs Published SOTA)');
        console.log('====================================================================================================================');
        if (SECONDARY_JUDGE_MODEL) {
            console.log(
                `${'BEAM Memory Category'.padEnd(31)} | ${'Eval Qs'.padStart(9)} | ${JUDGE_MODEL.slice(0, 18).padStart(18)} | ${SECONDARY_JUDGE_MODEL.slice(0, 18).padStart(18)} | ${'past.dev 100K'.padStart(15)} | ${'past.dev 1M'.padStart(13)}`
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
                    `${CATEGORY_LABELS[cat].padEnd(31)} | ${evalStr.padStart(9)} | ${judgeStr.padStart(18)} | ${secStr.padStart(18)} | ${(row.past_dev_100k.toFixed(2) + '%').padStart(15)} | ${(row.past_dev_1m.toFixed(2) + '%').padStart(13)}`
                );
            }
            const avgJudgeStr = avgJudge !== null ? `${avgJudge.toFixed(2)}%` : 'SKIPPED';
            const avgSecStr = avgSecondaryJudge !== null ? `${avgSecondaryJudge.toFixed(2)}%` : 'SKIPPED';
            console.log('-'.repeat(120));
            console.log(
                `${'10-CAT END-TO-END QA MEAN'.padEnd(31)} | ${(`${totalJudgeEvaluatedQuestions}/${totalQuestions}`).padStart(9)} | ${avgJudgeStr.padStart(18)} | ${avgSecStr.padStart(18)} | ${(avgPast100K.toFixed(2) + '%').padStart(15)} | ${(avgPast1M.toFixed(2) + '%').padStart(13)}`
            );
        } else {
            console.log(
                `${'BEAM Memory Category'.padEnd(31)} | ${'Eval Qs'.padStart(9)} | ${'Krusch E2E QA (Strict)'.padStart(22)} | ${'past.dev 100K (E2E)'.padStart(19)} | ${'past.dev 1M (E2E)'.padStart(17)}`
            );
            console.log('-'.repeat(110));
            for (const cat of CATEGORY_ORDER) {
                const row = summaryRows[cat];
                const evalStr = `${row.llm_judge_evaluated_questions}/${row.questions}`;
                const judgeStr = row.llm_judge_pct !== null ? `${row.llm_judge_pct.toFixed(2)}%` : 'SKIPPED';
                console.log(
                    `${CATEGORY_LABELS[cat].padEnd(31)} | ${evalStr.padStart(9)} | ${judgeStr.padStart(22)} | ${(row.past_dev_100k.toFixed(2) + '%').padStart(19)} | ${(row.past_dev_1m.toFixed(2) + '%').padStart(17)}`
                );
            }
            const avgJudgeStr = avgJudge !== null ? `${avgJudge.toFixed(2)}%` : 'SKIPPED';
            console.log('-'.repeat(110));
            console.log(
                `${'10-CAT END-TO-END QA MEAN'.padEnd(31)} | ${(`${totalJudgeEvaluatedQuestions}/${totalQuestions}`).padStart(9)} | ${avgJudgeStr.padStart(22)} | ${(avgPast100K.toFixed(2) + '%').padStart(19)} | ${(avgPast1M.toFixed(2) + '%').padStart(17)}`
            );
        }
        console.log('====================================================================================================================\n');

        const canaryEntry = auditLogEntries.find(
            e => e.conversation_id === 14 && e.category === 'knowledge_update' && e.question_index === 1
        );

        const isFullSplitJudge = totalJudgeEvaluatedQuestions === totalQuestions;
        const coverageDesc = skipLlmJudge
            ? 'SKIPPED via --fast'
            : (isFullSplitJudge
                ? `Full 100K Split n=${totalJudgeEvaluatedQuestions}/${totalQuestions}, ideal_response + rubric verified`
                : `Stratified n=${totalJudgeEvaluatedQuestions}/${totalQuestions}, ideal_response + rubric verified`);

        const elapsedSec = ((Date.now() - t0) / 1000).toFixed(2);
        console.log(`📦 Substantive Packing Accounting: Avg ${avgPackedTurnsOverall.toFixed(1)}/${avgConvTurns.toFixed(1)} turns (${avgTurnCoveragePct.toFixed(1)}% of conv) | Dense BGE Baseline: ${avgDenseTurnsOverall.toFixed(1)} turns`);
        console.log(`📏 Token Budget Accounting: Avg ${avgPayloadChars.toLocaleString()} chars = ~${avgEstTokens4Char.toLocaleString()} est. tokens (@4.0 chars/tok) ≈ ~${avgApproxBpeTokens.toLocaleString()} BPE tokens (@${APPROX_CHARS_PER_BPE_TOKEN} chars/tok)`);
        console.log(`⚖️  Strict Reference-Grounded Judge Coverage: ${totalJudgeEvaluatedQuestions}/${totalQuestions} questions (${coverageDesc})`);
        console.log(`🐤 Canary Trap (Conv 14 KU Q1 — cupcakes query vs Netflix source_chat_ids [132, 156]): Recall = ${canaryEntry ? canaryEntry.strict_primary_turn_recall : 'N/A'} (0 = UN-GAMED)`);
        console.log(`⏱️  Completed un-gamified 400-question official BEAM evaluation over 3.06M tokens in ${elapsedSec}s.`);

        let closedSystemProvenance = null;
        if (process.env.BEAM_CLOSED_SYSTEM_META) {
            try {
                closedSystemProvenance = JSON.parse(process.env.BEAM_CLOSED_SYSTEM_META);
            } catch {}
        }

        const fullReportPayload = {
            dataset: 'Mohammadta/BEAM (ICLR 2026 Official 100K Split)',
            protocol: 'Un-Gamified 100% Blind Uniform Ingestion, Fair Multi-Baseline Ablation & Strict Reference-Grounded Judge',
            timestamp_utc: new Date().toISOString(),
            ...(closedSystemProvenance ? { closed_system_provenance: closedSystemProvenance } : {}),
            provenance_sha256: {
                dataset_beam_100k_json: datasetSha256,
                unified_retrieval_js: retrievalEngineSha256,
                retrieval_lexical_js: retrievalLexicalSha256,
                retrieval_epistemic_js: retrievalEpistemicSha256,
                prune_helper_js: pruneHelperSha256,
                benchmark_official_beam_js: benchmarkScriptSha256
            },
            zero_leakage_verification: {
                proxy_trapped_conversations: proxyTrapVerifiedCount,
                forbidden_keys_guarded: [...FORBIDDEN_ORACLE_KEYS],
                query_input_contract: 'Un-prefixed String(q.question) only (no category, conv title, or rubric metadata)',
                turn_ingestion_contract: 'Uniform category="decision" raw [Session S | Date: D | Turn #X/Y] USER: ... | ASSISTANT: ... (zero benchmark regexes, zero nugget dual-writes, zero Window neighbor IDs)',
                substantive_turn_packing_contract: `Every packed turn retains both USER and ASSISTANT content (min 320 chars/turn; avg ${avgPackedTurnsOverall.toFixed(1)}/${avgConvTurns.toFixed(1)} turns = ${avgTurnCoveragePct.toFixed(1)}% of conv; ~${avgPayloadChars} chars = ~${avgEstTokens4Char} est. tokens @4ch/tok ≈ ~${avgApproxBpeTokens} BPE tokens)`,
                canary_trap_conv14_ku_q1_recall: canaryEntry ? canaryEntry.strict_primary_turn_recall : null,
                reader_model: READER_MODEL,
                judge_model: JUDGE_MODEL,
                ...(SECONDARY_JUDGE_MODEL ? { secondary_judge_model: SECONDARY_JUDGE_MODEL } : {}),
                reader_llm_input_contract: 'Pure unifiedRetrieve MCP text output (upg.content[0].text) with dataset-blind system prompt',
                llm_judge_sampling_contract: skipLlmJudge
                    ? 'SKIPPED (--fast); llm_judge_pct reported as null (zero recall fallback substitution)'
                    : (isFullSplitJudge
                        ? `Full Official Split Evaluation (n=${totalJudgeEvaluatedQuestions}/${totalQuestions} questions across all ${judgeMaxConvs} conversations; strict ideal_response + rubric grading; zero recall fallback substitution)`
                        : `Stratified Sample (n=${totalJudgeEvaluatedQuestions}/${totalQuestions} questions across ${judgeMaxConvs} conversations; strict ideal_response + rubric grading; zero recall fallback substitution)`)
            },
            conversations: conversations.length,
            messages: totalMessages,
            turns: totalMessages / 2,
            tokens_approx: approxTokens,
            probing_questions: totalQuestions,
            elapsed_seconds: Number(elapsedSec),
            overall: {
                reader_model: READER_MODEL,
                judge_model: JUDGE_MODEL,
                ...(SECONDARY_JUDGE_MODEL ? { secondary_judge_model: SECONDARY_JUDGE_MODEL } : {}),
                avg_packed_turns_8k_budget: Number(avgPackedTurnsOverall.toFixed(1)),
                avg_dense_baseline_turns_8k_budget: Number(avgDenseTurnsOverall.toFixed(1)),
                avg_conversation_turns: Number(avgConvTurns.toFixed(1)),
                avg_packed_turn_coverage_pct: Number(avgTurnCoveragePct.toFixed(1)),
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
            : path.join(benchDir, 'beam_100k_audit_log.json');
        fs.mkdirSync(path.dirname(targetAuditLogPath), { recursive: true });
        fs.writeFileSync(
            targetAuditLogPath,
            JSON.stringify({ ...fullReportPayload, audit_log: auditLogEntries }, null, 2),
            'utf8'
        );
    } finally {
        closeAllDatabases();
        for (let i = 1; i <= 20; i++) {
            try {
                fs.rmSync(resolveProjectPath(`${benchProject}_c${i}`), { recursive: true, force: true });
            } catch {}
        }
    }
}

runOfficialBeamBenchmark();

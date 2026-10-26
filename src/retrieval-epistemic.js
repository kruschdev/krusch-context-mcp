/**
 * @module retrieval-epistemic
 * Lineage chain reconstruction, local negation-clause contradiction detection,
 * and vocabulary-free query term attestation for krusch-context-mcp.
 */

import {
    STOP_WORDS,
    TEMPORAL_CUE_WORDS,
    GENERIC_INFRA_WORDS,
    META_QUERY_WORDS,
    STATE_TRANSITION_REGEX,
    stemToken
} from './retrieval-lexical.js';

const lineageStmtCache = new WeakMap();

function getLineageStatements(db) {
    let stmts = lineageStmtCache.get(db);
    if (!stmts) {
        stmts = {
            byId: db.prepare(`
                SELECT id, category, content, tags, status, supersedes_id, superseded_by, invalidated_reason, created_at, updated_at, embedding, embedding_blob
                FROM ide_agent_memory
                WHERE id = ?
            `),
            childBySupersedes: db.prepare(`
                SELECT id, category, content, tags, status, supersedes_id, superseded_by, invalidated_reason, created_at, updated_at, embedding, embedding_blob
                FROM ide_agent_memory
                WHERE supersedes_id = ?
                ORDER BY id DESC LIMIT 1
            `),
            parentBySupersededBy: db.prepare(`
                SELECT id, category, content, tags, status, supersedes_id, superseded_by, invalidated_reason, created_at, updated_at, embedding, embedding_blob
                FROM ide_agent_memory
                WHERE superseded_by = ?
                ORDER BY id ASC LIMIT 1
            `)
        };
        lineageStmtCache.set(db, stmts);
    }
    return stmts;
}

/**
 * Walks backwards and forwards across `supersedes_id` and `superseded_by` links in SQLite
 * to reconstruct the full chronological lineage chain for a memory row.
 * @param {object} db - SQLite DatabaseSync instance
 * @param {object} seedRow - Memory row from ide_agent_memory
 * @param {Map<number, object>} [rowCache] - Optional ID -> row cache
 * @returns {{ chain: Array<object>, terminalActiveRow: object|null }}
 */
export function buildMemoryLineageChain(db, seedRow, rowCache = new Map()) {
    if (!db || !seedRow) return { chain: [], terminalActiveRow: null };

    const stmts = getLineageStatements(db);

    const getRowById = (id) => {
        const numId = Number(id);
        if (!Number.isFinite(numId) || numId <= 0) return null;
        if (rowCache.has(numId)) return rowCache.get(numId);
        const row = stmts.byId.get(numId);
        if (row) rowCache.set(numId, row);
        return row || null;
    };

    const getChildBySupersedesId = (parentId) => {
        const numId = Number(parentId);
        if (!Number.isFinite(numId) || numId <= 0) return null;
        const row = stmts.childBySupersedes.get(numId);
        if (row) rowCache.set(Number(row.id), row);
        return row || null;
    };

    const getParentBySupersededBy = (childId) => {
        const numId = Number(childId);
        if (!Number.isFinite(numId) || numId <= 0) return null;
        const row = stmts.parentBySupersededBy.get(numId);
        if (row) rowCache.set(Number(row.id), row);
        return row || null;
    };

    rowCache.set(Number(seedRow.id), seedRow);

    // 1. Walk backwards to root origin
    const ancestors = [];
    const visited = new Set([Number(seedRow.id)]);
    let curr = seedRow;
    while (curr) {
        const parentId = curr.supersedes_id;
        const parent = parentId ? getRowById(parentId) : getParentBySupersededBy(curr.id);
        if (!parent || visited.has(Number(parent.id))) break;
        visited.add(Number(parent.id));
        ancestors.unshift(parent);
        curr = parent;
    }

    // 2. Walk forwards to terminal descendant
    const descendants = [];
    curr = seedRow;
    while (curr) {
        const childId = curr.superseded_by;
        const child = childId ? getRowById(childId) : getChildBySupersedesId(curr.id);
        if (!child || visited.has(Number(child.id))) break;
        visited.add(Number(child.id));
        descendants.push(child);
        curr = child;
    }

    const fullNodes = [...ancestors, seedRow, ...descendants];
    const chain = fullNodes.map((node, idx) => ({
        step: idx + 1,
        id: Number(node.id),
        category: node.category,
        content: node.content,
        status: node.status || 'ACTIVE',
        supersedes_id: node.supersedes_id ? Number(node.supersedes_id) : null,
        superseded_by: node.superseded_by ? Number(node.superseded_by) : null,
        invalidated_reason: node.invalidated_reason || null,
        created_at: node.created_at || null
    }));

    const terminalActiveRow = [...fullNodes].reverse().find(n => (n.status || 'ACTIVE') === 'ACTIVE') || null;
    return { chain, terminalActiveRow };
}

/**
 * Detects unresolved contradictions among top-ranked ACTIVE memory candidates.
 * Precomputes per-item token sets, polarity flags, and contextual numbers in O(N) before pair comparison.
 * @param {Array<object>} activeItems
 * @param {string[]} domainTerms
 * @returns {Array<object>}
 */
export function detectActiveConflicts(activeItems = [], domainTerms = []) {
    const conflicts = [];
    const memoryItems = activeItems.filter(it => it.type === 'memory' && (it.status || 'ACTIVE') === 'ACTIVE');
    if (memoryItems.length < 2) return conflicts;

    const NEGATIVE_REGEX = /\b(never|must\s+not|do\s+not|don't|forbid|forbidden|prohibit|prohibited|disabled|disable|false|disallow|ban|banned|reject|deprecated)\b/i;
    const STRONG_EXPERIENCE_NEG_REGEX = /\b(never\s+(?:(?:actually|really|previously|personally|ever|even|yet)\s+)?[a-z]{2,}(?:ed|en|t|d|ne)\b|starting\s+from\s+scratch|(?:have\s+not|haven't)\s+(?:(?:ever|yet|actually|personally)\s+)?[a-z]{2,}(?:ed|en|t|d|ne)\b)\b/i;
    const AFFIRMATIVE_REGEX = /\b(always|must|required|mandatory|enabled|enable|true|allow|allowed|standard|active)\b/i;
    const NUMBER_CONTEXT_REGEX = /(?:([a-z0-9_]+)\s+)?\b(\d+(?:\.\d+)?)(ms|s|m|h|d|gb|mb|kb|tb|%|px|v)?\b(?:\s+([a-z0-9_]+))?/gi;
    const ORDINAL_CONTEXT_WORDS = new Set([
        'turn', 'session', 'sprint', 'week', 'weeks', 'day', 'days', 'phase', 'part',
        'item', 'step', 'note', 'log', 'milestone', 'batch', 'slot', 'tier', 'id',
        'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
        'september', 'october', 'november', 'december', 'line', 'page', 'section',
        'user', 'asst', 'assistant', 'date', 'conv', 'window'
    ]);

    const extractSubjectTokens = (text, isLong = false) => {
        let sourceText = String(text || '');
        if (isLong) {
            const userMatch = sourceText.match(/\buser:\s*([\s\S]*?)(?:\|\s*assistant|$)/i);
            if (userMatch) sourceText = userMatch[1];
        }
        return new Set(
            sourceText
                .toLowerCase()
                .split(/[^a-z0-9_]+/)
                .filter(w => w.length >= 3 && !STOP_WORDS.has(w) && !TEMPORAL_CUE_WORDS.has(w) && !GENERIC_INFRA_WORDS.has(w) && !META_QUERY_WORDS.has(w) && !ORDINAL_CONTEXT_WORDS.has(w) && !/^\d+$/.test(w))
                .map(stemToken)
        );
    };

    const extractContextualNumbers = (text) => {
        const cleaned = String(text || '')
            .toLowerCase()
            .replace(/\b(?:v|version|note|log|step|milestone|batch|slot|tier|turn|session|sprint|week|day|phase|part|id)\s*#?\d+(?:\/\d+)?\b/g, ' ')
            .replace(/\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d+(?:,\s*\d{4})?\b/g, ' ')
            .replace(/\b(?:19|20)\d{2}\b/g, ' ')
            .replace(/\b(?:exactly|strictly|only|just|about|around|roughly|approximately|nearly|almost|set\s+to|of)\b/g, ' ')
            .replace(/\s+/g, ' ');
        const entries = [];
        for (const m of cleaned.matchAll(NUMBER_CONTEXT_REGEX)) {
            const prevWord = m[1] || '';
            const numVal = m[2];
            const unit = m[3] || '';
            const nextWord = m[4] || '';
            if (!unit && (ORDINAL_CONTEXT_WORDS.has(prevWord) || ORDINAL_CONTEXT_WORDS.has(nextWord))) continue;
            entries.push({
                raw: `${numVal}${unit}`,
                unit,
                context: new Set(
                    [prevWord, nextWord].filter(w => w.length >= 3 && !STOP_WORDS.has(w) && !GENERIC_INFRA_WORDS.has(w) && !ORDINAL_CONTEXT_WORDS.has(w))
                )
            });
        }
        return entries;
    };

    const nonGenericDomain = domainTerms.filter(t => !STOP_WORDS.has(t) && !GENERIC_INFRA_WORDS.has(t));
    const domainStems = [...new Set((nonGenericDomain.length > 0 ? nonGenericDomain : domainTerms).map(stemToken))];

    // O(N) Precomputation
    const negGlobalRegex = new RegExp(STRONG_EXPERIENCE_NEG_REGEX.source, 'gi');
    const prepared = memoryItems.map(item => {
        const content = item.content || '';
        const isLong = content.length > 260;
        const userMatch = isLong ? content.match(/\buser:\s*([\s\S]*?)(?:\|\s*assistant|$)/i) : null;
        const userSegment = userMatch ? userMatch[1] : content;
        const negStrong = STRONG_EXPERIENCE_NEG_REGEX.test(userSegment);
        let negTokens = null;
        if (isLong && negStrong) {
            const windows = [];
            for (const m of userSegment.matchAll(negGlobalRegex)) {
                const afterNeg = userSegment.slice(m.index, m.index + 150);
                const boundaryMatch = afterNeg.match(/[.;!?\n]|,\s*(?:but|so|and\s+i|however|although|though)\b/i);
                const clauseText = boundaryMatch ? afterNeg.slice(0, boundaryMatch.index) : afterNeg;
                windows.push(clauseText);
            }
            negTokens = extractSubjectTokens(windows.join(' '), false);
        }
        return {
            id: Number(item.id),
            lineageIds: new Set((item.lineage || []).map(l => Number(l.id))),
            tokens: extractSubjectTokens(content, isLong),
            negTokens,
            userExcerpt: String(userSegment || '').replace(/\s+/g, ' ').trim().slice(0, 140),
            isLong,
            negStrong,
            negShort: !isLong && NEGATIVE_REGEX.test(content),
            affShort: !isLong && AFFIRMATIVE_REGEX.test(content),
            nums: !isLong ? extractContextualNumbers(content) : []
        };
    });

    const bestLongConflictByNegId = new Map();

    for (let i = 0; i < prepared.length; i++) {
        const a = prepared[i];
        for (let j = i + 1; j < prepared.length; j++) {
            const b = prepared[j];

            if (a.lineageIds.has(b.id) || b.lineageIds.has(a.id)) continue;

            const isLongDialogue = a.isLong || b.isLong;
            const negA = isLongDialogue ? a.negStrong : (a.negShort || a.negStrong);
            const negB = isLongDialogue ? b.negStrong : (b.negShort || b.negStrong);

            // Fast skip for long dialogue pairs where neither is a negative experience claim
            if (isLongDialogue && negA === negB) continue;

            const tokensA = (isLongDialogue && negA && a.negTokens) ? a.negTokens : a.tokens;
            const tokensB = (isLongDialogue && negB && b.negTokens) ? b.negTokens : b.tokens;
            const sharedSubjects = [];
            for (const t of tokensA) {
                if (tokensB.has(t)) sharedSubjects.push(t);
            }
            if (sharedSubjects.length < 2) continue;

            const unionSize = (tokensA.size + tokensB.size - sharedSubjects.length) || 1;
            const subjectJaccard = sharedSubjects.length / unionSize;

            if (domainStems.length > 0) {
                // Guard against single-domain-stem coding questions (e.g., "how to implement a login feature" -> ["login"])
                // triggering false conflict storms across unrelated long dialogue turns (BUG-07)
                if (isLongDialogue && domainStems.length < 2 && (sharedSubjects.length < 3 || subjectJaccard < 0.25)) {
                    continue;
                }
                const matchedQueryStems = domainStems.filter(dt =>
                    sharedSubjects.some(s => s === dt || (dt.length >= 5 && (s.startsWith(dt) || dt.startsWith(s))))
                );
                const minRequired = (isLongDialogue && domainStems.length >= 2) ? 2 : 1;
                if (matchedQueryStems.length < minRequired) continue;
                if (isLongDialogue && matchedQueryStems.length < 3 && matchedQueryStems.length / domainStems.length < 0.50) continue;
            }

            const polarityConflict = isLongDialogue
                ? (negA !== negB && sharedSubjects.length >= 2)
                : ((negA && !negB && b.affShort) || (negB && !negA && a.affShort) || (negA !== negB && sharedSubjects.length >= 3));

            let numericConflict = false;
            if (!isLongDialogue && a.nums.length > 0 && b.nums.length > 0) {
                const rawSetA = new Set(a.nums.map(n => n.raw));
                const rawSetB = new Set(b.nums.map(n => n.raw));
                const hasExactOverlap = [...rawSetA].some(n => rawSetB.has(n));
                if (!hasExactOverlap) {
                    const comparableMetric = a.nums.some(na =>
                        b.nums.some(nb =>
                            na.unit === nb.unit &&
                            (na.unit !== '' || [...na.context].some(c => nb.context.has(c)) || subjectJaccard >= 0.45)
                        )
                    );
                    if (comparableMetric && (subjectJaccard >= 0.35 || sharedSubjects.length >= 3)) {
                        numericConflict = true;
                    }
                }
            }

            if (polarityConflict || numericConflict) {
                const newerId = Math.max(a.id, b.id);
                const olderId = Math.min(a.id, b.id);
                if (isLongDialogue) {
                    const negItem = negA ? a : b;
                    const affItem = negA ? b : a;
                    const strength = (subjectJaccard * 2.0) + (sharedSubjects.length * 0.15);
                    const prev = bestLongConflictByNegId.get(negItem.id);
                    if (!prev || strength > prev._strength) {
                        bestLongConflictByNegId.set(negItem.id, {
                            _strength: strength,
                            entry: {
                                memory_ids: [olderId, newerId],
                                newer_id: newerId,
                                older_id: olderId,
                                shared_subject: sharedSubjects.slice(0, 5),
                                conflict_type: 'polarity_contradiction',
                                resolution_hint: `Direct contradiction between Memory #${affItem.id} ("${affItem.userExcerpt}...") and Memory #${negItem.id} ("${negItem.userExcerpt}...") without formal supersession.`
                            }
                        });
                    }
                } else {
                    conflicts.push({
                        memory_ids: [olderId, newerId],
                        newer_id: newerId,
                        older_id: olderId,
                        shared_subject: sharedSubjects.slice(0, 5),
                        conflict_type: polarityConflict ? 'polarity_contradiction' : 'value_contradiction',
                        resolution_hint: `Memory #${newerId} is newer than #${olderId}, but #${olderId} remains ACTIVE without formal supersession.`
                    });
                }
            }
        }
    }

    if (bestLongConflictByNegId.size > 0) {
        const dedupedLong = [...bestLongConflictByNegId.values()]
            .sort((x, y) => y._strength - x._strength)
            .slice(0, 3)
            .map(x => x.entry);
        conflicts.push(...dedupedLong);
    }

    return conflicts;
}

/**
 * Vocabulary-free Query Term Attestation diagnostic:
 * Computes which distinctive query terms are absent from the USER statements of the retrieved memories,
 * without using any hardcoded word lists or suppressing retrieved results.
 * @param {string[]} distinctiveTerms
 * @param {Array<object>} packedItems
 * @param {Array<object>} allCandidateRows
 * @returns {string[]}
 */
export function computeUnattestedQueryTerms(distinctiveTerms = [], packedItems = [], allCandidateRows = []) {
    if (!Array.isArray(distinctiveTerms) || distinctiveTerms.length === 0 || packedItems.length === 0) {
        return [];
    }
    const allUserStems = new Set();
    for (const r of allCandidateRows) {
        if (r._userStems) {
            for (const s of r._userStems) allUserStems.add(s);
        }
    }
    if (allUserStems.size === 0) return [];
    return distinctiveTerms.filter(t => t.length >= 3 && !allUserStems.has(stemToken(t)));
}

/**
 * Computes which informative distinctive query terms (`length >= 4`, non-numeric) have zero exact or stemmed
 * occurrences across the ENTIRE candidate store (both USER and ASSISTANT segments plus steering nuggets),
 * without using any hardcoded word lists or suppressing retrieved results.
 * @param {string[]} distinctiveTerms
 * @param {Array<object>} allCandidateRows
 * @param {Array<object>} [nuggetItems=[]]
 * @returns {string[]}
 */
export function computeCorpusUnattestedTerms(distinctiveTerms = [], allCandidateRows = [], nuggetItems = []) {
    if (!Array.isArray(distinctiveTerms) || distinctiveTerms.length === 0 || allCandidateRows.length === 0) {
        return [];
    }
    const corpusStems = new Set();
    for (const r of allCandidateRows) {
        if (r._stems) {
            for (const s of r._stems) corpusStems.add(s);
        }
    }
    for (const n of nuggetItems) {
        const text = `${n.key || ''} ${n.content || n.value || ''}`.toLowerCase();
        for (const tok of text.split(/[^a-z0-9_]+/)) {
            if (tok.length >= 2) corpusStems.add(stemToken(tok));
        }
    }
    if (corpusStems.size === 0) return [];

    return distinctiveTerms.filter(t => {
        if (!t || t.length < 4 || /^\d+$/.test(t)) return false;
        const st = stemToken(t);
        if (corpusStems.has(st) || corpusStems.has(t)) return false;
        for (const r of allCandidateRows) {
            if (r._combinedText && r._combinedText.includes(t)) return false;
        }
        return true;
    });
}

/**
 * Detects passive chronological state updates across retrieved ACTIVE memories (including long conversational
 * dialogue turns) without mutating unresolved contradiction status (`CONFLICTED`).
 * Identifies ordered `(older_id -> newer_id)` pairs on the queried subject where the later memory expresses
 * a state transition or updated contextual quantity in its user statement.
 * @param {Array<object>} activeItems
 * @param {string[]} [domainTerms=[]]
 * @returns {Array<{older_id: number, newer_id: number, shared_subject: string[], older_excerpt: string, newer_excerpt: string}>}
 */
export function detectTemporalUpdates(activeItems = [], domainTerms = []) {
    const memoryItems = activeItems
        .filter(it => it.type === 'memory' && (it.status || 'ACTIVE') === 'ACTIVE')
        .slice()
        .sort((a, b) => Number(a.id) - Number(b.id));
    if (memoryItems.length < 2) return [];

    const ORDINAL_WORDS = new Set([
        'turn', 'session', 'sprint', 'week', 'weeks', 'day', 'days', 'phase', 'part',
        'item', 'step', 'note', 'log', 'milestone', 'batch', 'slot', 'tier', 'id',
        'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
        'september', 'october', 'november', 'december', 'line', 'page', 'section',
        'user', 'asst', 'assistant', 'date', 'conv', 'window'
    ]);
    const METRIC_REGEX = /(?:([a-z0-9_]+)\s+)?(?:\$|€|£)?\b(\d+(?:\.\d+)?)(ms|s|m|h|d|gb|mb|kb|tb|%|px|v|usd|eur|hrs|mins|kg|lbs|mph|km)?\b(?:\s+([a-z0-9_]+))?/gi;

    const stripTurnHeader = (raw) =>
        String(raw || '').replace(/\[[^\]]*\b(?:session|turn)\b[^\]]*\]\s*/gi, '').trim();

    const extractUserClause = (content) => {
        const str = String(content || '');
        const userMatch = str.match(/\buser:\s*([\s\S]*?)(?:\|\s*assistant:|$)/i);
        return stripTurnHeader(userMatch ? userMatch[1] : str);
    };

    const extractStems = (text) => new Set(
        String(text || '')
            .toLowerCase()
            .split(/[^a-z0-9_]+/)
            .filter(w => w.length >= 3 && !STOP_WORDS.has(w) && !TEMPORAL_CUE_WORDS.has(w) && !GENERIC_INFRA_WORDS.has(w) && !META_QUERY_WORDS.has(w) && !ORDINAL_WORDS.has(w) && !/^\d+$/.test(w))
            .map(stemToken)
    );

    const extractUserMetrics = (userText) => {
        const hasCurrency = /[$€£]\s*\d/.test(userText);
        const cleaned = String(userText || '')
            .toLowerCase()
            .replace(/\b(?:v|version|note|log|step|milestone|batch|slot|tier|turn|session|sprint|week|day|phase|part|id)\s*#?\d+(?:\/\d+)?\b/g, ' ')
            .replace(/\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d+(?:,\s*\d{4})?\b/g, ' ')
            .replace(/\b(?:19|20)\d{2}\b/g, ' ')
            .replace(/\s+/g, ' ');
        const out = [];
        for (const m of cleaned.matchAll(METRIC_REGEX)) {
            const prevWord = m[1] || '';
            const numVal = m[2];
            const unit = m[3] || (hasCurrency && /\$\s*\d/.test(m[0]) ? 'usd' : '');
            const nextWord = m[4] || '';
            if (!unit && (ORDINAL_WORDS.has(prevWord) || ORDINAL_WORDS.has(nextWord))) continue;
            const ctx = new Set(
                [prevWord, nextWord]
                    .filter(w => w.length >= 3 && !STOP_WORDS.has(w) && !GENERIC_INFRA_WORDS.has(w) && !ORDINAL_WORDS.has(w))
                    .map(stemToken)
            );
            if (!unit && ctx.size === 0) continue;
            out.push({ raw: `${numVal}${unit}`, unit, ctx });
        }
        return out;
    };

    const nonGenericDomain = domainTerms.filter(t => !STOP_WORDS.has(t) && !GENERIC_INFRA_WORDS.has(t));
    const domainStems = [...new Set((nonGenericDomain.length > 0 ? nonGenericDomain : domainTerms).map(stemToken))];

    const prepared = memoryItems.map(it => {
        const userText = extractUserClause(it.content);
        return {
            id: Number(it.id),
            lineageIds: new Set((it.lineage || []).map(l => Number(l.id))),
            stems: extractStems(userText),
            hasTransition: STATE_TRANSITION_REGEX.test(userText),
            metrics: extractUserMetrics(userText),
            excerpt: userText.replace(/\s+/g, ' ').trim().slice(0, 120)
        };
    });

    const bestByNewerId = new Map();
    for (let j = 1; j < prepared.length; j++) {
        const newer = prepared[j];
        for (let i = 0; i < j; i++) {
            const older = prepared[i];
            if (older.lineageIds.has(newer.id) || newer.lineageIds.has(older.id)) continue;

            const sharedSubjects = [];
            for (const s of older.stems) {
                if (newer.stems.has(s)) sharedSubjects.push(s);
            }
            if (sharedSubjects.length < 2) continue;

            const unionSize = (older.stems.size + newer.stems.size - sharedSubjects.length) || 1;
            const subjectJaccard = sharedSubjects.length / unionSize;

            if (domainStems.length > 0) {
                const matchedQueryStems = domainStems.filter(dt =>
                    sharedSubjects.some(s => s === dt || (dt.length >= 5 && (s.startsWith(dt) || dt.startsWith(s))))
                );
                if (matchedQueryStems.length < 1) continue;
                if (domainStems.length >= 3 && matchedQueryStems.length < 2 && subjectJaccard < 0.22) continue;
            }

            let comparableMetricShift = false;
            if (older.metrics.length > 0 && newer.metrics.length > 0) {
                const rawOlder = new Set(older.metrics.map(x => x.raw));
                const rawNewer = new Set(newer.metrics.map(x => x.raw));
                const exactSame = [...rawOlder].some(v => rawNewer.has(v));
                if (!exactSame) {
                    comparableMetricShift = older.metrics.some(ma =>
                        newer.metrics.some(mb =>
                            ma.unit === mb.unit &&
                            (
                                (ma.unit !== '' && [...ma.ctx].some(c => mb.ctx.has(c))) ||
                                (ma.unit !== '' && subjectJaccard >= 0.28) ||
                                [...ma.ctx].some(c => mb.ctx.has(c)) && subjectJaccard >= 0.24
                            )
                        )
                    );
                }
            }

            if (!newer.hasTransition && !comparableMetricShift) continue;

            const strength =
                (newer.hasTransition ? 0.5 : 0) +
                (comparableMetricShift ? 0.45 : 0) +
                subjectJaccard * 1.6 +
                sharedSubjects.length * 0.12;

            const prev = bestByNewerId.get(newer.id);
            if (!prev || strength > prev._strength) {
                bestByNewerId.set(newer.id, {
                    _strength: strength,
                    entry: {
                        older_id: older.id,
                        newer_id: newer.id,
                        shared_subject: sharedSubjects.slice(0, 5),
                        older_excerpt: older.excerpt,
                        newer_excerpt: newer.excerpt
                    }
                });
            }
        }
    }

    return [...bestByNewerId.values()]
        .sort((a, b) => (b.entry.newer_id - a.entry.newer_id) || (b._strength - a._strength))
        .slice(0, 3)
        .map(x => x.entry);
}

const USER_DIALOGUE_SEGMENT_REGEX = /\buser:\s*([\s\S]*?)(?:\|\s*assistant\b:?|$)/i;
const USER_DIALOGUE_GLOBAL_REGEX = /\buser:\s*([\s\S]*?)(?:\|\s*assistant\b:?|(?=\[[^\]]*\bsession\b)|$)/gi;
const SESSION_HEADER_ID_REGEX = /\[[^\]]*\bsession[\s_-]+(\d+)\b/i;

function extractUserSegmentOnly(raw = '') {
    const str = String(raw || '');
    if (!str) return '';
    const segments = [];
    for (const m of str.matchAll(USER_DIALOGUE_GLOBAL_REGEX)) {
        if (m[1]) segments.push(m[1].trim());
    }
    return segments.length > 0 ? segments.join(' ') : str;
}

function addTokenizedStems(text = '', targetSet = new Set()) {
    const lower = String(text || '').toLowerCase();
    for (const tok of lower.split(/[^a-z0-9_]+/)) {
        if (tok.length >= 2) {
            targetSet.add(stemToken(tok));
        }
    }
    return targetSet;
}

function parseCandidateSessionId(row) {
    if (!row || typeof row !== 'object') return null;
    if (row._sessionId !== undefined && row._sessionId !== null && Number.isFinite(Number(row._sessionId))) {
        return Number(row._sessionId);
    }
    const content = String(row.content || '');
    const match = content.match(SESSION_HEADER_ID_REGEX);
    if (match) {
        const parsed = Number(match[1]);
        if (Number.isFinite(parsed)) return parsed;
    }
    const rawTags = row.tags ? String(row.tags) : '';
    if (rawTags) {
        const tagMatch = rawTags.match(/\bsession[\s_-]*(\d+)\b/i);
        if (tagMatch) {
            const parsed = Number(tagMatch[1]);
            if (Number.isFinite(parsed)) return parsed;
        }
    }
    return null;
}

function parseCandidateTurnSpan(row) {
    if (!row || typeof row !== 'object') return null;
    const content = String(row.content || '');
    const m = content.match(/\[[^\]]*\bTurn\s*#\s*(\d+)(?:\s*\/\s*(\d+))?\b/i);
    if (!m) return null;
    const start = Number(m[1]);
    if (!Number.isFinite(start)) return null;
    const second = m[2] !== undefined ? Number(m[2]) : null;
    // Handle paired USER/ASSISTANT message spans (`Turn #0/1`, `Turn #2/3`) vs single-turn ordinals (`Turn #4/24`)
    const end = (second !== null && Number.isFinite(second) && second === start + 1)
        ? second
        : start;
    return { start, end };
}

/**
 * Vocabulary-free Compositional Attribute Grounding Evaluator (Pillar 3):
 * Evaluates whether queried attributes are jointly attested with their entity/topic anchors
 * inside USER statements across +-1 same-session turn windows, without any hardcoded word lists.
 *
 * @param {string[]} [distinctiveTerms=[]]
 * @param {Array<object>} [packedItems=[]]
 * @param {Array<object>} [allCandidateRows=[]]
 * @param {{ maxRawCosine?: number, isGenerativeAdvisory?: boolean }} [options={}]
 * @returns {{
 *   status: 'GROUNDED' | 'UNATTESTED_ATTRIBUTE' | 'UNSUPPORTED',
 *   attested_anchors: string[],
 *   unattested_user_terms: string[],
 *   unlinked_attribute_terms: string[],
 *   max_joint_user_coverage: number,
 *   max_raw_cosine: number
 * }}
 */
export function evaluateAttributeGrounding(
    distinctiveTerms = [],
    packedItems = [],
    allCandidateRows = [],
    options = {}
) {
    const { maxRawCosine = 1.0, isGenerativeAdvisory = false } = options || {};
    const rawCos = Number.isFinite(maxRawCosine) ? Number(maxRawCosine) : 1.0;
    const roundedRawCos = Number(rawCos.toFixed(4));

    const seenTerms = new Set();
    const terms = [];
    if (Array.isArray(distinctiveTerms)) {
        for (const raw of distinctiveTerms) {
            if (typeof raw !== 'string') continue;
            const t = raw.trim().toLowerCase();
            if (t && t.length >= 3 && !/^\d+$/.test(t) && !seenTerms.has(t)) {
                seenTerms.add(t);
                terms.push(t);
            }
        }
    }

    const compoundQueryTerms = [];
    const queryStemSet = new Set();
    for (const t of terms) {
        const stem = stemToken(t);
        if (stem) {
            queryStemSet.add(stem);
            if (/[._-]/.test(t)) {
                compoundQueryTerms.push({ term: t, stem });
            }
        }
    }

    if (
        isGenerativeAdvisory ||
        terms.length < 2 ||
        queryStemSet.size < 2 ||
        !Array.isArray(allCandidateRows) ||
        allCandidateRows.length === 0
    ) {
        return {
            status: 'GROUNDED',
            attested_anchors: [],
            unattested_user_terms: [],
            unlinked_attribute_terms: [],
            max_joint_user_coverage: 1,
            max_raw_cosine: roundedRawCos
        };
    }

    const getUserStemsForRow = (r) => {
        if (!r || typeof r !== 'object') return new Set();
        const structuredChain = (Array.isArray(r.lineage) && r.lineage.length > 1)
            ? r.lineage
            : ((Array.isArray(r._lineageChain) && r._lineageChain.length > 1) ? r._lineageChain : null);
        const lineageUserLower = structuredChain
            ? structuredChain.map(s => extractUserSegmentOnly(s?.content || '')).join(' ').toLowerCase()
            : ((r._lineageText || r.lineageText)
                ? extractUserSegmentOnly(r._lineageText || r.lineageText).toLowerCase()
                : '');
        const tagsLower = r.tags ? String(r.tags).toLowerCase() : '';

        if (r._userStems instanceof Set && r._userStems.size > 0) {
            const needCompoundCheck = compoundQueryTerms.length > 0;
            const userText = needCompoundCheck
                ? `${r._userRaw || extractUserSegmentOnly(r.content || '').toLowerCase()} ${tagsLower} ${lineageUserLower}`
                : '';
            const matchedCompounds = needCompoundCheck
                ? compoundQueryTerms.filter(ct => userText.includes(ct.term))
                : [];
            if (!lineageUserLower && !tagsLower && matchedCompounds.length === 0) {
                return r._userStems;
            }
            const merged = new Set(r._userStems);
            if (tagsLower) addTokenizedStems(tagsLower, merged);
            if (lineageUserLower) addTokenizedStems(lineageUserLower, merged);
            for (const ct of matchedCompounds) merged.add(ct.stem);
            return merged;
        }

        const rawContent = String(r.content || '');
        const userMatch = rawContent.match(USER_DIALOGUE_SEGMENT_REGEX);
        const baseText = userMatch ? userMatch[1] : rawContent;
        const userText = `${baseText} ${tagsLower} ${lineageUserLower}`.toLowerCase();
        const stems = addTokenizedStems(userText, new Set());
        if (compoundQueryTerms.length > 0) {
            for (const ct of compoundQueryTerms) {
                if (userText.includes(ct.term)) stems.add(ct.stem);
            }
        }
        return stems;
    };

    const annotatedRows = allCandidateRows.map((r, origIdx) => {
        const id = Number(r?.id || 0);
        const sessionId = parseCandidateSessionId(r);
        const turnSpan = parseCandidateTurnSpan(r);
        return { r, origIdx, id, sessionId, turnSpan };
    });

    // Map row id -> sessionId before sorting so tag-only session rows separated only by interleaved other-session/atomic IDs remain adjacent
    const sessionByRowId = new Map();
    for (let i = 0; i < annotatedRows.length; i++) {
        const item = annotatedRows[i];
        if (Number.isFinite(item.id) && item.id > 0) {
            sessionByRowId.set(item.id, item.sessionId);
        }
    }

    annotatedRows.sort((a, b) => {
        const aNull = a.sessionId === null ? 1 : 0;
        const bNull = b.sessionId === null ? 1 : 0;
        if (aNull !== bNull) return aNull - bNull;
        if (a.sessionId !== b.sessionId) return (a.sessionId || 0) - (b.sessionId || 0);
        const aOrder = a.turnSpan !== null ? a.turnSpan.start : a.id;
        const bOrder = b.turnSpan !== null ? b.turnSpan.start : b.id;
        if (aOrder !== bOrder) return aOrder - bOrder;
        if (a.id !== b.id) return a.id - b.id;
        return a.origIdx - b.origIdx;
    });

    const corpusN = annotatedRows.length;
    const dfByStem = new Map();
    for (const s of queryStemSet) dfByStem.set(s, 0);

    const rowQueryStems = new Array(corpusN);
    const rowSessionIds = new Array(corpusN);
    const rowIds = new Array(corpusN);
    const rowTurnSpans = new Array(corpusN);

    for (let i = 0; i < corpusN; i++) {
        const entry = annotatedRows[i];
        rowIds[i] = entry.id;
        rowSessionIds[i] = entry.sessionId;
        rowTurnSpans[i] = entry.turnSpan;
        const uStems = getUserStemsForRow(entry.r);
        let matched = null;
        for (const s of queryStemSet) {
            if (uStems.has(s)) {
                dfByStem.set(s, (dfByStem.get(s) || 0) + 1);
                if (!matched) matched = new Set();
                matched.add(s);
            }
        }
        rowQueryStems[i] = matched;
    }

    const areAdjacentSameSessionTurns = (idxA, idxB) => {
        if (idxB < 0 || idxB >= corpusN) return false;
        const sessA = rowSessionIds[idxA];
        if (sessA === null || rowSessionIds[idxB] !== sessA) return false;
        const spA = rowTurnSpans[idxA];
        const spB = rowTurnSpans[idxB];
        if (spA !== null && spB !== null) {
            return Math.max(spA.start, spB.start) - Math.min(spA.end, spB.end) <= 1;
        }
        const idA = rowIds[idxA];
        const idB = rowIds[idxB];
        if (Number.isFinite(idA) && Number.isFinite(idB) && idA > 0 && idB > 0) {
            const delta = Math.abs(idB - idA);
            if (delta <= 1) return true;
            if (delta <= 8) {
                const lo = Math.min(idA, idB);
                const hi = Math.max(idA, idB);
                for (let mid = lo + 1; mid < hi; mid++) {
                    if (!sessionByRowId.has(mid) || sessionByRowId.get(mid) === sessA) {
                        return false;
                    }
                }
                return true;
            }
        }
        return false;
    };

    const packedUserStems = new Set();
    const firstPackedIdxByStem = new Map();
    if (Array.isArray(packedItems)) {
        let memRank = 0;
        for (const it of packedItems) {
            if (!it || (it.type !== undefined && it.type !== 'memory')) continue;
            const itStems = getUserStemsForRow(it);
            for (const s of queryStemSet) {
                if (itStems.has(s)) {
                    packedUserStems.add(s);
                    if (!firstPackedIdxByStem.has(s)) {
                        firstPackedIdxByStem.set(s, memRank);
                    }
                }
            }
            memRank++;
        }
    }

    const termEntries = terms.map(t => {
        const stem = stemToken(t);
        return {
            term: t,
            stem,
            dfUser: dfByStem.get(stem) || 0
        };
    });

    const windows = new Array(corpusN);
    let maxJointCoverage = 0;
    for (let k = 0; k < corpusN; k++) {
        const currSet = rowQueryStems[k];
        const prevSet = areAdjacentSameSessionTurns(k, k - 1)
            ? rowQueryStems[k - 1]
            : null;
        const nextSet = areAdjacentSameSessionTurns(k, k + 1)
            ? rowQueryStems[k + 1]
            : null;

        let wk = null;
        if (currSet && !prevSet && !nextSet) {
            wk = currSet;
        } else if (currSet || prevSet || nextSet) {
            wk = new Set();
            if (prevSet) for (const s of prevSet) wk.add(s);
            if (currSet) for (const s of currSet) wk.add(s);
            if (nextSet) for (const s of nextSet) wk.add(s);
        }
        windows[k] = wk;

        if (wk && wk.size > 0) {
            const cov = wk.size / queryStemSet.size;
            if (cov > maxJointCoverage) maxJointCoverage = cov;
        }
    }

    const anchorEntries = termEntries
        .filter(e => e.dfUser >= 1 && packedUserStems.has(e.stem))
        .slice()
        .sort((a, b) => {
            if (a.dfUser !== b.dfUser) return a.dfUser - b.dfUser;
            const rankA = firstPackedIdxByStem.get(a.stem) ?? Infinity;
            const rankB = firstPackedIdxByStem.get(b.stem) ?? Infinity;
            if (rankA !== rankB) return rankA - rankB;
            return b.term.length - a.term.length;
        });

    const attested_anchors = anchorEntries.map(e => e.term);
    const uniqueAnchorStemCount = new Set(anchorEntries.map(e => e.stem)).size;

    const unattestedEntries = termEntries.filter(e => e.term.length >= 4 && e.dfUser === 0);
    const unattested_user_terms = unattestedEntries.map(e => e.term);
    const uniqueUnattestedStemCount = new Set(unattestedEntries.map(e => e.stem)).size;

    const sharesWindow = (stemA, stemB) => {
        if (stemA === stemB) return true;
        for (let k = 0; k < corpusN; k++) {
            const wk = windows[k];
            if (wk && wk.has(stemA) && wk.has(stemB)) return true;
        }
        return false;
    };

    const unlinked_attribute_terms = [];
    const unlinkedStemSet = new Set();
    if (anchorEntries.length >= 1) {
        const ubiquitousCeiling = Math.max(3, corpusN * 0.40);
        const nonUbiquitous = anchorEntries.filter(e => e.dfUser <= ubiquitousCeiling);
        const anchorPool = nonUbiquitous.length > 0 ? nonUbiquitous : anchorEntries;

        let primaryFirst = anchorPool[0];
        if ((firstPackedIdxByStem.get(primaryFirst.stem) ?? Infinity) > 0) {
            const topPackedAnchor = anchorPool.find(e => firstPackedIdxByStem.get(e.stem) === 0);
            if (topPackedAnchor && !sharesWindow(primaryFirst.stem, topPackedAnchor.stem)) {
                primaryFirst = topPackedAnchor;
            }
        }

        const primaryAnchorStems = new Set([primaryFirst.stem]);
        if (queryStemSet.size >= 3 && anchorPool.length >= 2) {
            const secondCandidate = anchorPool.find(
                e => e.stem !== primaryFirst.stem &&
                     (nonUbiquitous.length === 0 || e.dfUser <= ubiquitousCeiling) &&
                     sharesWindow(primaryFirst.stem, e.stem)
            );
            if (secondCandidate) {
                primaryAnchorStems.add(secondCandidate.stem);
            }
        }

        for (const entry of termEntries) {
            if (entry.term.length < 4 || entry.dfUser < 1 || primaryAnchorStems.has(entry.stem)) {
                continue;
            }
            let linked = false;
            for (let k = 0; k < corpusN; k++) {
                const wk = windows[k];
                if (!wk || !wk.has(entry.stem)) continue;
                for (const anchorStem of primaryAnchorStems) {
                    if (wk.has(anchorStem)) {
                        linked = true;
                        break;
                    }
                }
                if (linked) break;
            }
            if (!linked) {
                unlinked_attribute_terms.push(entry.term);
                unlinkedStemSet.add(entry.stem);
            }
        }
    }

    // Extreme-value cosine scaling for large episodic stores (max of N isotropic unit-sphere draws grows with log(N))
    const extremeLogScale = corpusN >= 50
        ? Math.min(3.5, Math.log10(corpusN / 25))
        : 0;
    const unsupportedCosCeiling = 0.42 + 0.032 * extremeLogScale;
    const unattestedAttrCosCeiling = 0.50 + 0.045 * extremeLogScale;

    let status = 'GROUNDED';
    if (
        queryStemSet.size >= 3 &&
        rawCos < unsupportedCosCeiling &&
        (
            (uniqueAnchorStemCount === 0 && maxJointCoverage <= 0.25) ||
            (uniqueUnattestedStemCount >= 2 && maxJointCoverage <= 0.34)
        )
    ) {
        status = 'UNSUPPORTED';
    } else if (
        uniqueAnchorStemCount >= 1 &&
        rawCos < unattestedAttrCosCeiling &&
        maxJointCoverage < 0.65 &&
        (uniqueUnattestedStemCount >= 1 || unlinkedStemSet.size >= 1)
    ) {
        status = 'UNATTESTED_ATTRIBUTE';
    }

    return {
        status,
        attested_anchors,
        unattested_user_terms,
        unlinked_attribute_terms,
        max_joint_user_coverage: Number(maxJointCoverage.toFixed(4)),
        max_raw_cosine: roundedRawCos
    };
}

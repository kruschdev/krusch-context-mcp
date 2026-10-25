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


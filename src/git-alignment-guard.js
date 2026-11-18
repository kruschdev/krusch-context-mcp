/**
 * @module git-alignment-guard
 * Zero-LLM deterministic Git & Co-Change alignment guards for krusch-context-mcp:
 *
 * 1. Old-Hunk & Pre-Edit Snippet `git blame -w -M` Attribution (INV-ALIGN-BLAME-01):
 *    Parses `@@ -start,count` old-side hunks from unified diffs OR locates verbatim /
 *    prefix-suffix modified line spans on `pre_edit` snippets, runs a single batched
 *    `git blame -w -M --porcelain` per file (zero shell interpolation, fail-open deadline),
 *    and joins authoring commit SHAs / explicit PR numbers / overlapping line spans against
 *    project-scoped active memories (`decision`, `invariant`, `blocker`, `bug`).
 *
 * 2. Reverse Supersession `stale-code` Scanner (INV-ALIGN-STALE-02):
 *    Walks `SUPERSEDED -> ACTIVE` lineage (`superseded_by`) that carries a commit SHA,
 *    exempts code explicitly re-ratified by the active replacement (`anchor_hash` or
 *    `quoted_sentence` parity), scopes blame to `[start_line, end_line]` / `quoted_sentence`
 *    when span-anchored, and scans `HEAD` via `git blame -w -M --porcelain` to pinpoint
 *    surviving stale lines.
 *
 * 3. Deterministic Co-Change Companion-File Gate (INV-ALIGN-COCHANGE-03):
 *    Evaluates `--when <glob> --require <glob>` companion-file invariants against
 *    multi-file / pre-commit unified diffs (including quoted paths, `git mv` renames, and
 *    `git cp` copies) with zero LLM calls, and surfaces malformed rule syntax explicitly.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findGitRoot } from './project-helper.js';
import { resolveProjectPath } from './sqlite-engine.js';

const PROSE_EXTENSIONS = /\.(?:md|mdx|markdown|txt|rst|adoc)$/i;
const CODE_EXTENSIONS = /\.[a-z][a-z0-9]*$/i;
const PROSE_BASENAMES = /^(?:readme|licen[sc]e|copying|notice|authors|contributors|changelog|changes|history|news|security|code_of_conduct|contributing)(?:[-.].+)?$/i;
const LOCKFILE_NAMES = new Set([
    'package-lock.json',
    'npm-shrinkwrap.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'bun.lockb',
    'cargo.lock',
    'gemfile.lock',
    'poetry.lock',
    'uv.lock',
    'composer.lock',
    'go.sum'
]);

/** Mechanical commit prefixes whose PR/commit numbers should not trigger behavioral PR-only matches. */
const MECHANICAL_COMMIT_SUBJECT_RE = /^(?:style|docs|chore|ci|build|test)(?:\([^)]*\))?!?:\s/i;

export const DEFAULT_BLAME_BUDGET_MS = 1500;
export const DEFAULT_STALE_BUDGET_MS = 2000;
const MAX_BLAME_FILES = 3;
const MAX_HUNK_LINES = 200;
const MAX_SNIPPET_OCCURRENCES = 3;
const MAX_STALE_FILES_PER_DECISION = 10;
const MAX_BLAMEABLE_FILE_BYTES = 262_144;
const UNCOMMITTED_ZERO_SHA_RE = /^0{40}$/;
const HEX_SHA_RE = /^[0-9a-f]{7,40}$/i;

/**
 * Fast check skipping prose docs, changelogs, licenses (`LICENSE-MIT`, `LICENSE-APACHE-2.0`),
 * and package manager lockfiles before spawning `git blame`, while still blaming code files
 * like `license-validator.js`.
 *
 * @param {string} filePath
 * @returns {boolean}
 */
export function isProseOrGeneratedFile(filePath) {
    if (!filePath || typeof filePath !== 'string') return true;
    const base = path.basename(filePath.replace(/\\/g, '/'));
    const lower = base.toLowerCase();
    if (!base) return true;
    if (PROSE_EXTENSIONS.test(base) || LOCKFILE_NAMES.has(lower) || lower.endsWith('.lock')) {
        return true;
    }
    if (/^(?:readme|licen[sc]e|copying|notice|authors|contributors|changelog|changes)$/i.test(base)) {
        return true;
    }
    return PROSE_BASENAMES.test(base) && !CODE_EXTENSIONS.test(base);
}

/**
 * Unquotes C-escaped Git diff paths (`"a/dir/my file.js"`, `\t`, `\n`, octal `\303\251`).
 *
 * @param {string} raw
 * @returns {string}
 */
function unquoteGitPath(raw) {
    const trimmed = String(raw || '').trim();
    if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
        const inner = trimmed.slice(1, -1);
        const bytes = [];
        for (let i = 0; i < inner.length; i++) {
            const ch = inner[i];
            if (ch === '\\' && i + 1 < inner.length) {
                const next = inner[i + 1];
                if (/[0-7]{3}/.test(inner.slice(i + 1, i + 4))) {
                    bytes.push(parseInt(inner.slice(i + 1, i + 4), 8));
                    i += 3;
                    continue;
                }
                const escMap = { n: 10, t: 9, r: 13, '\\': 92, '"': 34 };
                if (Object.prototype.hasOwnProperty.call(escMap, next)) {
                    bytes.push(escMap[next]);
                    i += 1;
                    continue;
                }
            }
            const encoded = Buffer.from(ch, 'utf8');
            for (const b of encoded) bytes.push(b);
        }
        return Buffer.from(bytes).toString('utf8');
    }
    if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
}

/**
 * Normalizes a repo-relative path from diff headers (`a/foo`, `b/foo`, `"a/my file.js"`, `./foo`),
 * returning `null` on `/dev/null`, traversal (`..`), or control characters.
 *
 * @param {string} rawPath
 * @returns {string|null}
 */
export function normalizeRepoRelativePath(rawPath) {
    if (!rawPath || typeof rawPath !== 'string') return null;
    let cleaned = unquoteGitPath(rawPath);
    if (!cleaned || cleaned === '/dev/null' || cleaned.includes('\0')) return null;
    cleaned = cleaned.replace(/\\/g, '/');
    if (cleaned === 'a/dev/null' || cleaned === 'b/dev/null' || cleaned === '/dev/null') return null;
    if (/^[ab]\//.test(cleaned)) {
        cleaned = cleaned.slice(2);
    }
    cleaned = cleaned.replace(/^(?:\.\/)+/, '').replace(/^\/+/, '');
    if (!cleaned) return null;
    const segments = cleaned.split('/');
    if (segments.some((seg) => !seg || seg === '.' || seg === '..')) return null;
    return cleaned;
}

/**
 * Splits a `diff --git` header rest (`a/foo b/foo` or `"a/my file.js" "b/my file.js"`) into two raw paths.
 *
 * @param {string} rest
 * @returns {[string, string]|null}
 */
function parseDiffGitPair(rest) {
    const s = String(rest || '').trim();
    if (!s) return null;
    if (s.startsWith('"')) {
        let i = 1;
        while (i < s.length) {
            if (s[i] === '\\') { i += 2; continue; }
            if (s[i] === '"') break;
            i += 1;
        }
        if (i >= s.length) return null;
        const first = s.slice(0, i + 1);
        const second = s.slice(i + 1).trim();
        return second ? [first, second] : null;
    }
    const bIdx = s.indexOf(' b/');
    if (bIdx !== -1) {
        return [s.slice(0, bIdx), s.slice(bIdx + 1)];
    }
    const qIdx = s.indexOf(' "b/');
    if (qIdx !== -1) {
        return [s.slice(0, qIdx), s.slice(qIdx + 1)];
    }
    const ws = /^(\S+)\s+(\S+)$/.exec(s);
    return ws ? [ws[1], ws[2]] : null;
}

/**
 * Checks whether raw text contains unified git diff structure.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isUnifiedDiffText(text) {
    if (!text || typeof text !== 'string') return false;
    return /^(?:diff --git\s|---\s+(?:[ab]\/|"?[ab]\/|\/dev\/null)|\+\+\+\s+(?:[ab]\/|"?[ab]\/|\/dev\/null)|@@\s+-\d+)/m.test(text);
}

/**
 * Extracts all touched repository-relative file paths from a unified diff,
 * including quoted paths with spaces and both source and destination paths on `git mv` / `git cp`.
 *
 * @param {string} diffText
 * @returns {string[]}
 */
export function extractDiffTouchedFiles(diffText) {
    if (!diffText || typeof diffText !== 'string') return [];
    const seen = new Set();
    const lines = diffText.split(/\r?\n/);

    for (const line of lines) {
        if (line.startsWith('diff --git ')) {
            const pair = parseDiffGitPair(line.slice(11));
            if (pair) {
                const left = normalizeRepoRelativePath(pair[0]);
                const right = normalizeRepoRelativePath(pair[1]);
                if (left) seen.add(left);
                if (right) seen.add(right);
            }
            continue;
        }

        const renameOrCopy = /^(?:rename|copy) (?:from|to)\s+(.+)$/.exec(line);
        if (renameOrCopy) {
            const p = normalizeRepoRelativePath(renameOrCopy[1]);
            if (p) seen.add(p);
            continue;
        }

        const headerMatch = /^(?:---|\+\+\+)\s+([^\t\r\n]+)/.exec(line);
        if (headerMatch) {
            const norm = normalizeRepoRelativePath(headerMatch[1]);
            if (norm) seen.add(norm);
        }
    }

    return Array.from(seen);
}

/**
 * Parses old-side hunk line ranges (`@@ -start[,count] +... @@`) per file from a unified diff.
 * Pure additions (`count === 0` or `--- /dev/null`) produce no old-side lines to blame.
 *
 * @param {string} diffText
 * @param {{ maxHunkLines?: number }} [options]
 * @returns {Map<string, Array<[number, number]>>}
 */
export function parseDiffOldHunks(diffText, { maxHunkLines = MAX_HUNK_LINES } = {}) {
    const hunksByFile = new Map();
    if (!diffText || typeof diffText !== 'string') return hunksByFile;

    let currentOldFile = null;
    for (const line of diffText.split(/\r?\n/)) {
        if (line.startsWith('diff --git ')) {
            currentOldFile = null;
            continue;
        }
        const fromMatch = /^---\s+([^\t\r\n]+)/.exec(line);
        if (fromMatch) {
            const rawTarget = fromMatch[1].trim();
            currentOldFile = rawTarget === '/dev/null' ? null : normalizeRepoRelativePath(rawTarget);
            continue;
        }
        const hunkMatch = /^@@\s+-(\d+)(?:,(\d+))?\s+\+\d+(?:,\d+)?\s+@@/.exec(line);
        if (hunkMatch && currentOldFile) {
            const start = Number(hunkMatch[1]);
            const count = hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]);
            if (Number.isInteger(start) && start >= 1 && count > 0) {
                const boundedEnd = start + Math.min(count, maxHunkLines) - 1;
                const list = hunksByFile.get(currentOldFile) || [];
                list.push([start, boundedEnd]);
                hunksByFile.set(currentOldFile, list);
            }
        }
    }

    return hunksByFile;
}

/**
 * Resolves 1-indexed old-file line ranges when `nudge` is called on `pre_edit` with a code snippet
 * or full-file replacement + `file_path` (no unified diff header required).
 *
 * @param {string} currentFileText - Current on-disk UTF-8 content of `file_path`.
 * @param {string} snippetText - Proposed edit snippet or full-file content.
 * @returns {Array<[number, number]>}
 */
export function resolvePreEditSnippetRanges(currentFileText, snippetText) {
    if (!currentFileText || !snippetText) return [];
    const cur = String(currentFileText).replace(/\r\n/g, '\n');
    const snip = String(snippetText).replace(/\r\n/g, '\n').replace(/\n+$/, '');
    const trimmed = snip.trim();
    if (!trimmed) return [];

    const lineNumberAt = (text, charOffset) => {
        let line = 1;
        for (let idx = text.indexOf('\n'); idx !== -1 && idx < charOffset; idx = text.indexOf('\n', idx + 1)) {
            line += 1;
        }
        return line;
    };

    // 1. Exact substring occurrence(s) in current file (old_string / context snippet)
    const exactRanges = [];
    for (const needle of [snip, trimmed]) {
        if (!needle) continue;
        const lineSpan = needle.split('\n').length - 1;
        let pos = cur.indexOf(needle);
        while (pos !== -1 && exactRanges.length < MAX_SNIPPET_OCCURRENCES) {
            const startLine = lineNumberAt(cur, pos);
            exactRanges.push([startLine, Math.min(startLine + lineSpan, startLine + MAX_HUNK_LINES - 1)]);
            pos = cur.indexOf(needle, pos + needle.length);
        }
        if (exactRanges.length > 0) return exactRanges;
    }

    // 2. Full-file replacement prefix/suffix trim (identifies the exact replaced middle region)
    const curLines = cur.replace(/\n+$/, '').split('\n');
    const nextLines = snip.split('\n');
    if (nextLines.length >= 2 && curLines.length >= 2) {
        let head = 0;
        while (head < curLines.length && head < nextLines.length && curLines[head] === nextLines[head]) {
            head += 1;
        }
        let tail = 0;
        while (
            tail < curLines.length - head &&
            tail < nextLines.length - head &&
            curLines[curLines.length - 1 - tail] === nextLines[nextLines.length - 1 - tail]
        ) {
            tail += 1;
        }
        if (head > 0 || tail > 0) {
            const endLine = curLines.length - tail;
            if (endLine >= head + 1) {
                return [[head + 1, Math.min(endLine, head + MAX_HUNK_LINES)]];
            }
        }
    }

    // 3. Individual trimmed non-trivial line matches (>= 12 chars) inside current file
    const matchedLineNums = [];
    const curTrimmedMap = new Map();
    for (let i = 0; i < curLines.length; i++) {
        const t = curLines[i].trim();
        if (t.length >= 12 && !curTrimmedMap.has(t)) {
            curTrimmedMap.set(t, i + 1);
        }
    }
    for (const rawLine of nextLines) {
        const t = rawLine.trim();
        if (t.length >= 12 && curTrimmedMap.has(t)) {
            matchedLineNums.push(curTrimmedMap.get(t));
            if (matchedLineNums.length >= MAX_HUNK_LINES) break;
        }
    }
    return coalesceLineRanges(matchedLineNums).slice(0, MAX_SNIPPET_OCCURRENCES);
}

/**
 * Compiles a safe glob pattern supporting `*`, `**`, and `?` only.
 * Refuses unsupported syntax (`{a,b}`, `[abc]`, `!`, `\`) explicitly rather than silently failing to match.
 *
 * @param {string} pattern
 * @returns {{ valid: boolean, pattern: string, regex: RegExp|null, error: string|null }}
 */
export function compileSafeCoChangeGlob(pattern) {
    const raw = typeof pattern === 'string' ? pattern.trim() : '';
    if (!raw) {
        return { valid: false, pattern: raw, regex: null, error: 'Empty glob pattern.' };
    }
    if (/[{}\[\]!\\]/.test(raw)) {
        return {
            valid: false,
            pattern: raw,
            regex: null,
            error: `Unsupported glob syntax in "${raw}": only *, **, and ? are allowed.`
        };
    }
    const normalized = raw.replace(/^(?:\.\/)+/, '').replace(/^\/+/, '');
    if (!normalized || normalized.split('/').includes('..')) {
        return { valid: false, pattern: raw, regex: null, error: `Invalid relative glob "${raw}".` };
    }

    let rx = '^';
    let i = 0;
    while (i < normalized.length) {
        const ch = normalized[i];
        if (ch === '*' && normalized[i + 1] === '*') {
            const prevIsSlashOrStart = i === 0 || normalized[i - 1] === '/';
            const nextIdx = i + 2;
            if (prevIsSlashOrStart && normalized[nextIdx] === '/') {
                rx += '(?:[^/]+/)*';
                i += 3;
                continue;
            }
            rx += '.*';
            i += 2;
            continue;
        }
        if (ch === '*') {
            rx += '[^/]*';
            i += 1;
            continue;
        }
        if (ch === '?') {
            rx += '[^/]';
            i += 1;
            continue;
        }
        rx += /[.+^$()|]/.test(ch) ? `\\${ch}` : ch;
        i += 1;
    }
    rx += '$';
    return { valid: true, pattern: normalized, regex: new RegExp(rx), error: null };
}

/**
 * Evaluates deterministic `--when <glob> --require <glob>` co-change rules against
 * a unified diff or an explicit list of changed files.
 *
 * @param {{ diff?: string, changedFiles?: string[], rules?: Array<object>, matchSubpaths?: boolean }} [params]
 * @returns {{ passed: boolean, touchedFiles: string[], violations: Array<object>, invalidRules: Array<object> }}
 */
export function evaluateCoChangeRules({
    diff = '',
    changedFiles = [],
    rules = [],
    matchSubpaths = true
} = {}) {
    const touchedSet = new Set(extractDiffTouchedFiles(diff));
    if (Array.isArray(changedFiles)) {
        for (const f of changedFiles) {
            const norm = normalizeRepoRelativePath(f);
            if (norm) touchedSet.add(norm);
        }
    }
    const touchedFiles = Array.from(touchedSet);
    const violations = [];
    const invalidRules = [];

    if (!Array.isArray(rules) || rules.length === 0) {
        return { passed: true, touchedFiles, violations, invalidRules };
    }

    for (const rule of rules) {
        if (!rule || typeof rule !== 'object') continue;
        const ruleId = String(rule.id || rule.key || 'cochange-rule');
        const rawWhen = Array.isArray(rule.whenGlobs || rule.when)
            ? (rule.whenGlobs || rule.when)
            : (rule.when ? [rule.when] : []);
        const rawReq = Array.isArray(rule.requireGlobs || rule.require)
            ? (rule.requireGlobs || rule.require)
            : (rule.require ? [rule.require] : []);

        if (rawWhen.length === 0 || rawReq.length === 0) {
            invalidRules.push({ id: ruleId, error: 'Both whenGlobs and requireGlobs must be non-empty.' });
            continue;
        }

        const compiledWhen = rawWhen.map((g) => compileSafeCoChangeGlob(g));
        const compiledReq = rawReq.map((g) => compileSafeCoChangeGlob(g));
        const bad = [...compiledWhen, ...compiledReq].find((c) => !c.valid);
        if (bad) {
            invalidRules.push({ id: ruleId, error: bad.error });
            continue;
        }

        if (touchedFiles.length === 0) continue;

        const matchesGlob = (file, compiled) =>
            compiled.regex.test(file) || (matchSubpaths && touchedMatchesSuffixGlob(file, compiled));

        const triggeredBy = touchedFiles.filter((file) => compiledWhen.some((c) => matchesGlob(file, c)));
        if (triggeredBy.length === 0) continue;

        const satisfied = touchedFiles.some((file) => compiledReq.some((c) => matchesGlob(file, c)));
        if (!satisfied) {
            const missingAnyOf = compiledReq.map((c) => c.pattern);
            const desc = String(
                rule.description ||
                rule.content ||
                `Changes matching ${compiledWhen.map((c) => c.pattern).join(', ')} require updating ${missingAnyOf.join(' or ')}.`
            );
            violations.push({
                id: ruleId,
                category: rule.category || 'invariant',
                description: desc,
                triggeredBy,
                missingAnyOf,
                provenance: rule.provenance || null
            });
        }
    }

    return {
        passed: violations.length === 0 && invalidRules.length === 0,
        touchedFiles,
        violations,
        invalidRules
    };
}

function touchedMatchesSuffixGlob(file, compiledGlob) {
    let cursor = file.indexOf('/');
    while (cursor !== -1) {
        const sub = file.slice(cursor + 1);
        if (sub && compiledGlob.regex.test(sub)) return true;
        cursor = file.indexOf('/', cursor + 1);
    }
    return false;
}

/**
 * Parses co-change rule definitions stored in `krusch-context-mcp` without DB schema changes:
 * - Steering nuggets keyed as `cochange:<name>` (JSON `{"when":[...],"require":[...]}` or `when: a, b | require: c | note`)
 * - Active `invariant` / `blocker` memories carrying `when:<glob>` & `require:<glob>` tags or `--when <glob> --require <glob>` syntax.
 *
 * @param {{ projectDb: any, ruleWeights?: Map<string, number> }} params
 * @returns {{ rules: Array<object>, malformedRules: Array<{ id: string, error: string }> }}
 */
export function extractProjectCoChangeRules({ projectDb, ruleWeights = new Map() } = {}) {
    if (!projectDb) return { rules: [], malformedRules: [] };
    const rules = [];
    const malformedRules = [];

    try {
        const nugRows = projectDb.prepare(`SELECT key, value FROM ide_agent_nuggets WHERE LOWER(key) LIKE 'cochange:%'`).all();
        for (const n of nugRows) {
            const weight = ruleWeights.has(String(n.key)) ? ruleWeights.get(String(n.key)) : 1.0;
            if (weight <= 0.2) continue;
            const parsed = parseCoChangeValueSpec(n.key, n.value);
            if (!parsed) {
                malformedRules.push({
                    id: String(n.key),
                    error: 'Missing valid `when:` and `require:` globs in cochange nugget.'
                });
                continue;
            }
            const validation = evaluateCoChangeRules({ rules: [parsed] });
            if (validation.invalidRules.length > 0) {
                malformedRules.push(...validation.invalidRules);
            } else {
                rules.push(parsed);
            }
        }
    } catch {
        // Ignore missing table in minimal fixtures
    }

    try {
        const memRows = projectDb.prepare(`
            SELECT id, category, content, tags, provenance
            FROM ide_agent_memory
            WHERE status = 'ACTIVE' AND category IN ('invariant', 'blocker')
        `).all();

        for (const m of memRows) {
            const idStr = String(m.id);
            const weight = ruleWeights.has(idStr) ? ruleWeights.get(idStr) : 1.0;
            if (weight <= 0.2) continue;

            const parsed = parseCoChangeMemoryRow(m);
            if (!parsed) continue;
            const validation = evaluateCoChangeRules({ rules: [parsed] });
            if (validation.invalidRules.length > 0) {
                malformedRules.push(...validation.invalidRules);
            } else {
                rules.push(parsed);
            }
        }
    } catch {
        // Ignore missing table in minimal fixtures
    }

    return { rules, malformedRules };
}

function parseCoChangeValueSpec(ruleId, rawValue) {
    const val = String(rawValue || '').trim();
    if (!val) return null;
    if (val.startsWith('{')) {
        try {
            const obj = JSON.parse(val);
            const whenGlobs = normalizeGlobArray(obj.whenGlobs || obj.when);
            const requireGlobs = normalizeGlobArray(obj.requireGlobs || obj.require);
            if (whenGlobs.length > 0 && requireGlobs.length > 0) {
                return {
                    id: ruleId,
                    category: 'invariant',
                    whenGlobs,
                    requireGlobs,
                    description: obj.description || obj.reason || val
                };
            }
        } catch {
            // Fall through to pipe/flag parser
        }
    }

    const parts = val.split('|').map((s) => s.trim()).filter(Boolean);
    let whenGlobs = [];
    let requireGlobs = [];
    const notes = [];
    for (const part of parts) {
        if (/^when\s*:/i.test(part)) {
            whenGlobs.push(...normalizeGlobArray(part.replace(/^when\s*:/i, '')));
        } else if (/^require(?:s)?\s*:/i.test(part)) {
            requireGlobs.push(...normalizeGlobArray(part.replace(/^require(?:s)?\s*:/i, '')));
        } else {
            notes.push(part);
        }
    }
    if (whenGlobs.length === 0 || requireGlobs.length === 0) {
        const cliParsed = extractCliCoChangeFlags(val);
        whenGlobs = cliParsed.whenGlobs;
        requireGlobs = cliParsed.requireGlobs;
    }
    if (whenGlobs.length === 0 || requireGlobs.length === 0) return null;

    return {
        id: ruleId,
        category: 'invariant',
        whenGlobs,
        requireGlobs,
        description: notes.join(' - ') || val
    };
}

function parseCoChangeMemoryRow(row) {
    let tags = [];
    if (Array.isArray(row.tags)) {
        tags = row.tags.map(String);
    } else if (typeof row.tags === 'string' && row.tags.trim()) {
        try {
            const parsed = JSON.parse(row.tags);
            if (Array.isArray(parsed)) tags = parsed.map(String);
        } catch {
            tags = row.tags.split(/[,;]+/).map((s) => s.trim());
        }
    }

    const whenGlobs = [];
    const requireGlobs = [];
    for (const t of tags) {
        if (/^when:/i.test(t)) {
            const g = t.slice(5).trim();
            if (g) whenGlobs.push(g);
        } else if (/^require:/i.test(t)) {
            const g = t.slice(8).trim();
            if (g) requireGlobs.push(g);
        }
    }

    const content = String(row.content || '');
    if (whenGlobs.length === 0 || requireGlobs.length === 0) {
        const cliFlags = extractCliCoChangeFlags(content);
        if (whenGlobs.length === 0) whenGlobs.push(...cliFlags.whenGlobs);
        if (requireGlobs.length === 0) requireGlobs.push(...cliFlags.requireGlobs);
    }

    if (whenGlobs.length === 0 || requireGlobs.length === 0) return null;

    let provenance = null;
    if (row.provenance) {
        try {
            provenance = typeof row.provenance === 'string' ? JSON.parse(row.provenance) : row.provenance;
        } catch {
            provenance = null;
        }
    }

    return {
        id: row.id,
        category: row.category || 'invariant',
        whenGlobs,
        requireGlobs,
        description: content,
        provenance
    };
}

function extractCliCoChangeFlags(text) {
    const whenGlobs = [];
    const requireGlobs = [];
    for (const m of String(text || '').matchAll(/--when\s+['"`]?([^\s'"`,;|]+)['"`]?/gi)) {
        if (m[1]) whenGlobs.push(m[1]);
    }
    for (const m of String(text || '').matchAll(/--require\s+['"`]?([^\s'"`,;|]+)['"`]?/gi)) {
        if (m[1]) requireGlobs.push(m[1]);
    }
    return { whenGlobs, requireGlobs };
}

function normalizeGlobArray(input) {
    if (!input) return [];
    if (Array.isArray(input)) return input.map((s) => String(s).trim()).filter(Boolean);
    return String(input)
        .split(',')
        .map((s) => s.trim().replace(/^['"`]+|['"`]+$/g, ''))
        .filter(Boolean);
}

/**
 * Default safe `git` runner using `execFileSync` (zero shell interpolation, strict timeout).
 */
function defaultRunGit(args, cwd, timeoutMs) {
    return execFileSync('git', args, {
        cwd,
        timeout: Math.max(50, Math.floor(timeoutMs)),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 4 * 1024 * 1024
    });
}

function resolveProjectGitContext(targetProject) {
    const projectRoot = resolveProjectPath(targetProject);
    if (!projectRoot || !fs.existsSync(projectRoot)) return null;
    const gitRoot = findGitRoot(projectRoot);
    if (!gitRoot) return null;
    let realGitRoot;
    let realProjectRoot;
    try {
        realGitRoot = fs.realpathSync(gitRoot);
        realProjectRoot = fs.realpathSync(projectRoot);
    } catch {
        return null;
    }
    return { gitRoot: realGitRoot, projectRoot: realProjectRoot };
}

function resolveSafeRepoFile(relCandidate, { gitRoot, projectRoot }) {
    const norm = normalizeRepoRelativePath(relCandidate);
    if (!norm || isProseOrGeneratedFile(norm)) return null;

    for (const base of [projectRoot, gitRoot]) {
        const candidateAbs = path.resolve(base, norm);
        try {
            if (!fs.existsSync(candidateAbs)) continue;
            const realAbs = fs.realpathSync(candidateAbs);
            const gitRel = path.relative(gitRoot, realAbs).replace(/\\/g, '/');
            if (!gitRel || gitRel.startsWith('..') || path.isAbsolute(gitRel)) continue;
            const st = fs.statSync(realAbs);
            if (!st.isFile() || st.size === 0 || st.size > MAX_BLAMEABLE_FILE_BYTES) continue;
            return { absPath: realAbs, gitRelPath: gitRel };
        } catch {
            continue;
        }
    }
    return null;
}

/**
 * Checks whether a memory record is compatible with `targetProject` (prevents cross-project
 * bleed when multiple projects share a monorepo `.agent/context.db`).
 */
function isRowInProjectScope(row, prov, targetProject) {
    if (!targetProject || targetProject === 'default' || targetProject === 'homelab') {
        return true;
    }
    const projLower = String(targetProject).toLowerCase();
    if (prov?.file && typeof prov.file === 'string') {
        const normFile = prov.file.replace(/\\/g, '/').replace(/^\.\//, '');
        const sibMatch = /^projects\/([^/]+)\//i.exec(normFile);
        if (sibMatch && sibMatch[1].toLowerCase() !== projLower) {
            return false;
        }
    }
    const lowerContent = String(row?.content || '').toLowerCase();
    if (lowerContent.includes(projLower)) return true;
    const otherProjRefs = [...lowerContent.matchAll(/\bprojects\/([a-z0-9_-]+)/gi)].map((m) => m[1].toLowerCase());
    if (otherProjRefs.length > 0 && otherProjRefs.every((p) => p !== projLower)) {
        return false;
    }
    return true;
}

/**
 * Parses `git blame --porcelain` stdout into blamed commit records and line hits.
 *
 * @param {string} porcelainOutput
 * @returns {{ commits: Map<string, { sha: string, summary: string, isMechanical: boolean, prNumbers: string[], lines: number[] }>, lineCommits: Array<{ line: number, sha: string }> }}
 */
export function parseGitBlamePorcelain(porcelainOutput) {
    const commits = new Map();
    const lineCommits = [];
    if (!porcelainOutput || typeof porcelainOutput !== 'string') {
        return { commits, lineCommits };
    }

    let currentSha = null;
    let currentFinalLine = null;

    for (const line of porcelainOutput.split('\n')) {
        const header = /^([0-9a-f]{40})\s+\d+\s+(\d+)(?:\s+\d+)?$/.exec(line);
        if (header) {
            currentSha = header[1].toLowerCase();
            currentFinalLine = Number(header[2]);
            if (!UNCOMMITTED_ZERO_SHA_RE.test(currentSha)) {
                if (!commits.has(currentSha)) {
                    commits.set(currentSha, {
                        sha: currentSha,
                        summary: '',
                        isMechanical: false,
                        prNumbers: [],
                        lines: []
                    });
                }
                commits.get(currentSha).lines.push(currentFinalLine);
                lineCommits.push({ line: currentFinalLine, sha: currentSha });
            }
            continue;
        }

        if (currentSha && !UNCOMMITTED_ZERO_SHA_RE.test(currentSha) && line.startsWith('summary ')) {
            const summary = line.slice(8).trim();
            const entry = commits.get(currentSha);
            if (entry && !entry.summary) {
                entry.summary = summary;
                entry.isMechanical = MECHANICAL_COMMIT_SUBJECT_RE.test(summary);
                const prs = new Set();
                for (const m of summary.matchAll(/(?:\(#(\d+)\)\s*$|^Merge pull request #(\d+)\b|\bPR\s*#(\d+)\b)/gi)) {
                    const num = m[1] || m[2] || m[3];
                    if (num) prs.add(num);
                }
                entry.prNumbers = Array.from(prs);
            }
        }
    }

    return { commits, lineCommits };
}

/**
 * Coalesces sorted/unsorted 1-indexed line numbers into compact `[start, end]` ranges.
 *
 * @param {number[]} lines
 * @returns {Array<[number, number]>}
 */
export function coalesceLineRanges(lines) {
    if (!Array.isArray(lines) || lines.length === 0) return [];
    const sorted = Array.from(new Set(lines.filter((n) => Number.isInteger(n) && n >= 1))).sort((a, b) => a - b);
    if (sorted.length === 0) return [];

    const ranges = [];
    let start = sorted[0];
    let prev = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
        const cur = sorted[i];
        if (cur === prev + 1) {
            prev = cur;
        } else {
            ranges.push([start, prev]);
            start = cur;
            prev = cur;
        }
    }
    ranges.push([start, prev]);
    return ranges;
}

/**
 * Formats up to 3 coalesced line ranges per file (`src/file.js#L10-L12,L40-L45 (+1 more)`).
 *
 * @param {string} filePath
 * @param {Array<[number, number]>} ranges
 * @returns {string}
 */
export function formatLineRangesLabel(filePath, ranges) {
    if (!ranges || ranges.length === 0) return filePath;
    const shown = ranges.slice(0, 3).map(([s, e]) => (s === e ? `L${s}` : `L${s}-L${e}`));
    const extra = ranges.length > 3 ? ` (+${ranges.length - 3} more)` : '';
    return `${filePath}#${shown.join(',')}${extra}`;
}

function shaMatchesPrefix(fullSha, candidateRef) {
    if (!fullSha || !candidateRef) return false;
    const clean = String(candidateRef).trim().toLowerCase().replace(/^commit[:\s]+/i, '');
    const m = /([0-9a-f]{7,40})$/i.exec(clean);
    const hex = m ? m[1].toLowerCase() : (HEX_SHA_RE.test(clean) ? clean : null);
    if (!hex) return false;
    return fullSha.startsWith(hex) || hex.startsWith(fullSha);
}

function prMatchesRef(prNumbers, rawPr) {
    if (!rawPr || !Array.isArray(prNumbers) || prNumbers.length === 0) return false;
    const m = /(?:#|\/pull\/|^)(\d+)\b/i.exec(String(rawPr).trim());
    if (!m) return false;
    return prNumbers.includes(m[1]);
}

const TRAILER_LINE_RE = /^\s*(?:co-authored-by|signed-off-by|reviewed-by|reviewed-on|acked-by|tested-by|reported-by|suggested-by|helped-by|change-id|pr-url|cc|bug|ticket|tracker|issue)\s*:/i;
const FIXES_ONLY_RE = /^\s*(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?|refs?|see|related to|part of)\b:?\s*(?:#\d+|gh-\d+|[\w.-]+\/[\w.-]+#\d+|https?:\/\/\S+)(?:[\s,;&]+(?:and\s+)?(?:#\d+|gh-\d+|[\w.-]+\/[\w.-]+#\d+|https?:\/\/\S+))*\s*[.]?\s*$/i;
const BUMP_BODY_RE = /^\s*(?:bumps?|updates?|upgrades?)\s+(?:\[?`?[\w@/.-]+`?\]?(?:\([^)]*\))?\s+)?(?:from|to)\b|this pr contains the following updates|^\s*dependabot will resolve/im;
const DUMP_HEADING_RE = /^\s{0,3}(?:#{1,6}\s*)?(?:\*\*)?(?:what'?s changed|release notes?|changelog|full changelog|commits|sourced from)\b/im;
const EXPLICIT_WHY_LABEL_RE = /^(?:why|reason|rationale|motivation)\s*:\s*/i;
const EMPTY_LABEL_RE = /^(?:n\/?a|none|see\b|tbd|todo|-)\b/i;
const NEGATED_BECAUSE_RE = /(?:\bnot|\bnever|n't)\s+(?:just\s+|only\s+|simply\s+)?because\b/i;
const CONVENTIONAL_SUBJECT_RE = /^[a-z]+(?:\([^)]*\))?!?:\s+/i;

const STRONG_CAUSAL_MARKERS = [
    /\bbecause\b/i,
    /\bso that\b/i,
    /\bin order to\b/i,
    /\bto avoid\b/i,
    /\bto prevent\b/i,
    /\bdue to\b/i,
    /\bas a result\b/i,
    /\bwas causing\b/i,
    /\bcaused by\b/i,
    /\bsince\s+(?:(?:the|it|its|this|that|there|a|an|these|those|all|both|each|every|no|not|only)\b(?!\s+(?:last|first|previous|beginning|start|release|version|v?\d))|[\w.:/#-]+\s+(?:is|are|was|were|has|have|had|does|do|can|could|will|would|must|should|may|might|needs?|uses?|stores?|ignores?|supports?|reads?|runs?|returns?|calls?|requires?|handles?|caches?)\b)/i
];

const MEDIUM_CAUSAL_MARKERS = [
    /\binstead of\b/i,
    /\brather than\b/i,
    /\bpreviously\b/i,
    /\bno longer\b/i,
    /\botherwise\b/i,
    /\bto fix\b/i,
    /\bregression\b/i
];

const PROBLEM_NOUN_RE = /\b(?:break(?:s|ing)?|broke|broken|fail(?:s|ed|ing|ure)?|crash(?:es|ed|ing)?|leak(?:s|ed|ing)?|corrupt(?:s|ed|ion)?|deadlock(?:s|ed)?|race\b|timeout(?:s)?|hang(?:s|ing)?|bug(?:s)?|error(?:s)?|wrong(?:ly)?|incorrect(?:ly)?|vulnerab\w*|cache[sd]?)\b/i;

function stripInlineMarkup(text) {
    return String(text || '')
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/<\/?[a-z][a-z0-9]*\b[^>]*>/gi, ' ')
        .replace(/(\*\*|__)(.+?)\1/g, '$2')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();
}

function contentWordList(text) {
    return String(text || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [];
}

function repeatsCommitTitle(sentence, titleWordSet) {
    if (titleWordSet.size < 3) return false;
    const words = contentWordList(sentence);
    if (words.length === 0) return true;
    let overlap = 0;
    for (const w of words) {
        if (titleWordSet.has(w)) overlap += 1;
    }
    return overlap / words.length >= 0.8 && words.length <= titleWordSet.size + 3;
}

function capAtWordBoundary(sentence, maxChars) {
    if (sentence.length <= maxChars) return sentence;
    const cut = sentence.slice(0, maxChars - 3);
    const lastSpace = cut.lastIndexOf(' ');
    return (lastSpace > Math.floor(maxChars * 0.5) ? cut.slice(0, lastSpace) : cut).trimEnd() + '...';
}

/**
 * Cherry-Pick #4: Deterministic Commit / PR Causal Rationale Extractor (Zero-LLM).
 * Extracts up to 2 causal sentences (`because`, `so that`, `to prevent`, `Why:`, etc.)
 * while rejecting Dependabot bumps, git trailers, code blocks, and bare summaries.
 *
 * @param {string} title
 * @param {string|null|undefined} body
 * @param {{ maxSentences?: number, maxCharsPerSentence?: number }} [options]
 * @returns {string|null}
 */
export function extractCommitCausalRationale(title, body, options = {}) {
    if (!body || typeof body !== 'string') return null;
    const maxSentences = Number.isFinite(options?.maxSentences) && options.maxSentences > 0
        ? Math.floor(options.maxSentences)
        : 2;
    const maxChars = Number.isFinite(options?.maxCharsPerSentence) && options.maxCharsPerSentence >= 40
        ? Math.floor(options.maxCharsPerSentence)
        : 180;

    let text = body.replace(/\r\n?/g, '\n').slice(0, 6000);
    if (BUMP_BODY_RE.test(text)) return null;

    const dumpMatch = DUMP_HEADING_RE.exec(text);
    if (dumpMatch) text = text.slice(0, dumpMatch.index);

    text = text
        .replace(/<!--[\s\S]*?(?:-->|$)/g, '\n')
        .replace(/^\s*(```|~~~)[\s\S]*?(?:^\s*\1|$(?![\s\S]))/gm, '\n');

    const flatTitle = String(title || '').replace(/\s+/g, ' ').trim();
    const titleWords = new Set(contentWordList(flatTitle.replace(CONVENTIONAL_SUBJECT_RE, '')));

    const paragraphs = [];
    let buf = [];
    for (const rawLine of text.split('\n')) {
        const trimmed = rawLine.trim();
        if (!trimmed) {
            if (buf.length > 0) { paragraphs.push(buf.join(' ')); buf = []; }
            continue;
        }
        if (TRAILER_LINE_RE.test(trimmed) || FIXES_ONLY_RE.test(trimmed) || /^\|.*\|$/.test(trimmed)) {
            if (buf.length > 0) { paragraphs.push(buf.join(' ')); buf = []; }
            continue;
        }
        if (/^(?:[-*+]|\d+[.)])\s+/.test(trimmed)) {
            if (buf.length > 0) { paragraphs.push(buf.join(' ')); buf = []; }
            paragraphs.push(trimmed.replace(/^(?:[-*+]|\d+[.)])\s+/, ''));
            continue;
        }
        buf.push(trimmed);
    }
    if (buf.length > 0) paragraphs.push(buf.join(' '));

    const candidates = [];
    let pos = 0;

    for (const para of paragraphs) {
        let cleaned = stripInlineMarkup(para);
        if (!cleaned || cleaned === flatTitle) continue;

        let labelled = false;
        const labelMatch = EXPLICIT_WHY_LABEL_RE.exec(cleaned);
        if (labelMatch) {
            labelled = true;
            cleaned = cleaned.slice(labelMatch[0].length).trim();
            if (!cleaned || EMPTY_LABEL_RE.test(cleaned)) continue;
        }

        const sentences = cleaned.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(\[])/);
        for (let idx = 0; idx < sentences.length; idx++) {
            const s = sentences[idx].trim();
            pos += 1;
            const isLabelFirst = labelled && idx === 0;
            const words = s.split(/\s+/).filter(Boolean);
            if (words.length < 5 || /\?$/.test(s)) continue;
            if (!isLabelFirst && repeatsCommitTitle(s, titleWords)) continue;

            const unquoted = s.replace(/"[^"]*"/g, ' ');
            if (NEGATED_BECAUSE_RE.test(unquoted)) continue;

            let score = 0;
            if (isLabelFirst) {
                score = 4;
            } else if (STRONG_CAUSAL_MARKERS.some((rx) => rx.test(unquoted))) {
                score = 3;
            } else if (MEDIUM_CAUSAL_MARKERS.some((rx) => rx.test(unquoted)) && PROBLEM_NOUN_RE.test(unquoted)) {
                score = 2;
            }

            if (score >= 2) {
                candidates.push({ pos, score, text: capAtWordBoundary(s, maxChars) });
            }
        }
    }

    if (candidates.length === 0) return null;
    const top = [...candidates]
        .sort((a, b) => (b.score - a.score) || (a.pos - b.pos))
        .slice(0, maxSentences)
        .sort((a, b) => a.pos - b.pos);
    return top.map((c) => c.text).join(' ');
}

/**
 * Cherry-Pick #1: Old-Hunk & Pre-Edit Snippet `git blame -w -M` Attribution.
 * Supports both unified diffs (`@@ -start,count`) AND `pre_edit` code snippets (`filePath` + `code`).
 * Batches all `-L start,end` ranges for a file into a single `git blame -w -M --porcelain` spawn.
 *
 * @param {string} codeOrDiff
 * @param {object} [options]
 * @returns {Array<object>}
 */
export function findBlamedDiffMemories(codeOrDiff, {
    filePath = '',
    targetProject,
    projectDb,
    ruleWeights = new Map(),
    maxFiles = MAX_BLAME_FILES,
    budgetMs = DEFAULT_BLAME_BUDGET_MS,
    runGit = defaultRunGit
} = {}) {
    if (!projectDb || !codeOrDiff || typeof codeOrDiff !== 'string') return [];

    const gitCtx = resolveProjectGitContext(targetProject);
    if (!gitCtx) return [];

    let hunksByFile = new Map();
    if (isUnifiedDiffText(codeOrDiff)) {
        hunksByFile = parseDiffOldHunks(codeOrDiff);
    } else if (filePath) {
        const resolvedSingle = resolveSafeRepoFile(filePath, gitCtx);
        if (resolvedSingle) {
            try {
                const diskText = fs.readFileSync(resolvedSingle.absPath, 'utf8');
                const snippetRanges = resolvePreEditSnippetRanges(diskText, codeOrDiff);
                if (snippetRanges.length > 0) {
                    hunksByFile.set(resolvedSingle.gitRelPath, snippetRanges);
                }
            } catch {
                return [];
            }
        }
    }

    if (hunksByFile.size === 0) return [];

    const deadline = Date.now() + Math.max(100, budgetMs);
    const blamedFileEntries = [];

    for (const [rawFile, ranges] of hunksByFile.entries()) {
        if (blamedFileEntries.length >= maxFiles) break;
        const resolved = resolveSafeRepoFile(rawFile, gitCtx);
        if (!resolved || ranges.length === 0) continue;

        const remaining = deadline - Date.now();
        if (remaining <= 25) break;

        let fileCommits = new Map();
        try {
            const rangeArgs = ranges.flatMap(([start, end]) => ['-L', `${start},${end}`]);
            const stdout = runGit(
                ['blame', '-w', '-M', '--porcelain', ...rangeArgs, '--', resolved.gitRelPath],
                gitCtx.gitRoot,
                remaining
            );
            fileCommits = parseGitBlamePorcelain(stdout).commits;
        } catch {
            // Fail open if line numbers exceed HEAD file length or file is untracked
        }

        blamedFileEntries.push({
            gitRelPath: resolved.gitRelPath,
            hunkRanges: ranges,
            commits: fileCommits
        });
    }

    if (blamedFileEntries.length === 0) return [];

    let rows = [];
    try {
        rows = projectDb.prepare(`
            SELECT id, category, status, content, tags, provenance
            FROM ide_agent_memory
            WHERE category IN ('decision', 'invariant', 'blocker', 'bug')
        `).all();
    } catch {
        return [];
    }

    // Track SHAs already represented in ide_agent_memory (including SUPERSEDED / INVALIDATED / silenced)
    // so raw `git show` fallback never resurrects a retired or explicitly false-positived decision.
    const trackedCommitShas = new Set();
    const matches = [];

    for (const row of rows) {
        let prov = null;
        if (row.provenance) {
            try {
                prov = typeof row.provenance === 'string' ? JSON.parse(row.provenance) : row.provenance;
            } catch {
                prov = null;
            }
        }
        if (!isRowInProjectScope(row, prov, targetProject)) continue;

        const rowCommitSha = extractCommitShaFromRecord(prov, row.content);
        if (rowCommitSha) {
            for (const entry of blamedFileEntries) {
                for (const sha of entry.commits.keys()) {
                    if (shaMatchesPrefix(sha, rowCommitSha)) {
                        trackedCommitShas.add(sha);
                    }
                }
            }
        }

        if (String(row.status || 'ACTIVE').toUpperCase() !== 'ACTIVE') continue;

        const idKey = String(row.id);
        const weight = ruleWeights.has(idKey) ? ruleWeights.get(idKey) : 1.0;
        if (weight <= 0.2) continue;

        const content = String(row.content || '');
        let matchedCitation = null;

        for (const entry of blamedFileEntries) {
            // 1. Direct commit SHA or explicit PR match from `git blame -w -M` on the exact hunk lines
            for (const [sha, commitInfo] of entry.commits.entries()) {
                const shortSha = sha.slice(0, 7);
                const commitHit =
                    (prov?.commit && shaMatchesPrefix(sha, prov.commit)) ||
                    (content.length >= 7 && new RegExp(`\\b${shortSha}[0-9a-f]*\\b`, 'i').test(content));

                // Never match bare `#12` in free-text memory content (collides with `Memory #12` / `Rule #12`)
                const prHit = !commitInfo.isMechanical && (
                    (prov?.pr && prMatchesRef(commitInfo.prNumbers, prov.pr)) ||
                    commitInfo.prNumbers.some((prNum) => new RegExp(`(?:\\bPR\\s*#|/pull/)${prNum}\\b`, 'i').test(content))
                );

                if (commitHit || prHit) {
                    trackedCommitShas.add(sha);
                    const ranges = coalesceLineRanges(commitInfo.lines);
                    matchedCitation = `${formatLineRangesLabel(entry.gitRelPath, ranges)} @ ${shortSha}`;
                    break;
                }
            }
            if (matchedCitation) break;

            // 2. Provenance file + overlapping line-span match on rewritten old hunk
            if (prov?.file && Number.isInteger(prov.start_line)) {
                const provNorm = normalizeRepoRelativePath(prov.file);
                const fileMatches = provNorm && (
                    provNorm === entry.gitRelPath ||
                    entry.gitRelPath.endsWith('/' + provNorm) ||
                    provNorm.endsWith('/' + entry.gitRelPath)
                );
                if (fileMatches) {
                    const pStart = prov.start_line;
                    const pEnd = Number.isInteger(prov.end_line) ? prov.end_line : pStart;
                    const overlapped = entry.hunkRanges.find(([hStart, hEnd]) => pStart <= hEnd && pEnd >= hStart);
                    if (overlapped) {
                        matchedCitation = `${entry.gitRelPath}#L${pStart}${pEnd !== pStart ? `-L${pEnd}` : ''}`;
                        break;
                    }
                }
            }
        }

        if (matchedCitation) {
            matches.push({
                id: row.id,
                category: row.category,
                content,
                weight,
                blameMatched: true,
                is_drifted: false,
                provenance: {
                    ...(prov || {}),
                    citation: `Blame ${matchedCitation}`
                }
            });
        }
    }

    // 3. Day-0 Zero-Setup On-Demand Commit Body Rationale Fallback (INV-ALIGN-REASON-04):
    //    When no stored memory covers a blamed commit, inspect `git show -s` locally (<3ms)
    //    and surface the commit's stated causal rationale if one exists.
    if (matches.length < 3) {
        const seenFallbackShas = new Set();
        for (const entry of blamedFileEntries) {
            if (matches.length >= 3) break;
            for (const [sha, commitInfo] of entry.commits.entries()) {
                if (matches.length >= 3) break;
                if (commitInfo.isMechanical || trackedCommitShas.has(sha) || seenFallbackShas.has(sha)) {
                    continue;
                }
                seenFallbackShas.add(sha);

                const shortSha = sha.slice(0, 7);
                const ruleKey = `git:${shortSha}`;
                const weight = ruleWeights.has(ruleKey) ? ruleWeights.get(ruleKey) : 1.0;
                if (weight <= 0.2) continue;

                const remaining = deadline - Date.now();
                if (remaining <= 40) break;

                try {
                    const showOut = runGit(
                        ['show', '-s', '--format=%s%n%n%b', sha],
                        gitCtx.gitRoot,
                        remaining
                    );
                    const splitIdx = showOut.indexOf('\n\n');
                    const subject = (splitIdx === -1 ? showOut : showOut.slice(0, splitIdx)).trim();
                    const body = splitIdx === -1 ? '' : showOut.slice(splitIdx + 2);
                    const rationale = extractCommitCausalRationale(subject, body);
                    if (rationale) {
                        const ranges = coalesceLineRanges(commitInfo.lines);
                        matches.push({
                            id: ruleKey,
                            category: 'decision',
                            content: `${subject} (${rationale})`,
                            weight,
                            blameMatched: true,
                            is_drifted: false,
                            provenance: {
                                commit: shortSha,
                                citation: `Git Commit ${formatLineRangesLabel(entry.gitRelPath, ranges)} @ ${shortSha}`
                            }
                        });
                    }
                } catch {
                    // Fail open if commit object is unavailable in shallow clone
                }
            }
        }
    }

    return matches;
}

function extractCommitShaFromRecord(prov, content) {
    if (prov?.commit) {
        const clean = String(prov.commit).trim();
        const m = /([0-9a-f]{7,40})$/i.exec(clean);
        if (m) return m[1].toLowerCase();
    }
    const contentMatch = /\bcommit\s+`?([0-9a-f]{7,40})`?\b/i.exec(String(content || ''));
    if (contentMatch) return contentMatch[1].toLowerCase();
    return null;
}

function resolveTerminalReplacement(rowId, byIdMap) {
    let cur = byIdMap.get(rowId);
    const visited = new Set([rowId]);
    let hops = 0;
    while (cur && cur.superseded_by && !visited.has(cur.superseded_by) && hops < 8) {
        visited.add(cur.superseded_by);
        const next = byIdMap.get(cur.superseded_by);
        if (!next) break;
        cur = next;
        hops += 1;
    }
    return cur && String(cur.status || '').toUpperCase() === 'ACTIVE' ? cur : null;
}

/**
 * Checks whether the active replacement memory explicitly re-anchored and ratified
 * the exact same file hash or verbatim `quoted_sentence` as the superseded memory
 * (e.g., milestone rollups `#1072 -> #1073` where the code span remains authoritative).
 */
function isCodeReRatifiedByReplacement(oldProv, replProv) {
    if (!oldProv?.file || !replProv?.file) return false;
    const oldFile = normalizeRepoRelativePath(oldProv.file);
    const replFile = normalizeRepoRelativePath(replProv.file);
    if (!oldFile || !replFile) return false;
    const sameFile = oldFile === replFile || oldFile.endsWith('/' + replFile) || replFile.endsWith('/' + oldFile);
    if (!sameFile) return false;

    if (oldProv.anchor_hash && replProv.anchor_hash && oldProv.anchor_hash === replProv.anchor_hash) {
        return true;
    }
    if (
        oldProv.quoted_sentence &&
        replProv.quoted_sentence &&
        String(oldProv.quoted_sentence).trim() === String(replProv.quoted_sentence).trim()
    ) {
        return true;
    }
    return false;
}

/**
 * Cherry-Pick #2: Reverse Supersession `stale-code` Scanner.
 * Finds `SUPERSEDED` memories anchored to a Git commit SHA and checks whether `HEAD`
 * still contains lines `git blame -w -M`d to that superseded commit, respecting
 * span-anchored ranges and active re-ratifications.
 *
 * @param {object} [options]
 * @returns {{ findings: Array<object>, totalStaleLines: number, budgetExceeded: boolean }}
 */
export function scanSupersededStaleCode({
    targetProject,
    projectDb,
    maxFilesPerDecision = MAX_STALE_FILES_PER_DECISION,
    budgetMs = DEFAULT_STALE_BUDGET_MS,
    runGit = defaultRunGit
} = {}) {
    if (!projectDb) {
        return { findings: [], totalStaleLines: 0, budgetExceeded: false };
    }
    const gitCtx = resolveProjectGitContext(targetProject);
    if (!gitCtx) {
        return { findings: [], totalStaleLines: 0, budgetExceeded: false };
    }

    let rows = [];
    try {
        rows = projectDb.prepare(`
            SELECT id, category, content, status, superseded_by, provenance
            FROM ide_agent_memory
        `).all();
    } catch {
        return { findings: [], totalStaleLines: 0, budgetExceeded: false };
    }

    const byId = new Map();
    for (const r of rows) byId.set(r.id, r);

    const deadline = Date.now() + Math.max(100, budgetMs);
    const blameCache = new Map();
    const findings = [];
    let totalStaleLines = 0;
    let budgetExceeded = false;

    for (const row of rows) {
        if (String(row.status || '').toUpperCase() !== 'SUPERSEDED' || !row.superseded_by) continue;
        if (Date.now() >= deadline) {
            budgetExceeded = true;
            break;
        }

        const replacement = resolveTerminalReplacement(row.id, byId);
        if (!replacement) continue;

        let prov = null;
        if (row.provenance) {
            try {
                prov = typeof row.provenance === 'string' ? JSON.parse(row.provenance) : row.provenance;
            } catch {
                prov = null;
            }
        }
        if (!isRowInProjectScope(row, prov, targetProject)) continue;

        const oldSha = extractCommitShaFromRecord(prov, row.content);
        if (!oldSha) continue;

        let replProv = null;
        if (replacement.provenance) {
            try {
                replProv = typeof replacement.provenance === 'string' ? JSON.parse(replacement.provenance) : replacement.provenance;
            } catch {
                replProv = null;
            }
        }

        if (isCodeReRatifiedByReplacement(prov, replProv)) continue;

        const replSha = extractCommitShaFromRecord(replProv, replacement.content);
        if (replSha && shaMatchesPrefix(replSha, oldSha)) continue;

        /** @type {Array<{ gitRelPath: string, absPath: string, scopedRanges: Array<[number, number]>|null }>} */
        const candidateTargets = [];

        if (prov?.file) {
            const safe = resolveSafeRepoFile(prov.file, gitCtx);
            if (safe) {
                let scopedRanges = null;
                if (prov.quoted_sentence && typeof prov.quoted_sentence === 'string') {
                    try {
                        const diskText = fs.readFileSync(safe.absPath, 'utf8');
                        const quoteRanges = resolvePreEditSnippetRanges(diskText, prov.quoted_sentence);
                        if (quoteRanges.length === 0) {
                            // Quoted sentence was already removed/replaced in HEAD -> no longer stale!
                            continue;
                        }
                        scopedRanges = quoteRanges;
                    } catch {
                        continue;
                    }
                } else if (Number.isInteger(prov.start_line) && prov.start_line >= 1) {
                    const endLine = Number.isInteger(prov.end_line) && prov.end_line >= prov.start_line
                        ? prov.end_line
                        : prov.start_line;
                    scopedRanges = [[prov.start_line, endLine]];
                }
                candidateTargets.push({
                    gitRelPath: safe.gitRelPath,
                    absPath: safe.absPath,
                    scopedRanges
                });
            }
        } else {
            const remaining = deadline - Date.now();
            if (remaining <= 25) {
                budgetExceeded = true;
                break;
            }
            try {
                const treeOut = runGit(
                    ['diff-tree', '--no-commit-id', '--name-only', '-r', oldSha],
                    gitCtx.gitRoot,
                    remaining
                );
                for (const rawLine of treeOut.split(/\r?\n/)) {
                    if (candidateTargets.length >= maxFilesPerDecision) break;
                    const safe = resolveSafeRepoFile(rawLine, gitCtx);
                    if (safe) {
                        candidateTargets.push({
                            gitRelPath: safe.gitRelPath,
                            absPath: safe.absPath,
                            scopedRanges: null
                        });
                    }
                }
            } catch {
                continue;
            }
        }

        if (candidateTargets.length === 0) continue;

        const fileHits = [];
        let memoryStaleLines = 0;

        for (const target of candidateTargets) {
            const remaining = deadline - Date.now();
            if (remaining <= 25) {
                budgetExceeded = true;
                break;
            }

            const cacheKey = target.scopedRanges
                ? `${target.gitRelPath}::${target.scopedRanges.map(([s, e]) => `${s}-${e}`).join(',')}`
                : target.gitRelPath;

            let parsedBlame = blameCache.get(cacheKey);
            if (!parsedBlame) {
                try {
                    const rangeArgs = target.scopedRanges
                        ? target.scopedRanges.flatMap(([s, e]) => ['-L', `${s},${e}`])
                        : [];
                    const blameOut = runGit(
                        ['blame', '-w', '-M', '--porcelain', ...rangeArgs, 'HEAD', '--', target.gitRelPath],
                        gitCtx.gitRoot,
                        remaining
                    );
                    parsedBlame = parseGitBlamePorcelain(blameOut);
                    blameCache.set(cacheKey, parsedBlame);
                } catch {
                    continue;
                }
            }

            const matchingLines = [];
            for (const [sha, info] of parsedBlame.commits.entries()) {
                if (shaMatchesPrefix(sha, oldSha)) {
                    matchingLines.push(...info.lines);
                }
            }

            if (matchingLines.length > 0) {
                const ranges = coalesceLineRanges(matchingLines);
                const uniqueCount = ranges.reduce((acc, [s, e]) => acc + (e - s + 1), 0);
                memoryStaleLines += uniqueCount;
                fileHits.push({
                    file: target.gitRelPath,
                    lines: uniqueCount,
                    ranges,
                    citation: formatLineRangesLabel(target.gitRelPath, ranges)
                });
            }
        }

        if (fileHits.length > 0) {
            totalStaleLines += memoryStaleLines;
            findings.push({
                supersededId: row.id,
                supersededContent: String(row.content || ''),
                replacedById: replacement.id,
                replacedByContent: String(replacement.content || ''),
                commit: oldSha.slice(0, 7),
                totalLines: memoryStaleLines,
                files: fileHits
            });
        }
    }

    return { findings, totalStaleLines, budgetExceeded };
}

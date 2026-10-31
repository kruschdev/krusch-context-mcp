/**
 * @file lego-boilerplate-guard.js
 * Deterministic static guard detecting hand-rolled infrastructure boilerplate
 * that should use canonical `@krusch/toolkit` or `krusch_toolkit` Lego bricks.
 */

const MAX_INSPECT_CHARS = 262_144;

/**
 * Exempts root toolkit implementation directories (`lib/`, `lib-py/`), stack engines,
 * benchmarks, dependency trees, non-code docs/configs, and test suites from nudges,
 * while preserving coverage on downstream application folders like `src/lib/`.
 */
export const LEGO_GUARD_EXEMPT_PATH_RE = /(?:^(?:lib|lib-py)(?:[\\/]|$)|(?:^|[\\/])homelab[\\/](?:lib|lib-py)(?:[\\/]|$)|(?:^|[\\/])(?:krusch-stack|tests?|__tests__|benchmarks|node_modules)(?:[\\/]|$)|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|[\\/])test[_-]|\.(?:md|mdx|txt|rst|json|ya?ml|toml|lock|html|css|svg|sql|sh)$)/i;

const UNIFIED_DIFF_RE = /^(?:@@\s+-\d+|diff --git\s|\+\+\+\s+(?:[ab]\/|"?[ab]\/|\/dev\/null))/m;

const JS_REGEX_PREFIX_KEYWORDS = new Set([
    'return', 'throw', 'case', 'typeof', 'void', 'delete',
    'in', 'of', 'instanceof', 'yield', 'await', 'else', 'do'
]);

function inferIsPythonSource(code = '', filePath = '') {
    const fp = String(filePath || '').trim();
    if (/\.pyw?$/i.test(fp)) return true;
    if (/\.[cm]?[jt]sx?$/i.test(fp)) return false;
    return /^\s*(?:from\s+[a-zA-Z_][\w.]*\s+import\s+|import\s+fastapi\b|(?:async\s+)?def\s+[a-zA-Z_]\w*\s*\(|@[a-zA-Z_]\w*\.(?:get|post|put|delete|patch)\s*\()/m.test(
        String(code || '')
    );
}

function tryScanJsRegex(text, startIdx) {
    const len = text.length;
    let j = startIdx + 1;
    let inCharClass = false;
    while (j < len) {
        const c = text[j];
        if (c === '\n' || c === '\r') return -1;
        if (c === '\\') {
            if (j + 1 >= len || text[j + 1] === '\n' || text[j + 1] === '\r') return -1;
            j += 2;
            continue;
        }
        if (c === '[') {
            inCharClass = true;
            j += 1;
            continue;
        }
        if (c === ']' && inCharClass) {
            inCharClass = false;
            j += 1;
            continue;
        }
        if (c === '/' && !inCharClass) {
            j += 1;
            while (j < len && /[dgimsuvy]/.test(text[j])) j += 1;
            return j;
        }
        j += 1;
    }
    return -1;
}

function stripCodeComments(source = '', { isPython = false } = {}) {
    const text = String(source || '');
    if (!text) return '';
    let out = '';
    const len = text.length;
    let i = 0;
    let lastSigChar = '';
    let lastWord = '';
    let wordBuf = '';

    const templateBraceStack = [];

    const flushWord = () => {
        if (wordBuf) {
            lastWord = wordBuf;
            wordBuf = '';
        }
    };

    const scanTemplateBody = () => {
        while (i < len) {
            if (text[i] === '\\' && i + 1 < len) {
                out += text[i] + text[i + 1];
                i += 2;
                continue;
            }
            if (text[i] === '$' && text[i + 1] === '{') {
                out += '${';
                i += 2;
                templateBraceStack.push(0);
                lastSigChar = '{';
                lastWord = '';
                return;
            }
            if (text[i] === '`') {
                out += '`';
                i += 1;
                lastSigChar = '`';
                lastWord = '';
                return;
            }
            out += text[i];
            i += 1;
        }
        lastSigChar = '`';
        lastWord = '';
    };

    while (i < len) {
        const ch = text[i];
        const next = text[i + 1] || '';
        const next2 = text[i + 2] || '';

        if (!isPython && ch === '/' && next === '*') {
            flushWord();
            i += 2;
            while (i < len && !(text[i] === '*' && text[i + 1] === '/')) {
                if (text[i] === '\n') out += '\n';
                i += 1;
            }
            if (i < len) i += 2;
            continue;
        }

        if (!isPython && ch === '/' && next === '/') {
            flushWord();
            i += 2;
            while (i < len && text[i] !== '\n') i += 1;
            continue;
        }

        if (isPython && ch === '#') {
            flushWord();
            i += 1;
            while (i < len && text[i] !== '\n') i += 1;
            continue;
        }

        if (!isPython && i === 0 && ch === '#' && next === '!') {
            i += 2;
            while (i < len && text[i] !== '\n') i += 1;
            continue;
        }

        if (isPython && ((ch === "'" && next === "'" && next2 === "'") || (ch === '"' && next === '"' && next2 === '"'))) {
            flushWord();
            const delim = ch;
            out += delim + delim + delim;
            i += 3;
            while (i < len) {
                if (text[i] === '\\' && i + 1 < len) {
                    out += text[i] + text[i + 1];
                    i += 2;
                    continue;
                }
                if (text[i] === delim && text[i + 1] === delim && text[i + 2] === delim) {
                    out += delim + delim + delim;
                    i += 3;
                    break;
                }
                out += text[i];
                i += 1;
            }
            lastSigChar = delim;
            lastWord = '';
            continue;
        }

        if (!isPython && ch === '/' && next !== '/' && next !== '*' && (i === 0 || text[i - 1] !== '<')) {
            flushWord();
            const canStartRegex =
                lastSigChar === '' ||
                '(,[=:{;!&|?+-*~^%>'.includes(lastSigChar) ||
                (/[a-zA-Z_$]/.test(lastSigChar) && JS_REGEX_PREFIX_KEYWORDS.has(lastWord));
            if (canStartRegex) {
                const regexEnd = tryScanJsRegex(text, i);
                if (regexEnd > i) {
                    out += text.slice(i, regexEnd);
                    lastSigChar = '/';
                    lastWord = '';
                    i = regexEnd;
                    continue;
                }
            }
        }

        if (!isPython && ch === '`') {
            flushWord();
            out += '`';
            i += 1;
            scanTemplateBody();
            continue;
        }

        if (ch === "'" || ch === '"') {
            flushWord();
            const quote = ch;
            out += quote;
            i += 1;
            while (i < len) {
                if (text[i] === '\\' && i + 1 < len) {
                    out += text[i] + text[i + 1];
                    i += 2;
                    continue;
                }
                if (text[i] === '\n') {
                    break;
                }
                out += text[i];
                i += 1;
                if (text[i - 1] === quote) {
                    break;
                }
            }
            lastSigChar = quote;
            lastWord = '';
            continue;
        }

        if (!isPython && templateBraceStack.length > 0) {
            if (ch === '{') {
                flushWord();
                templateBraceStack[templateBraceStack.length - 1] += 1;
                lastSigChar = '{';
                out += '{';
                i += 1;
                continue;
            }
            if (ch === '}') {
                flushWord();
                if (templateBraceStack[templateBraceStack.length - 1] > 0) {
                    templateBraceStack[templateBraceStack.length - 1] -= 1;
                    lastSigChar = '}';
                    out += '}';
                    i += 1;
                    continue;
                }
                templateBraceStack.pop();
                out += '}';
                i += 1;
                scanTemplateBody();
                continue;
            }
        }

        if (/[a-zA-Z0-9_$.]/.test(ch)) {
            wordBuf += ch;
            lastSigChar = ch;
        } else {
            flushWord();
            if (!/\s/.test(ch)) {
                lastSigChar = ch;
            }
        }

        out += ch;
        i += 1;
    }

    return out;
}

function normalizeFilePath(rawPath = '') {
    if (!rawPath || typeof rawPath !== 'string') return '';
    let cleaned = rawPath.trim();
    const tabIdx = cleaned.indexOf('\t');
    if (tabIdx !== -1) {
        cleaned = cleaned.slice(0, tabIdx).trim();
    }
    if (
        (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
        (cleaned.startsWith("'") && cleaned.endsWith("'"))
    ) {
        cleaned = cleaned.slice(1, -1);
    }
    cleaned = cleaned.replace(/\\/g, '/');
    if (cleaned === '/dev/null') return '/dev/null';
    cleaned = cleaned.replace(/^(?:[ab]\/|\.\/*)/, '');
    return cleaned;
}

function parseGitDiffHeaderPath(line) {
    // Matches `diff --git a/<path> b/<path>` or quoted variants
    const quotedMatch = line.match(/^diff --git\s+(?:"a\/([^"]+)"|a\/(\S+))\s+(?:"b\/([^"]+)"|b\/(\S+))/);
    if (quotedMatch) {
        return normalizeFilePath(quotedMatch[3] || quotedMatch[4] || quotedMatch[1] || quotedMatch[2] || '');
    }
    return '';
}

/**
 * Extracts per-file added code segments from unified diffs, or wraps full source
 * text when `rawText` is not a unified diff. Removed `-` lines are excluded from
 * both `addedCode` and `survivingCode` so refactoring away from boilerplate never
 * triggers false-positive findings.
 *
 * @param {string} [rawText='']
 * @param {string} [filePath='']
 * @returns {{
 *   isDiff: boolean,
 *   addedText: string,
 *   hunks: Array<{ filePath: string, addedCode: string, survivingCode: string, deleted: boolean }>
 * }}
 */
export function extractAddedCodeLines(rawText = '', filePath = '') {
    if (typeof rawText !== 'string' || !rawText) {
        return { isDiff: false, addedText: '', hunks: [] };
    }

    const boundedText = rawText.length > MAX_INSPECT_CHARS
        ? rawText.slice(0, MAX_INSPECT_CHARS)
        : rawText;

    const defaultPath = normalizeFilePath(filePath);

    if (!UNIFIED_DIFF_RE.test(boundedText)) {
        return {
            isDiff: false,
            addedText: boundedText,
            hunks: [{
                filePath: defaultPath,
                addedCode: boundedText,
                survivingCode: boundedText,
                deleted: false
            }]
        };
    }

    const lines = boundedText.split(/\r?\n/);
    const fileMap = new Map();
    const anonymousHunks = [];

    const getOrCreateEntry = (fp) => {
        if (!fp) {
            const entry = { filePath: defaultPath, addedLines: [], survivingLines: [], deleted: false };
            anonymousHunks.push(entry);
            return entry;
        }
        if (!fileMap.has(fp)) {
            fileMap.set(fp, { filePath: fp, addedLines: [], survivingLines: [], deleted: false });
        }
        return fileMap.get(fp);
    };

    let currentEntry = null;
    let pendingHeaderPath = '';
    let pendingDeleted = false;
    let seenPlusHeader = false;
    let inHunk = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (line.startsWith('diff --git ')) {
            inHunk = false;
            seenPlusHeader = false;
            pendingDeleted = false;
            pendingHeaderPath = parseGitDiffHeaderPath(line);
            currentEntry = pendingHeaderPath ? getOrCreateEntry(pendingHeaderPath) : null;
            continue;
        }

        // Detect `--- <old>` followed immediately by `+++ <new>` (supports plain `diff -u` without `diff --git`)
        if (
            line.startsWith('--- ') &&
            i + 1 < lines.length &&
            /^\+\+\+\s+\S/.test(lines[i + 1])
        ) {
            inHunk = false;
            seenPlusHeader = false;
            continue;
        }

        if (!inHunk && /^\+\+\+\s+\S/.test(line)) {
            const rawTarget = line.slice(4);
            const parsedTarget = normalizeFilePath(rawTarget);
            seenPlusHeader = true;
            if (parsedTarget === '/dev/null') {
                pendingDeleted = true;
                if (currentEntry) {
                    currentEntry.deleted = true;
                }
            } else {
                pendingDeleted = false;
                pendingHeaderPath = parsedTarget || pendingHeaderPath || defaultPath;
                currentEntry = getOrCreateEntry(pendingHeaderPath);
            }
            continue;
        }

        if (/^@@\s+-\d+/.test(line)) {
            inHunk = true;
            if (!currentEntry && !pendingDeleted) {
                currentEntry = getOrCreateEntry(pendingHeaderPath || defaultPath);
            }
            continue;
        }

        if (!inHunk && !seenPlusHeader) {
            continue;
        }

        if (pendingDeleted || (currentEntry && currentEntry.deleted)) {
            continue;
        }

        if (line.startsWith('+')) {
            if (!currentEntry) {
                currentEntry = getOrCreateEntry(pendingHeaderPath || defaultPath);
            }
            const content = line.slice(1);
            currentEntry.addedLines.push(content);
            currentEntry.survivingLines.push(content);
        } else if (line.startsWith(' ')) {
            if (!currentEntry) {
                currentEntry = getOrCreateEntry(pendingHeaderPath || defaultPath);
            }
            currentEntry.survivingLines.push(line.slice(1));
        }
        // Removed `-` lines and `\ No newline at end of file` markers are intentionally skipped.
    }

    const rawEntries = [...fileMap.values(), ...anonymousHunks];
    const hunks = rawEntries
        .filter((entry) => !entry.deleted)
        .map((entry) => ({
            filePath: entry.filePath,
            addedCode: entry.addedLines.join('\n'),
            survivingCode: entry.survivingLines.join('\n'),
            deleted: false
        }));

    const addedText = hunks
        .map((h) => h.addedCode)
        .filter(Boolean)
        .join('\n');

    return {
        isDiff: true,
        addedText,
        hunks
    };
}

const MCP_NEW_SERVER_RE = /\bnew\s+Server\s*\(/;
const MCP_STDIO_TRANSPORT_RE = /\bStdioServerTransport\b/;
const MCP_TOOLKIT_IMPORT_RE = /@krusch\/toolkit\/mcp(?:-server)?\b/;
const MCP_TOOLKIT_ROOT_SYMBOLS_RE = /\b(?:createMcpServer|defineMcpTool)\b/;

const SSE_MIME_RE = /text\/event-stream/i;
const SSE_BUFFER_OR_CACHE_RE = /(?:X-Accel-Buffering|Cache-Control)/i;
const SSE_TOOLKIT_NODE_RE = /@krusch\/toolkit\/(?:streaming|edge)\b/;
const SSE_TOOLKIT_NODE_SYMBOLS_RE = /\b(?:sseResponse|streamChat|edgeSseResponse)\b/;
const SSE_TOOLKIT_PY_RE = /\bkrusch_toolkit\.fastapi_app\b/;

const WEBHOOK_CREATE_HMAC_RE = /\bcreateHmac\s*\(/;
const WEBHOOK_PROVIDER_HEADER_RE = /\b(?:x-slack-signature|x-hub-signature-256|stripe-signature)\b/i;
const WEBHOOK_TOOLKIT_IMPORT_RE = /@krusch\/toolkit\/webhooks\b/;
const WEBHOOK_TOOLKIT_SYMBOLS_RE =
    /\b(?:verifySlackSignature|verifyGithubSignature|verifyStripeSignature|signWebhookHmac)\b/;

const PG_QUALIFIED_POOL_RE = /\bnew\s+pg\.Pool\s*\(/;
const PG_UNQUALIFIED_POOL_RE = /\bnew\s+Pool\s*\(/;
const PG_DRIVER_IMPORT_RE = /(?:from\s+['"]pg['"]|require\(\s*['"]pg['"]\s*\))/;
const PG_TOOLKIT_IMPORT_RE = /@krusch\/toolkit\/(?:pg|polygres)\b/;
const PG_TOOLKIT_SYMBOLS_RE = /\b(?:createPgPool|runSqlMigrations|createPolygresClient)\b/;

const SQLITE_RAW_DB_RE = /\bnew\s+Database\s*\(/;
const SQLITE_DRIVER_RE = /\bbetter-sqlite3\b/;
const SQLITE_TOOLKIT_IMPORT_RE = /@krusch\/toolkit\/db\b/;
const SQLITE_TOOLKIT_SYMBOLS_RE = /\binitDb\b/;

const FASTAPI_CORS_RE = /\bCORSMiddleware\b/;
const FASTAPI_HEALTH_ROUTE_RE = /@(?:app|router)\.get\(\s*['"]\/health['"]/;
const FASTAPI_TOOLKIT_RE = /\b(?:krusch_toolkit\.fastapi_app|create_fastapi_app)\b/;

const REACT_USE_EFFECT_RE = /\buseEffect\s*\(/;
const REACT_RAW_FETCH_RE = /\bfetch\s*\(/;
const REACT_ABORT_SAFE_RE = /\b(?:AbortController|signal|useApiQuery|useSSEStream|fetchApiJson)\b/;

const TOOLKIT_JS_ROOT_RE = /@krusch\/toolkit\b/;
const TOOLKIT_PY_ROOT_RE = /\bkrusch_toolkit\b/;

const BOILERPLATE_RULES = [
    {
        priority: 1,
        id: 'INV-LEGO-MCP',
        ruleKey: 'INV-LEGO-MCP',
        toolkitFile: 'lib/mcp-server.js',
        toolkitAnchor: 'lib/spec.md#INV-LEGO-01 (@krusch/toolkit/mcp)',
        content:
            "Avoid hand-rolled MCP Server + StdioServerTransport setup. Use `import { defineMcpTool, createMcpServer, okMcpResult } from '@krusch/toolkit/mcp'` instead.",
        matches(addedCode, survivingCode) {
            const hasSetup =
                MCP_NEW_SERVER_RE.test(survivingCode) &&
                MCP_STDIO_TRANSPORT_RE.test(survivingCode);
            if (!hasSetup) return false;

            const addedTrigger =
                MCP_NEW_SERVER_RE.test(addedCode) ||
                MCP_STDIO_TRANSPORT_RE.test(addedCode);
            if (!addedTrigger) return false;

            const hasToolkitMcp =
                MCP_TOOLKIT_IMPORT_RE.test(survivingCode) ||
                (TOOLKIT_JS_ROOT_RE.test(survivingCode) && MCP_TOOLKIT_ROOT_SYMBOLS_RE.test(survivingCode));
            return !hasToolkitMcp;
        }
    },
    {
        priority: 2,
        id: 'INV-LEGO-SSE',
        ruleKey: 'INV-LEGO-SSE',
        toolkitFile: 'lib/streaming.js',
        toolkitAnchor: 'lib/spec.md#INV-LEGO-03 (@krusch/toolkit/streaming | @krusch/toolkit/edge)',
        content:
            'Avoid manual SSE header blocks (`text/event-stream` + `Cache-Control` / `X-Accel-Buffering`). Use `sseResponse` / `streamChat` (`@krusch/toolkit/streaming`), `edgeSseResponse` (`@krusch/toolkit/edge`), or `sse_event_response` (`krusch_toolkit.fastapi_app`).',
        matches(addedCode, survivingCode) {
            const hasHeaders =
                SSE_MIME_RE.test(survivingCode) &&
                SSE_BUFFER_OR_CACHE_RE.test(survivingCode);
            if (!hasHeaders) return false;

            const addedTrigger =
                SSE_MIME_RE.test(addedCode) ||
                SSE_BUFFER_OR_CACHE_RE.test(addedCode);
            if (!addedTrigger) return false;

            const hasToolkitSse =
                SSE_TOOLKIT_NODE_RE.test(survivingCode) ||
                SSE_TOOLKIT_PY_RE.test(survivingCode) ||
                (TOOLKIT_JS_ROOT_RE.test(survivingCode) && SSE_TOOLKIT_NODE_SYMBOLS_RE.test(survivingCode)) ||
                (TOOLKIT_PY_ROOT_RE.test(survivingCode) && /\b(?:fastapi_app|sse_event_response)\b/.test(survivingCode));
            return !hasToolkitSse;
        }
    },
    {
        priority: 3,
        id: 'INV-LEGO-DB',
        ruleKey: 'INV-LEGO-DB',
        toolkitFile: 'lib/pg.js',
        toolkitAnchor: 'lib/spec.md#INV-LEGO-01 (@krusch/toolkit/pg | @krusch/toolkit/db)',
        content:
            'Avoid raw database driver instantiation (`new pg.Pool` or `better-sqlite3` `new Database`). Use `createPgPool` / `runSqlMigrations` (`@krusch/toolkit/pg`) or `initDb` (`@krusch/toolkit/db`).',
        matches(addedCode, survivingCode) {
            const hasQualifiedPg =
                PG_QUALIFIED_POOL_RE.test(survivingCode) &&
                PG_QUALIFIED_POOL_RE.test(addedCode);
            const hasImportedPgPool =
                PG_UNQUALIFIED_POOL_RE.test(survivingCode) &&
                PG_DRIVER_IMPORT_RE.test(survivingCode) &&
                (PG_UNQUALIFIED_POOL_RE.test(addedCode) || PG_DRIVER_IMPORT_RE.test(addedCode));
            const hasToolkitPg =
                PG_TOOLKIT_IMPORT_RE.test(survivingCode) ||
                (TOOLKIT_JS_ROOT_RE.test(survivingCode) && PG_TOOLKIT_SYMBOLS_RE.test(survivingCode));

            if ((hasQualifiedPg || hasImportedPgPool) && !hasToolkitPg) {
                return true;
            }

            const hasRawSqlite =
                SQLITE_RAW_DB_RE.test(survivingCode) &&
                SQLITE_DRIVER_RE.test(survivingCode) &&
                (SQLITE_RAW_DB_RE.test(addedCode) || SQLITE_DRIVER_RE.test(addedCode));
            const hasToolkitSqlite =
                SQLITE_TOOLKIT_IMPORT_RE.test(survivingCode) ||
                (TOOLKIT_JS_ROOT_RE.test(survivingCode) && SQLITE_TOOLKIT_SYMBOLS_RE.test(survivingCode));

            return hasRawSqlite && !hasToolkitSqlite;
        }
    },
    {
        priority: 4,
        id: 'INV-LEGO-FASTAPI',
        ruleKey: 'INV-LEGO-FASTAPI',
        toolkitFile: 'lib-py/krusch_toolkit/fastapi_app.py',
        toolkitAnchor: 'lib/spec.md#INV-LEGO-01 (krusch_toolkit.fastapi_app)',
        content:
            'Avoid hand-rolled FastAPI `CORSMiddleware` + `/health` boilerplate. Use `from krusch_toolkit.fastapi_app import create_fastapi_app, ok_envelope` instead.',
        matches(addedCode, survivingCode) {
            const hasBoilerplate =
                FASTAPI_CORS_RE.test(survivingCode) &&
                FASTAPI_HEALTH_ROUTE_RE.test(survivingCode);
            if (!hasBoilerplate) return false;

            const addedTrigger =
                FASTAPI_CORS_RE.test(addedCode) ||
                FASTAPI_HEALTH_ROUTE_RE.test(addedCode);
            if (!addedTrigger) return false;

            const hasToolkitFastApi =
                FASTAPI_TOOLKIT_RE.test(survivingCode) ||
                (TOOLKIT_PY_ROOT_RE.test(survivingCode) && /\bfastapi_app\b/.test(survivingCode));
            return !hasToolkitFastApi;
        }
    },
    {
        priority: 5,
        id: 'INV-LEGO-REACT-FETCH',
        ruleKey: 'INV-LEGO-REACT-FETCH',
        toolkitFile: 'lib/react.js',
        toolkitAnchor: 'lib/spec.md#INV-LEGO-03 (@krusch/toolkit/react)',
        content:
            'Avoid un-aborted `fetch(` inside React `useEffect`. Use `useApiQuery`, `useSSEStream`, or `fetchApiJson` from `@krusch/toolkit/react` (or wire `AbortController` `signal` teardown).',
        matches(addedCode, survivingCode) {
            if (!hasFetchInsideUseEffect(survivingCode)) return false;

            const addedTrigger =
                REACT_USE_EFFECT_RE.test(addedCode) ||
                REACT_RAW_FETCH_RE.test(addedCode);
            if (!addedTrigger) return false;

            return !REACT_ABORT_SAFE_RE.test(survivingCode);
        }
    },
    {
        priority: 6,
        id: 'INV-LEGO-WEBHOOKS',
        ruleKey: 'INV-LEGO-WEBHOOKS',
        toolkitFile: 'lib/webhooks.js',
        toolkitAnchor: 'lib/spec.md#INV-LEGO-09 (@krusch/toolkit/webhooks)',
        content:
            'Avoid hand-rolled `createHmac` webhook signature checks. Use `verifySlackSignature`, `verifyGithubSignature`, `verifyStripeSignature`, or `verifyBearerToken` from `@krusch/toolkit/webhooks`.',
        matches(addedCode, survivingCode) {
            const hasRawWebhook =
                WEBHOOK_CREATE_HMAC_RE.test(survivingCode) &&
                WEBHOOK_PROVIDER_HEADER_RE.test(survivingCode);
            if (!hasRawWebhook) return false;

            const addedTrigger =
                WEBHOOK_CREATE_HMAC_RE.test(addedCode) ||
                WEBHOOK_PROVIDER_HEADER_RE.test(addedCode);
            if (!addedTrigger) return false;

            const hasToolkitWebhooks =
                WEBHOOK_TOOLKIT_IMPORT_RE.test(survivingCode) ||
                (TOOLKIT_JS_ROOT_RE.test(survivingCode) && WEBHOOK_TOOLKIT_SYMBOLS_RE.test(survivingCode));
            return !hasToolkitWebhooks;
        }
    }
];

function isWordOrDotCode(c) {
    return (
        (c >= 97 && c <= 122) ||
        (c >= 65 && c <= 90) ||
        (c >= 48 && c <= 57) ||
        c === 95 || c === 36 || c === 46
    );
}

function isSpaceCode(c) {
    return c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 11;
}

function hasFetchInsideUseEffect(cleaned) {
    if (!REACT_USE_EFFECT_RE.test(cleaned) || !REACT_RAW_FETCH_RE.test(cleaned)) {
        return false;
    }

    const useEffectRe = /\buseEffect\s*\(/g;
    const len = cleaned.length;
    let cursor = 0;
    let match;

    while ((match = useEffectRe.exec(cleaned)) !== null) {
        if (match.index < cursor) continue;
        const openParenIdx = match.index + match[0].length - 1;
        let i = openParenIdx + 1;
        let depth = 1;
        const tplBraceStack = [];
        let lastSigChar = '(';
        let lastWord = '';
        let wordBuf = '';
        let codeSpan = '(';

        const flushWord = () => {
            if (wordBuf) {
                lastWord = wordBuf;
                wordBuf = '';
            }
        };

        const skipTemplateLiteral = () => {
            while (i < len) {
                const tc = cleaned.charCodeAt(i);
                if (tc === 92 && i + 1 < len) {
                    i += 2;
                    continue;
                }
                if (tc === 36 && cleaned.charCodeAt(i + 1) === 123) {
                    tplBraceStack.push(0);
                    lastSigChar = '{';
                    lastWord = '';
                    codeSpan += ' {';
                    i += 2;
                    return;
                }
                if (tc === 96) {
                    lastSigChar = '`';
                    lastWord = '';
                    codeSpan += ' ';
                    i += 1;
                    return;
                }
                i += 1;
            }
        };

        while (i < len && depth > 0) {
            const code = cleaned.charCodeAt(i);
            const ch = cleaned[i];

            if (code === 47 && (i === 0 || cleaned.charCodeAt(i - 1) !== 60)) {
                flushWord();
                const lastSigCode = lastSigChar ? lastSigChar.charCodeAt(0) : 0;
                const canStartRegex =
                    lastSigChar === '' ||
                    '(,[=:{;!&|?+-*~^%>'.includes(lastSigChar) ||
                    (((lastSigCode >= 97 && lastSigCode <= 122) ||
                        (lastSigCode >= 65 && lastSigCode <= 90) ||
                        lastSigCode === 95 ||
                        lastSigCode === 36) &&
                        JS_REGEX_PREFIX_KEYWORDS.has(lastWord));
                if (canStartRegex) {
                    const regexEnd = tryScanJsRegex(cleaned, i);
                    if (regexEnd > i) {
                        i = regexEnd;
                        lastSigChar = '/';
                        lastWord = '';
                        codeSpan += ' ';
                        continue;
                    }
                }
                lastSigChar = '/';
                codeSpan += '/';
                i += 1;
                continue;
            }

            if (code === 96) {
                flushWord();
                codeSpan += ' ';
                i += 1;
                skipTemplateLiteral();
                continue;
            }

            if (code === 39 || code === 34) {
                flushWord();
                const quoteCode = code;
                i += 1;
                while (i < len) {
                    const qc = cleaned.charCodeAt(i);
                    if (qc === 92 && i + 1 < len) {
                        i += 2;
                        continue;
                    }
                    if (qc === 10) break;
                    i += 1;
                    if (qc === quoteCode) break;
                }
                lastSigChar = ch;
                lastWord = '';
                codeSpan += ' ';
                continue;
            }

            if (tplBraceStack.length > 0) {
                if (code === 123) {
                    flushWord();
                    tplBraceStack[tplBraceStack.length - 1] += 1;
                    lastSigChar = '{';
                    codeSpan += '{';
                    i += 1;
                    continue;
                }
                if (code === 125) {
                    flushWord();
                    if (tplBraceStack[tplBraceStack.length - 1] > 0) {
                        tplBraceStack[tplBraceStack.length - 1] -= 1;
                        lastSigChar = '}';
                        codeSpan += '}';
                        i += 1;
                        continue;
                    }
                    tplBraceStack.pop();
                    codeSpan += '} ';
                    i += 1;
                    skipTemplateLiteral();
                    continue;
                }
            }

            if (code === 40) {
                flushWord();
                depth += 1;
                lastSigChar = '(';
                codeSpan += '(';
                i += 1;
                continue;
            }
            if (code === 41) {
                flushWord();
                depth -= 1;
                lastSigChar = ')';
                codeSpan += ')';
                i += 1;
                continue;
            }

            if (isWordOrDotCode(code)) {
                wordBuf += ch;
                lastSigChar = ch;
            } else {
                flushWord();
                if (!isSpaceCode(code)) {
                    lastSigChar = ch;
                }
            }
            codeSpan += ch;
            i += 1;
        }

        // If EOF is reached before depth === 0 (truncated diff hunk), codeSpan contains remaining span
        cursor = i;
        if (/(?:^|[^.\w$])fetch\s*\(/.test(codeSpan) || /\b(?:window|globalThis|self)\.fetch\s*\(/.test(codeSpan)) {
            return true;
        }
    }

    return false;
}

/**
 * Inspects source code or unified diff text for hand-rolled infrastructure boilerplate
 * that should be replaced by `@krusch/toolkit` or `krusch_toolkit` Lego bricks.
 *
 * @param {string} [code='']
 * @param {string} [filePath='']
 * @returns {Array<{
 *   id: string,
 *   ruleKey: string,
 *   category: 'invariant',
 *   content: string,
 *   provenance: { file: string, citation: string }
 * }>}
 */
export function detectHandRolledBoilerplate(code = '', filePath = '') {
    if (typeof code !== 'string' || !code.trim()) {
        return [];
    }

    const boundedCode = code.length > MAX_INSPECT_CHARS ? code.slice(0, MAX_INSPECT_CHARS) : code;
    const callerPath = typeof filePath === 'string' ? filePath.trim() : '';
    const parsed = extractAddedCodeLines(boundedCode, callerPath);
    if (!parsed.isDiff && callerPath && LEGO_GUARD_EXEMPT_PATH_RE.test(callerPath)) {
        return [];
    }

    const activeSegments = parsed.hunks
        .map((hunk) => {
            const effectivePath = hunk.filePath || callerPath;
            const isPython = inferIsPythonSource(hunk.survivingCode, effectivePath);
            const cleanAdded = stripCodeComments(hunk.addedCode, { isPython });
            const cleanSurviving = hunk.survivingCode === hunk.addedCode
                ? cleanAdded
                : stripCodeComments(hunk.survivingCode, { isPython });
            return {
                ...hunk,
                cleanAdded,
                cleanSurviving
            };
        })
        .filter((hunk) => {
            if (!hunk.cleanAdded || !hunk.cleanAdded.trim()) return false;
            const effectivePath = hunk.filePath || callerPath;
            if (effectivePath && LEGO_GUARD_EXEMPT_PATH_RE.test(effectivePath)) {
                return false;
            }
            return true;
        });

    if (activeSegments.length === 0) {
        return [];
    }

    const findings = [];
    for (const rule of BOILERPLATE_RULES) {
        for (const segment of activeSegments) {
            if (rule.matches(segment.cleanAdded, segment.cleanSurviving)) {
                const targetFile = segment.filePath || normalizeFilePath(callerPath) || rule.toolkitFile;
                const citation = segment.filePath || callerPath
                    ? `${targetFile} [${rule.toolkitAnchor}]`
                    : rule.toolkitAnchor;
                findings.push({
                    id: rule.id,
                    ruleKey: rule.ruleKey,
                    category: 'invariant',
                    content: rule.content,
                    provenance: {
                        file: targetFile,
                        citation
                    }
                });
                break;
            }
        }
        if (findings.length >= 2) {
            break;
        }
    }

    return findings;
}

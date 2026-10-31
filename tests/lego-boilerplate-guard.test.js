import test from 'node:test';
import assert from 'node:assert/strict';
import {
    LEGO_GUARD_EXEMPT_PATH_RE,
    extractAddedCodeLines,
    detectHandRolledBoilerplate
} from '../src/lego-boilerplate-guard.js';

test('Lego Boilerplate Guard (INV-LEGO-01..06)', async (t) => {
    await t.test('1. Positive detections across all 5 boilerplate-reinvention patterns', () => {
        // 1) INV-LEGO-MCP
        const mcpFindings = detectHandRolledBoilerplate(
            [
                "import { Server } from '@modelcontextprotocol/sdk/server/index.js';",
                "import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';",
                "const server = new Server({ name: 'custom-mcp', version: '1.0.0' }, { capabilities: { tools: {} } });",
                'await server.connect(new StdioServerTransport());'
            ].join('\n'),
            'projects/demo-service/src/mcp.js'
        );
        assert.equal(mcpFindings.length, 1);
        assert.equal(mcpFindings[0].id, 'INV-LEGO-MCP');
        assert.equal(mcpFindings[0].ruleKey, 'INV-LEGO-MCP');
        assert.equal(mcpFindings[0].category, 'invariant');
        assert.match(mcpFindings[0].content, /@krusch\/toolkit\/mcp/);
        assert.match(mcpFindings[0].content, /defineMcpTool/);
        assert.equal(mcpFindings[0].provenance.file, 'projects/demo-service/src/mcp.js');

        // 2) INV-LEGO-SSE (with X-Accel-Buffering and with Cache-Control)
        const sseAccelFindings = detectHandRolledBoilerplate(
            [
                'export function streamEvents(req, res) {',
                "  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' });",
                '}'
            ].join('\n'),
            'projects/demo-service/src/routes/events.js'
        );
        assert.equal(sseAccelFindings.length, 1);
        assert.equal(sseAccelFindings[0].id, 'INV-LEGO-SSE');
        assert.match(sseAccelFindings[0].content, /sseResponse/);
        assert.match(sseAccelFindings[0].content, /sse_event_response/);

        const sseCacheFindings = detectHandRolledBoilerplate(
            [
                "res.setHeader('Content-Type', 'text/event-stream');",
                "res.setHeader('Cache-Control', 'no-cache');"
            ].join('\n'),
            'projects/demo-service/src/stream.js'
        );
        assert.equal(sseCacheFindings.length, 1);
        assert.equal(sseCacheFindings[0].id, 'INV-LEGO-SSE');

        // 3) INV-LEGO-DB (PostgreSQL Pool + SQLite better-sqlite3 Database)
        const pgFindings = detectHandRolledBoilerplate(
            [
                "import pg from 'pg';",
                'export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });'
            ].join('\n'),
            'projects/demo-service/src/db.js'
        );
        assert.equal(pgFindings.length, 1);
        assert.equal(pgFindings[0].id, 'INV-LEGO-DB');
        assert.match(pgFindings[0].content, /createPgPool/);

        const sqliteFindings = detectHandRolledBoilerplate(
            [
                "import Database from 'better-sqlite3';",
                "const db = new Database('./local.sqlite');"
            ].join('\n'),
            'projects/demo-service/src/sqlite.js'
        );
        assert.equal(sqliteFindings.length, 1);
        assert.equal(sqliteFindings[0].id, 'INV-LEGO-DB');
        assert.match(sqliteFindings[0].content, /initDb/);

        // 4) INV-LEGO-FASTAPI
        const fastApiFindings = detectHandRolledBoilerplate(
            [
                'from fastapi import FastAPI',
                'from fastapi.middleware.cors import CORSMiddleware',
                'app = FastAPI()',
                'app.add_middleware(CORSMiddleware, allow_origins=["*"])',
                '@app.get("/health")',
                'def health_check():',
                '    return {"ok": True}'
            ].join('\n'),
            'projects/demo-py/app/main.py'
        );
        assert.equal(fastApiFindings.length, 1);
        assert.equal(fastApiFindings[0].id, 'INV-LEGO-FASTAPI');
        assert.match(fastApiFindings[0].content, /create_fastapi_app/);

        // 5) INV-LEGO-REACT-FETCH
        const reactFindings = detectHandRolledBoilerplate(
            [
                "import { useEffect, useState } from 'react';",
                'export function MetricsPanel() {',
                '  const [rows, setRows] = useState([]);',
                '  useEffect(() => {',
                "    fetch('/api/metrics').then((r) => r.json()).then(setRows);",
                '  }, []);',
                '  return null;',
                '}'
            ].join('\n'),
            'projects/demo-ui/client/src/MetricsPanel.jsx'
        );
        assert.equal(reactFindings.length, 1);
        assert.equal(reactFindings[0].id, 'INV-LEGO-REACT-FETCH');
        assert.match(reactFindings[0].content, /useApiQuery/);
    });

    await t.test('2. Zero findings when @krusch/toolkit/* or krusch_toolkit.* equivalents are imported', () => {
        // MCP with @krusch/toolkit/mcp
        assert.deepEqual(
            detectHandRolledBoilerplate(
                [
                    "import { createMcpServer, defineMcpTool, okMcpResult } from '@krusch/toolkit/mcp';",
                    "import { Server } from '@modelcontextprotocol/sdk/server/index.js';",
                    "import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';",
                    "const s = new Server({ name: 'wrapped', version: '1.0.0' });"
                ].join('\n'),
                'projects/demo-service/src/mcp.js'
            ),
            []
        );

        // SSE with @krusch/toolkit/streaming and Python krusch_toolkit.fastapi_app
        assert.deepEqual(
            detectHandRolledBoilerplate(
                [
                    "import { sseResponse } from '@krusch/toolkit/streaming';",
                    "// Content-Type: text/event-stream, X-Accel-Buffering: no"
                ].join('\n'),
                'projects/demo-service/src/stream.js'
            ),
            []
        );
        assert.deepEqual(
            detectHandRolledBoilerplate(
                [
                    'from krusch_toolkit.fastapi_app import sse_event_response',
                    '# media_type="text/event-stream", X-Accel-Buffering: no'
                ].join('\n'),
                'projects/demo-py/app/stream.py'
            ),
            []
        );

        // DB with @krusch/toolkit/pg, @krusch/toolkit/polygres, and @krusch/toolkit/db
        assert.deepEqual(
            detectHandRolledBoilerplate(
                [
                    "import { createPgPool } from '@krusch/toolkit/pg';",
                    "import pg from 'pg';",
                    'export const wrapper = createPgPool({}, { PoolClass: pg.Pool });',
                    'const custom = new pg.Pool();'
                ].join('\n'),
                'projects/demo-service/src/db.js'
            ),
            []
        );
        assert.deepEqual(
            detectHandRolledBoilerplate(
                [
                    "import { createPolygresClient } from '@krusch/toolkit/polygres';",
                    'const fallback = new Pool();'
                ].join('\n'),
                'projects/demo-service/src/polygres.js'
            ),
            []
        );
        assert.deepEqual(
            detectHandRolledBoilerplate(
                [
                    "import { initDb } from '@krusch/toolkit/db';",
                    "import Database from 'better-sqlite3';",
                    "const raw = new Database(':memory:');"
                ].join('\n'),
                'projects/demo-service/src/sqlite.js'
            ),
            []
        );

        // FastAPI with krusch_toolkit.fastapi_app
        assert.deepEqual(
            detectHandRolledBoilerplate(
                [
                    'from krusch_toolkit.fastapi_app import create_fastapi_app, ok_envelope',
                    'from fastapi.middleware.cors import CORSMiddleware',
                    'app = create_fastapi_app("Demo")',
                    '@app.get("/health")',
                    'def custom_health():',
                    '    return ok_envelope("health", "ok")'
                ].join('\n'),
                'projects/demo-py/app/main.py'
            ),
            []
        );

        // React fetch with useApiQuery / fetchApiJson / AbortController
        assert.deepEqual(
            detectHandRolledBoilerplate(
                [
                    "import { useEffect } from 'react';",
                    "import { fetchApiJson } from '@krusch/toolkit/react';",
                    "useEffect(() => { fetch('/api/ping'); }, []);"
                ].join('\n'),
                'projects/demo-ui/src/App.jsx'
            ),
            []
        );
        assert.deepEqual(
            detectHandRolledBoilerplate(
                [
                    "import { useEffect } from 'react';",
                    'useEffect(() => {',
                    '  const controller = new AbortController();',
                    "  fetch('/api/items', { signal: controller.signal });",
                    '  return () => controller.abort();',
                    '}, []);'
                ].join('\n'),
                'projects/demo-ui/src/App.jsx'
            ),
            []
        );
    });

    await t.test('3. Zero findings on exempt toolkit, stack, benchmark, and test paths', () => {
        const heavyBoilerplate = [
            "import pg from 'pg';",
            'const pool = new pg.Pool();',
            "res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' });",
            'useEffect(() => { fetch("/api/raw"); }, []);'
        ].join('\n');

        const exemptPaths = [
            'lib/http.js',
            '/home/krusch/homelab/lib/pg.js',
            'lib-py/krusch_toolkit/fastapi_app.py',
            'projects/krusch-stack/src/engines/frontend-engine.js',
            'tests/foo.test.js',
            'projects/demo/test/integration.js',
            'projects/demo/src/__tests__/widget.jsx',
            'projects/demo/src/Widget.spec.tsx',
            'test_api_routes.py',
            'projects/demo/benchmarks/runner.js',
            'node_modules/some-pkg/index.js'
        ];

        for (const fp of exemptPaths) {
            assert.equal(LEGO_GUARD_EXEMPT_PATH_RE.test(fp), true, `Expected ${fp} to match LEGO_GUARD_EXEMPT_PATH_RE`);
            assert.deepEqual(
                detectHandRolledBoilerplate(heavyBoilerplate, fp),
                [],
                `Expected zero findings for exempt path ${fp}`
            );
        }
    });

    await t.test('4. Unified diff handling: refactoring away from boilerplate (- new pg.Pool -> + createPgPool) yields 0 findings', () => {
        const refactorDiff = [
            'diff --git a/projects/spark/src/db.js b/projects/spark/src/db.js',
            'index 1111111..2222222 100644',
            '--- a/projects/spark/src/db.js',
            '+++ b/projects/spark/src/db.js',
            '@@ -1,6 +1,5 @@',
            "-import pg from 'pg';",
            '-export const pool = new pg.Pool({',
            '-  connectionString: process.env.DATABASE_URL',
            '-});',
            "+import { createPgPool } from '@krusch/toolkit/pg';",
            '+export const db = createPgPool({ url: process.env.DATABASE_URL });'
        ].join('\n');

        const parsed = extractAddedCodeLines(refactorDiff);
        assert.equal(parsed.isDiff, true);
        assert.equal(parsed.hunks.length, 1);
        assert.equal(parsed.hunks[0].filePath, 'projects/spark/src/db.js');
        assert.equal(parsed.hunks[0].addedCode.includes('new pg.Pool'), false);
        assert.equal(parsed.hunks[0].addedCode.includes('createPgPool'), true);
        assert.deepEqual(detectHandRolledBoilerplate(refactorDiff), []);

        // Pure deletion of legacy boilerplate without adding toolkit import must also return 0 findings
        const pureRemovalDiff = [
            '--- a/projects/spark/src/legacy.js',
            '+++ b/projects/spark/src/legacy.js',
            '@@ -10,3 +10,1 @@',
            '-const legacyPool = new pg.Pool();',
            '+// legacy connection removed'
        ].join('\n');
        assert.deepEqual(detectHandRolledBoilerplate(pureRemovalDiff), []);

        // Multi-file diff: boilerplate added inside exempt `lib/pg.js` + clean code in `projects/app/src/index.js` -> 0 findings
        const mixedExemptDiff = [
            'diff --git a/lib/pg.js b/lib/pg.js',
            '--- a/lib/pg.js',
            '+++ b/lib/pg.js',
            '@@ -1,2 +1,4 @@',
            "+import pg from 'pg';",
            '+const internalPool = new pg.Pool();',
            'diff --git a/projects/app/src/index.js b/projects/app/src/index.js',
            '--- a/projects/app/src/index.js',
            '+++ b/projects/app/src/index.js',
            '@@ -1,1 +1,2 @@',
            "+import { okEnvelope } from '@krusch/toolkit/http';",
            "+export const status = () => okEnvelope('app', 'healthy');"
        ].join('\n');
        assert.deepEqual(detectHandRolledBoilerplate(mixedExemptDiff), []);
    });

    await t.test('5. Findings are capped at max 2 in deterministic priority order', () => {
        const kitchenSink = [
            "import { Server } from '@modelcontextprotocol/sdk/server/index.js';",
            "import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';",
            "import pg from 'pg';",
            'const srv = new Server({ name: "x", version: "1.0.0" });',
            'const transport = new StdioServerTransport();',
            'const pool = new pg.Pool();',
            "res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' });",
            'useEffect(() => { fetch("/api/items"); }, []);'
        ].join('\n');

        const findings = detectHandRolledBoilerplate(kitchenSink, 'projects/demo/src/everything.js');
        assert.equal(findings.length, 2);
        assert.deepEqual(
            findings.map((f) => f.id),
            ['INV-LEGO-MCP', 'INV-LEGO-SSE']
        );
    });

    await t.test('6. End-to-end handleProactiveNudge surfaces INV-LEGO-* findings on pre_commit', async () => {
        const { handleProactiveNudge } = await import('../src/proactive-engine.js');
        const res = await handleProactiveNudge({
            trigger: 'pre_commit',
            file_path: 'projects/new-app/src/db.js',
            code: "import pg from 'pg';\nexport const pool = new pg.Pool();"
        });
        const text = res?.content?.[0]?.text || '';
        assert.match(text, /INV-LEGO-DB/);
        assert.match(text, /@krusch\/toolkit\/pg/);
    });

    await t.test('7. Downstream src/lib paths are audited while comments, docs, and non-pg Pools are ignored (REF1-07)', () => {
        // Downstream `src/lib/` MUST NOT be exempted
        const nestedLibFindings = detectHandRolledBoilerplate(
            "import { Pool } from 'pg';\nexport const dbPool = new Pool();\n",
            'projects/demo-service/src/lib/db.js'
        );
        assert.equal(nestedLibFindings.length, 1);
        assert.equal(nestedLibFindings[0].id, 'INV-LEGO-DB');

        // Unqualified `new Pool(` from `undici` (not `pg`) must NOT trigger false positive
        assert.deepEqual(
            detectHandRolledBoilerplate(
                "import { Pool } from 'undici';\nexport const httpPool = new Pool('https://example.com');\n",
                'projects/demo-service/src/lib/http-client.js'
            ),
            []
        );

        // Comments mentioning anti-patterns must NOT trigger false positives
        assert.deepEqual(
            detectHandRolledBoilerplate(
                [
                    '// Avoid new pg.Pool() and new Server() + StdioServerTransport',
                    '/* useEffect(() => { fetch("/api/items"); }, []); */',
                    'export const healthy = true;'
                ].join('\n'),
                'projects/demo-service/src/notes.js'
            ),
            []
        );

        // Markdown / config files must be exempt
        assert.deepEqual(
            detectHandRolledBoilerplate(
                "import pg from 'pg';\nconst pool = new pg.Pool();\n",
                'projects/demo-service/README.md'
            ),
            []
        );
    });

    await t.test('8. String literals containing /* before JSDoc comments neither swallow toolkit imports nor hide boilerplate (REF4-05)', () => {
        const cleanWithGlob = [
            'const testGlob = "tests/*.test.js";',
            "import pg from 'pg';",
            "import { createPgPool } from '@krusch/toolkit/pg';",
            '/** JSDoc comment after glob literal */',
            'export const pool = new pg.Pool();'
        ].join('\n');
        assert.deepEqual(detectHandRolledBoilerplate(cleanWithGlob, 'projects/demo-service/src/db.js'), []);

        const violationWithGlob = [
            'const testGlob = "tests/*.test.js";',
            "import pg from 'pg';",
            'export const pool = new pg.Pool();',
            '/** JSDoc comment after glob literal */'
        ].join('\n');
        const findings = detectHandRolledBoilerplate(violationWithGlob, 'projects/demo-service/src/db.js');
        assert.equal(findings.length, 1);
        assert.equal(findings[0].id, 'INV-LEGO-DB');
    });

    await t.test('9. ES2022 #private class fields, JS /`/g regex literals, and tight Python # comments are handled accurately (REF5-02)', () => {
        // Indented ES2022 `#pool = new pg.Pool(...)` in JS must be caught (not stripped as a `#` comment)
        const privateFieldJs = [
            "import pg from 'pg';",
            'export class Repo {',
            '  #pool = new pg.Pool({ max: 5 });',
            '}'
        ].join('\n');
        const privFindings = detectHandRolledBoilerplate(privateFieldJs, 'projects/demo-service/src/repo.js');
        assert.equal(privFindings.length, 1);
        assert.equal(privFindings[0].id, 'INV-LEGO-DB');

        // Backtick inside JS regex `/`/g` must NOT open template literal mode or unstrip later `//` comments
        const regexBacktickClean = [
            'export const clean = (s) => s.replace(/`/g, "");',
            '// Replaced legacy new pg.Pool() here'
        ].join('\n');
        assert.deepEqual(detectHandRolledBoilerplate(regexBacktickClean, 'projects/demo-service/src/sanitize.js'), []);

        const regexBacktickCommentedImport = [
            'export const clean = (s) => s.replace(/`/g, "");',
            "// import { createPgPool } from '@krusch/toolkit/pg';",
            "import pg from 'pg';",
            'export const pool = new pg.Pool();'
        ].join('\n');
        const bypassFindings = detectHandRolledBoilerplate(regexBacktickCommentedImport, 'projects/demo-service/src/db.js');
        assert.equal(bypassFindings.length, 1);
        assert.equal(bypassFindings[0].id, 'INV-LEGO-DB');

        // Zero-space inline `#` comment in Python must be stripped
        const pyInlineHash = [
            'from fastapi import FastAPI',
            'from fastapi.middleware.cors import CORSMiddleware',
            'app = FastAPI()',
            'app.add_middleware(CORSMiddleware, allow_origins=["*"])',
            'x = 1#@app.get("/health")'
        ].join('\n');
        assert.deepEqual(detectHandRolledBoilerplate(pyInlineHash, 'projects/demo-py/app/main.py'), []);
    });

    await t.test('10. JS template literal ${...} interpolations with regexes, nested braces, and inline comments stay synchronized (REF7-02)', () => {
        const tplCommentedImportBypass = [
            'const label = `item ${name.replace(/`/g, "")}`;',
            "// import { createPgPool } from '@krusch/toolkit/pg';",
            "import pg from 'pg';",
            'export const pool = new pg.Pool();'
        ].join('\n');
        const findings1 = detectHandRolledBoilerplate(tplCommentedImportBypass, 'projects/demo-service/src/db.js');
        assert.equal(findings1.length, 1);
        assert.equal(findings1[0].id, 'INV-LEGO-DB');

        const tplInlineCommentBypass = [
            'const q = `${ // import { createPgPool } from "@krusch/toolkit/pg"',
            '  x }`;',
            "import pg from 'pg';",
            'export const pool = new pg.Pool();'
        ].join('\n');
        const findings2 = detectHandRolledBoilerplate(tplInlineCommentBypass, 'projects/demo-service/src/db.js');
        assert.equal(findings2.length, 1);
        assert.equal(findings2[0].id, 'INV-LEGO-DB');

        const tplBenignCommentAfterRegex = [
            'const label = `item ${fmt({ k: `inner ${1}` }, name.replace(/`/g, ""))}`;',
            '// Avoid new Server() and StdioServerTransport',
            'export const ok = true;'
        ].join('\n');
        assert.deepEqual(detectHandRolledBoilerplate(tplBenignCommentAfterRegex, 'projects/demo-service/src/util.js'), []);
    });

    await t.test('11. O(N) useEffect fetch span scanner avoids sibling-handler false positives while catching full and truncated diff hunks (REF13-02)', () => {
        const siblingHandlerCode = [
            "import { useEffect } from 'react';",
            'export function Panel({ title }) {',
            '  useEffect(() => { const re = /\\)/; document.title = title; }, [title]);',
            "  const onSave = async () => { await fetch('/api/save', { method: 'POST' }); };",
            '  return onSave;',
            '}'
        ].join('\n');
        assert.deepEqual(detectHandRolledBoilerplate(siblingHandlerCode, 'projects/demo-ui/src/Panel.jsx'), []);

        const repeatedEffects = `${'useEffect(() => { const q = 8 / 2; }, []);\n'.repeat(5000)}const run = () => fetch('/api/ping');\n`;
        const t0 = performance.now();
        const manyRes = detectHandRolledBoilerplate(repeatedEffects, 'projects/demo-ui/src/Many.jsx');
        const elapsed = performance.now() - t0;
        assert.ok(elapsed < 400, `Expected linear scan <400ms, got ${elapsed.toFixed(1)}ms`);
        assert.deepEqual(manyRes, []);

        const truncatedDiffHunk = [
            'diff --git a/projects/demo-ui/src/Feed.jsx b/projects/demo-ui/src/Feed.jsx',
            '--- a/projects/demo-ui/src/Feed.jsx',
            '+++ b/projects/demo-ui/src/Feed.jsx',
            '@@ -10,2 +10,5 @@',
            '   useEffect(() => {',
            '+    const clean = slug.replace(/\\)/g, "");',
            "+    fetch('/api/feed/' + clean).then((r) => r.json());"
        ].join('\n');
        const hunkFindings = detectHandRolledBoilerplate(truncatedDiffHunk);
        assert.equal(hunkFindings.length, 1);
        assert.equal(hunkFindings[0].id, 'INV-LEGO-REACT-FETCH');
    });

    await t.test('12. Proactive engine identifier and symbol extractors run in linear O(N) time on 32KB contiguous blobs (REF15-03)', async () => {
        const { buildQueryNudgeContext, scoreRuleRelevance } = await import('../src/proactive-engine.js');

        const alphaBlob = 'a'.repeat(32_000);
        const pathishBlob = `${'seg-'.repeat(8_000)}tail_`;

        const t0 = performance.now();
        const queryCtxA = buildQueryNudgeContext(alphaBlob);
        const queryCtxB = buildQueryNudgeContext(pathishBlob);
        const syntheticRule = {
            id: 'syn-1',
            category: 'invariant',
            content: `${alphaBlob} ${pathishBlob} \`createPgPool\``,
            tags: [pathishBlob]
        };
        const scored = scoreRuleRelevance(syntheticRule, queryCtxA);
        const elapsedMs = performance.now() - t0;

        assert.ok(elapsedMs < 300, `Expected linear O(N) extraction <300ms on 32KB blobs, got ${elapsedMs.toFixed(1)}ms`);
        assert.ok(queryCtxA.queryIdentifiers instanceof Set);
        assert.ok(queryCtxB.queryIdentifiers instanceof Set);
        assert.equal(typeof scored.qualifies, 'boolean');
    });

    await t.test('13. Wave-2 INV-LEGO-WEBHOOKS detection and @krusch/toolkit/edge SSE exemption', () => {
        // Edge SSE using @krusch/toolkit/edge produces zero findings
        const edgeSseClean = [
            "import { edgeSseResponse } from '@krusch/toolkit/edge';",
            "// Content-Type: text/event-stream, Cache-Control: no-cache"
        ].join('\n');
        assert.deepEqual(detectHandRolledBoilerplate(edgeSseClean, 'projects/edge-app/src/worker.js'), []);

        // Hand-rolled webhook HMAC verification triggers INV-LEGO-WEBHOOKS
        const rawWebhookCode = [
            "import { createHmac } from 'node:crypto';",
            'export function verifyHook(req, rawBody) {',
            "  const sig = req.headers['x-hub-signature-256'];",
            "  const digest = 'sha256=' + createHmac('sha256', process.env.HOOK_SECRET).update(rawBody).digest('hex');",
            '  return sig === digest;',
            '}'
        ].join('\n');
        const hookFindings = detectHandRolledBoilerplate(rawWebhookCode, 'projects/demo-api/src/webhook.js');
        assert.equal(hookFindings.length, 1);
        assert.equal(hookFindings[0].id, 'INV-LEGO-WEBHOOKS');
        assert.match(hookFindings[0].content, /@krusch\/toolkit\/webhooks/);

        // Importing @krusch/toolkit/webhooks suppresses INV-LEGO-WEBHOOKS
        const cleanWebhookCode = [
            "import { verifyGithubSignature } from '@krusch/toolkit/webhooks';",
            "import { createHmac } from 'node:crypto';",
            "export const hdr = 'x-hub-signature-256';",
            'export const check = (rawBody) => verifyGithubSignature({ rawBody, signatureHeader: hdr, webhookSecret: "s" });'
        ].join('\n');
        assert.deepEqual(detectHandRolledBoilerplate(cleanWebhookCode, 'projects/demo-api/src/webhook.js'), []);
    });
});



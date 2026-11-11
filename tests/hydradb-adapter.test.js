import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import {
    getProjectDb,
    pushHydraProjectMemory,
    queryHydraProjectContext,
    getHydraClient,
    resolveProjectPath
} from '../src/sqlite-engine.js';
import { addMemory, supersedeMemory } from '../src/memory-engine.js';
import { unifiedRetrieve } from '../src/unified-retrieval.js';

function startMockHydra(handler) {
    return new Promise((resolve) => {
        const server = http.createServer(handler);
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            resolve({
                baseUrl: `http://127.0.0.1:${addr.port}`,
                close: () => new Promise((res) => server.close(res))
            });
        });
    });
}

test('krusch-context-mcp HydraDB bridge: pushes superseding relations.ids and merges remote query chunks', async () => {
    const projectName = `test_hydra_bridge_${Date.now()}`;
    const ingestedPayloads = [];
    const queryPayloads = [];

    const mock = await startMockHydra((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const rawBody = Buffer.concat(chunks).toString('utf8');
            res.setHeader('Content-Type', 'application/json');

            if (req.url === '/context/ingest' && req.method === 'POST') {
                ingestedPayloads.push({
                    headers: req.headers,
                    rawBody
                });
                res.end(
                    JSON.stringify({
                        success: true,
                        data: { accepted: true },
                        error: null,
                        meta: { request_id: 'req_ctx_ingest_1', latency_ms: 5.1 }
                    })
                );
                return;
            }

            if (req.url === '/query' && req.method === 'POST') {
                queryPayloads.push(JSON.parse(rawBody));
                res.end(
                    JSON.stringify({
                        success: true,
                        data: {
                            chunks: [
                                {
                                    id: 'hydra-remote-chunk-1',
                                    source_id: `${projectName}-mem-999`,
                                    title: 'Remote Road Invariant',
                                    score: 0.89,
                                    text: 'HydraDB remote road invariant: enforce sub-second temporal graph lineage.'
                                }
                            ],
                            sources: [
                                {
                                    id: `${projectName}-mem-999`,
                                    title: 'Remote Road Invariant'
                                }
                            ],
                            graph_context: {
                                query_paths: [`${projectName}-mem-2 --[SUPERSEDES]--> ${projectName}-mem-1`]
                            }
                        },
                        error: null,
                        meta: { request_id: 'req_ctx_query_1', latency_ms: 9.4 }
                    })
                );
                return;
            }

            res.end(JSON.stringify({ success: true, data: {}, error: null }));
        });
    });

    const prevKey = process.env.HYDRADB_API_KEY;
    const prevUrl = process.env.HYDRADB_BASE_URL;
    const prevAllowTest = process.env.HYDRADB_ALLOW_TEST_PUSH;

    try {
        process.env.HYDRADB_API_KEY = 'hydra_ctx_bridge_key';
        process.env.HYDRADB_BASE_URL = mock.baseUrl;
        process.env.HYDRADB_ALLOW_TEST_PUSH = 'true';

        const m1 = await addMemory({
            project: projectName,
            category: 'decision',
            content: 'Initial architecture decision: store context in local SQLite WAL.',
            force: true,
            _embedding: [0.1, 0.2, 0.3, 0.4]
        });
        assert.ok(m1.id);

        const m2 = await supersedeMemory({
            project: projectName,
            target_id: m1.id,
            category: 'decision',
            content: 'Updated architecture decision: sync local SQLite WAL with HydraDB v2 graph relations.',
            _embedding: [0.1, 0.2, 0.3, 0.4]
        });
        assert.ok(m2.id);

        const db = await getProjectDb(projectName);
        const client = getHydraClient({
            apiKey: 'hydra_ctx_bridge_key',
            baseUrl: mock.baseUrl
        });
        const pushRes = await pushHydraProjectMemory(projectName, db, client);
        assert.equal(pushRes.skipped, false);
        assert.ok(ingestedPayloads.length >= 1);

        const combinedIngestBody = ingestedPayloads.map((p) => p.rawBody).join('\n');
        assert.match(combinedIngestBody, /SUPERSEDES/);
        assert.match(combinedIngestBody, new RegExp(`${projectName}-mem-${m1.id}`));

        const remoteQuery = await queryHydraProjectContext(
            projectName,
            'temporal graph lineage',
            { hydraClient: client }
        );
        assert.equal(remoteQuery.chunks.length, 1);
        assert.equal(queryPayloads[0].graph_context, true);
        assert.equal(queryPayloads[0].query_forceful_relations, true);

        const unified = await unifiedRetrieve({
            project: projectName,
            query: 'temporal graph lineage',
            limit_tokens: 2000
        });
        assert.match(unified.content[0].text, /HydraDB remote road invariant/);
    } finally {
        if (prevKey === undefined) delete process.env.HYDRADB_API_KEY;
        else process.env.HYDRADB_API_KEY = prevKey;

        if (prevUrl === undefined) delete process.env.HYDRADB_BASE_URL;
        else process.env.HYDRADB_BASE_URL = prevUrl;

        if (prevAllowTest === undefined) delete process.env.HYDRADB_ALLOW_TEST_PUSH;
        else process.env.HYDRADB_ALLOW_TEST_PUSH = prevAllowTest;

        try {
            const projDir = resolveProjectPath(projectName);
            if (projDir && projDir.includes(projectName) && fs.existsSync(projDir)) {
                fs.rmSync(projDir, { recursive: true, force: true });
            }
        } catch {}

        await mock.close();
    }
});

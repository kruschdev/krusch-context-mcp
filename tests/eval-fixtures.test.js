import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('Frozen Benchmark Fixtures Contract Suite', async (t) => {
    const fixturePath = path.resolve(__dirname, '../evals/fixtures/corpus_14_ablation.json');

    await t.test('corpus_14_ablation.json exists and is valid JSON', async () => {
        const content = await fs.readFile(fixturePath, 'utf8');
        const data = JSON.parse(content);
        assert.ok(data, 'Fixture should parse cleanly');
        assert.strictEqual(data.name, 'in-corpus-14-ablation');
        assert.strictEqual(data.version, '1.0.0');
        assert.ok(Array.isArray(data.queries), 'Queries should be an array');
        assert.strictEqual(data.queries.length, 14, 'Must contain exactly 14 ablation queries');
    });

    await t.test('All 14 ablation queries contain required schema fields', async () => {
        const content = await fs.readFile(fixturePath, 'utf8');
        const data = JSON.parse(content);
        
        let semanticCount = 0;
        let symbolicCount = 0;

        for (const q of data.queries) {
            assert.ok(q.id, 'Query must have an ID');
            assert.ok(q.query && typeof q.query === 'string' && q.query.length > 5, 'Query must be non-empty string');
            assert.ok(['semantic', 'symbolic'].includes(q.type), `Query type must be semantic or symbolic, got: ${q.type}`);
            assert.ok(Array.isArray(q.expectedMatches) && q.expectedMatches.length > 0, 'Must have at least one expected match target');
            assert.ok(q.description, 'Query must have a descriptive purpose');

            if (q.type === 'semantic') semanticCount++;
            if (q.type === 'symbolic') symbolicCount++;
        }

        assert.strictEqual(semanticCount, 8, 'Must have exactly 8 Tier 1 semantic queries');
        assert.strictEqual(symbolicCount, 6, 'Must have exactly 6 Tier 2 symbolic/identifier queries');
    });

    await t.test('express_benchmark_10.json exists and is valid JSON', async () => {
        const expressFixturePath = path.resolve(__dirname, '../evals/fixtures/express_benchmark_10.json');
        const content = await fs.readFile(expressFixturePath, 'utf8');
        const data = JSON.parse(content);
        assert.ok(data, 'Express fixture should parse cleanly');
        assert.strictEqual(data.name, 'foreign-corpus-express-10');
        assert.strictEqual(data.version, '1.0.0');
        assert.ok(Array.isArray(data.queries), 'Queries should be an array');
        assert.strictEqual(data.queries.length, 10, 'Must contain exactly 10 foreign benchmark queries');

        let semanticCount = 0;
        let symbolicCount = 0;

        for (const q of data.queries) {
            assert.ok(q.id, 'Query must have an ID');
            assert.ok(q.query && typeof q.query === 'string' && q.query.length > 5, 'Query must be non-empty string');
            assert.ok(['semantic', 'symbolic'].includes(q.type), `Query type must be semantic or symbolic, got: ${q.type}`);
            assert.ok(Array.isArray(q.expectedMatches) && q.expectedMatches.length > 0, 'Must have at least one expected match target');
            assert.ok(q.description, 'Query must have a descriptive purpose');

            if (q.type === 'semantic') semanticCount++;
            if (q.type === 'symbolic') symbolicCount++;
        }

        assert.strictEqual(semanticCount, 5, 'Must have exactly 5 Tier 1 semantic queries');
        assert.strictEqual(symbolicCount, 5, 'Must have exactly 5 Tier 2 symbolic/identifier queries');
    });
});

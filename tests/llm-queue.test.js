import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PriorityQueue, validateOllamaConfig } from '../src/llm-queue.js';
import { withAnchoredCacheLock } from '../src/memory-engine.js';

describe('llm-queue endpoint configuration validation (SEC-01)', () => {
    it('throws a clear Error when all Ollama environment variables are missing in strict mode', () => {
        const emptyEnv = {};
        assert.throws(
            () => validateOllamaConfig(emptyEnv),
            /Missing Ollama endpoint configuration/
        );
        assert.throws(
            () => new PriorityQueue(2, { env: emptyEnv, strict: true }),
            /Missing Ollama endpoint configuration/
        );
    });

    it('returns an empty array in non-strict mode and parses configured endpoints cleanly', () => {
        const qEmpty = new PriorityQueue(2, { env: {} });
        assert.deepEqual(qEmpty.endpoints, []);

        const qFleet = new PriorityQueue(2, {
            env: { OLLAMA_FLEET_URLS: 'http://10.10.10.1:11434, http://10.10.10.2:11434' },
            strict: true
        });
        assert.deepEqual(qFleet.endpoints, [
            'http://10.10.10.1:11434',
            'http://10.10.10.2:11434'
        ]);
    });

    it('propagates and logs errors in withAnchoredCacheLock without deadlocking subsequent callers (BUG-01)', async () => {
        await assert.rejects(
            () => withAnchoredCacheLock(async () => {
                throw new Error('Cache lock task boom');
            }),
            /Cache lock task boom/
        );

        const nextVal = await withAnchoredCacheLock(async () => 'recovered');
        assert.equal(nextVal, 'recovered');
    });
});


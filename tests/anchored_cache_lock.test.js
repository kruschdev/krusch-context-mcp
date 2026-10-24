import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { withAnchoredCacheLock } from '../src/memory-engine.js';
import { CLI_SCRIPT_REGISTRY, resolveCliScriptPath } from '../bin/cli.js';

describe('withAnchoredCacheLock error propagation & CLI script registry (TEST-01, ARCH-01)', () => {
    it('TEST-01: propagates errors thrown inside withAnchoredCacheLock and recovers lock chain for subsequent callers', async () => {
        await assert.rejects(
            () => withAnchoredCacheLock(() => {
                throw new Error('boom');
            }),
            /boom/
        );

        const recoveryResult = await withAnchoredCacheLock(async () => 'recovered-after-boom');
        assert.equal(recoveryResult, 'recovered-after-boom');
    });

    it('ARCH-01: resolves registered CLI script utilities and rejects unknown subcommands', () => {
        for (const sub of Object.keys(CLI_SCRIPT_REGISTRY)) {
            const resolved = resolveCliScriptPath(sub);
            assert.equal(fs.existsSync(resolved), true, `Expected CLI script for '${sub}' to exist at ${resolved}`);
        }
        assert.throws(
            () => resolveCliScriptPath('unknown-subcommand'),
            /Unknown CLI script subcommand/
        );
    });
});

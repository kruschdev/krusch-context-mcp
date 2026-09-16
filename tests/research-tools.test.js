import test from 'node:test';
import assert from 'node:assert';
import { routeSkills, loadSkills } from '../src/skills-engine.js';
import { handleEvaluateResilience } from '../src/proactive-engine.js';

test('Research Tools Suite: DSR & Multi-Agent Resilience Gate', async (t) => {
    await loadSkills();

    await t.test('routeSkills should throw on missing query', () => {
        assert.throws(() => {
            routeSkills({});
        }, /Parameter 'query' is required/);
    });

    await t.test('routeSkills should select diverse skills for a task', () => {
        const res = routeSkills({
            query: 'deploy container updates and verify fleet hardware health',
            max_skills: 3,
            diversity_lambda: 0.6
        });

        assert.ok(res.content && res.content[0] && res.content[0].text);
        const text = res.content[0].text;
        assert.ok(text.includes('Diverse Skill Routing (DSR - arXiv: 2609.05824)'));
        assert.ok(text.includes('Diversity Score'));
        assert.ok(text.includes('Selected'));
    });

    await t.test('handleEvaluateResilience should throw on missing or empty handoffs', () => {
        assert.throws(() => {
            handleEvaluateResilience({});
        }, /Parameter 'handoffs' must be a non-empty array/);

        assert.throws(() => {
            handleEvaluateResilience({ handoffs: [] });
        }, /Parameter 'handoffs' must be a non-empty array/);
    });

    await t.test('handleEvaluateResilience should identify clean and resilient execution', () => {
        const handoffs = [
            { senderId: 'orchestrator', recipientId: 'worker-1', message: 'Analyze memory table', status: 'SUCCESS' },
            { senderId: 'worker-1', recipientId: 'orchestrator', message: 'Analysis complete: 42 records active', status: 'SUCCESS' }
        ];

        const res = handleEvaluateResilience({ handoffs });
        assert.ok(res.content && res.content[0] && res.content[0].text);
        const text = res.content[0].text;
        assert.ok(text.includes('RESILIENT'));
        assert.ok(text.includes('**Max Cascade Depth**: 0'));
        assert.ok(text.includes('**Circular Deadlock**: None'));
        assert.ok(text.includes('**Credential Leakages**: 0'));
    });

    await t.test('handleEvaluateResilience should flag cascades and sensitive credential leaks', () => {
        const handoffs = [
            { senderId: 'orchestrator', recipientId: 'worker-1', message: 'Deploy with api_key=sk-proj-secret-key-1234567890', status: 'ERROR', error: 'Unauthorized' },
            { senderId: 'worker-1', recipientId: 'worker-2', message: 'Retry auth with bearer abcdef1234567890', status: 'ERROR', error: 'Timeout' },
            { senderId: 'worker-2', recipientId: 'worker-3', message: 'Fatal crash', status: 'ERROR', error: 'OOM' }
        ];

        const res = handleEvaluateResilience({ handoffs, max_cascade_depth: 2 });
        assert.ok(res.content && res.content[0] && res.content[0].text);
        const text = res.content[0].text;
        assert.ok(text.includes('AT RISK / GATED'));
        assert.ok(text.includes('Error cascade depth 3 exceeds limit 2'));
        assert.ok(text.includes('**Credential Leakages**: 2'));
    });
});

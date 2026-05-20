import test from 'node:test';
import assert from 'node:assert';
import { writeSessionHandoff, readSessionReview } from '../src/session-engine.js';
import { pool } from 'pg-git-mcp/db/pool.js';

test('Session Engine Unit Tests', async (t) => {

    await t.test('writeSessionHandoff should throw if project or summary missing', async () => {
        try {
            await writeSessionHandoff({ project: 'krusch-nexus' });
            assert.fail('Should have thrown an error');
        } catch (e) {
            assert.ok(e.message.includes('Project and summary are required'), 'Expected validation error');
        }
    });

    let handoffId = null;

    await t.test('writeSessionHandoff should insert handoff and spawn bridge', async () => {
        const res = await writeSessionHandoff({
            project: 'test-project',
            summary: 'This is a test session handoff summary for unit tests.'
        });
        
        assert.ok(res.content[0].text.includes('Session handoff successfully recorded'), 'Should return success text');
        assert.ok(res.content[0].text.includes('Jean SRE has been triggered'), 'Should mention Jean SRE spawn');
    });

    await t.test('readSessionReview should return no pending reviews if none exist', async () => {
        const res = await readSessionReview({ project: 'test-project' });
        assert.ok(res.content[0].text.includes('No pending session review'), 'Should return no pending review text');
    });

    await t.test('readSessionReview should fetch and mark review as consumed', async () => {
        // Manually insert a mock review
        const mockRes = await pool.query(
            `INSERT INTO session_handoffs (session_type, direction, project, content, reviewed)
             VALUES ('jean', 'review', 'test-project', 'Test Review Content from Jean SRE', FALSE)
             RETURNING id`
        );
        
        const reviewId = mockRes.rows[0].id;

        // Fetch it
        const res = await readSessionReview({ project: 'test-project' });
        assert.ok(res.content[0].text.includes('Test Review Content from Jean SRE'), 'Should contain the review content');

        // Verify it was marked as reviewed
        const checkRes = await pool.query(`SELECT reviewed FROM session_handoffs WHERE id = $1`, [reviewId]);
        assert.strictEqual(checkRes.rows[0].reviewed, true, 'Review should be marked as consumed (reviewed = true)');
    });

    t.after(async () => {
        // Cleanup test data
        await pool.query(`DELETE FROM session_handoffs WHERE project = 'test-project'`);
        await pool.end();
    });
});

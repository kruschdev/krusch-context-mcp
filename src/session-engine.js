import fs from 'fs';
import path from 'path';
import { execSync, spawn } from 'child_process';
import { pool } from 'pg-git-mcp/db/pool.js';
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

const HOMELAB_ROOT = '/home/kruschdev/homelab';

function getLatestTelemetry() {
    const brainPath = path.join(process.env.HOME || process.env.USERPROFILE || '', '.gemini', 'antigravity', 'brain');
    if (!fs.existsSync(brainPath)) return { id: 'unknown', path: '' };
    
    const dirs = fs.readdirSync(brainPath).filter(d => fs.statSync(path.join(brainPath, d)).isDirectory());
    
    dirs.sort((a, b) => {
        return fs.statSync(path.join(brainPath, b)).mtimeMs - fs.statSync(path.join(brainPath, a)).mtimeMs;
    });
    
    for (const d of dirs) {
        const overview = path.join(brainPath, d, '.system_generated', 'logs', 'overview.txt');
        if (fs.existsSync(overview)) {
            return { id: d, path: overview };
        }
    }
    return { id: 'unknown', path: '' };
}

export async function writeSessionHandoff(args) {
    const { project, summary } = args;
    if (!project || !summary) {
        throw new McpError(ErrorCode.InvalidParams, "Project and summary are required.");
    }

    const { id: conversation, path: telemetry } = getLatestTelemetry();

    let filesTouched = [];
    try {
        const projectDir = path.join(HOMELAB_ROOT, 'projects', project);
        if (fs.existsSync(projectDir)) {
            const diff = execSync('git diff --name-only HEAD 2>/dev/null | head -30', { cwd: projectDir }).toString().trim();
            if (diff) {
                filesTouched = diff.split('\n').filter(Boolean);
            } else {
                const diff2 = execSync('git diff --name-only HEAD~1..HEAD 2>/dev/null | head -30', { cwd: projectDir }).toString().trim();
                if (diff2) {
                    filesTouched = diff2.split('\n').filter(Boolean);
                }
            }
        }
    } catch (e) {
        console.error('[SessionBridge] Could not fetch git diff:', e.message);
    }

    let success = false;
    let handoffId = null;

    try {
        // TTL policy: clean up handoffs older than 30 days
        await pool.query(`DELETE FROM session_handoffs WHERE created_at < NOW() - INTERVAL '30 days'`);

        const res = await pool.query(
            `INSERT INTO session_handoffs 
             (session_type, direction, project, content, files_touched, conversation_id, telemetry_path)
             VALUES ('ide', 'close', $1, $2, $3, $4, $5)
             RETURNING id`,
            [project, summary, filesTouched, conversation, telemetry]
        );
        handoffId = res.rows[0].id;
        success = true;
    } catch (e) {
        throw new McpError(ErrorCode.InternalError, `Failed to record session handoff to DB: ${e.message}`);
    }

    if (success) {
        // Spawn the bridge asynchronously
        try {
            const bridgeScript = path.join(HOMELAB_ROOT, 'scripts', 'jean_session_bridge.js');
            const child = spawn('node', [bridgeScript], {
                detached: true,
                stdio: 'ignore'
            });
            child.unref(); // Allow the parent to exit independently of the child
            console.error(`[SessionBridge] Spawned background review process for handoff ${handoffId}`);
        } catch (e) {
            console.error(`[SessionBridge] Failed to spawn bridge:`, e.message);
        }
    }

    return { 
        content: [{ 
            type: "text", 
            text: `Session handoff successfully recorded (ID: ${handoffId}). Jean SRE has been triggered in the background to review your work.` 
        }] 
    };
}

export async function readSessionReview(args) {
    const { project } = args;
    if (!project) {
        throw new McpError(ErrorCode.InvalidParams, "Project is required.");
    }

    try {
        // Query for the oldest unreviewed review for this project
        // Wait, review direction is written by Jean. We want the newest one just in case.
        const res = await pool.query(
            `SELECT id, content, created_at 
             FROM session_handoffs 
             WHERE direction = 'review' 
               AND project = $1 
               AND reviewed = FALSE 
             ORDER BY created_at DESC 
             LIMIT 1`,
            [project]
        );

        if (res.rows.length === 0) {
            return { 
                content: [{ 
                    type: "text", 
                    text: "No pending session review from Jean was found for this project." 
                }] 
            };
        }

        const review = res.rows[0];

        // Mark it as reviewed atomically
        await pool.query(
            `UPDATE session_handoffs SET reviewed = TRUE WHERE id = $1`,
            [review.id]
        );

        return { 
            content: [{ 
                type: "text", 
                text: `# Jean's Session Review\n> Reviewed: ${review.created_at}\n\n${review.content}` 
            }] 
        };
    } catch (e) {
        throw new McpError(ErrorCode.InternalError, `Failed to fetch session review from DB: ${e.message}`);
    }
}

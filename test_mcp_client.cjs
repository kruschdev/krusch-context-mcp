const { spawn } = require('child_process');
const cp = spawn('node', ['src/index.js'], {
    cwd: '/home/kruschdev/homelab/projects/krusch-context-mcp',
    env: Object.assign({}, process.env, {
        "DB_HOST": "10.0.0.85",
        "DB_PORT": "5434",
        "DB_NAME": "kruschdb",
        "DB_USER": "openclaw",
        "DB_PASSWORD": "openclaw_password",
        "OLLAMA_URL": "http://127.0.0.1:11437",
        "DOTENV_CONFIG_QUIET": "true"
    })
});

cp.stdout.on('data', d => console.log('STDOUT:', d.toString()));
cp.stderr.on('data', d => console.log('STDERR:', d.toString()));
cp.on('close', code => console.log('EXIT:', code));

setTimeout(() => {
    cp.stdin.write(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
            name: "krusch_context_write_session_handoff",
            arguments: {
                project: "spectralquant-ollama-bridge",
                summary: "Finalized the SpectralQuant Ollama bridge public distribution. Committed and pushed the /api/embeddings proxy endpoint and docker port mapping fixes to the spectralquant-ollama-bridge public repo. Updated the krusch-context-mcp README to highlight the seamless proxying of both reasoning and embedding RAG workflows, and pushed the documentation updates via subtree to the krusch-context-mcp public repository. Session completely wrapped up."
            }
        }
    }) + "\n");
}, 2000);

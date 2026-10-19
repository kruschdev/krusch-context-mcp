import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

/**
 * Standard OpenAI-compatible client chat helper (standalone for public context MCP)
 */
export async function chat(systemPrompt, userPrompt, config = {}) {
    const openrouterKey = process.env.OPENROUTER_API_KEY;
    const model = config.model 
        || process.env.COMPLETION_MODEL 
        || (openrouterKey ? 'meta-llama/llama-3.2-3b-instruct' : 'qwen2.5-coder:7b');
    const temperature = config.temperature ?? 0.1;
    const maxTokens = config.maxTokens ?? 1000;
    const timeoutMs = config.timeoutMs ?? parseInt(process.env.LLM_TIMEOUT_MS || '10000', 10);
    const apiUrl = config.apiUrl 
        || process.env.COMPLETION_URL 
        || (openrouterKey ? 'https://openrouter.ai/api/v1/chat/completions' : null)
        || (process.env.OLLAMA_URL ? `${process.env.OLLAMA_URL.replace(/\/$/, '')}/v1/chat/completions` : 'http://localhost:11434/v1/chat/completions');
    const apiKey = config.apiKey 
        || process.env.COMPLETION_API_KEY 
        || openrouterKey 
        || null;

    const payload = {
        model,
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
        ],
        temperature,
        max_tokens: maxTokens
    };

    const headers = {
        'Content-Type': 'application/json'
    };

    if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }
    if (apiUrl && apiUrl.includes('openrouter.ai')) {
        headers['HTTP-Referer'] = 'https://github.com/kruschdev/krusch-context-mcp';
        headers['X-Title'] = 'Krusch Context MCP';
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
        response = await fetch(apiUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: controller.signal
        });
    } finally {
        clearTimeout(timeoutId);
    }

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`HTTP error ${response.status}: ${errText}`);
    }

    const data = await response.json();
    if (data.choices && data.choices[0] && data.choices[0].message) {
        return data.choices[0].message.content;
    } else {
        throw new Error("Invalid response format from completion endpoint.");
    }
}

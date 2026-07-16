import dotenv from 'dotenv';
dotenv.config();

/**
 * Standard OpenAI-compatible client chat helper (standalone for public context MCP)
 */
export async function chat(systemPrompt, userPrompt, config = {}) {
    const model = config.model 
        || process.env.COMPLETION_MODEL 
        || 'qwen2.5-coder:7b';
    const temperature = config.temperature ?? 0.1;
    const maxTokens = config.maxTokens ?? 1000;
    const apiUrl = config.apiUrl 
        || process.env.COMPLETION_URL 
        || (process.env.OLLAMA_URL ? `${process.env.OLLAMA_URL.replace(/\/$/, '')}/v1/chat/completions` : 'http://localhost:11434/v1/chat/completions');
    const apiKey = config.apiKey 
        || process.env.COMPLETION_API_KEY 
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

    const response = await fetch(apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
    });

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

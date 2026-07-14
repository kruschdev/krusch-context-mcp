import dotenv from 'dotenv';
dotenv.config();

/**
 * Standard OpenAI-compatible client chat helper (standalone for public context MCP)
 */
export async function chat(systemPrompt, userPrompt, config = {}) {
    const model = config.model || 'qwen2.5-coder:7b';
    const temperature = config.temperature ?? 0.1;
    const maxTokens = config.maxTokens ?? 1000;
    const apiUrl = config.apiUrl || 'http://localhost:11434/v1/chat/completions';
    const apiKey = config.apiKey || null;

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

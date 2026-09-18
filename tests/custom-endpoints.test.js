import test from 'node:test';
import assert from 'node:assert';
import { getEmbedding, getEmbeddingProvider } from '../src/embedding-helper.js';
import { chat } from '../src/llm.js';
import { generateTagsFromLLM, extractHeuristicTags } from '../src/llm-tags.js';

test('custom embedding endpoint routing - OpenAI format', async () => {
    const originalFetch = globalThis.fetch;
    let fetchedUrl = '';
    let fetchedOptions = {};

    globalThis.fetch = async (url, options) => {
        fetchedUrl = url;
        fetchedOptions = options;
        return {
            ok: true,
            json: async () => ({
                data: [
                    { embedding: [0.1, 0.2, 0.3] }
                ]
            })
        };
    };

    process.env.EMBEDDING_URL = 'http://mock-embedding-server:8080/v1/embeddings';
    process.env.EMBEDDING_API_KEY = 'mock-key';
    process.env.EMBED_MODEL = 'mock-model';

    try {
        const result = await getEmbedding('hello world');
        assert.deepStrictEqual(result, [0.1, 0.2, 0.3]);
        assert.strictEqual(fetchedUrl, 'http://mock-embedding-server:8080/v1/embeddings');
        
        const body = JSON.parse(fetchedOptions.body);
        assert.strictEqual(body.model, 'mock-model');
        assert.strictEqual(body.input, 'hello world');
        assert.strictEqual(fetchedOptions.headers['Authorization'], 'Bearer mock-key');
    } finally {
        globalThis.fetch = originalFetch;
        delete process.env.EMBEDDING_URL;
        delete process.env.EMBEDDING_API_KEY;
        delete process.env.EMBED_MODEL;
    }
});

test('custom embedding endpoint routing - llama.cpp raw format', async () => {
    const originalFetch = globalThis.fetch;
    let fetchedUrl = '';
    let fetchedOptions = {};

    globalThis.fetch = async (url, options) => {
        fetchedUrl = url;
        fetchedOptions = options;
        return {
            ok: true,
            json: async () => ({
                embedding: [0.4, 0.5, 0.6]
            })
        };
    };

    process.env.EMBEDDING_URL = 'http://mock-embedding-server:8080/embedding';

    try {
        const result = await getEmbedding('hello llama');
        assert.deepStrictEqual(result, [0.4, 0.5, 0.6]);
        assert.strictEqual(fetchedUrl, 'http://mock-embedding-server:8080/embedding');
        
        const body = JSON.parse(fetchedOptions.body);
        assert.strictEqual(body.content, 'hello llama');
        assert.strictEqual(body.input, undefined);
    } finally {
        globalThis.fetch = originalFetch;
        delete process.env.EMBEDDING_URL;
    }
});

test('custom chat completions routing', async () => {
    const originalFetch = globalThis.fetch;
    let fetchedUrl = '';
    let fetchedOptions = {};

    globalThis.fetch = async (url, options) => {
        fetchedUrl = url;
        fetchedOptions = options;
        return {
            ok: true,
            json: async () => ({
                choices: [
                    { message: { content: 'Mock response content' } }
                ]
            })
        };
    };

    process.env.COMPLETION_URL = 'http://mock-completion-server:8080/v1/chat/completions';
    process.env.COMPLETION_API_KEY = 'mock-key-chat';
    process.env.COMPLETION_MODEL = 'mock-model-chat';

    try {
        const result = await chat('system instruction', 'user query');
        assert.strictEqual(result, 'Mock response content');
        assert.strictEqual(fetchedUrl, 'http://mock-completion-server:8080/v1/chat/completions');
        
        const body = JSON.parse(fetchedOptions.body);
        assert.strictEqual(body.model, 'mock-model-chat');
        assert.strictEqual(body.messages[0].content, 'system instruction');
        assert.strictEqual(body.messages[1].content, 'user query');
        assert.strictEqual(fetchedOptions.headers['Authorization'], 'Bearer mock-key-chat');
    } finally {
        globalThis.fetch = originalFetch;
        delete process.env.COMPLETION_URL;
        delete process.env.COMPLETION_API_KEY;
        delete process.env.COMPLETION_MODEL;
    }
});

test('custom tag generation routing', async () => {
    const originalFetch = globalThis.fetch;
    let fetchedUrl = '';
    let fetchedOptions = {};

    globalThis.fetch = async (url, options) => {
        fetchedUrl = url;
        fetchedOptions = options;
        return {
            ok: true,
            json: async () => ({
                choices: [
                    { message: { content: 'tag1, tag2, tag3' } }
                ]
            })
        };
    };

    process.env.COMPLETION_URL = 'http://mock-completion-server:8080/v1/chat/completions';
    process.env.TAG_MODEL = 'tag-extraction-model';

    try {
        const tags = await generateTagsFromLLM('dummy text', { lowercase: true });
        assert.deepStrictEqual(tags, ['tag1', 'tag2', 'tag3']);
        assert.strictEqual(fetchedUrl, 'http://mock-completion-server:8080/v1/chat/completions');
        
        const body = JSON.parse(fetchedOptions.body);
        assert.strictEqual(body.model, 'tag-extraction-model');
    } finally {
        globalThis.fetch = originalFetch;
        delete process.env.COMPLETION_URL;
        delete process.env.TAG_MODEL;
    }
});

test('OpenRouter embedding auto-detection, default model and headers', async () => {
    const originalFetch = globalThis.fetch;
    let fetchedUrl = '';
    let fetchedOptions = {};

    globalThis.fetch = async (url, options) => {
        fetchedUrl = url;
        fetchedOptions = options;
        return {
            ok: true,
            json: async () => ({
                data: [
                    { embedding: new Array(1024).fill(0.05) }
                ]
            })
        };
    };

    process.env.OPENROUTER_API_KEY = 'sk-or-v1-test-openrouter-key';

    try {
        const result = await getEmbedding('test openrouter embedding');
        assert.strictEqual(result.length, 1024);
        assert.strictEqual(fetchedUrl, 'https://openrouter.ai/api/v1/embeddings');
        
        const body = JSON.parse(fetchedOptions.body);
        assert.strictEqual(body.model, 'baai/bge-large-en-v1.5');
        assert.strictEqual(body.input, 'test openrouter embedding');
        assert.strictEqual(fetchedOptions.headers['Authorization'], 'Bearer sk-or-v1-test-openrouter-key');
        assert.strictEqual(fetchedOptions.headers['HTTP-Referer'], 'https://github.com/kruschdev/krusch-context-mcp');
        assert.strictEqual(fetchedOptions.headers['X-Title'], 'Krusch Context MCP');

        const providerInfo = getEmbeddingProvider();
        assert.strictEqual(providerInfo.provider, 'openrouter');
        assert.strictEqual(providerInfo.model, 'baai/bge-large-en-v1.5');
        assert.strictEqual(providerInfo.name, 'OpenRouter Cloud (baai/bge-large-en-v1.5, 1024d)');
    } finally {
        globalThis.fetch = originalFetch;
        delete process.env.OPENROUTER_API_KEY;
    }
});

test('OpenRouter chat completions auto-routing and headers', async () => {
    const originalFetch = globalThis.fetch;
    let fetchedUrl = '';
    let fetchedOptions = {};

    globalThis.fetch = async (url, options) => {
        fetchedUrl = url;
        fetchedOptions = options;
        return {
            ok: true,
            json: async () => ({
                choices: [
                    { message: { content: 'OpenRouter assistant reply' } }
                ]
            })
        };
    };

    process.env.OPENROUTER_API_KEY = 'sk-or-v1-test-openrouter-key';

    try {
        const result = await chat('You are a helpful assistant.', 'Hello OpenRouter');
        assert.strictEqual(result, 'OpenRouter assistant reply');
        assert.strictEqual(fetchedUrl, 'https://openrouter.ai/api/v1/chat/completions');
        
        const body = JSON.parse(fetchedOptions.body);
        assert.strictEqual(body.model, 'meta-llama/llama-3.2-3b-instruct');
        assert.strictEqual(body.messages[0].content, 'You are a helpful assistant.');
        assert.strictEqual(body.messages[1].content, 'Hello OpenRouter');
        assert.strictEqual(fetchedOptions.headers['Authorization'], 'Bearer sk-or-v1-test-openrouter-key');
        assert.strictEqual(fetchedOptions.headers['HTTP-Referer'], 'https://github.com/kruschdev/krusch-context-mcp');
        assert.strictEqual(fetchedOptions.headers['X-Title'], 'Krusch Context MCP');
    } finally {
        globalThis.fetch = originalFetch;
        delete process.env.OPENROUTER_API_KEY;
    }
});

test('OpenRouter tag generation auto-routing', async () => {
    const originalFetch = globalThis.fetch;
    let fetchedUrl = '';
    let fetchedOptions = {};

    globalThis.fetch = async (url, options) => {
        fetchedUrl = url;
        fetchedOptions = options;
        return {
            ok: true,
            json: async () => ({
                choices: [
                    { message: { content: 'mcp, memory, openrouter' } }
                ]
            })
        };
    };

    process.env.OPENROUTER_API_KEY = 'sk-or-v1-test-openrouter-key';

    try {
        const tags = await generateTagsFromLLM('testing openrouter tag generation', { lowercase: true });
        assert.deepStrictEqual(tags, ['mcp', 'memory', 'openrouter']);
        assert.strictEqual(fetchedUrl, 'https://openrouter.ai/api/v1/chat/completions');
        
        const body = JSON.parse(fetchedOptions.body);
        assert.strictEqual(body.model, 'meta-llama/llama-3.2-3b-instruct');
    } finally {
        globalThis.fetch = originalFetch;
        delete process.env.OPENROUTER_API_KEY;
    }
});

test('heuristic fallback tag extraction when no LLM is configured', async () => {
    const text = 'Refactored authMiddleware with verifyJwtToken and PostgreSQL connection pool in KruschContext';
    const tags = extractHeuristicTags(text);
    
    assert.ok(tags.length > 0);
    assert.ok(tags.includes('authmiddleware') || tags.includes('verifyjwttoken'));
    assert.ok(tags.includes('jwt') || tags.includes('postgresql'));
});



import test from 'node:test';
import assert from 'node:assert';
import { getEmbedding } from '../src/embedding-helper.js';
import { chat } from '../src/llm.js';
import { generateTagsFromLLM } from '../src/llm-tags.js';

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

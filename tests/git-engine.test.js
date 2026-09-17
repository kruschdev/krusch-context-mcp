import test from 'node:test';
import assert from 'node:assert';
import { pool } from '../db/pool.js';
import { 
    getRepositories, 
    searchBlobs, 
    searchSymbols, 
    getSymbolsForBlob, 
    getSymbolGraph 
} from '../src/git-engine.js';
import { extractSymbolsAndImports } from '../src/ast-chunker.js';

test('Native Git Engine & AST Chunker Suite', async (t) => {

    await t.test('AST Chunker extracts symbols and imports from JavaScript/TypeScript', () => {
        const code = `
import { pool } from '../db/pool.js';
import { searchBlobs } from './git-engine.js';

export class CodeEngine {
    constructor() {
        this.ready = true;
    }

    async executeQuery(sql) {
        return await pool.query(sql);
    }
}

export function helperFunction(param1) {
    return param1 * 2;
}
`;
        const { symbols, imports } = extractSymbolsAndImports(code, 'src/test-file.js');
        
        assert.ok(Array.isArray(symbols), 'symbols should be an array');
        assert.ok(Array.isArray(imports), 'imports should be an array');
        
        const symbolNames = symbols.map(s => s.name);
        assert.ok(symbolNames.includes('CodeEngine'), 'Extracted class CodeEngine');
        assert.ok(symbolNames.includes('CodeEngine.executeQuery'), 'Extracted method CodeEngine.executeQuery');
        assert.ok(symbolNames.includes('helperFunction'), 'Extracted function helperFunction');
        
        assert.strictEqual(imports.length, 2, 'Should extract 2 import statements');
        assert.strictEqual(imports[0].targetPath, '../db/pool.js');
        assert.strictEqual(imports[1].targetPath, './git-engine.js');
    });

    await t.test('getRepositories should return indexed repositories array', async () => {
        const repos = await getRepositories();
        assert.ok(Array.isArray(repos), 'getRepositories should return an array');
    });

    await t.test('searchSymbols should return matching symbols without crashing', async () => {
        const symbols = await searchSymbols('Engine', 10);
        assert.ok(Array.isArray(symbols), 'searchSymbols should return an array');
    });

    await t.test('getSymbolGraph should return nodes and edges structure', async () => {
        const graph = await getSymbolGraph('CodeEngine', null, 2);
        assert.ok(graph, 'getSymbolGraph should return a graph object');
        assert.ok(Array.isArray(graph.nodes), 'graph.nodes should be an array');
        assert.ok(Array.isArray(graph.edges), 'graph.edges should be an array');
    });

    await t.test('searchBlobs with hybrid text query should return array', async () => {
        const dummyEmbedding = new Array(1024).fill(0.01);
        const results = await searchBlobs(dummyEmbedding, 5, null, 'database pool');
        assert.ok(Array.isArray(results), 'searchBlobs should return an array');
    });
});

import { createRequire } from 'module';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

const require = createRequire(import.meta.url);

let _pool = null;

function getPoolInstance() {
    if (_pool) return _pool;

    let pg;
    try {
        pg = require('pg');
    } catch {
        throw new Error(
            "[krusch-context-mcp] PostgreSQL client 'pg' is not installed. " +
            "To use PostgreSQL storage mode, run: npm install pg"
        );
    }

    const { Pool } = pg;
    _pool = new Pool({
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5432', 10),
        database: process.env.DB_NAME || 'kdcode',
        user: process.env.DB_USER || 'kdcode',
        password: process.env.DB_PASSWORD || 'password',
        max: parseInt(process.env.DB_POOL_SIZE || '15', 10),
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 30000
    });

    return _pool;
}

export const pool = new Proxy({}, {
    get(_target, prop) {
        const instance = getPoolInstance();
        const value = instance[prop];
        if (typeof value === 'function') {
            return value.bind(instance);
        }
        return value;
    }
});

export const query = (text, params) => pool.query(text, params);
export default pool;

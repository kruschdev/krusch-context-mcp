import fs from 'node:fs';
import { createRequire } from 'node:module';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

const require = createRequire(import.meta.url);

let canResolvePg = false;
try {
    require.resolve('pg');
    canResolvePg = true;
} catch {
    canResolvePg = false;
}

let createPgPool = null;
if (canResolvePg) {
    try {
        const siblingPgUrl = new URL('../../../lib/pg.js', import.meta.url);
        if (fs.existsSync(siblingPgUrl)) {
            ({ createPgPool } = await import(siblingPgUrl.href));
        } else {
            ({ createPgPool } = await import('@krusch/toolkit/pg'));
        }
    } catch {
        createPgPool = null;
    }
}

export function resolvePoolConfig(env = process.env) {
    const parsedMax = parseInt(env.DB_POOL_SIZE || '15', 10);
    const max = Number.isInteger(parsedMax) && parsedMax > 0 ? parsedMax : 15;
    const connStr = env.DATABASE_URL || env.DBOS_DATABASE_URL;
    if (connStr) {
        return {
            connectionString: connStr,
            max,
            connectionTimeoutMillis: 5000,
            idleTimeoutMillis: 30000,
            allowExitOnIdle: true
        };
    }
    const parsedPort = parseInt(env.DB_PORT || '5432', 10);
    return {
        host: env.DB_HOST || 'localhost',
        port: Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : 5432,
        database: env.DB_NAME || 'kdcode',
        user: env.DB_USER || 'kdcode',
        password: env.DB_PASSWORD || 'password',
        max,
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 30000,
        allowExitOnIdle: true
    };
}

let _pool = null;

function getPoolInstance() {
    if (_pool) return _pool;

    let pgModule;
    try {
        pgModule = require('pg');
    } catch {
        throw new Error(
            "[krusch-context-mcp] PostgreSQL client 'pg' is not installed. " +
            "To use PostgreSQL storage mode, run: npm install pg"
        );
    }

    const PgDriver = pgModule.Pool || pgModule.default?.Pool;
    const resolvedPoolConfig = resolvePoolConfig(process.env);

    if (typeof createPgPool === 'function') {
        function IdleExitPgDriver(opts) {
            return new PgDriver({ ...opts, allowExitOnIdle: true });
        }
        _pool = createPgPool(resolvedPoolConfig, {
            serviceName: 'krusch-context-mcp',
            max: resolvedPoolConfig.max,
            connectionTimeoutMillis: resolvedPoolConfig.connectionTimeoutMillis,
            idleTimeoutMillis: resolvedPoolConfig.idleTimeoutMillis,
            PoolClass: IdleExitPgDriver,
            logger: {
                info() {},
                debug() {},
                warn() {},
                error(_msg, err) {
                    console.error('[krusch-context-mcp] PostgreSQL pool idle client error:', err?.message || err);
                }
            }
        }).pool;
    } else {
        _pool = new PgDriver(resolvedPoolConfig);
        // Guard against uncaught idle client crashes (e.g. Postgres restart or network drops)
        _pool.on('error', (err) => {
            console.error('[krusch-context-mcp] PostgreSQL pool idle client error:', err.message);
        });
    }

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

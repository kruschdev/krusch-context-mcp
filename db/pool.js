import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

const { Pool } = pg;

export const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'kdcode',
    user: process.env.DB_USER || 'kdcode',
    password: process.env.DB_PASSWORD || 'password',
    max: parseInt(process.env.DB_POOL_SIZE || '15', 10),
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000
});

export const query = (text, params) => pool.query(text, params);
export default pool;

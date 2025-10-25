import 'dotenv/config';
import { Pool } from 'pg';

const pool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  ssl: process.env.PGSSLMODE && process.env.PGSSLMODE !== 'disable' ? { rejectUnauthorized: false } : false,
  max: 20, // ajustable
});

pool.on('error', (err) => {
  console.error('[PG] pool error', err);
});

export async function query(text, params) {
  const res = await pool.query(text, params);
  return res;
}

export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await fn(client);
    await client.query('COMMIT');
    return res;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

export { pool };

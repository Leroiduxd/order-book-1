import 'dotenv/config';
import { Pool } from 'pg';

function must(name) {
  const v = process.env[name];
  if (v === undefined || v === null || String(v).trim() === '') {
    throw new Error(`[PG] Missing env: ${name}`);
  }
  return String(v);
}

const cfg = {
  // OPTION 1 (TCP):
  // host: process.env.PGHOST || '127.0.0.1',
  // port: Number(process.env.PGPORT || 5432),

  // OPTION 2 (socket UNIX — recommandé si Postgres local):
  // Mettez PGHOST=/var/run/postgresql dans .env (Debian/Ubuntu),
  // ou le répertoire du socket de votre distro.
  host: must('PGHOST'),
  port: Number(process.env.PGPORT || 5432),

  database: must('PGDATABASE'),
  user: must('PGUSER'),
  ssl: false,
  max: 20,
};

// mot de passe seulement s’il est fourni (sinon on N’ENVOIE PAS la propriété)
if (process.env.PGPASSWORD && String(process.env.PGPASSWORD).length > 0) {
  cfg.password = String(process.env.PGPASSWORD);
}

// Si vous utilisez une URL unique, vous pouvez aussi faire :
// const pool = new Pool({ connectionString: process.env.PGURL });

const pool = new Pool(cfg);

pool.on('error', (err) => {
  console.error('[PG] pool error', err);
});

export async function query(text, params) {
  return pool.query(text, params);
}

export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await fn(client);
    await client.query('COMMIT');
    return res;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

export { pool };

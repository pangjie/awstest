import fs from 'node:fs';
import pg from 'pg';

const { Pool } = pg;

const MIGRATION = `
  CREATE TABLE IF NOT EXISTS messages (
    id BIGSERIAL PRIMARY KEY,
    author VARCHAR(40) NOT NULL,
    body VARCHAR(280) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

function sslConfig(env = process.env) {
  const mode = env.DB_SSL ?? (env.NODE_ENV === 'production' ? 'verify-full' : 'disable');
  if (mode === 'disable') return false;

  if (mode !== 'verify-full') {
    throw new Error('DB_SSL must be either disable or verify-full');
  }

  const caPath = env.DB_CA_PATH;
  if (!caPath) throw new Error('DB_CA_PATH is required when DB_SSL=verify-full');

  return {
    ca: fs.readFileSync(caPath, 'utf8'),
    rejectUnauthorized: true
  };
}

export function createDatabase(env = process.env) {
  const connection = env.DATABASE_URL
    ? { connectionString: env.DATABASE_URL }
    : {
        host: env.DB_HOST,
        port: Number(env.DB_PORT ?? 5432),
        database: env.DB_NAME,
        user: env.DB_USER,
        password: env.DB_PASSWORD
      };

  if (!env.DATABASE_URL && (!env.DB_HOST || !env.DB_NAME || !env.DB_USER || !env.DB_PASSWORD)) {
    throw new Error('DATABASE_URL or DB_HOST/DB_NAME/DB_USER/DB_PASSWORD is required');
  }

  const pool = new Pool({
    ...connection,
    ssl: sslConfig(env),
    max: Number(env.DB_POOL_MAX ?? 5),
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    application_name: 'aws-miniflow'
  });

  return {
    async migrate() {
      await pool.query(MIGRATION);
    },

    async isReady() {
      await pool.query('SELECT 1');
    },

    async listMessages(limit = 20) {
      const result = await pool.query(
        `SELECT id, author, body, created_at
         FROM messages
         ORDER BY created_at DESC, id DESC
         LIMIT $1`,
        [limit]
      );
      return result.rows;
    },

    async createMessage(author, body) {
      const result = await pool.query(
        `INSERT INTO messages (author, body)
         VALUES ($1, $2)
         RETURNING id, author, body, created_at`,
        [author, body]
      );
      return result.rows[0];
    },

    async close() {
      await pool.end();
    }
  };
}

export { sslConfig };

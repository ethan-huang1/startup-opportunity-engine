/**
 * Minimal migration runner: applies lib/migrations/*.sql in filename order,
 * once each, tracked in schema_migrations. No rollback support and no
 * framework — this project has few migrations; add complexity when rollback
 * actually matters.
 *
 * A local-only admin script, so it uses `pg` directly rather than
 * lib/db.js's HTTP-based `sql` (which lib/store.js's runtime queries use) —
 * a DDL script with multi-statement files and explicit transactions is
 * exactly the shape the HTTP driver isn't meant for.
 *
 * Usage: node lib/migrate.js
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: true },
});

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const { rows } = await pool.query('SELECT filename FROM schema_migrations');
  const applied = new Set(rows.map((row) => row.filename));

  const files = (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith('.sql')).sort();

  for (const filename of files) {
    if (applied.has(filename)) continue;
    const sql = await readFile(join(MIGRATIONS_DIR, filename), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
      await client.query('COMMIT');
      console.log(`applied ${filename}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw new Error(`migration ${filename} failed: ${error.message}`);
    } finally {
      client.release();
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrate()
    .then(() => pool.end())
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

export { migrate };

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './pool.js';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const ADVISORY_LOCK_ID = 727_001;

export async function migrate(db: Db, log: (msg: string) => void = () => undefined): Promise<void> {
  const client = await db.connect();
  try {
    // Serialises concurrent boots so two instances never apply the same migration.
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const applied = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
    );
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        log(`applied migration ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_ID]).catch(() => undefined);
    client.release();
  }
}

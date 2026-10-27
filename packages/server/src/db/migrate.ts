import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const defaultDir = fileURLToPath(new URL('../../migrations', import.meta.url));

export async function runMigrations(pool: pg.Pool | pg.PoolClient, dir: string = defaultDir): Promise<string[]> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migration (
       name text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
  const applied = new Set(
    (await pool.query<{ name: string }>('SELECT name FROM schema_migration')).rows.map((r) => r.name),
  );
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const done: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(`${dir}/${file}`, 'utf8');
    // a pool hands out a client per migration; a client runs BEGIN..COMMIT on itself
    const client = 'release' in pool ? pool : await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migration (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      done.push(file);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      if (client !== pool) (client as pg.PoolClient).release();
    }
  }
  return done;
}

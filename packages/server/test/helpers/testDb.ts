import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';

export interface TestDb {
  pool: pg.Pool;
  url: string;
  drop(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const adminUrl = inject('pgAdminUrl');
  const name = `test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  const url = u.toString();
  const pool = new pg.Pool({ connectionString: url });
  return {
    pool,
    url,
    async drop() {
      await pool.end();
      const c = new pg.Client({ connectionString: adminUrl });
      await c.connect();
      try {
        await c.query(`DROP DATABASE ${name} WITH (FORCE)`);
      } finally {
        await c.end();
      }
    },
  };
}

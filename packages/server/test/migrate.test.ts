import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { createTestDb } from './helpers/testDb.js';

const fixtureDir = fileURLToPath(new URL('./fixtures/migrations-bad', import.meta.url));

describe('runMigrations', () => {
  it('applies migrations once and records them', async () => {
    const { pool, drop } = await createTestDb();
    try {
      expect(await runMigrations(pool)).toEqual(['001_init.sql']);
      expect(await runMigrations(pool)).toEqual([]);
      const { rows } = await pool.query('SELECT name FROM schema_migration');
      expect(rows).toEqual([{ name: '001_init.sql' }]);
    } finally {
      await drop();
    }
  });

  it('rolls back a failing migration and keeps earlier ones', async () => {
    const { pool, drop } = await createTestDb();
    try {
      await expect(runMigrations(pool, fixtureDir)).rejects.toThrow();
      const { rows } = await pool.query('SELECT name FROM schema_migration');
      expect(rows).toEqual([{ name: '001_ok.sql' }]);
    } finally {
      await drop();
    }
  });
});

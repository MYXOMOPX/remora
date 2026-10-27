import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { createTestDb } from './helpers/testDb.js';

const fixtureDir = fileURLToPath(new URL('./fixtures/migrations-bad', import.meta.url));

describe('runMigrations', () => {
  it('applies migrations once and records them', async () => {
    const { pool, drop } = await createTestDb();
    try {
      expect(await runMigrations(pool)).toEqual(['001_init.sql', '002_relation_logical_id_seq.sql']);
      expect(await runMigrations(pool)).toEqual([]);
      const { rows } = await pool.query('SELECT name FROM schema_migration ORDER BY name');
      expect(rows).toEqual([{ name: '001_init.sql' }, { name: '002_relation_logical_id_seq.sql' }]);
    } finally {
      await drop();
    }
  });

  it('accepts a pool client and applies both migrations once', async () => {
    const { pool, drop } = await createTestDb();
    try {
      const client = await pool.connect();
      try {
        expect(await runMigrations(client)).toEqual(['001_init.sql', '002_relation_logical_id_seq.sql']);
        expect(await runMigrations(client)).toEqual([]);
      } finally {
        client.release();
      }
      const { rows } = await pool.query('SELECT name FROM schema_migration ORDER BY name');
      expect(rows).toHaveLength(2);
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

import { describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import type { Queryable } from '../src/db/types.js';
import { createEntity, findEntities, getEntity, requireEntity } from '../src/services/entities.js';
import { createTestDb } from './helpers/testDb.js';

async function withDb(fn: (db: Queryable) => Promise<void>): Promise<void> {
  const { pool, drop } = await createTestDb();
  try {
    await runMigrations(pool);
    await fn(pool);
  } finally {
    await drop();
  }
}

describe('entities', () => {
  it('createEntity is idempotent', () =>
    withDb(async (pool) => {
      const a = await createEntity(pool, 'bob');
      const b = await createEntity(pool, 'bob');
      expect(a.created).toBe(true);
      expect(b.created).toBe(false);
      expect(typeof a.entity.entityId).toBe('bigint');
      expect(b.entity.entityId).toBe(a.entity.entityId);
    }));

  it('parallel createEntity of one key yields one row and no error', () =>
    withDb(async (pool) => {
      const rs = await Promise.all(Array.from({ length: 8 }, () => createEntity(pool, 'carl')));
      expect(new Set(rs.map((r) => r.entity.entityId)).size).toBe(1);
      expect(rs.filter((r) => r.created)).toHaveLength(1);
    }));

  it('getEntity returns null and requireEntity throws unknown_entity with key', () =>
    withDb(async (pool) => {
      expect(await getEntity(pool, 'nobody')).toBeNull();
      await expect(requireEntity(pool, 'nobody')).rejects.toMatchObject({
        code: 'unknown_entity',
        details: { key: 'nobody' },
      });
      await createEntity(pool, 'bob');
      expect((await requireEntity(pool, 'bob')).key).toBe('bob');
    }));

  it('empty key is invalid_name', () =>
    withDb(async (pool) => {
      await expect(createEntity(pool, '')).rejects.toMatchObject({ code: 'invalid_name' });
      await expect(createEntity(pool, '   ')).rejects.toMatchObject({ code: 'invalid_name' });
    }));

  it('findEntities matches all words as substrings, case-insensitively', () =>
    withDb(async (pool) => {
      for (const k of ['Bob Smith', 'bob_jones', 'carl']) await createEntity(pool, k);
      const r = await findEntities(pool, { query: 'bob smith' });
      expect(r.rows.map((x) => x.key)).toEqual(['Bob Smith']);
      expect(r.total).toBe(1);
      expect(r.truncated).toBe(false);
      await expect(findEntities(pool, { query: '  ' })).rejects.toMatchObject({
        code: 'invalid_param',
      });
    }));

  it('findEntities treats % and _ literally', () =>
    withDb(async (pool) => {
      for (const k of ['a%b', 'axb', 'a_c', 'abc']) await createEntity(pool, k);
      expect((await findEntities(pool, { query: 'a%b' })).rows.map((x) => x.key)).toEqual(['a%b']);
      expect((await findEntities(pool, { query: 'a_c' })).rows.map((x) => x.key)).toEqual(['a_c']);
    }));

  it('findEntities reports total and truncated', () =>
    withDb(async (pool) => {
      for (const k of ['k1', 'k2', 'k3', 'k4', 'k5']) await createEntity(pool, k);
      const r = await findEntities(pool, { query: 'k', limit: 2 });
      expect(r.rows).toHaveLength(2);
      expect(r.total).toBe(5);
      expect(r.truncated).toBe(true);
    }));
});

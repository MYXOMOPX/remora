import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import {
  createPropertyType,
  createRelationType,
  findPropertyTypes,
  findRelationTypes,
  listPropertyTypes,
  listRelationTypes,
  listTimeAxes,
  normalizeName,
} from '../src/services/dictionaries.js';
import { seedBasics } from './helpers/seed.js';
import { createTestDb } from './helpers/testDb.js';

async function withDb(fn: (pool: Pool) => Promise<void>): Promise<void> {
  const { pool, drop } = await createTestDb();
  try {
    await runMigrations(pool);
    await fn(pool);
  } finally {
    await drop();
  }
}

describe('normalizeName', () => {
  it.each([
    ['Любимый цвет', 'любимый_цвет'],
    ['  Works  At ', 'works_at'],
    ['hobby!!', 'hobby'],
    ['a__b', 'a_b'],
  ])('normalizeName(%j) = %j', (raw, want) => expect(normalizeName(raw)).toBe(want));

  it('NFC and NFD forms normalize identically and keep marks', () => {
    const nfc = 'Любимый цвет'.normalize('NFC');
    const nfd = 'Любимый цвет'.normalize('NFD');
    expect(nfd).not.toBe(nfc);
    expect(normalizeName(nfd)).toBe('любимый_цвет');
    expect(normalizeName(nfc)).toBe('любимый_цвет');
    expect(normalizeName('Ёж'.normalize('NFD'))).toBe('ёж');
    expect(normalizeName('Q̇ x')).toBe('q̇_x');
  });

  it('rejects names that become empty', () => {
    for (const raw of ['', '   ', '!!!']) {
      expect(() => normalizeName(raw)).toThrow(expect.objectContaining({ code: 'invalid_name' }));
    }
  });
});

describe('dictionaries', () => {
  it('createPropertyType normalizes and stores flags', () =>
    withDb(async (pool) => {
      const t = await createPropertyType(pool, {
        name: 'Job Title',
        description: 'Должность',
        valueType: 'text',
        singleValued: true,
      });
      expect(t).toMatchObject({
        name: 'job_title',
        description: 'Должность',
        valueType: 'text',
        singleValued: true,
      });
      expect(typeof t.id).toBe('number');
      expect(await listPropertyTypes(pool)).toEqual([t]);
    }));

  it('createRelationType stores flags', () =>
    withDb(async (pool) => {
      const t = await createRelationType(pool, {
        name: 'Works At',
        description: 'работает',
        directed: true,
      });
      expect(t).toMatchObject({ name: 'works_at', directed: true });
      expect(await listRelationTypes(pool)).toEqual([t]);
    }));

  it('rejects empty description and bad valueType', () =>
    withDb(async (pool) => {
      await expect(
        createRelationType(pool, { name: 'x', description: '  ', directed: false }),
      ).rejects.toMatchObject({ code: 'invalid_param' });
      await expect(
        createPropertyType(pool, {
          name: 'x',
          description: 'd',
          valueType: 'blob' as never,
          singleValued: false,
        }),
      ).rejects.toMatchObject({ code: 'invalid_param' });
    }));

  it('same name in the same dictionary is name_taken', () =>
    withDb(async (pool) => {
      await createRelationType(pool, { name: 'knows', description: 'знает', directed: false });
      await expect(
        createRelationType(pool, { name: 'Knows', description: 'x', directed: true }),
      ).rejects.toMatchObject({
        code: 'name_taken',
        details: { name: 'knows', dictionary: 'relation_type' },
      });
    }));

  it('same name in the other dictionary is name_taken', () =>
    withDb(async (pool) => {
      await createRelationType(pool, { name: 'friend of', description: 'дружба', directed: false });
      await expect(
        createPropertyType(pool, {
          name: 'Friend_Of',
          description: 'x',
          valueType: 'text',
          singleValued: false,
        }),
      ).rejects.toMatchObject({
        code: 'name_taken',
        details: { name: 'friend_of', dictionary: 'relation_type' },
      });
    }));

  it('works on a client already inside a transaction', () =>
    withDb(async (pool) => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await createRelationType(c, { name: 'in_tx', description: 'd', directed: false });
        await c.query('ROLLBACK');
      } finally {
        c.release();
      }
      expect(await listRelationTypes(pool)).toEqual([]);
    }));

  it('parallel creation of one name yields exactly one type', () =>
    withDb(async (pool) => {
      const rs = await Promise.allSettled(
        Array.from({ length: 6 }, () =>
          createRelationType(pool, { name: 'knows', description: 'знает', directed: false }),
        ),
      );
      expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of rs.filter((r) => r.status === 'rejected')) {
        expect((r as PromiseRejectedResult).reason.code).toBe('name_taken');
      }
    }));

  it('parallel creation across dictionaries yields exactly one type', () =>
    withDb(async (pool) => {
      const rs = await Promise.allSettled([
        ...Array.from({ length: 3 }, () =>
          createRelationType(pool, { name: 'dup', description: 'd', directed: false }),
        ),
        ...Array.from({ length: 3 }, () =>
          createPropertyType(pool, {
            name: 'dup',
            description: 'd',
            valueType: 'text',
            singleValued: false,
          }),
        ),
      ]);
      expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    }));

  it('list is sorted by name', () =>
    withDb(async (pool) => {
      for (const n of ['b', 'a', 'c']) {
        await createRelationType(pool, { name: n, description: 'd', directed: false });
      }
      expect((await listRelationTypes(pool)).map((t) => t.name)).toEqual(['a', 'b', 'c']);
    }));

  it('find* matches words in name or description and treats % literally', () =>
    withDb(async (pool) => {
      await createRelationType(pool, {
        name: 'works_at',
        description: 'Работает в компании',
        directed: true,
      });
      await createRelationType(pool, {
        name: 'friend_of',
        description: 'Дружба 100% точно',
        directed: false,
      });
      await createPropertyType(pool, {
        name: 'job_title',
        description: 'Должность в компании',
        valueType: 'text',
        singleValued: true,
      });
      expect((await findRelationTypes(pool, 'компании работает')).map((t) => t.name)).toEqual([
        'works_at',
      ]);
      expect((await findRelationTypes(pool, 'FRIEND')).map((t) => t.name)).toEqual(['friend_of']);
      expect((await findRelationTypes(pool, '100%')).map((t) => t.name)).toEqual(['friend_of']);
      expect(await findRelationTypes(pool, '%')).toHaveLength(1);
      expect((await findPropertyTypes(pool, 'должность')).map((t) => t.name)).toEqual(['job_title']);
      expect(await findPropertyTypes(pool, 'нет такого')).toEqual([]);
    }));

  it('listTimeAxes returns name, description, valueSchema, example from time_axis', () =>
    withDb(async (pool) => {
      await seedBasics(pool);
      expect(await listTimeAxes(pool)).toEqual([
        {
          name: 'game_day',
          description: 'Номер игрового дня, целое число.',
          valueSchema: { type: 'integer' },
          example: 1,
        },
        {
          name: 'real',
          description: 'Реальное время в секундах от epoch.',
          valueSchema: { type: 'integer' },
          example: 1,
        },
      ]);
    }));
});

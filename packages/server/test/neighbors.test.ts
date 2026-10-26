import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { apply } from '../src/api/apply.js';
import { query } from '../src/api/query.js';
import { runMigrations } from '../src/db/migrate.js';
import type { PluginRegistry } from '../src/plugins/registry.js';
import { neighbors, type NeighborsArgs } from '../src/services/neighbors.js';
import { parseWhen } from '../src/services/time.js';
import { seedAxes } from './helpers/axes.js';
import { seedBasics } from './helpers/seed.js';
import { createTestDb } from './helpers/testDb.js';

type NbArgs = Partial<Omit<NeighborsArgs, 'when'>> & { when?: unknown };

interface Ctx {
  pool: pg.Pool;
  reg: PluginRegistry;
  nb: (a: NbArgs) => ReturnType<typeof neighbors>;
}

const gd = (from: number, to?: number) => ({ axis: 'game_day', from, ...(to !== undefined ? { to } : {}) });

async function withDb(fn: (c: Ctx) => Promise<void>): Promise<void> {
  const { pool, drop } = await createTestDb();
  try {
    await runMigrations(pool);
    const seeded = await seedBasics(pool);
    const reg = await seedAxes(pool, seeded);
    const r = await apply(pool, reg, {
      ops: [
        ...['carl', 'dave', 'erin', 'google', 'acme'].map((key) => ({ op: 'create_entity', key })),
        { op: 'create_relation_type', name: 'friend_of', description: 'Friendship.', directed: false },
        { op: 'create_relation_type', name: 'works_at', description: 'Employment.', directed: true },
        { op: 'create_relation_type', name: 'knows', description: 'Knows.', directed: true },
        { op: 'add_relation', type: 'friend_of', from: 'bob', to: 'carl', time: gd(100) },
        { op: 'add_relation', type: 'friend_of', from: 'bob', to: 'carl' },
        { op: 'add_relation', type: 'friend_of', from: 'carl', to: 'dave', time: gd(100, 200) },
        { op: 'add_relation', type: 'knows', from: 'dave', to: 'bob' },
        { op: 'add_relation', type: 'knows', from: 'erin', to: 'bob' },
        { op: 'add_relation', type: 'works_at', from: 'bob', to: 'google' },
        {
          op: 'add_relation',
          type: 'works_at',
          from: 'bob',
          to: 'acme',
          time: [gd(1), { axis: 'real', from: 1 }],
        },
        { op: 'add_property', entity: 'carl', property: 'height', value: 186 },
        { op: 'add_property', entity: 'dave', property: 'height', value: 190 },
        { op: 'add_property', entity: 'erin', property: 'height', value: 170 },
      ],
    });
    if (!r.ok) throw new Error(`setup failed: ${JSON.stringify(r.error)}`);
    await fn({
      pool,
      reg,
      nb: ({ when, ...rest }) => {
        const w = parseWhen(reg, when);
        return neighbors(pool, reg, { entity: 'bob', ...rest, ...(w !== undefined ? { when: w } : {}) });
      },
    });
  } finally {
    await drop();
  }
}

const names = (r: { rows: { entity: string }[] }) => r.rows.map((x) => x.entity);

describe('neighbors', () => {
  it('depth 1 defaults to both directions, excludes the start', async () => {
    await withDb(async ({ nb }) => {
      const r = await nb({});
      expect(names(r)).toEqual(['acme', 'carl', 'dave', 'erin', 'google']);
      expect(r.rows.every((x) => x.depth === 1)).toBe(true);
      expect(r.total).toBe(5);
      expect(r.truncated).toBe(false);
    });
  });

  it('direction out / in', async () => {
    await withDb(async ({ nb }) => {
      expect(names(await nb({ direction: 'out' }))).toEqual(['acme', 'carl', 'google']);
      expect(names(await nb({ direction: 'in' }))).toEqual(['carl', 'dave', 'erin']);
    });
  });

  it('cycles do not list the start nor duplicate rows', async () => {
    await withDb(async ({ nb }) => {
      const r = await nb({ relationTypes: ['friend_of', 'knows'], direction: 'out', depth: 3 });
      expect(r.rows.map((x) => [x.entity, x.depth])).toEqual([
        ['carl', 1],
        ['dave', 2],
      ]);
    });
  });

  it('when filters edges; timeless edges always pass', async () => {
    await withDb(async ({ nb }) => {
      const gdAt = (at: number) => ({ axis: 'game_day', at });
      expect(names(await nb({ when: gdAt(250), relationTypes: ['friend_of'], depth: 2 }))).toEqual(['carl']);
      expect(names(await nb({ when: gdAt(150), relationTypes: ['friend_of'], depth: 2 }))).toEqual([
        'carl',
        'dave',
      ]);
      const r = await nb({ when: { axis: 'real', at: 5 }, relationTypes: ['friend_of'] });
      expect(names(r)).toEqual(['carl']);
      expect(r.rows[0]!.via!.time).toBeNull();
    });
  });

  it('via is the smallest relation; via_count counts logical relations', async () => {
    await withDb(async ({ pool, reg, nb }) => {
      const h = await query(pool, reg, {
        ops: [{ op: 'relation_history', entity: 'bob', relation_types: ['friend_of'] }],
      });
      if (!h.ok) throw new Error('history failed');
      const ids = (h.results[0] as { rows: { relation_id: number }[] }).rows.map((x) => BigInt(x.relation_id));
      expect(new Set(ids).size).toBe(2);
      const min = ids.reduce((a, b) => (a < b ? a : b));
      const r = await nb({});
      const carl = r.rows.find((x) => x.entity === 'carl')!;
      expect(carl.viaCount).toBe(2);
      expect(carl.via).toMatchObject({ relation: 'friend_of', from: 'bob', relationId: min });
      expect(carl.via!.time).toEqual({ axis: 'game_day', from: 100 });
      expect(r.rows.find((x) => x.entity === 'acme')!.viaCount).toBe(1);
    });
  });

  it('retracted relations are excluded', async () => {
    await withDb(async ({ pool, reg, nb }) => {
      const r = await apply(pool, reg, {
        ops: [{ op: 'retract_relation', type: 'works_at', from: 'bob', to: 'google' }],
      });
      expect(r.ok).toBe(true);
      expect(names(await nb({}))).toEqual(['acme', 'carl', 'dave', 'erin']);
    });
  });

  it('include adds properties for each requested name', async () => {
    await withDb(async ({ nb }) => {
      const r = await nb({ include: ['height'] });
      expect(r.rows.find((x) => x.entity === 'carl')!.properties).toEqual({ height: [186] });
      expect(r.rows.find((x) => x.entity === 'google')!.properties).toEqual({ height: [] });
      const plain = await nb({});
      expect('properties' in plain.rows[0]!).toBe(false);
    });
  });

  it('order_by sorts before limit, missing values last', async () => {
    await withDb(async ({ nb }) => {
      const r = await nb({ orderBy: { property: 'height', dir: 'desc' }, limit: 1 });
      expect(names(r)).toEqual(['dave']);
      expect(r.total).toBe(5);
      expect(r.truncated).toBe(true);
      const asc = await nb({ orderBy: { property: 'height', dir: 'asc' } });
      expect(asc.rows[0]!.entity).toBe('erin');
      expect(names(asc).slice(-2)).toEqual(['acme', 'google']);
    });
  });

  it('validates arguments', async () => {
    await withDb(async ({ nb }) => {
      const code = async (a: NbArgs): Promise<string> => {
        try {
          await nb(a);
          return 'ok';
        } catch (e) {
          return (e as { code: string }).code;
        }
      };
      for (const depth of [0, 7, 1.5]) expect(await code({ depth })).toBe('invalid_param');
      expect(await code({ relationTypes: [] })).toBe('invalid_param');
      expect(await code({ relationTypes: ['nope'] })).toBe('unknown_type');
      expect(await code({ include: ['nope'] })).toBe('unknown_type');
      expect(await code({ entity: 'nobody' })).toBe('unknown_entity');
      expect(await code({ limit: 0 })).toBe('invalid_param');
      expect(await code({ limit: 500 })).toBe('ok');
      expect(await code({ direction: 'up' as 'out' })).toBe('invalid_param');
      expect(await code({ orderBy: { property: 'height', dir: 'up' as 'asc' } })).toBe('invalid_param');
      expect(await code({ paths: true })).toBe('invalid_param');
    });
  });

  it('works through query() with snake_case rows', async () => {
    await withDb(async ({ pool, reg }) => {
      const r = await query(pool, reg, {
        ops: [{ op: 'neighbors', entity: 'bob', relation_types: ['works_at'], direction: 'out', include: ['height'] }],
      });
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      const res = r.results[0] as { rows: Record<string, unknown>[]; total: number; truncated: boolean };
      expect(res.total).toBe(2);
      expect(res.truncated).toBe(false);
      expect(res.rows[0]).toEqual({
        entity: 'acme',
        depth: 1,
        via: { relation: 'works_at', from: 'bob', relation_id: expect.any(Number), time: { axis: 'game_day', from: 1 } },
        via_count: 1,
        properties: { height: [] },
      });
      const bad = await query(pool, reg, { ops: [{ op: 'neighbors', entity: 'bob', order_by: 'height' }] });
      expect(bad.ok).toBe(false);
    });
  });
});

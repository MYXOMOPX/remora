import { RemoraError } from '@remora/sdk';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import type { PluginRegistry } from '../src/plugins/registry.js';
import { createRelationType } from '../src/services/dictionaries.js';
import { createEntity } from '../src/services/entities.js';
import {
  propertyAt,
  propertyHistory,
  relationHistory,
  whenClause,
} from '../src/services/facts-read.js';
import { addProperty, endProperty, retractProperty } from '../src/services/properties.js';
import { addRelation } from '../src/services/relations.js';
import {
  parseMoment,
  parseSpans,
  parseWhen,
  type AxisRef,
  type Moment,
  type Span,
  type When,
} from '../src/services/time.js';
import { seedAxes } from './helpers/axes.js';
import { seedBasics } from './helpers/seed.js';
import { createTestDb } from './helpers/testDb.js';

interface Ctx {
  pool: pg.Pool;
  reg: PluginRegistry;
  sp: (raw: unknown) => Span[];
  mo: (axis: string, at: number) => Moment;
  at: (axis: string, at: number) => When;
  during: (axis: string, a: number, b: number) => When;
  axis: (name: string) => AxisRef;
}

async function withDb(fn: (c: Ctx) => Promise<void>): Promise<void> {
  const { pool, drop } = await createTestDb();
  try {
    await runMigrations(pool);
    const s = await seedBasics(pool);
    const reg = await seedAxes(pool, s);
    await createEntity(pool, 'google');
    await createRelationType(pool, { name: 'works_at', description: 'Employment.', directed: true });
    await createRelationType(pool, { name: 'friend_of', description: 'Friendship.', directed: false });
    await fn({
      pool,
      reg,
      sp: (raw) => parseSpans(reg, raw),
      mo: (axis, at) => parseMoment(reg, { axis, at }),
      at: (axis, at) => parseWhen(reg, { axis, at })!,
      during: (axis, a, b) => parseWhen(reg, { axis, during: [a, b] })!,
      axis: (name) => reg.getAxis(name),
    });
  } finally {
    await drop();
  }
}

const gd = (from?: number, to?: number): unknown => ({ axis: 'game_day', from, to });
const real = (from?: number, to?: number): unknown => ({ axis: 'real', from, to });

async function code(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    if (e instanceof RemoraError) return e.code;
    throw e;
  }
  return undefined;
}

describe('whenClause', () => {
  it('builds sql with numbering from firstParam', () => {
    const axis = { id: 7, name: 'x', def: {} as never } as AxisRef;
    expect(whenClause(undefined, 3)).toEqual({ sql: 'true', params: [] });
    expect(whenClause({ axis, at: 5n }, 3)).toEqual({
      sql: '(time_axis IS NULL OR (time_axis = $3 AND time_span @> $4::bigint))',
      params: [7, 5n],
    });
    expect(whenClause({ axis, from: 1n, to: 2n }, 2)).toEqual({
      sql: "(time_axis IS NULL OR (time_axis = $2 AND time_span && int8range($3, $4, '[)')))",
      params: [7, 1n, 2n],
    });
  });
});

async function seedJobs({ pool, sp }: Ctx): Promise<void> {
  await addProperty(pool, { entity: 'bob', property: 'job_title', value: 'Junior', spans: sp([gd(290, 300)]) });
  await addProperty(pool, { entity: 'bob', property: 'job_title', value: 'Senior', spans: sp([gd(300, 310)]) });
}

describe('propertyAt', () => {
  it('picks the value current at the moment', () =>
    withDb(async (c) => {
      await seedJobs(c);
      const q = (n: number) =>
        propertyAt(c.pool, c.reg, { entity: 'bob', property: 'job_title', when: c.at('game_day', n) });
      expect((await q(295)).map((r) => r.value)).toEqual(['Junior']);
      expect((await q(300)).map((r) => r.value)).toEqual(['Senior']);
      expect(await q(310)).toEqual([]);
      const [row] = await q(295);
      expect(row!.time).toEqual({ axis: 'game_day', from: 290, to: 300 });
      expect(typeof row!.id).toBe('bigint');
      expect(row!.evidenceId).toBeNull();
      expect(row!.recordedAt).toBeInstanceOf(Date);
      expect(row!.retractedAt).toBeNull();
    }));

  it('timeless value appears for any axis', () =>
    withDb(async (c) => {
      await addProperty(c.pool, { entity: 'bob', property: 'height', value: 180, spans: [] });
      for (const w of [c.at('game_day', 1), c.at('real', 1)]) {
        const r = await propertyAt(c.pool, c.reg, { entity: 'bob', property: 'height', when: w });
        expect(r).toHaveLength(1);
        expect(r[0]!.time).toBeNull();
      }
    }));

  it('other-axis row is not returned', () =>
    withDb(async (c) => {
      await addProperty(c.pool, { entity: 'bob', property: 'job_title', value: 'X', spans: c.sp([real(0)]) });
      const r = await propertyAt(c.pool, c.reg, {
        entity: 'bob',
        property: 'job_title',
        when: c.at('game_day', 5),
      });
      expect(r).toEqual([]);
    }));

  it('during is half-open overlap', () =>
    withDb(async (c) => {
      await seedJobs(c);
      const q = (a: number, b: number) =>
        propertyAt(c.pool, c.reg, { entity: 'bob', property: 'job_title', when: c.during('game_day', a, b) });
      expect((await q(290, 300)).map((r) => r.value)).toEqual(['Junior']);
      expect((await q(299, 301)).map((r) => r.value)).toEqual(['Junior', 'Senior']);
    }));

  it('multi-valued returns both rows', () =>
    withDb(async (c) => {
      await addProperty(c.pool, { entity: 'bob', property: 'nickname', value: 'Bobby', spans: [] });
      await addProperty(c.pool, { entity: 'bob', property: 'nickname', value: 'Rob', spans: [] });
      const r = await propertyAt(c.pool, c.reg, {
        entity: 'bob',
        property: 'nickname',
        when: c.at('game_day', 1),
      });
      expect(r.map((x) => x.value)).toEqual(['Bobby', 'Rob']);
    }));

  it('excludes retracted rows', () =>
    withDb(async (c) => {
      const { ids } = await addProperty(c.pool, { entity: 'bob', property: 'height', value: 1, spans: [] });
      await retractProperty(c.pool, { id: ids[0]! });
      const r = await propertyAt(c.pool, c.reg, { entity: 'bob', property: 'height', when: c.at('real', 1) });
      expect(r).toEqual([]);
    }));

  it('unknown property / entity', () =>
    withDb(async (c) => {
      const when = c.at('real', 1);
      expect(await code(propertyAt(c.pool, c.reg, { entity: 'bob', property: 'nope', when }))).toBe('unknown_type');
      expect(await code(propertyAt(c.pool, c.reg, { entity: 'nobody', property: 'height', when }))).toBe(
        'unknown_entity',
      );
    }));
});

describe('propertyHistory', () => {
  it('hides retracted by default, shows with includeRetracted', () =>
    withDb(async (c) => {
      const { ids } = await addProperty(c.pool, { entity: 'bob', property: 'job_title', value: 'A', spans: [] });
      await retractProperty(c.pool, { id: ids[0]! });
      const a = { entity: 'bob', property: 'job_title' };
      expect(await propertyHistory(c.pool, c.reg, a)).toEqual([]);
      const r = await propertyHistory(c.pool, c.reg, { ...a, includeRetracted: true });
      expect(r).toHaveLength(1);
      expect(r[0]!.retractedAt).toBeInstanceOf(Date);
    }));

  it('axis filter keeps that axis and timeless rows; orders by time', () =>
    withDb(async (c) => {
      await addProperty(c.pool, { entity: 'bob', property: 'nickname', value: 'g2', spans: c.sp([gd(20)]) });
      await addProperty(c.pool, { entity: 'bob', property: 'nickname', value: 't', spans: [] });
      await addProperty(c.pool, { entity: 'bob', property: 'nickname', value: 'g1', spans: c.sp([gd(10)]) });
      await addProperty(c.pool, { entity: 'bob', property: 'nickname', value: 'r', spans: c.sp([real(1)]) });
      const a = { entity: 'bob', property: 'nickname' };
      const g = await propertyHistory(c.pool, c.reg, { ...a, axis: c.axis('game_day') });
      expect(g.map((x) => x.value)).toEqual(['t', 'g1', 'g2']);
      const all = await propertyHistory(c.pool, c.reg, a);
      expect(all).toHaveLength(4);
      expect(all[0]!.value).toBe('t');
    }));

  it('closed row via endProperty reports to', () =>
    withDb(async (c) => {
      await addProperty(c.pool, { entity: 'bob', property: 'job_title', value: 'A', spans: c.sp([gd(1)]) });
      await endProperty(c.pool, { entity: 'bob', property: 'job_title', moment: c.mo('game_day', 5) });
      const r = await propertyHistory(c.pool, c.reg, { entity: 'bob', property: 'job_title' });
      expect(r[0]!.time).toEqual({ axis: 'game_day', from: 1, to: 5 });
    }));

  it('big values round-trip exactly', () =>
    withDb(async (c) => {
      await addProperty(c.pool, {
        entity: 'bob',
        property: 'job_title',
        value: 'B',
        spans: c.sp([{ axis: 'big', from: { v: '9007199254740993' } }]),
      });
      const r = await propertyHistory(c.pool, c.reg, { entity: 'bob', property: 'job_title' });
      expect(r[0]!.time).toEqual({ axis: 'big', from: { v: '9007199254740993' } });
      const raw = await c.pool.query('SELECT lower(time_span)::text AS lo FROM property_version');
      expect(raw.rows[0].lo).toBe('9007199254740993');
    }));
});

describe('relationHistory', () => {
  it('directed type respects direction', () =>
    withDb(async (c) => {
      await addRelation(c.pool, { type: 'works_at', from: 'bob', to: 'google', spans: [] });
      const h = (entity: string, direction?: 'out' | 'in' | 'both') =>
        relationHistory(c.pool, c.reg, { entity, direction });
      expect((await h('bob', 'out')).rows).toHaveLength(1);
      expect((await h('bob', 'in')).rows).toHaveLength(0);
      expect((await h('google', 'in')).rows).toHaveLength(1);
      expect((await h('google', 'out')).rows).toHaveLength(0);
      expect((await h('google')).rows).toHaveLength(1);
      const row = (await h('bob')).rows[0]!;
      expect(row.type).toBe('works_at');
      expect(row.from).toBe('bob');
      expect(row.to).toBe('google');
      expect(row.time).toBeNull();
      expect(typeof row.relationId).toBe('bigint');
    }));

  it('undirected type matches from either end regardless of direction', () =>
    withDb(async (c) => {
      await addRelation(c.pool, { type: 'friend_of', from: 'bob', to: 'google', spans: [] });
      const r = await relationHistory(c.pool, c.reg, { entity: 'google', direction: 'out' });
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]!.from).toBe('bob');
    }));

  it('filters by type and rejects unknown type', () =>
    withDb(async (c) => {
      await addRelation(c.pool, { type: 'works_at', from: 'bob', to: 'google', spans: [] });
      await addRelation(c.pool, { type: 'friend_of', from: 'bob', to: 'google', spans: [] });
      const r = await relationHistory(c.pool, c.reg, { entity: 'bob', relationTypes: ['friend_of'] });
      expect(r.rows.map((x) => x.type)).toEqual(['friend_of']);
      expect(await code(relationHistory(c.pool, c.reg, { entity: 'bob', relationTypes: ['nope'] }))).toBe(
        'unknown_type',
      );
    }));

  it('applies when and retraction filters', () =>
    withDb(async (c) => {
      const a = await addRelation(c.pool, {
        type: 'works_at',
        from: 'bob',
        to: 'google',
        spans: c.sp([gd(10, 20)]),
      });
      const inside = await relationHistory(c.pool, c.reg, { entity: 'bob', when: c.at('game_day', 15) });
      expect(inside.rows).toHaveLength(1);
      expect(inside.rows[0]!.time).toEqual({ axis: 'game_day', from: 10, to: 20 });
      const outside = await relationHistory(c.pool, c.reg, { entity: 'bob', when: c.at('game_day', 20) });
      expect(outside.rows).toHaveLength(0);
      await c.pool.query('UPDATE relation SET retracted_at = now() WHERE id = $1', [a.ids[0]]);
      expect((await relationHistory(c.pool, c.reg, { entity: 'bob' })).rows).toHaveLength(0);
      const inc = await relationHistory(c.pool, c.reg, { entity: 'bob', includeRetracted: true });
      expect(inc.rows).toHaveLength(1);
      expect(inc.rows[0]!.retractedAt).toBeInstanceOf(Date);
    }));

  it('limit gives total and truncated', () =>
    withDb(async (c) => {
      for (let i = 0; i < 3; i++) {
        await addRelation(c.pool, { type: 'works_at', from: 'bob', to: 'google', spans: [] });
      }
      const r = await relationHistory(c.pool, c.reg, { entity: 'bob', limit: 2 });
      expect(r.rows).toHaveLength(2);
      expect(r.total).toBe(3);
      expect(r.truncated).toBe(true);
      const all = await relationHistory(c.pool, c.reg, { entity: 'bob' });
      expect(all.truncated).toBe(false);
    }));

  it('unknown entity', () =>
    withDb(async (c) => {
      expect(await code(relationHistory(c.pool, c.reg, { entity: 'nobody' }))).toBe('unknown_entity');
    }));
});

import { RemoraError } from '@remora/sdk';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { createRelationType } from '../src/services/dictionaries.js';
import { createEntity } from '../src/services/entities.js';
import { addRelation, endRelation, retractRelation } from '../src/services/relations.js';
import { parseMoment, parseSpans, type AxisRef, type Moment, type Span } from '../src/services/time.js';
import { seedAxes } from './helpers/axes.js';
import { seedBasics } from './helpers/seed.js';
import { createTestDb } from './helpers/testDb.js';

interface Ctx {
  pool: pg.Pool;
  sp: (raw: unknown) => Span[];
  mo: (axis: string, at: number) => Moment;
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
      sp: (raw) => parseSpans(reg, raw),
      mo: (axis, at) => parseMoment(reg, { axis, at }),
      axis: (name) => reg.getAxis(name),
    });
  } finally {
    await drop();
  }
}

const gd = (from?: number, to?: number): unknown => ({ axis: 'game_day', from, to });
const real = (from?: number, to?: number): unknown => ({ axis: 'real', from, to });
const works = { type: 'works_at', from: 'bob', to: 'google' };

async function rows(pool: pg.Pool) {
  const r = await pool.query(
    `SELECT id, relation_id, time_axis, upper(time_span) AS hi, retracted_at FROM relation ORDER BY id`,
  );
  return r.rows;
}

async function code(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    if (e instanceof RemoraError) return e.code;
    throw e;
  }
  return undefined;
}

describe('relation writes', () => {
  it('add with two spans shares one relation_id', () =>
    withDb(async ({ pool, sp }) => {
      const a = await addRelation(pool, { ...works, spans: sp([gd(290), real(100)]) });
      expect(a.ids).toHaveLength(2);
      const b = await addRelation(pool, { ...works, spans: sp([gd(5)]) });
      expect(b.relationId > a.relationId).toBe(true);
      const rs = await rows(pool);
      expect(rs[0].relation_id).toBe(rs[1].relation_id);
      expect(rs[0].relation_id).toBe(a.relationId.toString());
    }));

  it('timeless add gives one NULL-axis row', () =>
    withDb(async ({ pool }) => {
      const a = await addRelation(pool, { ...works, spans: [] });
      expect(a.ids).toHaveLength(1);
      const r = await pool.query('SELECT time_axis, time_span FROM relation');
      expect(r.rows).toEqual([{ time_axis: null, time_span: null }]);
    }));

  it('end by relationId closes only the matching axis', () =>
    withDb(async ({ pool, sp, mo }) => {
      const a = await addRelation(pool, { ...works, spans: sp([gd(290), real(100)]) });
      const e = await endRelation(pool, { ref: { relationId: a.relationId }, moment: mo('game_day', 306) });
      expect(e.closed).toEqual([a.ids[0]]);
      const rs = await rows(pool);
      expect(rs[0].hi).toBe('306');
      expect(rs[1].hi).toBeNull();
    }));

  it('end by selector; twice -> not_found', () =>
    withDb(async ({ pool, sp, mo }) => {
      await addRelation(pool, { ...works, spans: sp([gd(290)]) });
      await endRelation(pool, { ref: works, moment: mo('game_day', 306) });
      expect(await code(endRelation(pool, { ref: works, moment: mo('game_day', 307) }))).toBe('not_found');
    }));

  it('selector matching nothing -> not_found', () =>
    withDb(async ({ pool, mo }) => {
      expect(await code(endRelation(pool, { ref: works, moment: mo('game_day', 1) }))).toBe('not_found');
    }));

  it('R2: closing at the start -> invalid_time', () =>
    withDb(async ({ pool, sp, mo }) => {
      await addRelation(pool, { ...works, spans: sp([gd(292)]) });
      expect(await code(endRelation(pool, { ref: works, moment: mo('game_day', 292) }))).toBe('invalid_time');
      expect((await rows(pool))[0].hi).toBeNull();
    }));

  it('undirected works from either endpoint', () =>
    withDb(async ({ pool, sp, mo }) => {
      await addRelation(pool, { type: 'friend_of', from: 'bob', to: 'google', spans: sp([gd(1)]) });
      const e = await endRelation(pool, {
        ref: { type: 'friend_of', from: 'google', to: 'bob' },
        moment: mo('game_day', 5),
      });
      expect(e.closed).toHaveLength(1);
    }));

  it('directed reversed selector -> not_found', () =>
    withDb(async ({ pool, sp, mo }) => {
      await addRelation(pool, { ...works, spans: sp([gd(1)]) });
      expect(
        await code(
          endRelation(pool, { ref: { type: 'works_at', from: 'google', to: 'bob' }, moment: mo('game_day', 5) }),
        ),
      ).toBe('not_found');
    }));

  it('retract without axis retracts all rows; with axis only that one', () =>
    withDb(async ({ pool, sp, axis }) => {
      const a = await addRelation(pool, { ...works, spans: sp([gd(1), real(1)]) });
      const r1 = await retractRelation(pool, { ref: { relationId: a.relationId }, axis: axis('real') });
      expect(r1.retracted).toEqual([a.ids[1]]);
      const r2 = await retractRelation(pool, { ref: { relationId: a.relationId } });
      expect(r2.retracted).toEqual([a.ids[0]]);
      expect((await rows(pool)).every((r) => r.retracted_at !== null)).toBe(true);
      expect(await code(retractRelation(pool, { ref: { relationId: a.relationId } }))).toBe('not_found');
    }));

  it('retract all rows at once', () =>
    withDb(async ({ pool, sp }) => {
      const a = await addRelation(pool, { ...works, spans: sp([gd(1), real(1)]) });
      const r = await retractRelation(pool, { ref: works });
      expect(r.retracted).toEqual(a.ids);
    }));

  it('parallel relations are both closed by one selector', () =>
    withDb(async ({ pool, sp, mo }) => {
      await addRelation(pool, { ...works, spans: sp([gd(1)]) });
      await addRelation(pool, { ...works, spans: sp([gd(2)]) });
      const e = await endRelation(pool, { ref: works, moment: mo('game_day', 10) });
      expect(e.closed).toHaveLength(2);
    }));

  it('unknown relationId -> not_found', () =>
    withDb(async ({ pool, mo }) => {
      expect(await code(endRelation(pool, { ref: { relationId: 999n }, moment: mo('game_day', 1) }))).toBe(
        'not_found',
      );
      expect(await code(retractRelation(pool, { ref: { relationId: 999n } }))).toBe('not_found');
    }));

  it('unknown entity / type', () =>
    withDb(async ({ pool }) => {
      expect(await code(addRelation(pool, { ...works, to: 'nope', spans: [] }))).toBe('unknown_entity');
      expect(await code(addRelation(pool, { ...works, type: 'nope', spans: [] }))).toBe('unknown_type');
    }));
});

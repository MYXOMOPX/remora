import { RemoraError } from '@remora/sdk';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { apply } from '../src/api/apply.js';
import { runMigrations } from '../src/db/migrate.js';
import type { PluginRegistry } from '../src/plugins/registry.js';
import { createEntity } from '../src/services/entities.js';
import { addEvent, normalizeKeywords, retractEvent, updateEvent } from '../src/services/events.js';
import { parseEventTimes } from '../src/services/time.js';
import { fakeSource, seedAxes } from './helpers/axes.js';
import { seedBasics } from './helpers/seed.js';
import { createTestDb } from './helpers/testDb.js';

interface Ctx {
  pool: pg.Pool;
  reg: PluginRegistry;
}

async function withDb(fn: (c: Ctx) => Promise<void>): Promise<void> {
  const { pool, drop } = await createTestDb();
  try {
    await runMigrations(pool);
    const seeded = await seedBasics(pool);
    const reg = await seedAxes(pool, seeded, [fakeSource('chat')]);
    await fn({ pool, reg });
  } finally {
    await drop();
  }
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof RemoraError) return e.code;
    throw e;
  }
  return 'no error';
}

const gd = (at: number) => ({ axis: 'game_day', at });

async function row(pool: pg.Pool, id: bigint): Promise<Record<string, unknown>> {
  const r = await pool.query('SELECT * FROM event WHERE id = $1', [id]);
  return r.rows[0] as Record<string, unknown>;
}

async function links(pool: pg.Pool, id: bigint): Promise<string[]> {
  const r = await pool.query<{ k: string }>(
    `SELECT e.key || ':' || ee.role AS k FROM event_entity ee JOIN entity e USING (entity_id)
      WHERE ee.event_id = $1 ORDER BY 1`,
    [id],
  );
  return r.rows.map((x) => x.k);
}

describe('normalizeKeywords', () => {
  it('trims, lowercases, de-duplicates', () => {
    expect(normalizeKeywords(['Salto', ' salto ', 'Park'])).toEqual(['salto', 'park']);
  });
  it('empty keyword -> invalid_param', () => {
    expect(() => normalizeKeywords(['a', '  '])).toThrow(RemoraError);
  });
});

describe('addEvent', () => {
  it('stores event, times, entities, keywords', async () => {
    await withDb(async ({ pool, reg }) => {
      await createEntity(pool, 'carl');
      const times = parseEventTimes(reg, [gd(300), { axis: 'real', from: 5 }]);
      const { id } = await addEvent(pool, {
        summary: ' Bob jumped ',
        details: 'from the roof',
        keywords: ['Salto', ' salto ', 'Park'],
        times,
        entities: [{ entity: 'bob', role: 'Eye Witness' }, { entity: 'carl' }, { entity: 'carl' }],
      });
      const e = await row(pool, id);
      expect(e.summary).toBe('Bob jumped');
      expect(e.details).toBe('from the roof');
      expect(e.keywords).toEqual(['salto', 'park']);
      expect(e.evidence_id).toBeNull();
      expect(e.updated_at).toBeNull();
      const t = await pool.query(
        'SELECT time_axis, lower(time_span) AS lo, upper(time_span) AS hi, instant FROM event_time WHERE event_id = $1 ORDER BY time_axis',
        [id],
      );
      expect(t.rows).toEqual([
        { time_axis: 1, lo: '300', hi: '301', instant: true },
        { time_axis: 2, lo: '5', hi: null, instant: false },
      ]);
      expect(await links(pool, id)).toEqual(['bob:eye_witness', 'carl:participant']);
    });
  });
  it('rejects blank summary, empty keyword, unknown entity', async () => {
    await withDb(async ({ pool, reg }) => {
      const times = parseEventTimes(reg, gd(1));
      expect(await codeOf(addEvent(pool, { summary: '  ', times }))).toBe('invalid_param');
      expect(await codeOf(addEvent(pool, { summary: 'x', keywords: [''], times }))).toBe('invalid_param');
      expect(await codeOf(addEvent(pool, { summary: 'x', times, entities: [{ entity: 'nobody' }] }))).toBe(
        'unknown_entity',
      );
    });
  });
});

describe('updateEvent', () => {
  async function seed(pool: pg.Pool, reg: PluginRegistry): Promise<bigint> {
    await createEntity(pool, 'carl');
    const { id } = await addEvent(pool, {
      summary: 's',
      details: 'd',
      keywords: ['salto', 'park'],
      times: parseEventTimes(reg, gd(300)),
      entities: [{ entity: 'bob', role: 'actor' }, { entity: 'bob', role: 'witness' }],
    });
    return id;
  }

  it('summary sets updated_at; details null clears', async () => {
    await withDb(async ({ pool, reg }) => {
      const id = await seed(pool, reg);
      await updateEvent(pool, { id, summary: 'new' });
      let e = await row(pool, id);
      expect(e.summary).toBe('new');
      expect(e.updated_at).toBeInstanceOf(Date);
      await updateEvent(pool, { id, details: null });
      e = await row(pool, id);
      expect(e.details).toBeNull();
      expect(e.summary).toBe('new');
    });
  });
  it('keywords add/remove, set, mixing', async () => {
    await withDb(async ({ pool, reg }) => {
      const id = await seed(pool, reg);
      await updateEvent(pool, { id, keywords: { add: ['X'], remove: ['salto'] } });
      expect((await row(pool, id)).keywords).toEqual(['park', 'x']);
      await updateEvent(pool, { id, keywords: { set: [] } });
      expect((await row(pool, id)).keywords).toEqual([]);
      const bad = { set: ['a'], add: ['b'] } as never;
      expect(await codeOf(updateEvent(pool, { id, keywords: bad }))).toBe('invalid_param');
    });
  });
  it('times replace one axis, add another, keep the rest', async () => {
    await withDb(async ({ pool, reg }) => {
      const id = await seed(pool, reg);
      await updateEvent(pool, { id, times: parseEventTimes(reg, gd(400)) });
      await updateEvent(pool, { id, times: parseEventTimes(reg, { axis: 'real', from: 1, to: 9 }) });
      const t = await pool.query(
        'SELECT time_axis, lower(time_span) AS lo, upper(time_span) AS hi, instant FROM event_time WHERE event_id = $1 ORDER BY time_axis',
        [id],
      );
      expect(t.rows).toEqual([
        { time_axis: 1, lo: '400', hi: '401', instant: true },
        { time_axis: 2, lo: '1', hi: '9', instant: false },
      ]);
    });
  });
  it('entities add (no-op on existing) and remove', async () => {
    await withDb(async ({ pool, reg }) => {
      const id = await seed(pool, reg);
      await updateEvent(pool, { id, entities: { add: [{ entity: 'bob', role: 'actor' }, { entity: 'carl' }] } });
      expect(await links(pool, id)).toEqual(['bob:actor', 'bob:witness', 'carl:participant']);
      await updateEvent(pool, { id, entities: { remove: [{ entity: 'bob', role: 'witness' }] } });
      expect(await links(pool, id)).toEqual(['bob:actor', 'carl:participant']);
      await updateEvent(pool, { id, entities: { remove: [{ entity: 'bob' }] } });
      expect(await links(pool, id)).toEqual(['carl:participant']);
      expect(await codeOf(updateEvent(pool, { id, entities: { remove: [{ entity: 'bob' }] } }))).toBe('not_found');
    });
  });
  it('only id -> invalid_param; missing / retracted -> not_found', async () => {
    await withDb(async ({ pool, reg }) => {
      const id = await seed(pool, reg);
      expect(await codeOf(updateEvent(pool, { id }))).toBe('invalid_param');
      expect(await codeOf(updateEvent(pool, { id: 9999n, summary: 'x' }))).toBe('not_found');
      await retractEvent(pool, { id });
      expect(await codeOf(updateEvent(pool, { id, summary: 'x' }))).toBe('not_found');
    });
  });
  it('evidence replaces evidence_id', async () => {
    await withDb(async ({ pool, reg }) => {
      const id = await seed(pool, reg);
      const ev = await pool.query<{ id: string }>(
        `INSERT INTO evidence_log (source_id, payload) SELECT id, '{}'::jsonb FROM evidence_source LIMIT 1 RETURNING id`,
      );
      await updateEvent(pool, { id, evidenceId: BigInt(ev.rows[0]!.id) });
      expect(String((await row(pool, id)).evidence_id)).toBe(ev.rows[0]!.id);
    });
  });
});

describe('retractEvent', () => {
  it('sets retracted_at / retracted_evidence_id; twice -> not_found', async () => {
    await withDb(async ({ pool, reg }) => {
      const { id } = await addEvent(pool, { summary: 's', times: parseEventTimes(reg, gd(1)) });
      const ev = await pool.query<{ id: string }>(
        `INSERT INTO evidence_log (source_id, payload) SELECT id, '{}'::jsonb FROM evidence_source LIMIT 1 RETURNING id`,
      );
      await retractEvent(pool, { id, evidenceId: BigInt(ev.rows[0]!.id) });
      const e = await row(pool, id);
      expect(e.retracted_at).toBeInstanceOf(Date);
      expect(String(e.retracted_evidence_id)).toBe(ev.rows[0]!.id);
      expect(await codeOf(retractEvent(pool, { id }))).toBe('not_found');
    });
  });
});

describe('apply events', () => {
  it('runs add/update/retract with $refs', async () => {
    await withDb(async ({ pool, reg }) => {
      const r = await apply(pool, reg, {
        ops: [
          { op: 'add_evidence', source: 'chat', payload: { text: 'x' }, as: 'e1' },
          { op: 'create_entity', key: 'carl', as: 'c' },
          {
            op: 'add_event',
            summary: 'jump',
            time: gd(300),
            entities: [{ entity: '$c', role: 'actor' }, { entity: 'bob' }],
            keywords: ['salto'],
            evidence: '$e1',
            as: 'ev',
          },
          { op: 'update_event', id: 1, summary: 'jump 2', keywords: { add: ['park'] }, time: gd(301), evidence: '$e1' },
          { op: 'retract_event', id: 1, evidence: '$e1' },
        ],
      });
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      const res = r.results as Record<string, unknown>[];
      expect(res[2]).toMatchObject({ id: expect.any(Number) });
      const eid = res[2]!.id as number;
      expect(res[3]).toEqual({ id: eid });
      expect(res[4]).toEqual({ id: eid });
      const e = await row(pool, BigInt(eid));
      expect(String(e.evidence_id)).toBe(String(res[0]!.id));
      expect(e.summary).toBe('jump 2');
      expect(e.keywords).toEqual(['salto', 'park']);
      expect(await links(pool, BigInt(eid))).toEqual(['bob:participant', 'carl:actor']);
    });
  });
  it('maps argument errors', async () => {
    await withDb(async ({ pool, reg }) => {
      const run = (op: unknown) => apply(pool, reg, { ops: [op] });
      const code = async (op: unknown) => {
        const r = await run(op);
        return r.ok ? 'ok' : r.error.code;
      };
      expect(await code({ op: 'add_event', summary: 'x' })).toBe('invalid_param');
      expect(await code({ op: 'add_event', summary: 'x', time: gd(1), keywords: 'a' })).toBe('invalid_param');
      expect(await code({ op: 'add_event', summary: 'x', time: gd(1), entities: [{ entity: '$nope' }] })).toBe(
        'unknown_ref',
      );
      expect(await code({ op: 'update_event', id: 'a', summary: 'x' })).toBe('invalid_param');
      expect(await code({ op: 'update_event', id: 5, summary: 'x' })).toBe('not_found');
      expect(await code({ op: 'retract_event', id: 5 })).toBe('not_found');
    });
  });
});

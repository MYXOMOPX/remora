import { RemoraError } from '@remora/sdk';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { query, type QueryResponse } from '../src/api/query.js';
import { runMigrations } from '../src/db/migrate.js';
import type { PluginRegistry } from '../src/plugins/registry.js';
import { createEntity } from '../src/services/entities.js';
import { addEvent, retractEvent } from '../src/services/events.js';
import { entityEvents, getEvent, listEventRoles, searchEvents } from '../src/services/events-read.js';
import { parseEventTimes, parseWhen } from '../src/services/time.js';
import { seedAxes } from './helpers/axes.js';
import { seedBasics } from './helpers/seed.js';
import { createTestDb } from './helpers/testDb.js';

interface Ctx {
  pool: pg.Pool;
  reg: PluginRegistry;
  axes: { gameDay: number; real: number };
}

// generous by default so loaded CI machines do not flake; REMORA_TEST_SPEED_MS tightens or loosens it
const SPEED_MS = Number(process.env.REMORA_TEST_SPEED_MS ?? 3000);

async function withDb(fn: (c: Ctx) => Promise<void>): Promise<void> {
  const { pool, drop } = await createTestDb();
  try {
    await runMigrations(pool);
    const seeded = await seedBasics(pool);
    const reg = await seedAxes(pool, seeded);
    await fn({ pool, reg, axes: seeded.axes });
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

async function ev(
  { pool, reg }: Ctx,
  summary: string,
  time: unknown,
  extra: { details?: string; keywords?: string[]; entities?: { entity: string; role?: string }[] } = {},
): Promise<bigint> {
  return (await addEvent(pool, { summary, times: parseEventTimes(reg, time), ...extra })).id;
}

const when = (reg: PluginRegistry, raw: unknown) => parseWhen(reg, raw)!;

describe('getEvent', () => {
  it('returns the full shape, including retracted events', async () => {
    await withDb(async (c) => {
      await createEntity(c.pool, 'carl');
      const id = await ev(c, 'Bob jumped', [gd(300), { axis: 'real', from: 5 }], {
        details: 'roof',
        keywords: ['salto'],
        entities: [{ entity: 'bob', role: 'actor' }, { entity: 'carl' }],
      });
      const e = await getEvent(c.pool, c.reg, id);
      expect(e).toMatchObject({
        id,
        summary: 'Bob jumped',
        details: 'roof',
        keywords: ['salto'],
        time: [{ axis: 'game_day', at: 300 }, { axis: 'real', from: 5 }],
        entities: [
          { entity: 'bob', role: 'actor' },
          { entity: 'carl', role: 'participant' },
        ],
        evidenceId: null,
        updatedAt: null,
        retractedAt: null,
      });
      expect(e.recordedAt).toBeInstanceOf(Date);
      await retractEvent(c.pool, { id });
      expect((await getEvent(c.pool, c.reg, id)).retractedAt).toBeInstanceOf(Date);
    });
  });
  it('missing -> not_found', async () => {
    await withDb(async (c) => {
      expect(await codeOf(getEvent(c.pool, c.reg, 999n))).toBe('not_found');
    });
  });
});

describe('searchEvents', () => {
  it('keywords: normalised, any vs all', async () => {
    await withDb(async (c) => {
      const a = await ev(c, 'a', gd(1), { keywords: ['salto'] });
      const b = await ev(c, 'b', gd(2), { keywords: ['salto', 'park'] });
      await ev(c, 'c', gd(3), { keywords: ['park'] });
      const ids = async (kw: string[], match?: 'any' | 'all') =>
        (await searchEvents(c.pool, c.reg, { keywords: kw, ...(match ? { match } : {}) })).rows.map((r) => r.id);
      expect(await ids(['SALTO'])).toEqual([b, a]);
      expect((await ids(['salto', 'park'], 'any')).length).toBe(3);
      expect(await ids(['salto', 'park'], 'all')).toEqual([b]);
    });
  });
  it('text: words in summary or details, all required, % literal', async () => {
    await withDb(async (c) => {
      const a = await ev(c, 'Он сделал сальто', gd(1), { details: 'вчера' });
      const b = await ev(c, 'Прыжок', gd(2), { details: 'красивое сальто' });
      const p = await ev(c, 'Скидка 100% сегодня', gd(3));
      await ev(c, 'Скидка 1000 сегодня', gd(4));
      const t = async (text: string) => (await searchEvents(c.pool, c.reg, { text })).rows.map((r) => r.id);
      expect(await t('сальт')).toEqual([b, a]);
      expect(await t('красив')).toEqual([b]);
      expect(await t('вчера сальт')).toEqual([a]);
      expect(await t('100%')).toEqual([p]);
    });
  });
  it('entities: all listed entities required', async () => {
    await withDb(async (c) => {
      await createEntity(c.pool, 'carl');
      await createEntity(c.pool, 'dave');
      await ev(c, 'only bob', gd(1), { entities: [{ entity: 'bob' }] });
      const both = await ev(c, 'bob carl', gd(2), { entities: [{ entity: 'bob' }, { entity: 'carl', role: 'x' }] });
      await ev(c, 'carl dave', gd(3), { entities: [{ entity: 'carl' }, { entity: 'dave' }] });
      const r = await searchEvents(c.pool, c.reg, { entities: ['bob', 'carl'] });
      expect(r.rows.map((x) => x.id)).toEqual([both]);
      expect(await codeOf(searchEvents(c.pool, c.reg, { entities: ['nobody'] }))).toBe('unknown_entity');
    });
  });
  it('when: at / during, other-axis-only events excluded, ordering', async () => {
    await withDb(async (c) => {
      const early = await ev(c, 'early', { axis: 'game_day', from: 299, to: 301 });
      const inst = await ev(c, 'inst', gd(300));
      await ev(c, 'realonly', { axis: 'real', from: 1 });
      const late = await ev(c, 'late', { axis: 'game_day', from: 400 });
      const ids = async (w: unknown) =>
        (await searchEvents(c.pool, c.reg, { when: when(c.reg, w) })).rows.map((r) => r.id);
      // newest lower bound first: inst (300) before early (299)
      expect(await ids({ axis: 'game_day', at: 300 })).toEqual([inst, early]);
      expect(await ids({ axis: 'game_day', during: [290, 310] })).toEqual([inst, early]);
      expect(await ids({ axis: 'game_day', during: [290, 500] })).toEqual([late, inst, early]);
    });
  });
  it('no when: id desc; retracted excluded; no criteria = newest', async () => {
    await withDb(async (c) => {
      const a = await ev(c, 'a', gd(1));
      const b = await ev(c, 'b', gd(2));
      const d = await ev(c, 'd', gd(3));
      await retractEvent(c.pool, { id: b });
      expect((await searchEvents(c.pool, c.reg, {})).rows.map((r) => r.id)).toEqual([d, a]);
    });
  });
  it('limit / total / truncated', async () => {
    await withDb(async (c) => {
      await ev(c, 'a', gd(1));
      const b = await ev(c, 'b', gd(2));
      const r = await searchEvents(c.pool, c.reg, { limit: 1 });
      expect(r.rows.map((x) => x.id)).toEqual([b]);
      expect(r.total).toBe(2);
      expect(r.truncated).toBe(true);
      expect(await codeOf(searchEvents(c.pool, c.reg, { limit: 0 }))).toBe('invalid_param');
    });
  });
  it('invalid args', async () => {
    await withDb(async (c) => {
      expect(await codeOf(searchEvents(c.pool, c.reg, { keywords: [] }))).toBe('invalid_param');
      expect(await codeOf(searchEvents(c.pool, c.reg, { entities: [] }))).toBe('invalid_param');
      for (const text of ['', '   ', '\t\n']) {
        expect(await codeOf(searchEvents(c.pool, c.reg, { text })), JSON.stringify(text)).toBe('invalid_param');
      }
      expect(await codeOf(searchEvents(c.pool, c.reg, { text: 5 as never }))).toBe('invalid_param');
      expect(await codeOf(searchEvents(c.pool, c.reg, { keywords: ['a'], match: 'some' as 'any' }))).toBe(
        'invalid_param',
      );
    });
  });
});

describe('entityEvents / listEventRoles', () => {
  it('entityEvents and roles', async () => {
    await withDb(async (c) => {
      await createEntity(c.pool, 'carl');
      const a = await ev(c, 'a', gd(1), { entities: [{ entity: 'bob', role: 'witness' }] });
      await ev(c, 'b', gd(2), { entities: [{ entity: 'carl', role: 'actor' }] });
      const gone = await ev(c, 'c', gd(3), { entities: [{ entity: 'bob', role: 'zzz' }] });
      await retractEvent(c.pool, { id: gone });
      expect((await entityEvents(c.pool, c.reg, { entity: 'bob' })).rows.map((r) => r.id)).toEqual([a]);
      expect(await listEventRoles(c.pool)).toEqual(['actor', 'witness']);
    });
  });
});

describe('query ops', () => {
  it('get_event shows retracted_at only for a retracted event', async () => {
    await withDb(async (c) => {
      const id = await ev(c, 'S', gd(300));
      const get = async () => {
        const r = (await query(c.pool, c.reg, { ops: [{ op: 'get_event', id: Number(id) }] })) as Extract<
          QueryResponse,
          { ok: true }
        >;
        expect(r.ok).toBe(true);
        return r.results[0] as Record<string, unknown>;
      };
      expect('retracted_at' in (await get())).toBe(false);
      await retractEvent(c.pool, { id });
      expect((await get()).retracted_at).toEqual(expect.any(String));
    });
  });
  it('search_events validates match and empty entities / text through query()', async () => {
    await withDb(async (c) => {
      for (const op of [
        { op: 'search_events', keywords: ['a'], match: 'some' },
        { op: 'search_events', entities: [] },
        { op: 'search_events', text: '  ' },
      ]) {
        const r = await query(c.pool, c.reg, { ops: [op] });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe('invalid_param');
      }
    });
  });
  it('snake_case row shape', async () => {
    await withDb(async (c) => {
      const id = await ev(c, 'S', gd(300), { keywords: ['k'], entities: [{ entity: 'bob', role: 'actor' }] });
      const res = (await query(c.pool, c.reg, {
        ops: [
          { op: 'get_event', id: Number(id) },
          { op: 'search_events', keywords: ['k'] },
          { op: 'entity_events', entity: 'bob' },
          { op: 'list_event_roles' },
        ],
      })) as Extract<QueryResponse, { ok: true }>;
      const row = {
        id: Number(id),
        summary: 'S',
        details: null,
        keywords: ['k'],
        time: [{ axis: 'game_day', at: 300 }],
        entities: [{ entity: 'bob', role: 'actor' }],
        evidence_id: null,
        recorded_at: expect.any(String),
        updated_at: null,
      };
      expect(res.ok).toBe(true);
      expect(res.results[0]).toEqual(row);
      expect(res.results[1]).toEqual({ rows: [row], total: 1, truncated: false });
      expect(res.results[2]).toEqual({ rows: [row], total: 1, truncated: false });
      expect(res.results[3]).toEqual({ roles: ['actor'] });
    });
  });
});

describe('search performance (spec 15 q.3)', () => {
  it('3000 events: each search is fast and total matches count(*)', async () => {
    await withDb(async (c) => {
      const words = Array.from({ length: 20 }, (_, i) => `w${String.fromCharCode(97 + i)}${String.fromCharCode(97 + i)}`);
      for (let i = 0; i < 50; i++) await createEntity(c.pool, `e${i}`);
      await c.pool.query(
        `INSERT INTO event (summary, keywords)
         SELECT 'event ' || i || ' ' || ($1::text[])[1 + i % 20],
                ARRAY[($1::text[])[1 + i % 20], ($1::text[])[1 + (i * 7) % 20]]
           FROM generate_series(1, 3000) i`,
        [words],
      );
      await c.pool.query(
        `INSERT INTO event_time (event_id, time_axis, time_span, instant)
         SELECT id, $1::smallint, int8range(id, id + 1, '[)'), true FROM event`,
        [c.axes.gameDay],
      );
      await c.pool.query(
        `INSERT INTO event_entity (event_id, entity_id, role)
         SELECT ev.id, en.entity_id, 'participant'
           FROM event ev JOIN (SELECT entity_id, row_number() OVER (ORDER BY entity_id) - 1 AS n
                                 FROM entity WHERE key LIKE 'e%') en ON en.n = ev.id % 50`,
      );
      await c.pool.query('ANALYZE');
      const count = async (sql: string, p: unknown[]) =>
        Number((await c.pool.query<{ n: string }>(sql, p)).rows[0]!.n);
      const timed = async (a: Parameters<typeof searchEvents>[2]) => {
        const t0 = performance.now();
        const r = await searchEvents(c.pool, c.reg, a);
        const ms = performance.now() - t0;
        expect(ms).toBeLessThan(SPEED_MS);
        expect(r.total).toBeGreaterThan(0);
        return r.total;
      };
      // events i carry [words[i % 20], words[(i * 7) % 20]]: take a pair that really occurs together
      const k1 = words[3]!;
      const k2 = words[(3 * 7) % 20]!;
      const during = when(c.reg, { axis: 'game_day', during: [100, 2000] });
      const hasE3 = `EXISTS (SELECT 1 FROM event_entity ee JOIN entity en USING (entity_id)
                             WHERE ee.event_id = ev.id AND en.key = 'e3')`;
      const inSpan = `EXISTS (SELECT 1 FROM event_time t WHERE t.event_id = ev.id AND t.time_axis = ${c.axes.gameDay}
                             AND t.time_span && int8range(100, 2000, '[)'))`;
      expect(await timed({ keywords: [k1, k2] })).toBe(
        await count('SELECT count(*) n FROM event WHERE keywords && $1::text[]', [[k1, k2]]),
      );
      expect(await timed({ keywords: [k1, k2], match: 'all' })).toBe(
        await count('SELECT count(*) n FROM event WHERE keywords @> $1::text[]', [[k1, k2]]),
      );
      expect(await timed({ text: `event ${k1}` })).toBe(
        await count(
          `SELECT count(*) n FROM event WHERE (summary || ' ' || coalesce(details, '')) ILIKE '%event%'
             AND (summary || ' ' || coalesce(details, '')) ILIKE '%' || $1 || '%'`,
          [k1],
        ),
      );
      expect(await timed({ entities: ['e3'], when: during })).toBe(
        await count(`SELECT count(*) n FROM event ev WHERE ${hasE3} AND ${inSpan}`, []),
      );
      expect(await timed({ text: 'event', keywords: [k1], entities: ['e3'], when: during })).toBe(
        await count(
          `SELECT count(*) n FROM event ev
            WHERE ev.summary ILIKE '%event%' AND ev.keywords && $1::text[] AND ${hasE3} AND ${inSpan}`,
          [[k1]],
        ),
      );
    });
  }, 60_000);
});

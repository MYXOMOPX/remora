import { RemoraError, type RetentionRow } from '@remora/sdk';
import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { apply } from '../src/api/apply.js';
import { runMigrations } from '../src/db/migrate.js';
import type { PluginRegistry } from '../src/plugins/registry.js';
import { addEvidence, getEvidence } from '../src/services/evidence.js';
import {
  applyRetention,
  pinEvidence,
  purgeEvidence,
  unpinEvidence,
} from '../src/services/evidence-maintenance.js';
import { fakeSource, seedAxes } from './helpers/axes.js';
import { seedBasics } from './helpers/seed.js';
import { createTestDb } from './helpers/testDb.js';

type Plan = (rows: RetentionRow[], now: Date) => unknown;

const textOf = (r: RetentionRow): unknown => (r.payload as { text?: unknown }).text;
const defaultPlan: Plan = (rows) =>
  rows.flatMap((r) => {
    if (textOf(r) === 'old') return [{ id: r.id, action: 'purge' }];
    if (textOf(r) === 'trim') {
      return [{ id: r.id, action: 'replace', payload: { text: 't' }, retentionState: { stage: 1 } }];
    }
    return [];
  });

interface Ctx {
  pool: pg.Pool;
  reg: PluginRegistry;
  plan: ReturnType<typeof vi.fn>;
  add: (text: string, source?: string) => Promise<bigint>;
}

async function withDb(fn: (c: Ctx) => Promise<void>, plan: Plan = defaultPlan): Promise<void> {
  const { pool, drop } = await createTestDb();
  try {
    await runMigrations(pool);
    const seeded = await seedBasics(pool);
    const spy = vi.fn(plan);
    const reg = await seedAxes(
      pool,
      seeded,
      [fakeSource('chat', { planRetention: spy as never }), fakeSource('raw')],
      ['down'],
    );
    await fn({
      pool,
      reg,
      plan: spy,
      add: async (text, source = 'chat') => (await addEvidence(pool, reg, { source, payload: { text } })).id,
    });
  } finally {
    await drop();
  }
}

async function failure(p: Promise<unknown>): Promise<RemoraError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof RemoraError) return e;
    throw e;
  }
  throw new Error('expected RemoraError');
}

const payloads = async (pool: pg.Pool): Promise<unknown[]> =>
  (await pool.query('SELECT payload FROM evidence_log ORDER BY id')).rows.map((r: { payload: unknown }) => r.payload);

const purgedCount = async (pool: pg.Pool): Promise<number> =>
  (await pool.query('SELECT count(*)::int AS n FROM evidence_log WHERE purged_at IS NOT NULL')).rows[0].n;

describe('applyRetention', () => {
  it('purges, replaces, keeps; skips pinned; second run only sees live rows', async () => {
    await withDb(async ({ pool, reg, plan, add }) => {
      const old = await add('old');
      const trim = await add('trim');
      const keep = await add('keep');
      const pinned = await add('old');
      await pinEvidence(pool, pinned);
      const rep = await applyRetention(pool, reg, { source: 'chat' });
      expect(rep).toEqual({ processed: 3, kept: 1, replaced: 1, purged: 1, skipped: [] });
      const seen = plan.mock.calls.flatMap((c) => (c[0] as RetentionRow[]).map((r) => r.id));
      expect(seen).not.toContain(pinned);
      expect([...seen].sort()).toEqual([old, trim, keep].sort());
      const o = (await pool.query('SELECT payload, retention_state, purged_at FROM evidence_log WHERE id = $1', [old]))
        .rows[0];
      expect(o.payload).toBeNull();
      expect(o.retention_state).toBeNull();
      expect(o.purged_at).toBeInstanceOf(Date);
      const t = (await pool.query('SELECT payload, retention_state FROM evidence_log WHERE id = $1', [trim])).rows[0];
      expect(t).toEqual({ payload: { text: 't' }, retention_state: { stage: 1 } });
      plan.mockClear();
      const rep2 = await applyRetention(pool, reg, { source: 'chat' });
      expect(rep2.processed).toBe(2);
      expect(rep2.purged).toBe(0);
    });
  });

  it('passes typed rows and now to the plugin', async () => {
    await withDb(async ({ pool, reg, plan, add }) => {
      await add('keep');
      const now = new Date('2030-01-01T00:00:00Z');
      await applyRetention(pool, reg, { source: 'chat', now });
      const [rows, n] = plan.mock.calls[0] as [RetentionRow[], Date];
      expect(n).toEqual(now);
      expect(rows[0]!.createdAt).toBeInstanceOf(Date);
      expect(typeof rows[0]!.id).toBe('bigint');
    });
  });

  it('batches by 500 and validates batchSize', async () => {
    await withDb(async ({ pool, reg, plan }) => {
      const sid = (await pool.query("SELECT id FROM evidence_source WHERE name = 'chat'")).rows[0].id;
      await pool.query(
        `INSERT INTO evidence_log (source_id, payload) SELECT $1, '{"text":"keep"}'::jsonb FROM generate_series(1, 1200)`,
        [sid],
      );
      await applyRetention(pool, reg, { source: 'chat' });
      expect(plan.mock.calls.map((c) => (c[0] as unknown[]).length)).toEqual([500, 500, 200]);
      for (const batchSize of [0, 10001, 1.5]) {
        expect((await failure(applyRetention(pool, reg, { source: 'chat', batchSize }))).code).toBe('invalid_param');
      }
    });
  });

  const bad: [string, Plan][] = [
    ['foreign id', (rows) => [{ id: rows[0]!.id, action: 'purge' }, { id: 99999n, action: 'keep' }]],
    ['duplicate id', (rows) => [{ id: rows[0]!.id, action: 'purge' }, { id: rows[0]!.id, action: 'keep' }]],
    ['unknown action', (rows) => [{ id: rows[0]!.id, action: 'purge' }, { id: rows[1]!.id, action: 'zap' }]],
    ['replace without payload', (rows) => [{ id: rows[0]!.id, action: 'purge' }, { id: rows[1]!.id, action: 'replace' }]],
    ['non-JSON replace payload', (rows) => [
      { id: rows[0]!.id, action: 'purge' },
      { id: rows[1]!.id, action: 'replace', payload: 1n, retentionState: null },
    ]],
    ['not an array', () => ({ nope: true })],
    [
      'throw',
      () => {
        throw new Error('boom');
      },
    ],
  ];
  for (const [name, plan] of bad) {
    it(`misbehaving plugin (${name}) -> invalid_plugin, batch untouched`, async () => {
      await withDb(async ({ pool, reg, add }) => {
        await add('a');
        await add('b');
        const before = await payloads(pool);
        const err = await failure(applyRetention(pool, reg, { source: 'chat' }));
        expect(err.code).toBe('invalid_plugin');
        expect(await payloads(pool)).toEqual(before);
        expect(await purgedCount(pool)).toBe(0);
      }, plan);
    });
  }

  it('earlier batches persist when a later batch is bad', async () => {
    let call = 0;
    await withDb(
      async ({ pool, reg, add }) => {
        await add('a');
        await add('b');
        const err = await failure(applyRetention(pool, reg, { source: 'chat', batchSize: 1 }));
        expect(err.code).toBe('invalid_plugin');
        const r = await pool.query('SELECT purged_at IS NOT NULL AS p FROM evidence_log ORDER BY id');
        expect(r.rows.map((x: { p: boolean }) => x.p)).toEqual([true, false]);
      },
      (rows) => (++call === 1 ? [{ id: rows[0]!.id, action: 'purge' }] : [{ id: rows[0]!.id, action: 'zap' }]),
    );
  });

  it('source selection', async () => {
    await withDb(async ({ pool, reg, add }) => {
      await add('keep');
      await add('keep', 'raw');
      const rep = await applyRetention(pool, reg);
      expect(rep).toEqual({ processed: 2, kept: 2, replaced: 0, purged: 0, skipped: ['down'] });
      expect((await failure(applyRetention(pool, reg, { source: 'nope' }))).code).toBe('unknown_source');
      expect((await failure(applyRetention(pool, reg, { source: 'down' }))).code).toBe('source_unavailable');
    });
  });
});

describe('purgeEvidence', () => {
  it('by ids respects pins and is idempotent', async () => {
    await withDb(async ({ pool, add }) => {
      const a = await add('a');
      const p = await add('p');
      await pinEvidence(pool, p);
      expect(await purgeEvidence(pool, { ids: [a, p] })).toEqual({ purged: 1, skippedPinned: 1 });
      expect(await purgeEvidence(pool, { ids: [a, p] })).toEqual({ purged: 0, skippedPinned: 1 });
      const row = (await pool.query('SELECT payload, retention_state, purged_at FROM evidence_log WHERE id = $1', [a]))
        .rows[0];
      expect(row.payload).toBeNull();
      expect(row.purged_at).toBeInstanceOf(Date);
    });
  });

  it('unknown id -> not_found, nothing purged; empty ids -> invalid_param', async () => {
    await withDb(async ({ pool, add }) => {
      const a = await add('a');
      const err = await failure(purgeEvidence(pool, { ids: [a, 999n] }));
      expect(err.code).toBe('not_found');
      expect(err.details).toEqual({ ids: [999] });
      expect((await getEvidence(pool, a)).purgedAt).toBeNull();
      expect((await failure(purgeEvidence(pool, { ids: [] }))).code).toBe('invalid_param');
    });
  });

  it('by source and olderThan', async () => {
    await withDb(async ({ pool, add }) => {
      const oldId = await add('x');
      const newId = await add('y');
      const rawOld = await add('z', 'raw');
      const pinned = await add('w');
      await pool.query("UPDATE evidence_log SET created_at = now() - interval '10 days' WHERE id = ANY($1::bigint[])", [
        [oldId, rawOld, pinned].map(String),
      ]);
      await pinEvidence(pool, pinned);
      const cutoff = new Date(Date.now() - 5 * 86400_000);
      expect(await purgeEvidence(pool, { source: 'chat', olderThan: cutoff })).toEqual({ purged: 1, skippedPinned: 1 });
      expect((await getEvidence(pool, oldId)).purgedAt).not.toBeNull();
      expect((await getEvidence(pool, newId)).purgedAt).toBeNull();
      expect((await getEvidence(pool, rawOld)).purgedAt).toBeNull();
      expect((await failure(purgeEvidence(pool, { source: 'nope', olderThan: cutoff }))).code).toBe('unknown_source');
    });
  });

  it('works for a source whose plugin is down', async () => {
    await withDb(async ({ pool }) => {
      expect(await purgeEvidence(pool, { source: 'down', olderThan: new Date() })).toEqual({
        purged: 0,
        skippedPinned: 0,
      });
    });
  });
});

describe('pin / unpin', () => {
  it('is idempotent and checks existence', async () => {
    await withDb(async ({ pool, add }) => {
      const a = await add('a');
      await pinEvidence(pool, a);
      await pinEvidence(pool, a);
      expect((await getEvidence(pool, a)).pinned).toBe(true);
      await unpinEvidence(pool, a);
      await unpinEvidence(pool, a);
      expect((await getEvidence(pool, a)).pinned).toBe(false);
      expect((await failure(pinEvidence(pool, 999n))).code).toBe('not_found');
      expect((await failure(unpinEvidence(pool, 999n))).code).toBe('not_found');
    });
  });
});

describe('purged evidence stays referenced', () => {
  it('property row keeps evidence_id; getEvidence returns null payload', async () => {
    await withDb(async ({ pool, reg, add }) => {
      const ev = await add('a');
      const r = await apply(pool, reg, {
        ops: [
          { op: 'add_property', entity: 'bob', property: 'nickname', value: 'b', evidence: Number(ev) },
        ],
      });
      expect(r.ok).toBe(true);
      await purgeEvidence(pool, { ids: [ev] });
      const h = await pool.query('SELECT evidence_id FROM property_version');
      expect(h.rows.map((x: { evidence_id: string }) => x.evidence_id)).toEqual([ev.toString()]);
      const e = await getEvidence(pool, ev);
      expect(e.payload).toBeNull();
      expect(e.purgedAt).toBeInstanceOf(Date);
    });
  });
});

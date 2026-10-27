import { RemoraError } from '@remora/sdk';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { apply } from '../src/api/apply.js';
import { query } from '../src/api/query.js';
import { runMigrations } from '../src/db/migrate.js';
import type { PluginRegistry } from '../src/plugins/registry.js';
import { addEvidence, getEvidence, listEvidenceSources } from '../src/services/evidence.js';
import { fakeSource, seedAxes } from './helpers/axes.js';
import { seedBasics } from './helpers/seed.js';
import { createTestDb } from './helpers/testDb.js';

const chat = fakeSource('chat', {
  ingest: (p) => ({ payload: { text: (p as { text: string }).text }, retentionState: { stage: 0 } }),
});
const boom = fakeSource('boom', {
  ingest: () => {
    throw new Error('x');
  },
});
const passthru = fakeSource('passthru', {
  ingest: () => {
    throw new RemoraError('invalid_time', 'custom');
  },
});
const badPlugin = fakeSource('badplug', { ingest: () => ({}) as { payload: unknown } });

const circ: Record<string, unknown> = {};
circ.self = circ;
const odd: Record<string, ReturnType<typeof fakeSource>> = {
  big: fakeSource('big', { ingest: () => ({ payload: 1n }) }),
  fn: fakeSource('fn', { ingest: () => ({ payload: () => 1 }) }),
  circ: fakeSource('circ', { ingest: () => ({ payload: circ }) }),
  retbig: fakeSource('retbig', { ingest: () => ({ payload: {}, retentionState: 1n }) }),
  asyncy: fakeSource('asyncy', { ingest: (async () => ({ payload: {} })) as never }),
  asyncrej: fakeSource('asyncrej', { ingest: (async () => Promise.reject(new Error('r'))) as never }),
  thenable: fakeSource('thenable', { ingest: (() => ({ then: () => undefined })) as never }),
  getter: fakeSource('getter', {
    ingest: (() => ({
      get payload(): unknown {
        throw new Error('getter boom');
      },
    })) as never,
  }),
};

const ALL = ['chat', 'raw', 'boom', 'passthru', 'badplug', ...Object.keys(odd), 'down'];

interface Ctx {
  pool: pg.Pool;
  reg: PluginRegistry;
  run: (...ops: unknown[]) => ReturnType<typeof apply>;
  q: (...ops: unknown[]) => ReturnType<typeof query>;
}

async function withDb(fn: (c: Ctx) => Promise<void>): Promise<void> {
  const { pool, drop } = await createTestDb();
  try {
    await runMigrations(pool);
    const seeded = await seedBasics(pool);
    const reg = await seedAxes(pool, seeded, [chat, fakeSource('raw'), boom, passthru, badPlugin, ...Object.values(odd)], ['down']);
    await fn({
      pool,
      reg,
      run: (...ops) => apply(pool, reg, { ops }),
      q: (...ops) => query(pool, reg, { ops }),
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

describe('addEvidence', () => {
  it('stores ingested payload and retention_state', async () => {
    await withDb(async ({ pool, reg }) => {
      const { id } = await addEvidence(pool, reg, { source: 'chat', payload: { text: 'hi', secret: 1 } });
      const r = await pool.query(
        'SELECT e.payload, e.retention_state, s.name FROM evidence_log e JOIN evidence_source s ON s.id = e.source_id WHERE e.id = $1',
        [id],
      );
      expect(r.rows[0]).toEqual({ payload: { text: 'hi' }, retention_state: { stage: 0 }, name: 'chat' });
      const raw = await addEvidence(pool, reg, { source: 'raw', payload: { text: 'z' } });
      const rr = await pool.query('SELECT retention_state IS NULL AS n, payload FROM evidence_log WHERE id = $1', [
        raw.id,
      ]);
      expect(rr.rows[0]).toEqual({ n: true, payload: { text: 'z' } });
    });
  });

  it('error cases', async () => {
    await withDb(async ({ pool, reg }) => {
      const e1 = await failure(addEvidence(pool, reg, { source: 'chat', payload: {} }));
      expect(e1.code).toBe('invalid_payload');
      expect(e1.details).toMatchObject({ source: 'chat' });
      expect((await failure(addEvidence(pool, reg, { source: 'nope', payload: {} }))).code).toBe('unknown_source');
      expect((await failure(addEvidence(pool, reg, { source: 'down', payload: {} }))).code).toBe(
        'source_unavailable',
      );
      const e2 = await failure(addEvidence(pool, reg, { source: 'boom', payload: { text: 'a' } }));
      expect(e2.code).toBe('invalid_payload');
      expect(e2.details).toMatchObject({ source: 'boom', reason: 'x' });
      expect((await failure(addEvidence(pool, reg, { source: 'passthru', payload: { text: 'a' } }))).code).toBe(
        'invalid_time',
      );
      expect((await failure(addEvidence(pool, reg, { source: 'badplug', payload: { text: 'a' } }))).code).toBe(
        'invalid_plugin',
      );
      expect((await failure(addEvidence(pool, reg, { source: 'chat', payload: undefined }))).code).toBe(
        'invalid_param',
      );
    });
  });

  it('non-JSON or async ingest output -> invalid_plugin and nothing stored', async () => {
    await withDb(async ({ pool, reg }) => {
      for (const source of Object.keys(odd)) {
        const e = await failure(addEvidence(pool, reg, { source, payload: { text: 'a' } }));
        expect(e.code, source).toBe('invalid_plugin');
        expect(e.details, source).toMatchObject({ source });
      }
      expect((await pool.query('SELECT 1 FROM evidence_log')).rows).toHaveLength(0);
    });
  });

  it('getEvidence and listEvidenceSources', async () => {
    await withDb(async ({ pool, reg }) => {
      const { id } = await addEvidence(pool, reg, { source: 'chat', payload: { text: 'hi' } });
      const row = await getEvidence(pool, id);
      expect(row).toMatchObject({ id, source: 'chat', payload: { text: 'hi' }, purgedAt: null, pinned: false });
      expect(row.createdAt).toBeInstanceOf(Date);
      expect((await failure(getEvidence(pool, 999n))).code).toBe('not_found');
      const list = await listEvidenceSources(pool);
      expect(list.map((s) => s.name)).toEqual(ALL);
      expect(list[0]!.payloadSchema).toEqual(chat.payloadSchema);
    });
  });
});

describe('apply add_evidence', () => {
  it('binds $name for evidence on facts, and ids work numerically across batches', async () => {
    await withDb(async ({ pool, run }) => {
      const r = await run(
        { op: 'create_relation_type', name: 'knows', description: 'd', directed: true },
        { op: 'create_entity', key: 'al' },
        { op: 'add_evidence', source: 'chat', payload: { text: 'hi' }, as: 'e1' },
        { op: 'add_property', entity: 'bob', property: 'nickname', value: 'Bobby', evidence: '$e1' },
        { op: 'add_relation', type: 'knows', from: 'bob', to: 'al', evidence: '$e1' },
      );
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      const e = r.results[2] as { id: number; as: string };
      expect(e).toEqual({ id: expect.any(Number), as: 'e1' });
      const p = await pool.query(`SELECT evidence_id FROM property_version WHERE value = '"Bobby"'`);
      expect(Number(p.rows[0].evidence_id)).toBe(e.id);
      const rel = await pool.query('SELECT evidence_id FROM relation');
      expect(Number(rel.rows[0].evidence_id)).toBe(e.id);
      const r2 = await run({ op: 'add_property', entity: 'bob', property: 'nickname', value: 'B2', evidence: e.id });
      expect(r2.ok).toBe(true);
    });
  });

  it('a failed batch rolls back the evidence insert', async () => {
    await withDb(async ({ pool, run }) => {
      const r = await run(
        { op: 'add_evidence', source: 'chat', payload: { text: 'a' } },
        { op: 'add_property', entity: 'nobody', property: 'nickname', value: 'x' },
      );
      expect(r).toMatchObject({ ok: false, error: { op_index: 1 } });
      expect((await pool.query('SELECT 1 FROM evidence_log')).rows).toHaveLength(0);
    });
  });

  it('errors', async () => {
    await withDb(async ({ run }) => {
      const r = await run(
        { op: 'add_evidence', source: 'chat', payload: { text: 'a' }, as: 'e1' },
        { op: 'add_property', entity: '$e1', property: 'nickname', value: 'x' },
      );
      expect(r).toMatchObject({ ok: false, error: { op_index: 1, code: 'unknown_ref' } });
      const m = await run({ op: 'add_evidence', source: 'chat' });
      expect(m).toMatchObject({ ok: false, error: { op_index: 0, code: 'invalid_param' } });
      const s = await run({ op: 'add_evidence', payload: {} });
      expect(s).toMatchObject({ ok: false, error: { code: 'invalid_param' } });
    });
  });
});

describe('query evidence', () => {
  it('list_evidence_sources and get_evidence', async () => {
    await withDb(async ({ run, q }) => {
      const r = await run({ op: 'add_evidence', source: 'chat', payload: { text: 'hi' } });
      if (!r.ok) throw new Error('setup failed');
      const id = (r.results[0] as { id: number }).id;
      const l = await q({ op: 'list_evidence_sources' });
      if (!l.ok) throw new Error(JSON.stringify(l.error));
      const rows = (l.results[0] as { rows: { name: string; payload_schema: unknown }[] }).rows;
      expect(rows.map((x) => x.name)).toEqual(ALL);
      expect(rows[0]!.payload_schema).toEqual(chat.payloadSchema);
      const g = await q({ op: 'get_evidence', id });
      if (!g.ok) throw new Error(JSON.stringify(g.error));
      expect(g.results[0]).toEqual({
        id,
        source: 'chat',
        payload: { text: 'hi' },
        created_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/),
        purged_at: null,
        pinned: false,
      });
      expect(await q({ op: 'get_evidence', id: 999 })).toMatchObject({ ok: false, error: { code: 'not_found' } });
      expect(await q({ op: 'get_evidence', id: 0 })).toMatchObject({ ok: false, error: { code: 'invalid_param' } });
    });
  });
});

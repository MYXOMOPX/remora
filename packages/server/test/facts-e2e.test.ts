import corePlugin from '@remora/core-plugin';
import { describe, expect, it } from 'vitest';
import { startRemora, type RemoraApp } from '../src/app.js';
import type { Importer } from '../src/plugins/registry.js';
import { createTestDb } from './helpers/testDb.js';

const importer: Importer = async (spec) => {
  if (spec === '@remora/core-plugin') return corePlugin;
  throw new Error(`cannot import ${spec}`);
};

async function withApp(fn: (app: RemoraApp) => Promise<void>): Promise<void> {
  const { url, drop } = await createTestDb();
  const app = await startRemora({ databaseUrl: url, importer });
  try {
    await fn(app);
  } finally {
    await app.close();
    await drop();
  }
}

type Row = Record<string, unknown>;

async function write(app: RemoraApp, ...ops: unknown[]): Promise<Row[]> {
  const r = await app.apply({ ops });
  if (!r.ok) throw new Error(`apply failed: ${JSON.stringify(r.error)}`);
  return r.results as Row[];
}

async function read(app: RemoraApp, ...ops: unknown[]): Promise<{ rows: Row[]; total?: number }[]> {
  const r = await app.query({ ops });
  if (!r.ok) throw new Error(`query failed: ${JSON.stringify(r.error)}`);
  return r.results as { rows: Row[]; total?: number }[];
}

async function setup(app: RemoraApp): Promise<void> {
  await write(
    app,
    { op: 'create_entity', key: 'bob' },
    { op: 'create_entity', key: 'carl' },
    { op: 'create_entity', key: 'google' },
    { op: 'create_property_type', name: 'job_title', description: 'Job title.', value_type: 'text', single_valued: true },
    { op: 'create_property_type', name: 'nickname', description: 'Nickname.', value_type: 'text', single_valued: false },
    { op: 'create_property_type', name: 'level', description: 'Level.', value_type: 'number', single_valued: true },
    { op: 'create_relation_type', name: 'works_at', description: 'Employment.', directed: true },
    { op: 'create_relation_type', name: 'manages', description: 'Management.', directed: true },
    { op: 'create_relation_type', name: 'friend_of', description: 'Friendship.', directed: false },
  );
}

const gd = (at: number) => ({ axis: 'game_day', at });

describe('facts end to end (startRemora + core plugin)', () => {
  it('job history: Junior 292, Senior 300, ended 310', async () => {
    await withApp(async (app) => {
      await setup(app);
      await write(
        app,
        { op: 'replace_property', entity: 'bob', property: 'job_title', value: 'Junior', time: gd(292) },
        { op: 'replace_property', entity: 'bob', property: 'job_title', value: 'Senior', time: gd(300) },
        { op: 'end_property', entity: 'bob', property: 'job_title', time: gd(310) },
      );
      const [h, at] = await read(
        app,
        { op: 'property_history', entity: 'bob', property: 'job_title', axis: 'game_day' },
        { op: 'property_at', entity: 'bob', property: 'job_title', when: gd(305) },
      );
      expect(h!.rows.map((r) => [r.value, r.time])).toEqual([
        ['Junior', { axis: 'game_day', from: 292, to: 300 }],
        ['Senior', { axis: 'game_day', from: 300, to: 310 }],
      ]);
      expect(at!.rows.map((r) => r.value)).toEqual(['Senior']);
      const [after] = await read(app, { op: 'property_at', entity: 'bob', property: 'job_title', when: gd(310) });
      expect(after!.rows).toEqual([]);
    });
  });

  it('nicknames are multi-valued and timeless', async () => {
    await withApp(async (app) => {
      await setup(app);
      await write(
        app,
        { op: 'add_property', entity: 'bob', property: 'nickname', value: 'Bobby' },
        { op: 'add_property', entity: 'bob', property: 'nickname', value: 'Rob' },
      );
      const [r] = await read(app, { op: 'property_at', entity: 'bob', property: 'nickname', when: gd(1) });
      expect(r!.rows.map((x) => x.value).sort()).toEqual(['Bobby', 'Rob']);
      expect(r!.rows.every((x) => x.time === null)).toBe(true);
    });
  });

  it('one relation on two axes shares relation_id; real axis stored as epoch seconds and read back as ISO', async () => {
    await withApp(async (app) => {
      await setup(app);
      const [res] = await write(app, {
        op: 'add_relation',
        type: 'works_at',
        from: 'bob',
        to: 'google',
        time: [
          { axis: 'game_day', from: 292, to: 306 },
          { axis: 'real', from: '2026-10-01T00:00:00Z', to: '2026-10-20T00:00:00Z' },
        ],
      });
      expect(res!.ids).toHaveLength(2);

      const stored = await app.pool.query(
        `SELECT lower(time_span)::text AS lo, count(*) OVER () AS n, relation_id::text AS rid
           FROM relation r JOIN time_axis a ON a.id = r.time_axis WHERE a.name = 'real'`,
      );
      expect(stored.rows[0].lo).toBe('1790812800');

      const [h] = await read(app, { op: 'relation_history', entity: 'bob', relation_types: ['works_at'] });
      expect(h!.total).toBe(2);
      expect(new Set(h!.rows.map((r) => r.relation_id)).size).toBe(1);
      const real = h!.rows.find((r) => (r.time as { axis: string }).axis === 'real')!;
      expect(real.time).toEqual({
        axis: 'real',
        from: '2026-10-01T00:00:00.000Z',
        to: '2026-10-20T00:00:00.000Z',
      });
      const day = h!.rows.find((r) => (r.time as { axis: string }).axis === 'game_day')!;
      expect(day.time).toEqual({ axis: 'game_day', from: 292, to: 306 });

      const [inGame] = await read(app, {
        op: 'relation_history',
        entity: 'google',
        direction: 'in',
        when: gd(300),
      });
      expect(inGame!.rows).toHaveLength(1);
      const [outGame] = await read(app, { op: 'relation_history', entity: 'google', direction: 'in', when: gd(310) });
      expect(outGame!.rows).toHaveLength(0);
    });
  });

  it('end_relation by selector closes an open relation', async () => {
    await withApp(async (app) => {
      await setup(app);
      await write(
        app,
        { op: 'add_relation', type: 'manages', from: 'bob', to: 'carl', time: { axis: 'game_day', from: 300 } },
        { op: 'end_relation', type: 'manages', from: 'bob', to: 'carl', time: gd(305) },
      );
      const [h] = await read(app, { op: 'relation_history', entity: 'bob', relation_types: ['manages'] });
      expect(h!.rows.map((r) => r.time)).toEqual([{ axis: 'game_day', from: 300, to: 305 }]);
    });
  });

  it('story axis value round-trips with defaults filled in', async () => {
    await withApp(async (app) => {
      await setup(app);
      await write(app, {
        op: 'add_property',
        entity: 'bob',
        property: 'level',
        value: 1,
        time: { axis: 'story', from: { tome: 10, chapter: 5 } },
      });
      const [h] = await read(app, { op: 'property_history', entity: 'bob', property: 'level' });
      expect(h!.rows[0]!.time).toEqual({ axis: 'story', from: { tome: 10, chapter: 5, scene: 0 } });
    });
  });

  it('correction in one batch (retract + add) and retracted rows visible on request (Review Focus 3)', async () => {
    await withApp(async (app) => {
      await setup(app);
      await write(app, {
        op: 'add_property',
        entity: 'bob',
        property: 'job_title',
        value: 'Junoir',
        time: { axis: 'game_day', from: 292 },
      });
      const [before] = await read(app, { op: 'property_history', entity: 'bob', property: 'job_title' });
      const wrongId = before!.rows[0]!.id;

      // adding an overlapping value without retracting first conflicts
      const bad = await app.apply({
        ops: [{ op: 'add_property', entity: 'bob', property: 'job_title', value: 'Junior', time: { axis: 'game_day', from: 292 } }],
      });
      expect(bad.ok).toBe(false);

      await write(
        app,
        { op: 'retract_property', id: wrongId },
        { op: 'add_property', entity: 'bob', property: 'job_title', value: 'Junior', time: { axis: 'game_day', from: 292 } },
      );
      const [now, all] = await read(
        app,
        { op: 'property_history', entity: 'bob', property: 'job_title' },
        { op: 'property_history', entity: 'bob', property: 'job_title', include_retracted: true },
      );
      expect(now!.rows.map((r) => r.value)).toEqual(['Junior']);
      expect(all!.rows).toHaveLength(2);
      const retracted = all!.rows.find((r) => r.id === wrongId)!;
      expect(retracted.value).toBe('Junoir');
      expect(typeof retracted.retracted_at).toBe('string');
    });
  });

  it('undirected relations work from either endpoint (Review Focus 5)', async () => {
    await withApp(async (app) => {
      await setup(app);
      await write(app, {
        op: 'add_relation',
        type: 'friend_of',
        from: 'bob',
        to: 'carl',
        time: { axis: 'game_day', from: 1 },
      });
      for (const entity of ['bob', 'carl']) {
        const [h] = await read(app, { op: 'relation_history', entity, direction: 'in' });
        expect(h!.rows).toHaveLength(1);
      }
      // selector given in reverse order
      await write(app, { op: 'end_relation', type: 'friend_of', from: 'carl', to: 'bob', time: gd(50) });
      const [h] = await read(app, { op: 'relation_history', entity: 'carl', when: gd(60) });
      expect(h!.rows).toHaveLength(0);
      await write(app, { op: 'retract_relation', type: 'friend_of', from: 'carl', to: 'bob' });
      const [live] = await read(app, { op: 'relation_history', entity: 'bob' });
      expect(live!.rows).toHaveLength(0);
      const [hist] = await read(app, { op: 'relation_history', entity: 'bob', include_retracted: true });
      expect(hist!.rows).toHaveLength(1);
    });
  });
});

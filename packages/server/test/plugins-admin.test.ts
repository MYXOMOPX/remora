import corePlugin from '@remora/core-plugin';
import { definePlugin, type PluginDef } from '@remora/sdk';
import { describe, expect, it } from 'vitest';
import { startRemora, type RemoraApp } from '../src/app.js';
import type { Importer } from '../src/plugins/registry.js';
import { fakeSource, intAxis } from './helpers/axes.js';
import { createTestDb } from './helpers/testDb.js';

const p2 = definePlugin<{ n: number }>({
  name: 'p2',
  configSchema: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'], additionalProperties: false },
  defaultConfig: { n: 1 },
  setup: () => ({ timeAxes: [intAxis('p2_day')] }),
});

const p4 = definePlugin<{ n: number }>({
  ...p2,
  name: 'p4',
  setup: () => ({ evidenceSources: [fakeSource('p4_src')] }),
});

const mods: Record<string, unknown> = { '@remora/core-plugin': corePlugin, p2, p4 };
const importer: Importer = async (spec) => {
  if (spec in mods) return mods[spec];
  throw new Error(`cannot import ${spec}`);
};

async function withApp(fn: (app: RemoraApp, url: string) => Promise<void>): Promise<void> {
  const { url, drop } = await createTestDb();
  const app = await startRemora({ databaseUrl: url, importer });
  try {
    await fn(app, url);
  } finally {
    await app.close();
    await drop();
  }
}

async function factOn(app: RemoraApp, axis: string): Promise<void> {
  const r = await app.apply({
    ops: [
      { op: 'create_entity', key: 'bob' },
      { op: 'create_property_type', name: 'age', description: 'Age.', value_type: 'text', single_valued: true },
      { op: 'add_property', entity: 'bob', property: 'age', value: 'x', time: { axis, from: 1 } },
    ],
  });
  expect(r.ok).toBe(true);
}

const fail = async (p: Promise<unknown>): Promise<{ code: string; details?: any }> =>
  p.then(
    () => {
      throw new Error('expected rejection');
    },
    (e) => e,
  );

describe('listPlugins', () => {
  it('core plugin is ok with its axes and sources', async () => {
    await withApp(async (app) => {
      const rows = await app.listPlugins();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ name: 'remora-core', status: 'ok', axes: ['game_day', 'real', 'story'], sources: ['chat_message'] });
      expect(rows[0]!.error).toBeUndefined();
    });
  });

  it('shows pending_restart for a plugin added after start and degraded for a broken one', async () => {
    await withApp(async (app, url) => {
      await app.addPlugin({ package: 'p2' });
      const rows = await app.listPlugins();
      expect(rows.map((r) => [r.name, r.status])).toEqual([
        ['remora-core', 'ok'],
        ['p2', 'pending_restart'],
      ]);
      await app.pool.query(`INSERT INTO plugin (name, package, config) VALUES ('ghost', 'ghost-pkg', '{}')`);
      const again = await startRemora({ databaseUrl: url, importer });
      try {
        const r = await again.listPlugins();
        const byName = Object.fromEntries(r.map((x) => [x.name, x]));
        expect(byName.p2!.status).toBe('ok');
        expect(byName.p2!.axes).toEqual(['p2_day']);
        expect(byName.ghost!.status).toBe('degraded');
        expect(byName.ghost!.error).toMatch(/ghost-pkg/);
      } finally {
        await again.close();
      }
    });
  });
});

describe('setPluginConfig', () => {
  it('rejects an invalid config, unknown plugin and a config that breaks setup', async () => {
    await withApp(async (app) => {
      expect((await fail(app.setPluginConfig({ name: 'remora-core', config: { timeAxes: 5 } }))).code).toBe('invalid_config');
      expect((await fail(app.setPluginConfig({ name: 'nope', config: {} }))).code).toBe('not_found');
      const e = await fail(app.setPluginConfig({ name: 'remora-core', config: { timeAxes: [{ nope: 1 }] } }));
      expect(e.code).toBe('invalid_config');
      const { rows } = await app.pool.query(`SELECT config FROM plugin WHERE name = 'remora-core'`);
      expect(rows[0].config.timeAxes).toHaveLength(3);
    });
  });

  it('stores a config on an empty database; a restart loads it', async () => {
    await withApp(async (app, url) => {
      const cfg = { timeAxes: [{ name: 'tick', kind: 'integer', description: 'Ticks.' }] };
      const r = await app.setPluginConfig({ name: 'remora-core', config: cfg });
      expect(r).toEqual({ name: 'remora-core', restartRequired: true });
      const again = await startRemora({ databaseUrl: url, importer });
      try {
        expect(again.registry.getAxis('tick').name).toBe('tick');
      } finally {
        await again.close();
      }
    });
  });

  it('requires confirmation once an axis has data', async () => {
    await withApp(async (app) => {
      await factOn(app, 'game_day');
      const cfg = { timeAxes: [{ name: 'game_day', kind: 'integer', description: 'Days.' }] };
      const e = await fail(app.setPluginConfig({ name: 'remora-core', config: cfg }));
      expect(e.code).toBe('invalid_param');
      expect(e.details.reason).toBe('confirm_required');
      expect(e.details.affected.axes).toContain('game_day');
      const ok = await app.setPluginConfig({ name: 'remora-core', config: cfg, confirm: true });
      expect(ok.restartRequired).toBe(true);
      const { rows } = await app.pool.query(`SELECT config FROM plugin WHERE name = 'remora-core'`);
      expect(rows[0].config).toEqual(cfg);
    });
  });

  it('checks the setup result against names owned by other plugins', async () => {
    await withApp(async (app) => {
      await app.addPlugin({ package: 'p2' });
      const clash: PluginDef<any> = { ...p2, name: 'p2', setup: () => ({ timeAxes: [intAxis('real')] }) };
      mods.p2 = clash;
      try {
        expect((await fail(app.setPluginConfig({ name: 'p2', config: { n: 2 } }))).code).toBe('name_taken');
      } finally {
        mods.p2 = p2;
      }
    });
  });
});

describe('removePlugin', () => {
  it('refuses core and unknown plugins', async () => {
    await withApp(async (app) => {
      expect((await fail(app.removePlugin('remora-core'))).code).toBe('invalid_plugin');
      expect((await fail(app.removePlugin('nope'))).code).toBe('not_found');
    });
  });

  it('refuses a plugin whose axis has data, removes one without', async () => {
    await withApp(async (app, url) => {
      await app.addPlugin({ package: 'p2' });
      const again = await startRemora({ databaseUrl: url, importer });
      try {
        await factOn(again, 'p2_day');
        const e = await fail(again.removePlugin('p2'));
        expect(e.code).toBe('invalid_param');
        expect(e.details.reason).toBe('has_data');
        expect(e.details.axes).toEqual(['p2_day']);
      } finally {
        await again.close();
      }
      await app.pool.query('DELETE FROM property_version');
      expect(await app.removePlugin('p2')).toEqual({ name: 'p2', restartRequired: true });
      const left = await app.pool.query(
        `SELECT (SELECT count(*) FROM plugin WHERE name = 'p2')::int AS p,
                (SELECT count(*) FROM time_axis WHERE name = 'p2_day')::int AS a`,
      );
      expect(left.rows[0]).toEqual({ p: 0, a: 0 });
    });
  });
});

describe('plugins with evidence sources', () => {
  async function withP4(fn: (app: RemoraApp) => Promise<void>): Promise<void> {
    await withApp(async (app, url) => {
      await app.addPlugin({ package: 'p4' });
      const again = await startRemora({ databaseUrl: url, importer });
      try {
        await fn(again);
      } finally {
        await again.close();
      }
    });
  }
  const addRow = (app: RemoraApp) =>
    app.apply({ ops: [{ op: 'add_evidence', source: 'p4_src', payload: { text: 'hi' } }] });

  it('an evidence row makes set_plugin_config need confirmation and blocks removal', async () => {
    await withP4(async (app) => {
      expect((await addRow(app)).ok).toBe(true);
      const e = await fail(app.setPluginConfig({ name: 'p4', config: { n: 2 } }));
      expect(e.details.reason).toBe('confirm_required');
      expect(e.details.affected).toEqual({ axes: [], sources: ['p4_src'] });
      const r = await fail(app.removePlugin('p4'));
      expect(r.details.reason).toBe('has_data');
      expect(r.details.sources).toEqual(['p4_src']);
    });
  });

  it('removal deletes the plugin, its sources and axes when there is no data', async () => {
    await withP4(async (app) => {
      expect(await app.removePlugin('p4')).toEqual({ name: 'p4', restartRequired: true });
      const left = await app.pool.query(
        `SELECT (SELECT count(*) FROM plugin WHERE name = 'p4')::int AS p,
                (SELECT count(*) FROM evidence_source WHERE name = 'p4_src')::int AS s`,
      );
      expect(left.rows[0]).toEqual({ p: 0, s: 0 });
    });
  });

  it('setup cannot alter the stored config', async () => {
    await withP4(async (app) => {
      mods.p4 = { ...p4, setup: (c: { n: number }) => { c.n = 99; return {}; } };
      try {
        await app.setPluginConfig({ name: 'p4', config: { n: 3 } });
      } finally {
        mods.p4 = p4;
      }
      const { rows } = await app.pool.query(`SELECT config FROM plugin WHERE name = 'p4'`);
      expect(rows[0].config).toEqual({ n: 3 });
    });
  });
});

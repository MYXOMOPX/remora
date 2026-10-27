import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { definePlugin, RemoraError, type PluginDef, type TimeAxisDef } from '@remora/sdk';
import { runMigrations } from '../src/db/migrate.js';
import { addPlugin, loadPlugins, type Importer } from '../src/plugins/registry.js';
import { fakeSource } from './helpers/axes.js';
import { createTestDb } from './helpers/testDb.js';

async function withDb(fn: (pool: pg.Pool) => Promise<void>): Promise<void> {
  const { pool, drop } = await createTestDb();
  try {
    await runMigrations(pool);
    await fn(pool);
  } finally {
    await drop();
  }
}

function axis(name: string, description = 'День игры'): TimeAxisDef {
  return {
    name,
    description,
    valueSchema: { type: 'integer' },
    example: 3,
    encode: (v) => BigInt(v as number),
    decode: (n) => Number(n),
  };
}

const schema = {
  type: 'object',
  properties: { n: { type: 'integer' } },
  required: ['n'],
  additionalProperties: false,
};

function plug(
  name: string,
  axes: string[],
  extra: Partial<PluginDef<{ n: number }>> = {},
): PluginDef<{ n: number }> {
  return definePlugin<{ n: number }>({
    name,
    configSchema: schema,
    defaultConfig: { n: 1 },
    setup: () => ({ timeAxes: axes.map((a) => axis(a)) }),
    ...extra,
  });
}

function importerOf(fakes: Record<string, unknown>): Importer {
  return async (spec) => {
    if (!(spec in fakes)) throw new Error(`cannot import ${spec}`);
    return fakes[spec];
  };
}

async function insertPlugin(pool: pg.Pool, name: string, config: unknown = { n: 1 }): Promise<number> {
  const r = await pool.query<{ id: number }>(
    `INSERT INTO plugin (name, package, config) VALUES ($1, $1, $2::jsonb) RETURNING id`,
    [name, JSON.stringify(config)],
  );
  return r.rows[0]!.id;
}

const code = (c: string) => expect.objectContaining({ code: c });

describe('plugin registry', () => {
  it('addPlugin stores name and default config', async () => {
    await withDb(async (pool) => {
      const importer = importerOf({ 'fake-a': plug('fake-a', ['day']) });
      const r = await addPlugin(pool, { package: 'fake-a' }, importer);
      expect(r.name).toBe('fake-a');
      const { rows } = await pool.query('SELECT name, package, config FROM plugin');
      expect(rows).toEqual([{ name: 'fake-a', package: 'fake-a', config: { n: 1 } }]);
    });
  });

  it('addPlugin rejects a duplicate name', async () => {
    await withDb(async (pool) => {
      const importer = importerOf({ 'fake-a': plug('fake-a', []) });
      await addPlugin(pool, { package: 'fake-a' }, importer);
      await expect(addPlugin(pool, { package: 'fake-a' }, importer)).rejects.toSatisfy(
        (e) => e instanceof RemoraError && e.code === 'name_taken',
      );
    });
  });

  it('addPlugin rejects an invalid defaultConfig', async () => {
    await withDb(async (pool) => {
      const bad = plug('fake-a', [], { defaultConfig: { n: 'x' } as never });
      await expect(
        addPlugin(pool, { package: 'fake-a' }, importerOf({ 'fake-a': bad })),
      ).rejects.toMatchObject({ code: 'invalid_config' });
    });
  });

  it('addPlugin rejects a definition without setup', async () => {
    await withDb(async (pool) => {
      const bad = { name: 'fake-a', configSchema: schema, defaultConfig: { n: 1 } };
      await expect(
        addPlugin(pool, { package: 'fake-a' }, importerOf({ 'fake-a': bad })),
      ).rejects.toMatchObject({ code: 'invalid_plugin' });
    });
  });

  it('loadPlugins registers axes and copies description/schema/example into time_axis', async () => {
    await withDb(async (pool) => {
      await insertPlugin(pool, 'fake-a');
      const reg = await loadPlugins(pool, { importer: importerOf({ 'fake-a': plug('fake-a', ['day']) }) });
      const { rows } = await pool.query('SELECT name, description, value_schema, example FROM time_axis');
      expect(rows).toEqual([
        { name: 'day', description: 'День игры', value_schema: { type: 'integer' }, example: 3 },
      ]);
      expect(reg.getAxis('day').def.encode(5)).toBe(5n);
      expect(reg.status()).toEqual([{ name: 'fake-a', ok: true }]);
    });
  });

  it('loadPlugins registers evidence sources', async () => {
    await withDb(async (pool) => {
      await insertPlugin(pool, 'fake-a');
      const p = plug('fake-a', [], {
        setup: () => ({
          evidenceSources: [
            {
              name: 'chat',
              description: 'Чат',
              payloadSchema: { type: 'object' },
              ingest: (payload) => ({ payload }),
              planRetention: () => [],
            },
          ],
        }),
      });
      await loadPlugins(pool, { importer: importerOf({ 'fake-a': p }) });
      const { rows } = await pool.query('SELECT name, description, payload_schema FROM evidence_source');
      expect(rows).toEqual([{ name: 'chat', description: 'Чат', payload_schema: { type: 'object' } }]);
    });
  });

  it('loadPlugins is idempotent and updates the description on restart', async () => {
    await withDb(async (pool) => {
      await insertPlugin(pool, 'fake-a');
      await loadPlugins(pool, { importer: importerOf({ 'fake-a': plug('fake-a', ['day']) }) });
      const p2 = plug('fake-a', [], {
        setup: () => ({ timeAxes: [axis('day', 'Новое описание')] }),
      });
      await loadPlugins(pool, { importer: importerOf({ 'fake-a': p2 }) });
      const { rows } = await pool.query('SELECT name, description FROM time_axis');
      expect(rows).toEqual([{ name: 'day', description: 'Новое описание' }]);
    });
  });

  it('a plugin whose setup throws is unavailable; others keep working; error is logged', async () => {
    await withDb(async (pool) => {
      await insertPlugin(pool, 'good');
      const badId = await insertPlugin(pool, 'bad');
      const badAxisId = (
        await pool.query<{ id: number }>(
          `INSERT INTO time_axis (name, plugin_id, description, value_schema, example)
           VALUES ('bad_axis', $1, 'x', '{"type":"integer"}', '1') RETURNING id`,
          [badId],
        )
      ).rows[0]!.id;
      const bad = plug('bad', ['bad_axis'], {
        setup: () => {
          throw new Error('boom');
        },
      });
      const logger = { warn: vi.fn(), error: vi.fn() };
      const reg = await loadPlugins(pool, {
        importer: importerOf({ good: plug('good', ['good_axis']), bad }),
        logger,
      });
      expect(reg.status()).toEqual([
        { name: 'good', ok: true },
        { name: 'bad', ok: false, error: expect.stringContaining('boom') },
      ]);
      expect(logger.error).toHaveBeenCalled();
      expect(reg.getAxis('good_axis').def.name).toBe('good_axis');
      expect(() => reg.getAxis('bad_axis')).toThrow(code('axis_unavailable'));
      expect(() => reg.getAxisById(badAxisId)).toThrow(code('axis_unavailable'));
    });
  });

  it('a plugin with invalid stored config is unavailable', async () => {
    await withDb(async (pool) => {
      await insertPlugin(pool, 'fake-a', { n: 'nope' });
      const logger = { warn: vi.fn(), error: vi.fn() };
      const reg = await loadPlugins(pool, {
        importer: importerOf({ 'fake-a': plug('fake-a', ['day']) }),
        logger,
      });
      expect(reg.status()).toEqual([
        { name: 'fake-a', ok: false, error: expect.stringContaining('invalid_config') },
      ]);
      expect(logger.error).toHaveBeenCalled();
    });
  });

  it('a plugin that fails to import is unavailable', async () => {
    await withDb(async (pool) => {
      await insertPlugin(pool, 'ghost');
      const logger = { warn: vi.fn(), error: vi.fn() };
      const reg = await loadPlugins(pool, { importer: importerOf({}), logger });
      expect(reg.status()).toEqual([
        { name: 'ghost', ok: false, error: expect.stringContaining('cannot import') },
      ]);
    });
  });

  it('a failing remora-core aborts startup instead of degrading', async () => {
    await withDb(async (pool) => {
      await insertPlugin(pool, 'remora-core');
      await expect(loadPlugins(pool, { importer: importerOf({}) })).rejects.toMatchObject({
        code: 'invalid_plugin',
      });
      const boom = plug('remora-core', [], {
        setup: () => {
          throw new Error('boom');
        },
      });
      await expect(
        loadPlugins(pool, { importer: importerOf({ 'remora-core': boom }) }),
      ).rejects.toMatchObject({ code: 'invalid_plugin' });
    });
  });

  it('a failing upsert leaves no partial rows and degrades only that plugin', async () => {
    await withDb(async (pool) => {
      await insertPlugin(pool, 'p1');
      await insertPlugin(pool, 'p2');
      const logger = { warn: vi.fn(), error: vi.fn() };
      // the second axis description cannot be stored (NUL in jsonb), after the first one is valid
      const p2 = plug('p2', [], { setup: () => ({ timeAxes: [axis('good_axis'), axis('bad_axis', 'nul   byte')] }) });
      const reg = await loadPlugins(pool, { importer: importerOf({ p1: plug('p1', ['day']), p2 }), logger });
      expect(reg.status()).toEqual([
        { name: 'p1', ok: true },
        { name: 'p2', ok: false, error: expect.any(String) },
      ]);
      const { rows } = await pool.query(`SELECT name FROM time_axis ORDER BY name`);
      expect(rows).toEqual([{ name: 'day' }]);
      expect(reg.getAxis('day').name).toBe('day');
      expect(() => reg.getAxis('good_axis')).toThrow(code('unknown_axis'));
    });
  });

  it('a non-core plugin declaring an axis owned by another plugin is degraded with name_taken', async () => {
    await withDb(async (pool) => {
      await insertPlugin(pool, 'p1');
      await insertPlugin(pool, 'p2');
      const logger = { warn: vi.fn(), error: vi.fn() };
      const reg = await loadPlugins(pool, {
        importer: importerOf({ p1: plug('p1', ['day']), p2: plug('p2', ['day', 'other']) }),
        logger,
      });
      expect(reg.status()).toEqual([
        { name: 'p1', ok: true },
        { name: 'p2', ok: false, error: expect.stringContaining('name_taken') },
      ]);
      expect(reg.getAxis('day').def.name).toBe('day');
      const owner = await pool.query(
        `SELECT p.name FROM time_axis a JOIN plugin p ON p.id = a.plugin_id WHERE a.name = 'day'`,
      );
      expect(owner.rows).toEqual([{ name: 'p1' }]);
      const { rows } = await pool.query(
        `SELECT a.name FROM time_axis a JOIN plugin p ON p.id = a.plugin_id WHERE p.name = 'p2'`,
      );
      expect(rows).toEqual([]);
      expect(() => reg.getAxis('other')).toThrow(code('unknown_axis'));
    });
  });

  it('a package whose name differs from its row is degraded with invalid_plugin', async () => {
    await withDb(async (pool) => {
      await insertPlugin(pool, 'p2');
      await pool.query(
        `INSERT INTO time_axis (name, plugin_id, description, value_schema, example)
         SELECT 'old_axis', id, 'x', '{"type":"integer"}', '1' FROM plugin WHERE name = 'p2'`,
      );
      const reg = await loadPlugins(pool, {
        importer: importerOf({ p2: plug('other', ['new_axis']) }),
        logger: { warn: vi.fn(), error: vi.fn() },
      });
      expect(reg.status()).toEqual([
        { name: 'p2', ok: false, error: expect.stringContaining('invalid_plugin') },
      ]);
      expect(() => reg.getAxis('old_axis')).toThrow(code('axis_unavailable'));
      expect(() => reg.getAxis('new_axis')).toThrow(code('unknown_axis'));
    });
  });

  it('duplicate axis names inside one setup result are invalid_plugin', async () => {
    await withDb(async (pool) => {
      await insertPlugin(pool, 'p3');
      const reg = await loadPlugins(pool, {
        importer: importerOf({ p3: plug('p3', ['x', 'x']) }),
        logger: { warn: vi.fn(), error: vi.fn() },
      });
      expect(reg.status()).toEqual([
        { name: 'p3', ok: false, error: expect.stringContaining('invalid_plugin') },
      ]);
      const { rows } = await pool.query('SELECT 1 FROM time_axis');
      expect(rows).toEqual([]);
    });
  });

  it('a core plugin declaring an axis owned by another plugin aborts with name_taken', async () => {
    await withDb(async (pool) => {
      await insertPlugin(pool, 'a');
      await insertPlugin(pool, 'remora-core');
      await expect(
        loadPlugins(pool, {
          importer: importerOf({ a: plug('a', ['day']), 'remora-core': plug('remora-core', ['day']) }),
        }),
      ).rejects.toMatchObject({ code: 'name_taken' });
    });
  });

  it('getAxis of a missing axis throws unknown_axis', async () => {
    await withDb(async (pool) => {
      const reg = await loadPlugins(pool, { importer: importerOf({}) });
      expect(() => reg.getAxis('nope')).toThrow(code('unknown_axis'));
    });
  });

  it('getAxisById returns the served axis, rejects unknown ids', async () => {
    await withDb(async (pool) => {
      await insertPlugin(pool, 'fake-a');
      const reg = await loadPlugins(pool, { importer: importerOf({ 'fake-a': plug('fake-a', ['day']) }) });
      const day = reg.getAxis('day');
      expect(day.name).toBe('day');
      expect(reg.getAxisById(day.id)).toEqual(day);
      expect(() => reg.getAxisById(9999)).toThrow(code('unknown_axis'));
    });
  });

  it('getAxisById of an axis the plugin no longer declares is axis_unavailable', async () => {
    await withDb(async (pool) => {
      await insertPlugin(pool, 'fake-a');
      const r1 = await loadPlugins(pool, { importer: importerOf({ 'fake-a': plug('fake-a', ['day']) }) });
      const id = r1.getAxis('day').id;
      const r2 = await loadPlugins(pool, { importer: importerOf({ 'fake-a': plug('fake-a', []) }) });
      expect(() => r2.getAxisById(id)).toThrow(code('axis_unavailable'));
    });
  });

  describe('malformed setup() results degrade the plugin', () => {
    const goodAxis = axis('x');
    const goodSource = {
      name: 'src', description: 'd', payloadSchema: { type: 'object' },
      ingest: (payload: unknown) => ({ payload }), planRetention: () => [],
    };
    const bads: Record<string, () => unknown> = {
      'axis without description': () => ({ timeAxes: [{ ...goodAxis, description: undefined }] }),
      'axis with empty description': () => ({ timeAxes: [{ ...goodAxis, description: '' }] }),
      'axis without example': () => ({ timeAxes: [{ ...goodAxis, example: undefined }] }),
      'axis without name': () => ({ timeAxes: [{ ...goodAxis, name: '' }] }),
      'axis with non-object valueSchema': () => ({ timeAxes: [{ ...goodAxis, valueSchema: 'integer' }] }),
      'axis without encode': () => ({ timeAxes: [{ ...goodAxis, encode: undefined }] }),
      'axis without decode': () => ({ timeAxes: [{ ...goodAxis, decode: undefined }] }),
      'axis null entry': () => ({ timeAxes: [null] }),
      'timeAxes not an array': () => ({ timeAxes: 5 }),
      'evidenceSources not an array': () => ({ evidenceSources: {} }),
      'source without description': () => ({ evidenceSources: [{ ...goodSource, description: undefined }] }),
      'source with bad payloadSchema': () => ({ evidenceSources: [{ ...goodSource, payloadSchema: null }] }),
      'source with uncompilable payloadSchema': () => ({
        evidenceSources: [{ ...goodSource, payloadSchema: { type: 'nope' } }],
      }),
      'source without ingest': () => ({ evidenceSources: [{ ...goodSource, ingest: undefined }] }),
      'source without planRetention': () => ({ evidenceSources: [{ ...goodSource, planRetention: undefined }] }),
      'async setup (Promise)': () => Promise.resolve({ timeAxes: [goodAxis] }),
      'array result': () => [],
      'string result': () => 'nope',
    };

    for (const [label, mk] of Object.entries(bads)) {
      it(`${label}: non-core degrades, good plugin still loads`, async () => {
        await withDb(async (pool) => {
          await insertPlugin(pool, 'good');
          await insertPlugin(pool, 'bad');
          const bad = plug('bad', [], { setup: mk as never });
          const logger = { warn: vi.fn(), error: vi.fn() };
          const reg = await loadPlugins(pool, {
            importer: importerOf({ good: plug('good', ['good_axis']), bad }),
            logger,
          });
          expect(reg.status()).toEqual([
            { name: 'good', ok: true },
            { name: 'bad', ok: false, error: expect.stringContaining('invalid_plugin') },
          ]);
          expect(logger.error).toHaveBeenCalled();
          expect(reg.getAxis('good_axis').def.name).toBe('good_axis');
          const { rows } = await pool.query(`SELECT name FROM time_axis ORDER BY name`);
          expect(rows).toEqual([{ name: 'good_axis' }]);
        });
      });

      it(`${label}: aborts for remora-core`, async () => {
        await withDb(async (pool) => {
          await insertPlugin(pool, 'remora-core');
          const bad = plug('remora-core', [], { setup: mk as never });
          await expect(
            loadPlugins(pool, { importer: importerOf({ 'remora-core': bad }) }),
          ).rejects.toMatchObject({ code: 'invalid_plugin' });
        });
      });
    }
  });

  it('a non-core plugin with a malformed axis valueSchema is degraded (axis_unavailable)', async () => {
    await withDb(async (pool) => {
      const id = await insertPlugin(pool, 'badschema');
      await pool.query(
        `INSERT INTO time_axis (name, plugin_id, description, value_schema, example)
         VALUES ('broken', $1, 'x', '{"type":"integer"}', '1')`,
        [id],
      );
      const broken = plug('badschema', [], {
        setup: () => ({ timeAxes: [{ ...axis('broken'), valueSchema: { type: 'nonsense' } }] }),
      });
      const reg = await loadPlugins(pool, {
        importer: importerOf({ badschema: broken }),
        logger: { warn: vi.fn(), error: vi.fn() },
      });
      expect(reg.status()).toEqual([{ name: 'badschema', ok: false, error: expect.any(String) }]);
      expect(() => reg.getAxis('broken')).toThrow(code('axis_unavailable'));
    });
  });

  describe('evidence source lookup', () => {
    const withSources = (name: string, sources: unknown[]) =>
      plug(name, [], { setup: () => ({ evidenceSources: sources as never }) });

    it('getSource / listSources return served sources', async () => {
      await withDb(async (pool) => {
        await insertPlugin(pool, 'fake-a');
        const reg = await loadPlugins(pool, { importer: importerOf({ 'fake-a': withSources('fake-a', [fakeSource('chat')]) }) });
        const row = await pool.query<{ id: number }>(`SELECT id FROM evidence_source WHERE name = 'chat'`);
        const s = reg.getSource('chat');
        expect(s.name).toBe('chat');
        expect(s.id).toBe(row.rows[0]!.id);
        expect(s.def.ingest({ a: 1 })).toEqual({ payload: { a: 1 } });
        expect(reg.listSources().map((x) => x.name)).toEqual(['chat']);
        expect(() => reg.getSource('nope')).toThrow(code('unknown_source'));
      });
    });

    it('a source of a failed plugin is source_unavailable', async () => {
      await withDb(async (pool) => {
        const id = await insertPlugin(pool, 'bad');
        await pool.query(
          `INSERT INTO evidence_source (name, plugin_id, description, payload_schema) VALUES ('bad_src', $1, 'x', '{}')`,
          [id],
        );
        const bad = plug('bad', [], { setup: () => { throw new Error('boom'); } });
        const reg = await loadPlugins(pool, {
          importer: importerOf({ bad }),
          logger: { warn: vi.fn(), error: vi.fn() },
        });
        expect(() => reg.getSource('bad_src')).toThrow(code('source_unavailable'));
        expect(reg.listSources()).toEqual([]);
      });
    });

    it('a source no longer declared is source_unavailable', async () => {
      await withDb(async (pool) => {
        await insertPlugin(pool, 'fake-a');
        await loadPlugins(pool, { importer: importerOf({ 'fake-a': withSources('fake-a', [fakeSource('old_src')]) }) });
        const reg = await loadPlugins(pool, { importer: importerOf({ 'fake-a': withSources('fake-a', []) }) });
        expect(() => reg.getSource('old_src')).toThrow(code('source_unavailable'));
      });
    });

    it('an uncompilable payloadSchema degrades the plugin with invalid_plugin', async () => {
      await withDb(async (pool) => {
        await insertPlugin(pool, 'fake-a');
        const reg = await loadPlugins(pool, {
          importer: importerOf({ 'fake-a': withSources('fake-a', [fakeSource('s', { payloadSchema: { type: 'nope' } })]) }),
          logger: { warn: vi.fn(), error: vi.fn() },
        });
        expect(reg.status()).toEqual([
          { name: 'fake-a', ok: false, error: expect.stringContaining('invalid_plugin') },
        ]);
      });
    });
  });
});

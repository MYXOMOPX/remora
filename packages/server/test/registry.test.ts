import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { definePlugin, RemoraError, type PluginDef, type TimeAxisDef } from '@remora/sdk';
import { runMigrations } from '../src/db/migrate.js';
import { addPlugin, loadPlugins, type Importer } from '../src/plugins/registry.js';
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
      await pool.query(
        `INSERT INTO time_axis (name, plugin_id, description, value_schema, example)
         VALUES ('bad_axis', $1, 'x', '{"type":"integer"}', '1')`,
        [badId],
      );
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

  it('two plugins declaring the same axis name abort startup', async () => {
    await withDb(async (pool) => {
      await insertPlugin(pool, 'a');
      await insertPlugin(pool, 'b');
      await expect(
        loadPlugins(pool, { importer: importerOf({ a: plug('a', ['day']), b: plug('b', ['day']) }) }),
      ).rejects.toMatchObject({ code: 'name_taken' });
    });
  });

  it('getAxis of a missing axis throws unknown_axis', async () => {
    await withDb(async (pool) => {
      const reg = await loadPlugins(pool, { importer: importerOf({}) });
      expect(() => reg.getAxis('nope')).toThrow(code('unknown_axis'));
    });
  });
});

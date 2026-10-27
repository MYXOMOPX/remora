import { describe, expect, it, vi } from 'vitest';
import corePlugin from '@remora/core-plugin';
import { startRemora } from '../src/app.js';
import { mapPgError } from '../src/api/apply.js';
import { createEntity, findEntities } from '../src/services/entities.js';
import { createPropertyType, listPropertyTypes, listTimeAxes } from '../src/services/dictionaries.js';
import type { Importer } from '../src/plugins/registry.js';
import { createTestDb } from './helpers/testDb.js';

const importer: Importer = async (spec) => {
  if (spec === '@remora/core-plugin') return corePlugin;
  throw new Error(`cannot import ${spec}`);
};

async function withUrl(fn: (url: string) => Promise<void>): Promise<void> {
  const { url, drop } = await createTestDb();
  try {
    await fn(url);
  } finally {
    await drop();
  }
}

describe('startRemora', () => {
  it('starts on an empty database: migrates, registers remora-core and its axes', async () => {
    await withUrl(async (url) => {
      const app = await startRemora({ databaseUrl: url, importer });
      try {
        expect((await listTimeAxes(app.pool)).map((a) => a.name)).toEqual(['game_day', 'real', 'story']);
        expect(app.registry.getAxis('story').def.encode({ tome: 2, chapter: 3, scene: 1 })).toBe(2_003_001n);
      } finally {
        await app.close();
      }
    });
  });

  it('a second start reuses the database and does not duplicate the core plugin', async () => {
    await withUrl(async (url) => {
      await (await startRemora({ databaseUrl: url, importer })).close();
      const app = await startRemora({ databaseUrl: url, importer });
      try {
        const { rows } = await app.pool.query('SELECT count(*)::int AS n FROM plugin');
        expect(rows[0].n).toBe(1);
      } finally {
        await app.close();
      }
    });
  });

  it('entities and types work against the started app', async () => {
    await withUrl(async (url) => {
      const app = await startRemora({ databaseUrl: url, importer });
      try {
        await createEntity(app.pool, 'bob');
        await createPropertyType(app.pool, {
          name: 'Job Title',
          description: 'должность',
          valueType: 'text',
          singleValued: true,
        });
        expect((await findEntities(app.pool, { query: 'bo' })).rows.map((r) => r.key)).toEqual(['bob']);
        expect((await listPropertyTypes(app.pool)).map((t) => t.name)).toEqual(['job_title']);
      } finally {
        await app.close();
      }
    });
  });

  it('fails and releases the pool when the core plugin cannot load', async () => {
    await withUrl(async (url) => {
      const broken: Importer = async () => {
        throw new Error('boom');
      };
      await expect(startRemora({ databaseUrl: url, importer: broken })).rejects.toMatchObject({
        code: 'invalid_plugin',
      });
    });
  });

  it('starts without an importer: the core plugin is bundled', async () => {
    await withUrl(async (url) => {
      const app = await startRemora({ databaseUrl: url });
      try {
        expect((await listTimeAxes(app.pool)).map((a) => a.name)).toEqual(['game_day', 'real', 'story']);
      } finally {
        await app.close();
      }
    });
  });

  it('concurrent starts on one fresh database serialise on the startup lock', async () => {
    for (let i = 0; i < 3; i++) {
      await withUrl(async (url) => {
        const [a, b] = await Promise.all([startRemora({ databaseUrl: url }), startRemora({ databaseUrl: url })]);
        try {
          const mig = await a.pool.query('SELECT count(*)::int AS n FROM schema_migration');
          const plug = await a.pool.query('SELECT count(*)::int AS n FROM plugin');
          expect(mig.rows[0].n).toBe(2);
          expect(plug.rows[0].n).toBe(1);
        } finally {
          await a.close();
          await b.close();
        }
      });
    }
  });

  it('close() is idempotent', async () => {
    await withUrl(async (url) => {
      const app = await startRemora({ databaseUrl: url });
      await app.close();
      await expect(app.close()).resolves.toBeUndefined();
    });
  });

  it('statementTimeoutMs applies to pool queries (57014)', async () => {
    await withUrl(async (url) => {
      const app = await startRemora({ databaseUrl: url, statementTimeoutMs: 100 });
      try {
        await expect(app.pool.query('SELECT pg_sleep(1)')).rejects.toMatchObject({ code: '57014' });
      } finally {
        await app.close();
      }
    });
  });

  it('mapPgError maps 57014 to timeout', () => {
    expect(mapPgError({ code: '57014' })?.code).toBe('timeout');
  });

  it('fails on an unreachable database without hanging', async () => {
    const spy = vi.fn();
    await expect(
      startRemora({ databaseUrl: 'postgres://u:p@127.0.0.1:1/none', importer, logger: { warn: spy, error: spy } }),
    ).rejects.toThrow();
  });
});

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startRemora, type RemoraApp } from '../src/app.js';
import { createTestDb } from './helpers/testDb.js';

const pluginSource = (name: string, axis: string): string => `export default {
  name: '${name}',
  configSchema: { type: 'object' },
  defaultConfig: {},
  setup: () => ({ timeAxes: [{
    name: '${axis}', description: 'Test axis.', valueSchema: { type: 'integer' }, example: 1,
    encode: (v) => BigInt(v), decode: (n) => Number(n),
  }] }),
};
`;

async function fixtures(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'remora-plugins-'));
  const pkg = join(dir, 'node_modules', 'remora-plugin-moon');
  await mkdir(pkg, { recursive: true });
  await writeFile(
    join(pkg, 'package.json'),
    JSON.stringify({ name: 'remora-plugin-moon', type: 'module', exports: './index.js' }),
  );
  await writeFile(join(pkg, 'index.js'), pluginSource('moon', 'moon_phase'));
  await mkdir(join(dir, 'local'), { recursive: true });
  await writeFile(join(dir, 'local', 'sun.js'), pluginSource('sun', 'sun_day'));
  await mkdir(join(dir, 'pkgdir'), { recursive: true });
  await writeFile(join(dir, 'pkgdir', 'package.json'), JSON.stringify({ name: 'pkgdir', type: 'module', main: 'main.js' }));
  await writeFile(join(dir, 'pkgdir', 'main.js'), pluginSource('star', 'star_age'));
  await mkdir(join(dir, 'thrower'), { recursive: true });
  await writeFile(join(dir, 'thrower', 'index.js'), `throw new Error('boom');\nexport default {};\n`);
  return dir;
}

async function withEnv(fn: (a: { url: string; dir: string }) => Promise<void>): Promise<void> {
  const { url, drop } = await createTestDb();
  const dir = await fixtures();
  try {
    await fn({ url, dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
    await drop();
  }
}

async function useApp(url: string, dir: string, fn: (app: RemoraApp) => Promise<void>): Promise<void> {
  const app = await startRemora({ databaseUrl: url, pluginsDir: dir });
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

async function writeWith(app: RemoraApp, axis: string): Promise<{ ok: boolean; code?: string }> {
  const r = await app.apply({
    ops: [
      { op: 'create_entity', key: 'bob' },
      { op: 'create_property_type', name: 'job', description: 'Job.', value_type: 'text', single_valued: true },
      { op: 'add_property', entity: 'bob', property: 'job', value: 'x', time: { axis, from: 1 } },
    ],
  });
  return r.ok ? { ok: true } : { ok: false, code: r.error.code };
}

describe('plugin directory loading', () => {
  it.each([
    ['remora-plugin-moon', 'moon', 'moon_phase'],
    ['./local/sun.js', 'sun', 'sun_day'],
    ['./pkgdir', 'star', 'star_age'],
  ])('adds %s, stores the spec, serves its axis after restart', async (spec, name, axis) => {
    await withEnv(async ({ url, dir }) => {
      await useApp(url, dir, async (app) => {
        const added = await app.addPlugin({ package: spec });
        expect(added.name).toBe(name);
        const { rows } = await app.pool.query('SELECT package FROM plugin WHERE name = $1', [name]);
        expect(rows[0].package).toBe(spec);
      });
      await useApp(url, dir, async (app) => {
        expect(app.registry.getAxis(axis).name).toBe(axis);
        expect(await writeWith(app, axis)).toEqual({ ok: true });
      });
    });
  });

  it('rejects an unknown package and a duplicate', async () => {
    await withEnv(async ({ url, dir }) => {
      await useApp(url, dir, async (app) => {
        await expect(app.addPlugin({ package: 'nope' })).rejects.toMatchObject({ code: 'invalid_plugin' });
        await app.addPlugin({ package: 'remora-plugin-moon' });
        await expect(app.addPlugin({ package: 'remora-plugin-moon' })).rejects.toMatchObject({ code: 'name_taken' });
      });
    });
  });

  it('degrades when the plugin directory disappears', async () => {
    await withEnv(async ({ url, dir }) => {
      await useApp(url, dir, (app) => app.addPlugin({ package: 'remora-plugin-moon' }).then(() => undefined));
      await useApp(url, dir, async () => undefined);
      await rm(join(dir, 'node_modules'), { recursive: true, force: true });
      await useApp(url, dir, async (app) => {
        expect(app.registry.status()).toContainEqual(expect.objectContaining({ name: 'moon', ok: false }));
        expect(await writeWith(app, 'moon_phase')).toEqual({ ok: false, code: 'axis_unavailable' });
        expect(await writeWith(app, 'game_day')).toEqual({ ok: true });
      });
    });
  });

  it('degrades when the module throws at import time', async () => {
    await withEnv(async ({ url, dir }) => {
      await useApp(url, dir, async (app) => {
        await app.pool.query(`INSERT INTO plugin (name, package, config) VALUES ('bad', './thrower', '{}'::jsonb)`);
      });
      await useApp(url, dir, async (app) => {
        expect(app.registry.status()).toContainEqual(expect.objectContaining({ name: 'bad', ok: false }));
        expect(await writeWith(app, 'game_day')).toEqual({ ok: true });
      });
    });
  });
});

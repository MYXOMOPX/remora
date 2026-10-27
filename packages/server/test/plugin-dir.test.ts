import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
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
  const scoped = join(dir, 'node_modules', '@acme', 'remora-plugin-tide');
  await mkdir(scoped, { recursive: true });
  await writeFile(join(scoped, 'package.json'), JSON.stringify({ name: '@acme/remora-plugin-tide', type: 'module', main: 'tide.js' }));
  await writeFile(join(scoped, 'tide.js'), pluginSource('tide', 'tide_level'));
  const forms: [string, unknown, string][] = [
    ['exp-import', { '.': { import: './i.js' } }, 'i.js'],
    ['exp-default', { '.': { default: './d.js' } }, 'd.js'],
    ['exp-cond', { import: './c.js' }, 'c.js'],
    ['exp-str', { '.': './s.js' }, 's.js'],
  ];
  for (const [d, exp, file] of forms) {
    await mkdir(join(dir, d), { recursive: true });
    await writeFile(join(dir, d, 'package.json'), JSON.stringify({ name: d, type: 'module', exports: exp }));
    await writeFile(join(dir, d, file), pluginSource(d.replace('-', '_'), `${d.replace('-', '_')}_axis`));
  }
  await mkdir(join(dir, 'badjson'), { recursive: true });
  await writeFile(join(dir, 'badjson', 'package.json'), '{nope');
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

  it.each([
    ['@acme/remora-plugin-tide', 'tide', 'tide_level'],
    ['./exp-import', 'exp_import', 'exp_import_axis'],
    ['./exp-default', 'exp_default', 'exp_default_axis'],
    ['./exp-cond', 'exp_cond', 'exp_cond_axis'],
    ['./exp-str', 'exp_str', 'exp_str_axis'],
  ])('loads %s', async (spec, name, axis) => {
    await withEnv(async ({ url, dir }) => {
      await useApp(url, dir, async (app) => {
        expect((await app.addPlugin({ package: spec })).name).toBe(name);
      });
      await useApp(url, dir, async (app) => {
        expect(app.registry.getAxis(axis).name).toBe(axis);
      });
    });
  });

  it('accepts an absolute path spec', async () => {
    await withEnv(async ({ url, dir }) => {
      await useApp(url, dir, async (app) => {
        expect((await app.addPlugin({ package: join(dir, 'local', 'sun.js') })).name).toBe('sun');
      });
    });
  });

  it.each(['../x', 'a/../../b', '@acme', '@acme/a/b', 'a//b', 'a\b', '@/x'])('rejects bad name %s', async (spec) => {
    await withEnv(async ({ url, dir }) => {
      await useApp(url, dir, async (app) => {
        await expect(app.addPlugin({ package: spec })).rejects.toMatchObject({ code: 'invalid_plugin' });
      });
    });
  });

  it('addPlugin of a throwing module or invalid package.json is invalid_plugin', async () => {
    await withEnv(async ({ url, dir }) => {
      await useApp(url, dir, async (app) => {
        await expect(app.addPlugin({ package: './thrower' })).rejects.toMatchObject({ code: 'invalid_plugin' });
        await expect(app.addPlugin({ package: './badjson' })).rejects.toMatchObject({ code: 'invalid_plugin' });
      });
    });
  });

  it('looks up package names under plain node (no vitest)', async () => {
    const dir = await fixtures();
    try {
      const locate = pathToFileURL(resolve(__dirname, '../src/plugins/locate.ts')).href;
      const script = `
        import { stat } from 'node:fs/promises';
        const { locateEntry } = await import(${JSON.stringify(locate)});
        const isDir = async (p) => (await stat(p)).isDirectory();
        const out = [];
        for (const s of ['remora-plugin-moon', '@acme/remora-plugin-tide', './pkgdir']) {
          out.push(await locateEntry(${JSON.stringify(dir)}, s, isDir));
        }
        console.log(JSON.stringify(out));`;
      const { stdout } = await promisify(execFile)(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script]);
      expect((JSON.parse(stdout) as string[]).map((p) => p.replaceAll(String.fromCharCode(92), "/").slice(dir.length + 1))).toEqual([
        'node_modules/remora-plugin-moon/index.js',
        'node_modules/@acme/remora-plugin-tide/tide.js',
        'pkgdir/main.js',
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

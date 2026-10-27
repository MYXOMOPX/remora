import { execFileSync, execSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateSecret } from '../src/http/secret.js';
import { createTestDb, type TestDb } from './helpers/testDb.js';

const root = resolve(import.meta.dirname, '../../..');
const mainJs = join(root, 'packages/server/dist/main.js');
const posix = process.platform !== 'win32';

function runMain(args: string[], env: Record<string, string>) {
  // PATH only: the child must not inherit DATABASE_URL & co from the test environment
  return spawn(process.execPath, [mainJs, ...args], { cwd: root, env: { PATH: process.env.PATH ?? '', ...env } });
}

function lines(child: ChildProcess): AsyncIterable<string> {
  return createInterface({ input: child.stdout! });
}

function exited(child: ChildProcess, ms: number): Promise<number | null> {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('child did not exit in time')), ms);
    child.once('exit', (code) => {
      clearTimeout(t);
      res(code);
    });
  });
}

describe('built output under plain node', () => {
  let db: TestDb;
  let plugins: string;
  beforeAll(async () => {
    // no manual build step needed: the test builds
    execSync('npm run build', { cwd: root, stdio: 'pipe' });
    db = await createTestDb();
    plugins = await mkdtemp(join(tmpdir(), 'remora-smoke-'));
    const pkg = join(plugins, 'node_modules', 'remora-plugin-smoke');
    await mkdir(pkg, { recursive: true });
    await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'remora-plugin-smoke', type: 'module', exports: './index.js' }));
    await writeFile(
      join(pkg, 'index.js'),
      `export default { name: 'smoke', configSchema: { type: 'object' }, defaultConfig: {}, setup: () => ({ timeAxes: [{
        name: 'smoke_day', description: 'Smoke axis.', valueSchema: { type: 'integer' }, example: 1,
        encode: (v) => BigInt(v), decode: (n) => Number(n) }] }) };\n`,
    );
  }, 180_000);
  afterAll(async () => {
    await db?.drop();
    if (plugins) await rm(plugins, { recursive: true, force: true });
  });

  it('produces the build artifacts', () => {
    expect(existsSync(mainJs)).toBe(true);
    expect(existsSync(join(root, 'packages/sdk/dist/index.d.ts'))).toBe(true);
  });

  it('gen-secret prints a valid secret', () => {
    const out = execFileSync(process.execPath, [mainJs, 'gen-secret'], { cwd: root, encoding: 'utf8' });
    expect(out.trim()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('exits 1 with a JSON error line naming DATABASE_URL when unconfigured', async () => {
    const child = runMain([], {});
    const out: string[] = [];
    for await (const l of lines(child)) out.push(l);
    expect(await exited(child, 15_000)).toBe(1);
    const err = JSON.parse(out.find((l) => l.includes('"error"'))!);
    expect(err.level).toBe('error');
    expect(JSON.stringify(err)).toContain('DATABASE_URL');
  });

  it('serves requests, loads a package plugin from PLUGINS_DIR and shuts down', async () => {
    const secret = generateSecret();
    const adminSecret = generateSecret();
    const child = runMain([], {
      DATABASE_URL: db.url,
      PORT: '0',
      HOST: '127.0.0.1',
      REMORA_SECRET: secret,
      REMORA_ADMIN_SECRET: adminSecret,
      PLUGINS_DIR: plugins,
    });
    try {
      let port = 0;
      for await (const l of lines(child)) {
        const rec = JSON.parse(l) as { msg: string; port?: number };
        if (rec.msg === 'listening') {
          port = rec.port!;
          break;
        }
      }
      expect(port).toBeGreaterThan(0);
      const base = `http://127.0.0.1:${port}`;
      const health = await fetch(`${base}/health`);
      expect(health.status).toBe(200);
      expect(await health.text()).not.toContain('remora-core');

      // package-name plugin from PLUGINS_DIR/node_modules, registered through the admin route
      const added = await fetch(`${base}/${adminSecret}/admin/add_plugin`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ package: 'remora-plugin-smoke' }),
      });
      expect(added.status, await added.clone().text()).toBe(200);

      const res = await fetch(`${base}/${secret}/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ops: [{ op: 'create_entity', key: 'smoke' }] }),
      });
      const body = (await res.json()) as { ok: boolean };
      expect(res.status, JSON.stringify(body)).toBe(200);
      expect(body.ok).toBe(true);
      expect((await fetch(`${base}/wrong/apply`, { method: 'POST' })).status).toBe(404);
    } finally {
      child.kill();
    }
    await exited(child, 10_000); // on Windows kill() is a hard stop: only the exit is asserted
  }, 60_000);

  // Windows has no signals: child.kill() terminates hard, so graceful shutdown is verified on POSIX only
  it.skipIf(!posix)('SIGTERM shuts down gracefully with exit code 0', async () => {
    const secret = generateSecret();
    const child = runMain([], { DATABASE_URL: db.url, PORT: '0', HOST: '127.0.0.1', REMORA_SECRET: secret, PLUGINS_DIR: plugins });
    for await (const l of lines(child)) if ((JSON.parse(l) as { msg: string }).msg === 'listening') break;
    child.kill('SIGTERM');
    expect(await exited(child, 10_000)).toBe(0);
  }, 60_000);

  it('loads the registered package plugin by name after a restart', async () => {
    // second boot: the plugin registered above is loaded by name from PLUGINS_DIR under plain node
    const secret = generateSecret();
    const child = runMain([], { DATABASE_URL: db.url, PORT: '0', HOST: '127.0.0.1', REMORA_SECRET: secret, PLUGINS_DIR: plugins });
    try {
      let port = 0;
      for await (const l of lines(child)) {
        const rec = JSON.parse(l) as { msg: string; port?: number };
        if (rec.msg === 'listening') {
          port = rec.port!;
          break;
        }
      }
      const res = await fetch(`http://127.0.0.1:${port}/${secret}/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ops: [{ op: 'list_time_axes' }] }),
      });
      expect(JSON.stringify(await res.json())).toContain('smoke_day');
    } finally {
      child.kill();
    }
    await exited(child, 10_000);
  }, 60_000);
});

import corePlugin from '@remora/core-plugin';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { startRemora, type RemoraApp } from '../src/app.js';
import { createHttpServer, type HttpOptions, type RemoraHttpServer } from '../src/http/server.js';
import { createLogger } from '../src/log.js';
import type { Importer } from '../src/plugins/registry.js';
import { createTestDb } from './helpers/testDb.js';

const importer: Importer = async (spec) => {
  if (spec === '@remora/core-plugin') return corePlugin;
  throw new Error(`cannot import ${spec} from /secret/server/path`);
};

const SECRET = 'S3cretS3cretS3cretS3cretS3cretS3cretS3cr_t-';
const ADMIN = 'AdminAdminAdminAdminAdminAdminAdminAdminAdm-_';

interface Env {
  app: RemoraApp;
  port: number;
  lines: string[];
  url: string;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup(over: Partial<HttpOptions> = {}, prepare?: (url: string) => Promise<void>): Promise<Env> {
  const { url, drop } = await createTestDb();
  if (prepare) {
    const first = await startRemora({ databaseUrl: url, importer });
    await prepare(url);
    await first.close();
  }
  const app = await startRemora({ databaseUrl: url, importer });
  const lines: string[] = [];
  const logger = createLogger({ level: 'debug', write: (l) => lines.push(l) });
  const srv: RemoraHttpServer = createHttpServer(
    app,
    { secret: SECRET, adminSecret: ADMIN, maxBodyBytes: 1_048_576, requestTimeoutMs: 5_000, shutdownTimeoutMs: 2_000, ...over },
    logger,
  );
  const addr: AddressInfo = await srv.listen(0, '127.0.0.1');
  cleanups.push(async () => {
    await srv.shutdown();
    await app.close();
    await drop();
  });
  return { app, port: addr.port, lines, url };
}

interface Res {
  status: number;
  text: string;
  json(): any;
}

function raw(port: number, method: string, path: string, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = body !== undefined ? { 'content-type': 'application/json' } : {};
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode!, text, json: () => JSON.parse(text) });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const admin = (e: Env, op: string, body: unknown = {}, secret = ADMIN) =>
  raw(e.port, 'POST', `/${secret}/admin/${op}`, JSON.stringify(body));

async function addEvidence(e: Env): Promise<number> {
  const r = await raw(
    e.port,
    'POST',
    `/${SECRET}/apply`,
    JSON.stringify({ ops: [{ op: 'add_evidence', source: 'chat_message', payload: { text: 'hi' } }] }),
  );
  expect(r.status).toBe(200);
  return r.json().results[0].id;
}

const NOT_FOUND = { ok: false, error: { op_index: -1, code: 'not_found', message: 'not found' } };

describe('admin routes: auth', () => {
  it('serves list_plugins under the admin secret by POST and GET', async () => {
    const e = await setup();
    const p = await admin(e, 'list_plugins');
    expect(p.status).toBe(200);
    const body = p.json();
    expect(body.ok).toBe(true);
    expect(body.result.rows[0]).toMatchObject({ name: 'remora-core', status: 'ok', sources: ['chat_message'] });
    const g = await raw(e.port, 'GET', `/${ADMIN}/admin/list_plugins`);
    expect(g.status).toBe(200);
    expect(g.json().result.rows).toHaveLength(1);
  });

  it('is unreachable with the LLM secret, and the admin secret does not open LLM routes', async () => {
    const e = await setup();
    const a = await admin(e, 'list_plugins', {}, SECRET);
    expect(a.status).toBe(404);
    expect(a.json()).toEqual(NOT_FOUND);
    const b = await raw(e.port, 'POST', `/${ADMIN}/query`, JSON.stringify({ ops: [{ op: 'list_time_axes' }] }));
    expect(b.status).toBe(404);
    expect(b.json()).toEqual(NOT_FOUND);
    for (const wrong of [`${ADMIN}x`, ADMIN.toLowerCase(), '', 'short']) {
      const r = await admin(e, 'list_plugins', {}, wrong);
      expect(r.status).toBe(404);
      expect(r.json()).toEqual(NOT_FOUND);
    }
  });

  it('is disabled when no admin secret is configured', async () => {
    const e = await setup({ adminSecret: undefined });
    for (const secret of [ADMIN, SECRET]) {
      const r = await admin(e, 'list_plugins', {}, secret);
      expect(r.status).toBe(404);
      expect(r.json()).toEqual(NOT_FOUND);
    }
  });

  it('unknown op is 404, wrong method is 405, bad body is 400', async () => {
    const e = await setup();
    const u = await admin(e, 'frobnicate');
    expect(u.status).toBe(404);
    expect(u.json().error.code).toBe('not_found');
    expect((await raw(e.port, 'GET', `/${ADMIN}/admin/pin_evidence`)).status).toBe(405);
    expect((await raw(e.port, 'POST', `/${ADMIN}/admin/pin_evidence`, '[1]')).status).toBe(400);
    expect((await raw(e.port, 'POST', `/${ADMIN}/admin/pin_evidence`, '"x"')).status).toBe(400);
    expect((await raw(e.port, 'POST', `/${ADMIN}/admin/pin_evidence`, '{nope')).status).toBe(400);
    expect((await raw(e.port, 'POST', `/${ADMIN}/admin/list_plugins/extra`, '{}')).status).toBe(404);
  });
});

describe('admin routes: evidence maintenance', () => {
  it('pin, purge, unpin, purge', async () => {
    const e = await setup();
    const id = await addEvidence(e);
    expect((await admin(e, 'pin_evidence', { id })).json()).toEqual({ ok: true, result: { id } });
    expect((await admin(e, 'purge_evidence', { ids: [id] })).json().result).toEqual({ purged: 0, skipped_pinned: 1 });
    expect((await admin(e, 'unpin_evidence', { id })).json()).toEqual({ ok: true, result: { id } });
    expect((await admin(e, 'purge_evidence', { ids: [id] })).json().result).toEqual({ purged: 1, skipped_pinned: 0 });
  });

  it('apply_retention returns the report', async () => {
    const e = await setup();
    await addEvidence(e);
    const r = await admin(e, 'apply_retention', {});
    expect(r.status).toBe(200);
    expect(r.json().result).toMatchObject({ processed: 1, skipped: [] });
    const one = await admin(e, 'apply_retention', { source: 'chat_message', batch_size: 10 });
    expect(one.status).toBe(200);
    expect((await admin(e, 'apply_retention', { source: 'nope' })).status).toBe(404);
  });

  it('purge by source and age', async () => {
    const e = await setup();
    await addEvidence(e);
    const r = await admin(e, 'purge_evidence', { source: 'chat_message', older_than: '2999-01-01T00:00:00Z' });
    expect(r.json().result).toEqual({ purged: 1, skipped_pinned: 0 });
  });

  it('validates every input', async () => {
    const e = await setup();
    const bad: [string, unknown][] = [
      ['purge_evidence', { source: 'chat_message', older_than: 'nope' }],
      ['purge_evidence', { source: 'chat_message', older_than: 5 }],
      ['purge_evidence', { source: 'chat_message', older_than: '2020-13-45' }],
      ['purge_evidence', { source: 'chat_message', older_than: '2020-01-01T10:00' }],
      ['purge_evidence', { source: 'chat_message', older_than: '2020-01-01 10:00' }],
      ['purge_evidence', { source: 'chat_message', older_than: '2020-01-01T10:00:00' }],
      ['purge_evidence', { source: 'bad\nname', older_than: '2020-01-01' }],
      ['apply_retention', { source: 'bad\nname' }],
      ['apply_retention', { source: '' }],
      ['purge_evidence', {}],
      ['purge_evidence', { ids: [] }],
      ['purge_evidence', { ids: [1.5] }],
      ['purge_evidence', { ids: ['1'] }],
      ['purge_evidence', { ids: [0] }],
      ['purge_evidence', { ids: [1], source: 'chat_message', older_than: '2020-01-01' }],
      ['purge_evidence', { ids: [1], extra: true }],
      ['pin_evidence', {}],
      ['pin_evidence', { id: '1' }],
      ['pin_evidence', { id: -1 }],
      ['pin_evidence', { id: 1e300 }],
      ['unpin_evidence', { id: null }],
      ['apply_retention', { batch_size: 0 }],
      ['apply_retention', { batch_size: 'x' }],
      ['apply_retention', { source: 5 }],
      ['apply_retention', { source: 'x'.repeat(300) }],
      ['apply_retention', { bogus: 1 }],
      ['add_plugin', {}],
      ['add_plugin', { package: 5 }],
      ['add_plugin', { package: '' }],
      ['add_plugin', { package: 'x'.repeat(1000) }],
      ['add_plugin', { package: 'a\u0000b' }],
      ['set_plugin_config', { name: 'remora-core' }],
      ['set_plugin_config', { name: 5, config: {} }],
      ['set_plugin_config', { name: 'remora-core', config: {}, confirm: 'yes' }],
      ['remove_plugin', {}],
      ['remove_plugin', { name: '' }],
    ];
    for (const [op, body] of bad) {
      const r = await admin(e, op, body);
      expect(r.status, `${op} ${JSON.stringify(body).slice(0, 60)}`).toBe(400);
      expect(r.json().error.code).toBe('invalid_param');
      expect(r.json().error.op_index).toBeUndefined();
    }
    // prototype keys never reach the service
    const proto = await raw(
      e.port,
      'POST',
      `/${ADMIN}/admin/set_plugin_config`,
      '{"name":"remora-core","config":{"timeAxes":[],"__proto__":{"x":1}}}',
    );
    expect(proto.status).toBe(400);
    expect(proto.json().error.code).toBe('invalid_param');
    const ctor = await admin(e, 'set_plugin_config', { name: 'remora-core', config: { a: { constructor: 1 } } });
    // only `__proto__` is refused here; the plugin's own schema still judges the rest
    expect(ctor.status).toBe(400);
    expect(ctor.json().error.code).toBe('invalid_config');
    const nested = await raw(e.port, 'POST', `/${ADMIN}/admin/pin_evidence`, '{"id":1,"__proto__":{"a":1}}');
    expect(nested.status).toBe(400);
    expect((await admin(e, 'pin_evidence', { id: 999999 })).status).toBe(404);
  });
});

describe('admin routes: older_than time zones', () => {
  it('accepts date-only (UTC), Z and offset forms and reads them as such', async () => {
    const e = await setup();
    const id = await addEvidence(e);
    await e.app.pool.query(`UPDATE evidence_log SET created_at = '2020-06-01T12:00:00Z' WHERE id = $1`, [id]);
    const purge = (older_than: string) => admin(e, 'purge_evidence', { source: 'chat_message', older_than });
    // 12:00Z is before 15:00+02:00 (= 13:00Z)? yes, but not before 13:00+02:00 (= 11:00Z)
    expect((await purge('2020-06-01T13:00:00+02:00')).json().result.purged).toBe(0);
    expect((await purge('2020-06-01')).json().result.purged).toBe(0);
    expect((await purge('2020-06-01T12:00:00Z')).json().result.purged).toBe(0);
    expect((await purge('2020-06-01T15:00:00+02:00')).json().result.purged).toBe(1);
  });
});

describe('admin routes: plugins', () => {
  it('add_plugin with an unloadable package is invalid_plugin', async () => {
    const e = await setup();
    const r = await admin(e, 'add_plugin', { package: 'nope' });
    expect(r.status).toBe(400);
    expect(r.json().error.code).toBe('invalid_plugin');
  });

  it('set_plugin_config and remove_plugin results', async () => {
    const e = await setup();
    const inv = await admin(e, 'set_plugin_config', { name: 'remora-core', config: { timeAxes: 5 } });
    expect(inv.status).toBe(400);
    expect(inv.json().error.code).toBe('invalid_config');
    const ok = await admin(e, 'set_plugin_config', {
      name: 'remora-core',
      config: { timeAxes: [{ name: 'tick', kind: 'integer', description: 'Ticks.' }] },
    });
    expect(ok.status).toBe(200);
    expect(ok.json().result).toEqual({ name: 'remora-core', restart_required: true });
    const rm = await admin(e, 'remove_plugin', { name: 'remora-core' });
    expect(rm.status).toBe(400);
    expect(rm.json().error.code).toBe('invalid_plugin');
    expect((await admin(e, 'remove_plugin', { name: 'nope' })).status).toBe(404);
  });

  it('confirm_required is a 400 with details', async () => {
    const e = await setup();
    await raw(
      e.port,
      'POST',
      `/${SECRET}/apply`,
      JSON.stringify({
        ops: [
          { op: 'create_entity', key: 'bob' },
          { op: 'create_property_type', name: 'age', description: 'Age.', value_type: 'text', single_valued: true },
          { op: 'add_property', entity: 'bob', property: 'age', value: 'x', time: { axis: 'game_day', from: 1 } },
        ],
      }),
    );
    const r = await admin(e, 'set_plugin_config', {
      name: 'remora-core',
      config: { timeAxes: [{ name: 'game_day', kind: 'integer', description: 'D.' }] },
    });
    expect(r.status).toBe(400);
    expect(r.json().error.details.reason).toBe('confirm_required');
  });
});

describe('degraded plugins and logging', () => {
  it('/health is degraded without echoing plugin details; list_plugins shows the error', async () => {
    const e = await setup({}, async (url) => {
      const { default: pg } = await import('pg');
      const c = new pg.Client({ connectionString: url });
      await c.connect();
      await c.query(`INSERT INTO plugin (name, package, config) VALUES ('ghostly', 'ghost-pkg', '{}')`);
      await c.end();
    });
    const h = await raw(e.port, 'GET', '/health');
    expect(h.status).toBe(200);
    expect(h.json()).toEqual({ status: 'degraded' });
    expect(h.text).not.toMatch(/ghost|secret|server/);
    const l = await admin(e, 'list_plugins');
    const ghost = l.json().result.rows.find((r: any) => r.name === 'ghostly');
    expect(ghost.status).toBe('degraded');
    expect(ghost.error).toMatch(/ghost-pkg/);
    // core ops keep working
    expect((await raw(e.port, 'POST', `/${SECRET}/query`, JSON.stringify({ ops: [{ op: 'list_time_axes' }] }))).status).toBe(200);
  });

  it('logs the op name only: no secrets, config values or bodies', async () => {
    const e = await setup();
    await admin(e, 'set_plugin_config', {
      name: 'remora-core',
      config: { timeAxes: [{ name: 'tick', kind: 'integer', description: 'SENTINEL-CONFIG-VALUE' }] },
    });
    await admin(e, 'frobnicate');
    const log = e.lines.join('\n');
    expect(log).not.toContain(ADMIN);
    expect(log).not.toContain(SECRET);
    expect(log).not.toContain('SENTINEL-CONFIG-VALUE');
    const entries = e.lines.map((l) => JSON.parse(l));
    const ops = entries.filter((x) => x.msg === 'admin op');
    expect(ops.map((x) => x.op)).toEqual(['set_plugin_config']);
    expect(entries.some((x) => x.msg === 'request' && x.route === '/:admin_secret/admin/set_plugin_config')).toBe(true);
    expect(entries.some((x) => x.msg === 'request' && String(x.route).includes('frobnicate'))).toBe(false);
  });
});

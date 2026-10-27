import corePlugin from '@remora/core-plugin';
import { ERROR_CODES } from '@remora/sdk';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { startRemora, type RemoraApp } from '../src/app.js';
import { getContract } from '../src/index.js';
import { createHttpServer, type HttpOptions, type RemoraHttpServer } from '../src/http/server.js';
import { statusFor } from '../src/http/status.js';
import { createLogger } from '../src/log.js';
import type { Importer } from '../src/plugins/registry.js';
import { createTestDb } from './helpers/testDb.js';

const importer: Importer = async (spec) => {
  if (spec === '@remora/core-plugin') return corePlugin;
  throw new Error(`cannot import ${spec}`);
};

const SECRET = 'S3cretS3cretS3cretS3cretS3cretS3cretS3cr_t-';
const ADMIN = 'AdminAdminAdminAdminAdminAdminAdminAdminAdm-_';

interface Env {
  app: RemoraApp;
  srv: RemoraHttpServer;
  port: number;
  lines: string[];
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup(over: Partial<HttpOptions> = {}, level: 'debug' | 'info' = 'debug'): Promise<Env> {
  const { url, drop } = await createTestDb();
  const app = await startRemora({ databaseUrl: url, importer });
  const lines: string[] = [];
  const logger = createLogger({ level, write: (l) => lines.push(l) });
  const srv = createHttpServer(
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
  return { app, srv, port: addr.port, lines };
}

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json(): any;
}

function collect(res: http.IncomingMessage, resolve: (r: Res) => void): void {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => {
    const text = Buffer.concat(chunks).toString('utf8');
    resolve({ status: res.statusCode!, headers: res.headers, text, json: () => JSON.parse(text) });
  });
}

function raw(
  port: number,
  method: string,
  path: string,
  body?: string,
  headers: Record<string, string> = {},
  agent?: http.Agent,
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const h: Record<string, string> = { ...headers };
    if (body !== undefined && h['content-type'] === undefined) h['content-type'] = 'application/json';
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: h, ...(agent ? { agent } : {}) }, (res) =>
      collect(res, resolve),
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const post = (e: Env, path: string, body: unknown, headers: Record<string, string> = {}) =>
  raw(e.port, 'POST', path, typeof body === 'string' ? body : JSON.stringify(body), headers);

const NOT_FOUND = { ok: false, error: { op_index: -1, code: 'not_found', message: 'not found' } };

async function seed(e: Env): Promise<void> {
  const r = await post(e, `/${SECRET}/apply`, {
    ops: [
      { op: 'create_entity', key: 'bob' },
      { op: 'create_property_type', name: 'job_title', description: 'Job title.', value_type: 'text', single_valued: true },
    ],
  });
  expect(r.status).toBe(200);
}

describe('HTTP transport: routes and statuses', () => {
  it('apply, query, schema, health', async () => {
    const e = await setup();
    await seed(e);
    const a = await post(e, `/${SECRET}/apply`, {
      ops: [{ op: 'add_property', entity: 'bob', property: 'job_title', value: 'Junior', time: { axis: 'game_day', from: 1 } }],
    });
    expect(a.status).toBe(200);
    expect(a.json().ok).toBe(true);
    expect(a.headers['content-type']).toMatch(/^application\/json/);
    const q = await post(e, `/${SECRET}/query`, { ops: [{ op: 'get_entity', key: 'bob' }] });
    expect(q.status).toBe(200);
    expect(q.json().ok).toBe(true);
    const s = await raw(e.port, 'GET', `/${SECRET}/schema`);
    expect(s.status).toBe(200);
    expect(s.json()).toEqual(JSON.parse(JSON.stringify(getContract())));
    const h = await raw(e.port, 'GET', '/health');
    expect(h.status).toBe(200);
    expect(h.json()).toEqual({ status: 'ok' });
  });

  it('maps error codes to statuses', async () => {
    const e = await setup();
    await seed(e);
    const nobody = await post(e, `/${SECRET}/apply`, {
      ops: [{ op: 'add_property', entity: 'nobody', property: 'job_title', value: 'x' }],
    });
    expect(nobody.status).toBe(404);
    expect(nobody.json().error.code).toBe('unknown_entity');

    const add = (value: string) => ({
      ops: [{ op: 'add_property', entity: 'bob', property: 'job_title', value, time: { axis: 'game_day', from: 1, to: 10 } }],
    });
    expect((await post(e, `/${SECRET}/apply`, add('A'))).status).toBe(200);
    const conflict = await post(e, `/${SECRET}/apply`, add('B'));
    expect(conflict.status).toBe(409);
    expect(conflict.json().error.code).toBe('single_valued_conflict');

    const bad = await post(e, `/${SECRET}/apply`, { ops: [{ op: 'create_entity', key: 'ok' }, { op: 'create_entity' }] });
    expect(bad.status).toBe(400);
    expect(bad.json().error).toMatchObject({ op_index: 1, code: 'invalid_param', details: { field: 'key' } });

    const one = { ops: [{ op: 'create_entity', key: 'z' }] };
    e.app.apply = async () => ({ ok: false, error: { op_index: 0, code: 'axis_unavailable', message: 'm' } });
    expect((await post(e, `/${SECRET}/apply`, one)).status).toBe(503);
    e.app.apply = async () => ({ ok: false, error: { op_index: 0, code: 'timeout', message: 'm' } });
    expect((await post(e, `/${SECRET}/apply`, one)).status).toBe(504);
  });

  it('statusFor covers every error code', () => {
    for (const c of ERROR_CODES) expect(statusFor(c)).toBeGreaterThanOrEqual(400);
    expect(statusFor('too_many_paths')).toBe(422);
    expect(statusFor('internal')).toBe(500);
    expect(statusFor('name_taken')).toBe(409);
    expect(statusFor('unknown_source')).toBe(404);
  });
});

describe('HTTP transport: secret routing (Review Focus 1)', () => {
  it('wrong secret variants and unknown paths are indistinguishable 404s, and no secret is logged', async () => {
    const e = await setup();
    const variants = [
      `/${SECRET}x/apply`,
      `/${SECRET.toUpperCase()}/apply`,
      `/${SECRET.slice(0, -1)}/apply`,
      '//apply',
      '/apply',
      '/nope',
      '/',
      `/${ADMIN}x/admin/list_plugins`,
      `/${SECRET}/nope`,
    ];
    let first: string | undefined;
    for (const p of variants) {
      const r = await post(e, p, { ops: [{ op: 'create_entity', key: 'x' }] });
      expect(r.status, p).toBe(404);
      expect(r.json()).toEqual(NOT_FOUND);
      first ??= r.text;
      expect(r.text).toBe(first);
    }
    // a real request too, so the access log is exercised with the real secret
    await post(e, `/${SECRET}/query`, { ops: [{ op: 'list_time_axes' }] });
    expect(e.lines.length).toBeGreaterThan(0);
    for (const l of e.lines) {
      expect(l).not.toContain(SECRET);
      expect(l).not.toContain(ADMIN);
      expect(l).not.toContain(SECRET.slice(0, 20));
    }
  });
});

describe('HTTP transport: hostile bodies (Review Focus 2)', () => {
  it('bad JSON, wrong shapes, oversize, wrong content type, wrong method, too many ops', async () => {
    const e = await setup();
    await seed(e);
    const ok = async () => {
      const r = await post(e, `/${SECRET}/query`, { ops: [{ op: 'get_entity', key: 'bob' }] });
      expect(r.status).toBe(200);
    };
    const p = `/${SECRET}/apply`;

    for (const body of ['{bad', '', '"str"', '[1]', 'null']) {
      const r = await post(e, p, body);
      expect(r.status, body).toBe(400);
      expect(r.json().error).toMatchObject({ op_index: -1, code: 'invalid_param' });
      await ok();
    }

    const big = await post(e, p, JSON.stringify({ ops: [{ op: 'create_entity', key: 'x'.repeat(2 * 1024 * 1024) }] }));
    expect(big.status).toBe(413);
    expect(big.json().error.code).toBe('invalid_param');
    expect(big.headers.connection).toBe('close');
    await ok();

    const t = await post(e, p, '{}', { 'content-type': 'text/plain' });
    expect(t.status).toBe(415);
    await ok();
    const none = await raw(e.port, 'POST', p, undefined);
    expect(none.status).toBe(415);
    await ok();
    const params = await post(e, `/${SECRET}/query`, { ops: [{ op: 'list_time_axes' }] }, { 'content-type': 'Application/JSON; charset=utf-8' });
    expect(params.status).toBe(200);

    const g = await raw(e.port, 'GET', p);
    expect(g.status).toBe(405);
    expect(g.headers.allow).toBe('POST');
    expect((await post(e, `/${SECRET}/schema`, {})).status).toBe(405);
    await ok();

    const many = await post(e, p, { ops: Array.from({ length: 1001 }, () => ({ op: 'create_entity', key: 'a' })) });
    expect(many.status).toBe(400);
    expect(many.json().error.details.limit).toBe(1000);
    await ok();
  });

  it('chunked body without Content-Length aborts early once over the limit', async () => {
    const e = await setup({ maxBodyBytes: 100_000 });
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    let written = 0;
    let settled = false;
    const res = await new Promise<{ status: number; closed: boolean }>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: e.port, method: 'POST', path: `/${SECRET}/apply`, headers: { 'content-type': 'application/json' } },
        (r) => {
          settled = true;
          r.resume();
          r.on('end', () => resolve({ status: r.statusCode!, closed: r.headers.connection === 'close' }));
        },
      );
      req.on('error', (err) => {
        if (!settled) reject(err);
      });
      req.write('{"ops":[{"op":"create_entity","key":"');
      const pump = (): void => {
        if (settled || written > 200 * 1024 * 1024) return;
        written += chunk.length;
        if (req.write(chunk)) setImmediate(pump);
        else req.once('drain', pump);
      };
      pump();
    });
    expect(res.status).toBe(413);
    expect(res.closed).toBe(true);
    // the server stopped reading: far less than the 200 MiB ceiling got through
    expect(written).toBeLessThan(32 * 1024 * 1024);
    expect((await raw(e.port, 'GET', '/health')).status).toBe(200);
  });

  it('Content-Length above the limit fails before any body is read', async () => {
    const e = await setup({ maxBodyBytes: 1000 });
    const r = await new Promise<Res>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: e.port, method: 'POST', path: `/${SECRET}/apply`, headers: { 'content-type': 'application/json', 'content-length': '5000' } },
        (res) => collect(res, resolve),
      );
      req.on('error', reject);
      req.write('{'); // never sends the promised 5000 bytes
    });
    expect(r.status).toBe(413);
  });

  it('a slow (slowloris) body is cut off by the request timeout', async () => {
    const e = await setup({ requestTimeoutMs: 400 });
    const t0 = Date.now();
    const r = await new Promise<{ status?: number }>((resolve) => {
      const req = http.request(
        { host: '127.0.0.1', port: e.port, method: 'POST', path: `/${SECRET}/apply`, headers: { 'content-type': 'application/json', 'content-length': '100' } },
        (res) => {
          res.resume();
          res.on('end', () => resolve({ status: res.statusCode }));
        },
      );
      req.on('error', () => resolve({}));
      req.write('{"ops"');
      // never finishes
    });
    expect(Date.now() - t0).toBeLessThan(4000);
    // either our 408 envelope or a closed socket, never a hang and never a success
    expect([408, undefined]).toContain(r.status);
    expect((await raw(e.port, 'GET', '/health')).status).toBe(200);
  });
});

describe('HTTP transport: request id, internal errors, access log', () => {
  it('x-request-id everywhere; unexpected throws become a bare 500', async () => {
    const e = await setup();
    const h = await raw(e.port, 'GET', '/health');
    expect(h.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const nf = await raw(e.port, 'GET', '/zzz');
    expect(nf.headers['x-request-id']).toBeTruthy();
    expect(nf.headers['x-request-id']).not.toBe(h.headers['x-request-id']);

    e.app.apply = async () => {
      throw new Error('secret detail');
    };
    const r = await post(e, `/${SECRET}/apply`, { ops: [{ op: 'create_entity', key: 'x' }] });
    expect(r.status).toBe(500);
    expect(r.text).not.toContain('secret detail');
    expect(r.text).not.toContain('at ');
    const j = r.json();
    expect(j.error.code).toBe('internal');
    expect(j.error.details.request_id).toBe(r.headers['x-request-id']);
    // the error line carries the name only; message and stack are debug-only
    expect(e.lines.filter((l) => l.includes('secret detail') && !l.includes('unhandled error stack'))).toEqual([]);
    expect(e.lines.some((l) => l.includes('"error":"Error"'))).toBe(true);
    // the stack is a debug-level line
    expect(e.lines.some((l) => l.includes('unhandled error stack') && l.includes('secret detail'))).toBe(true);
  });

  it('info level never logs the stack or the message of unexpected errors', async () => {
    const e = await setup({}, 'info');
    e.app.apply = async () => {
      throw new Error('secret detail');
    };
    await post(e, `/${SECRET}/apply`, { ops: [{ op: 'create_entity', key: 'x' }] });
    expect(e.lines.some((l) => l.includes('secret detail'))).toBe(false);
    expect(e.lines.some((l) => l.includes('stack'))).toBe(false);
  });

  it('logs "aborted" for a client that left before the response, and keeps the handler counted until it ends', async () => {
    const e = await setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const started = new Promise<void>((r) => (entered = r));
    e.app.query = async () => {
      entered();
      await gate;
      return { ok: true, results: [] };
    };
    e.lines.length = 0;
    const req = http.request({ host: '127.0.0.1', port: e.port, method: 'POST', path: `/${SECRET}/query`, headers: { 'content-type': 'application/json' } });
    req.on('error', () => undefined);
    req.end(JSON.stringify({ ops: [{ op: 'list_time_axes' }] }));
    await started;
    req.destroy();
    await new Promise((r) => setTimeout(r, 100));
    let down = false;
    const sd = e.srv.shutdown().then(() => (down = true));
    await new Promise((r) => setTimeout(r, 300));
    expect(down).toBe(false); // still waiting for the handler although the client is gone
    release();
    await sd;
    const reqs = e.lines.map((l) => JSON.parse(l)).filter((l) => l.msg === 'request');
    expect(reqs[0].status).toBe('aborted');
  });

  it('GET with a body keeps the close-after-response rule', async () => {
    const e = await setup();
    const h = await raw(e.port, 'GET', '/health', '{}', { 'content-type': 'application/json', 'content-length': '2' });
    expect(h.status).toBe(200);
    expect(h.headers.connection).toBe('close');
    const s = await raw(e.port, 'GET', `/${SECRET}/schema`, '{}', { 'content-type': 'application/json', 'content-length': '2' });
    expect(s.status).toBe(200);
    expect(s.headers.connection).toBe('close');
  });

  it('refuses invalid secrets and timeouts at construction', async () => {
    const e = await setup();
    const base = { secret: SECRET, maxBodyBytes: 1000, requestTimeoutMs: 1000, shutdownTimeoutMs: 1000 };
    const mk = (o: Partial<HttpOptions>) => () => createHttpServer(e.app, { ...base, ...o }, createLogger({ write: () => {} }));
    expect(mk({ secret: 'short' })).toThrow();
    expect(mk({ adminSecret: SECRET })).toThrow();
    expect(mk({ adminSecret: 'short' })).toThrow();
    expect(mk({ requestTimeoutMs: 0 })).toThrow();
    expect(mk({ adminSecret: ADMIN })).not.toThrow();
  });

  it('the logger never throws on unserializable meta', () => {
    const out: string[] = [];
    const log = createLogger({ write: (l) => out.push(l) });
    const circ: Record<string, unknown> = {};
    circ.self = circ;
    expect(() => log.info('a', { n: 1n })).not.toThrow();
    expect(() => log.info('b', circ)).not.toThrow();
    expect(out).toHaveLength(2);
    expect(JSON.parse(out[0]!).msg).toBe('a');
    const bad = createLogger({ write: () => { throw new Error('sink'); } });
    expect(() => bad.error('x')).not.toThrow();
  });

  it('writes one structured access line per request with a redacted route', async () => {
    const e = await setup();
    e.lines.length = 0;
    await post(e, `/${SECRET}/query`, { ops: [{ op: 'list_time_axes' }, { op: 'list_relation_types' }] });
    await raw(e.port, 'GET', '/nope');
    const reqs = e.lines.map((l) => JSON.parse(l)).filter((l) => l.msg === 'request');
    expect(reqs).toHaveLength(2);
    expect(reqs[0]).toMatchObject({ level: 'info', method: 'POST', route: '/:secret/query', status: 200, ops: 2 });
    expect(typeof reqs[0].ms).toBe('number');
    expect(typeof reqs[0].request_id).toBe('string');
    expect(typeof reqs[0].ts).toBe('string');
    expect(reqs[1]).toMatchObject({ status: 404 });
    expect(reqs[1].route).not.toContain('nope');
  });
});

describe('HTTP transport: health and shutdown (Review Focus 5)', () => {
  it('health reports degraded plugins without naming them', async () => {
    const e = await setup();
    e.app.registry = { ...e.app.registry, status: () => [{ name: 'x', ok: false, error: 'boom' }] };
    const h = await raw(e.port, 'GET', '/health');
    expect(h.status).toBe(200);
    expect(h.json()).toEqual({ status: 'degraded' });
  });

  it('health is 503 unavailable when the pool is ended', async () => {
    const { url, drop } = await createTestDb();
    const app = await startRemora({ databaseUrl: url, importer });
    const srv = createHttpServer(
      app,
      { secret: SECRET, maxBodyBytes: 1000, requestTimeoutMs: 1000, shutdownTimeoutMs: 1000 },
      createLogger({ write: () => {} }),
    );
    const addr = await srv.listen(0, '127.0.0.1');
    try {
      await app.pool.end();
      const h = await raw(addr.port, 'GET', '/health');
      expect(h.status).toBe(503);
      expect(h.json()).toEqual({ status: 'unavailable' });
    } finally {
      await srv.shutdown();
      await drop();
    }
  });

  it('drains in-flight requests, answers 503 on kept-alive connections, then resolves', async () => {
    const e = await setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const started = new Promise<void>((r) => (entered = r));
    const realQuery = e.app.query.bind(e.app);
    e.app.query = async (req) => {
      entered();
      await gate;
      return realQuery(req);
    };
    // 503s during shutdown carry Connection: close and the listener is gone, so each follow-up needs its own warm socket
    const agent = new http.Agent({ keepAlive: true, maxSockets: 3 });
    cleanups.push(async () => agent.destroy());
    const warm = await Promise.all([0, 1, 2].map(() => raw(e.port, 'GET', '/health', undefined, {}, agent)));
    expect(warm.map((w) => w.status)).toEqual([200, 200, 200]);

    const body = JSON.stringify({ ops: [{ op: 'list_time_axes' }] });
    const inflight = raw(e.port, 'POST', `/${SECRET}/query`, body, {}, agent);
    await started;
    let done = false;
    const down = e.srv.shutdown().then(() => (done = true));
    await new Promise((r) => setTimeout(r, 100));

    const late = await raw(e.port, 'POST', `/${SECRET}/query`, body, {}, agent);
    expect(late.status).toBe(503);
    expect(late.json().error.details.reason).toBe('shutting_down');
    const h = await raw(e.port, 'GET', '/health', undefined, {}, agent);
    expect(h.status).toBe(503);
    expect(h.json()).toEqual({ status: 'shutting_down' });
    expect(done).toBe(false);

    release();
    const r = await inflight;
    expect(r.status).toBe(200);
    expect(r.json().ok).toBe(true);
    await down;
    expect(done).toBe(true);
    // the pool belongs to the caller: still usable after shutdown()
    await e.app.pool.query('SELECT 1');
  });

  it('steady traffic during the drain does not delay shutdown', async () => {
    const e = await setup({ shutdownTimeoutMs: 5000 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const started = new Promise<void>((r) => (entered = r));
    const realQuery = e.app.query.bind(e.app);
    e.app.query = async (req) => {
      entered();
      await gate;
      return realQuery(req);
    };
    const agent = new http.Agent({ keepAlive: true, maxSockets: 4 });
    cleanups.push(async () => agent.destroy());
    const body = JSON.stringify({ ops: [{ op: 'list_time_axes' }] });
    await Promise.all([raw(e.port, 'GET', '/health', undefined, {}, agent), raw(e.port, 'GET', '/health', undefined, {}, agent)]);
    const inflight = raw(e.port, 'POST', `/${SECRET}/query`, body, {}, agent);
    await started;
    const down = e.srv.shutdown();
    let stop = false;
    const traffic = (async () => {
      while (!stop) {
        await raw(e.port, 'GET', '/health', undefined, {}, agent).catch(() => undefined);
        await new Promise((r) => setTimeout(r, 5));
      }
    })();
    await new Promise((r) => setTimeout(r, 200));
    const t0 = Date.now();
    release();
    expect((await inflight).status).toBe(200);
    await down;
    stop = true;
    await traffic;
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(e.lines.some((l) => l.includes('shutdown timeout'))).toBe(false);
  });

  it('shutdown gives up on stuck requests after shutdownTimeoutMs', async () => {
    const e = await setup({ shutdownTimeoutMs: 200 });
    e.app.query = () => new Promise(() => {});
    const req = raw(e.port, 'POST', `/${SECRET}/query`, JSON.stringify({ ops: [{ op: 'list_time_axes' }] })).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    await e.srv.shutdown();
    expect(Date.now() - t0).toBeLessThan(2000);
    await req;
  }, 10_000);
});

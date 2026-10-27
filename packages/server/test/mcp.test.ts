import corePlugin from '@remora/core-plugin';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { startRemora, type RemoraApp } from '../src/app.js';
import { getContract } from '../src/index.js';
import { createHttpServer, type HttpOptions } from '../src/http/server.js';
import { createLogger } from '../src/log.js';
import { createMcpServer } from '../src/mcp/server.js';
import type { Importer } from '../src/plugins/registry.js';
import { createTestDb } from './helpers/testDb.js';

const importer: Importer = async (spec) => {
  if (spec === '@remora/core-plugin') return corePlugin;
  throw new Error(`cannot import ${spec}`);
};

const SECRET = 'S3cretS3cretS3cretS3cretS3cretS3cretS3cr_t-';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setupApp(): Promise<RemoraApp> {
  const { url, drop } = await createTestDb();
  const app = await startRemora({ databaseUrl: url, importer });
  cleanups.push(async () => {
    await app.close();
    await drop();
  });
  return app;
}

async function inMemoryClient(app: RemoraApp): Promise<Client> {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(app);
  await server.connect(st);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(ct);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

async function seed(client: Client): Promise<void> {
  const r = await client.callTool({
    name: 'apply',
    arguments: {
      ops: [
        { op: 'create_entity', key: 'bob' },
        { op: 'create_property_type', name: 'job_title', description: 'Job title.', value_type: 'text', single_valued: true },
      ],
    },
  });
  expect(r.isError).toBe(false);
}

const nullFromOp = { op: 'add_property', entity: 'bob', property: 'nickname', value: 'x', time: { axis: 'game_day', from: null } };

describe('MCP tools (in-memory)', () => {
  it('lists apply and query with the contract schemas', async () => {
    const client = await inMemoryClient(await setupApp());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['apply', 'query']);
    const contract = JSON.parse(JSON.stringify(getContract()));
    for (const t of tools) {
      expect(t.inputSchema).toEqual(contract[t.name]);
      expect(t.description!.length).toBeGreaterThan(40);
    }
  });

  it('apply returns the envelope as structured and text content', async () => {
    const client = await inMemoryClient(await setupApp());
    const r = await client.callTool({ name: 'apply', arguments: { ops: [{ op: 'create_entity', key: 'carl' }] } });
    expect(r.isError).toBe(false);
    expect((r.structuredContent as { ok: boolean }).ok).toBe(true);
    const content = r.content as { type: string; text: string }[];
    expect(content).toHaveLength(1);
    expect(content[0]!.type).toBe('text');
    expect(JSON.parse(content[0]!.text)).toEqual(r.structuredContent);
  });

  it('query reads what apply wrote; a failing op is an isError envelope', async () => {
    const client = await inMemoryClient(await setupApp());
    await seed(client);
    const q = await client.callTool({ name: 'query', arguments: { ops: [{ op: 'get_entity', key: 'bob' }] } });
    expect(q.isError).toBe(false);
    expect((q.structuredContent as { ok: boolean }).ok).toBe(true);
    const nobody = await client.callTool({
      name: 'apply',
      arguments: { ops: [{ op: 'add_property', entity: 'nobody', property: 'job_title', value: 'x' }] },
    });
    expect(nobody.isError).toBe(true);
    expect((nobody.structuredContent as any).error.code).toBe('unknown_entity');
  });

  it('loose LLM input yields validation envelopes, not protocol errors', async () => {
    const client = await inMemoryClient(await setupApp());
    await seed(client);
    const depth = await client.callTool({ name: 'query', arguments: { ops: [{ op: 'neighbors', entity: 'bob', depth: '2' }] } });
    expect(depth.isError).toBe(true);
    const e1 = (depth.structuredContent as any).error;
    expect(e1).toMatchObject({ op_index: 0, code: 'invalid_param' });
    expect(e1.details.field).toBe('depth');

    const nf = await client.callTool({ name: 'apply', arguments: { ops: [nullFromOp] } });
    expect(nf.isError).toBe(true);
    expect((nf.structuredContent as any).error.code).toBe('invalid_time');

    const noOp = await client.callTool({ name: 'query', arguments: { ops: [{ entity: 'bob' }] } });
    expect(noOp.isError).toBe(true);
    expect((noOp.structuredContent as any).error).toMatchObject({ op_index: 0, code: 'invalid_param' });

    const unknown = await client.callTool({ name: 'drop_db', arguments: {} });
    expect(unknown.isError).toBe(true);
    expect((unknown.structuredContent as any).error.code).toBe('invalid_param');
  });

  it('a throwing app yields a generic internal envelope', async () => {
    const app = await setupApp();
    const broken = Object.create(app, {
      apply: {
        value: async () => {
          throw new Error('secret db detail');
        },
      },
    }) as RemoraApp;
    const client = await inMemoryClient(broken);
    const r = await client.callTool({ name: 'apply', arguments: { ops: [{ op: 'create_entity', key: 'x' }] } });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r)).not.toContain('secret db detail');
    expect((r.structuredContent as any).error.code).toBe('internal');
  });
});

interface HttpEnv {
  port: number;
  lines: string[];
  url(secret?: string): URL;
}

async function setupHttp(over: Partial<HttpOptions> = {}): Promise<HttpEnv> {
  const app = await setupApp();
  const lines: string[] = [];
  const logger = createLogger({ level: 'debug', write: (l) => lines.push(l) });
  const srv = createHttpServer(
    app,
    { secret: SECRET, maxBodyBytes: 1_048_576, requestTimeoutMs: 5_000, shutdownTimeoutMs: 2_000, ...over },
    logger,
  );
  const addr: AddressInfo = await srv.listen(0, '127.0.0.1');
  cleanups.push(() => srv.shutdown());
  return { port: addr.port, lines, url: (s = SECRET) => new URL(`http://127.0.0.1:${addr.port}/${s}/mcp`) };
}

async function httpClient(url: URL): Promise<Client> {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url));
  cleanups.push(() => client.close());
  return client;
}

function rawRequest(port: number, path: string, body: string, headers: Record<string, string> = {}, method = 'POST') {
  return new Promise<{ status: number; text: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, text: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

describe('MCP over Streamable HTTP', () => {
  it('lists tools and runs apply then query through the SDK client', async () => {
    const env = await setupHttp();
    const client = await httpClient(env.url());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['apply', 'query']);
    await seed(client);
    const q = await client.callTool({ name: 'query', arguments: { ops: [{ op: 'get_entity', key: 'bob' }] } });
    expect(q.isError).toBe(false);
    expect((q.structuredContent as any).ok).toBe(true);
    const bad = await client.callTool({ name: 'query', arguments: { ops: [{ op: 'neighbors', entity: 'bob', depth: '2' }] } });
    expect(bad.isError).toBe(true);
    expect((bad.structuredContent as any).error.details.field).toBe('depth');
  });

  it('a wrong secret is the same 404 as HTTP and the client cannot connect', async () => {
    const env = await setupHttp();
    const wrong = 'W'.repeat(SECRET.length);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await expect(client.connect(new StreamableHTTPClientTransport(env.url(wrong)))).rejects.toThrow();
    const r = await rawRequest(env.port, `/${wrong}/mcp`, '{}', { 'content-type': 'application/json' });
    expect(r.status).toBe(404);
    expect(JSON.parse(r.text)).toEqual({ ok: false, error: { op_index: -1, code: 'not_found', message: 'not found' } });
  });

  it('GET and DELETE are 405, non-JSON content type 415, bad JSON 400, oversized 413', async () => {
    const env = await setupHttp({ maxBodyBytes: 2000 });
    const path = `/${SECRET}/mcp`;
    expect((await rawRequest(env.port, path, '', {}, 'GET')).status).toBe(405);
    expect((await rawRequest(env.port, path, '', {}, 'DELETE')).status).toBe(405);
    expect((await rawRequest(env.port, path, '{}', { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await rawRequest(env.port, path, '{nope', { 'content-type': 'application/json' })).status).toBe(400);
    const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(5000) } });
    const r = await rawRequest(env.port, path, big, {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(big)),
    });
    expect(r.status).toBe(413);
  });

  it('logs the MCP route without the secret', async () => {
    const env = await setupHttp();
    const client = await httpClient(env.url());
    await client.listTools();
    const logs = env.lines.join('\n');
    expect(logs).toContain('/:secret/mcp');
    expect(logs).not.toContain(SECRET);
  });

  it('after shutdown starts, MCP requests are refused', async () => {
    const app = await setupApp();
    const logger = createLogger({ level: 'info', write: () => undefined });
    const srv = createHttpServer(
      app,
      { secret: SECRET, maxBodyBytes: 1_048_576, requestTimeoutMs: 5_000, shutdownTimeoutMs: 2_000 },
      logger,
    );
    const addr = await srv.listen(0, '127.0.0.1');
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${addr.port}/${SECRET}/mcp`)));
    await client.listTools();
    const down = srv.shutdown();
    await expect(client.listTools()).rejects.toThrow();
    await down;
    await client.close().catch(() => undefined);
  });
});

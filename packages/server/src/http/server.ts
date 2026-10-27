import { RemoraError, type ErrorCode } from '@remora/sdk';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import type { ApiError } from '../api/apply.js';
import type { RemoraApp } from '../app.js';
import { getContract } from '../contract/index.js';
import type { JsonLogger } from '../log.js';
import { handleMcp } from '../mcp/server.js';
import { runApply, runQuery } from '../transport/dispatch.js';
import { HttpError, readJsonBody } from './body.js';
import { isValidSecret, secretMatches } from './secret.js';
import { statusFor } from './status.js';

export interface HttpOptions {
  secret: string;
  adminSecret?: string;
  maxBodyBytes: number;
  requestTimeoutMs: number;
  shutdownTimeoutMs: number;
}

export interface RemoraHttpServer {
  server: http.Server;
  listen(port: number, host?: string): Promise<AddressInfo>;
  /** Stops serving, drains in-flight requests (bounded), closes connections. Does not close the app. */
  shutdown(): Promise<void>;
}

/** Per-request state shared with the access log. */
interface Ctx {
  requestId: string;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  route: string;
  ops?: number;
  code?: string;
  /** set when the response must not reuse the connection (unread request body) */
  close: boolean;
}

/** A route below `/<secret>/`. Task 8 adds `admin` to the table. */
interface Route {
  method: string;
  label: string;
  handle(ctx: Ctx, opts: HttpOptions): Promise<void>;
}

const HEALTH_TIMEOUT_MS = 3000;
/** After an early error response the unread upload is discarded (never buffered) for at most this long / many bytes. */
const LINGER_MS = 1000;
const LINGER_BYTES = 8 * 1024 * 1024;
const NOT_FOUND: ApiError = { op_index: -1, code: 'not_found', message: 'not found' };

function envelope(error: ApiError): { ok: false; error: ApiError } {
  return { ok: false, error };
}

export function createHttpServer(app: RemoraApp, opts: HttpOptions, logger: JsonLogger): RemoraHttpServer {
  if (!isValidSecret(opts.secret)) throw new RemoraError('invalid_config', 'REMORA_SECRET is not a valid secret');
  if (opts.adminSecret !== undefined) {
    if (!isValidSecret(opts.adminSecret)) throw new RemoraError('invalid_config', 'REMORA_ADMIN_SECRET is not a valid secret');
    if (opts.adminSecret === opts.secret) {
      throw new RemoraError('invalid_config', 'REMORA_ADMIN_SECRET must differ from REMORA_SECRET');
    }
  }
  if (!(opts.requestTimeoutMs > 0)) throw new RemoraError('invalid_config', 'request timeout must be positive');
  // our own body timer fires slightly before node's requestTimeout so the 408 envelope wins the race
  const bodyTimeoutMs = Math.max(1, Math.floor(opts.requestTimeoutMs * 0.9));
  let shuttingDown = false;
  let poolListening = false;
  let inflight = 0;
  let idle: (() => void) | undefined;
  let shutdownPromise: Promise<void> | undefined;

  const server = http.createServer({
    // the default check interval is 30 s; keep timeouts accurate for short limits
    connectionsCheckingInterval: Math.max(50, Math.min(5000, Math.floor(opts.requestTimeoutMs / 4))),
  });
  server.requestTimeout = opts.requestTimeoutMs;
  server.headersTimeout = Math.min(10_000, opts.requestTimeoutMs);
  server.keepAliveTimeout = 5000;

  function send(ctx: Ctx, status: number, body: unknown, headers: Record<string, string> = {}): void {
    const { res } = ctx;
    if (res.headersSent || res.writableEnded) return;
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('content-length', payload.length);
    res.setHeader('cache-control', 'no-store');
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    if (ctx.close || shuttingDown) res.setHeader('connection', 'close');
    if (ctx.close) lingerClose(ctx);
    if (typeof body === 'object' && body !== null && 'ok' in body && (body as { ok: unknown }).ok === false) {
      const err = (body as { error?: { code?: unknown } }).error;
      if (typeof err?.code === 'string') ctx.code = err.code;
    }
    res.end(payload);
  }

  /**
   * Closing a socket that still has unread upload data makes the OS reset it, which can destroy the
   * response before the client reads it. So: half-close after the response, discard what still
   * arrives (bounded in time and bytes), then destroy.
   */
  function lingerClose({ req, res }: Ctx): void {
    const socket = res.socket;
    if (!socket) return;
    // Node's resOnFinish (_http_server.js) calls socket.destroySoon() after a `Connection: close`
    // response; replacing it on this one socket is the only hook to linger instead of cutting.
    socket.destroySoon = () => {
      socket.end();
      let seen = 0;
      const stop = (): void => {
        clearTimeout(timer);
        socket.destroy();
      };
      const timer = setTimeout(stop, LINGER_MS);
      timer.unref();
      req.on('data', (c: Buffer) => {
        seen += c.length;
        if (seen > LINGER_BYTES) stop();
      });
      req.resume();
      socket.once('close', () => clearTimeout(timer));
    };
  }

  const sendError = (ctx: Ctx, status: number, error: ApiError, headers?: Record<string, string>): void =>
    send(ctx, status, envelope(error), headers);

  const notFound = (ctx: Ctx): void => sendError(ctx, 404, NOT_FOUND);

  function envelopeStatus(r: { ok: boolean; error?: ApiError }): number {
    return r.ok ? 200 : statusFor(r.error!.code);
  }

  const countOps = (body: unknown): number | undefined =>
    typeof body === 'object' && body !== null && Array.isArray((body as { ops?: unknown }).ops)
      ? (body as { ops: unknown[] }).ops.length
      : undefined;

  const routes = new Map<string, Route>([
    [
      'apply',
      {
        method: 'POST',
        label: '/:secret/apply',
        async handle(ctx, o) {
          const body = await readJsonBody(ctx.req, o.maxBodyBytes, bodyTimeoutMs);
          const ops = countOps(body);
          if (ops !== undefined) ctx.ops = ops;
          const r = await runApply(app, body);
          send(ctx, envelopeStatus(r), r);
        },
      },
    ],
    [
      'query',
      {
        method: 'POST',
        label: '/:secret/query',
        async handle(ctx, o) {
          const body = await readJsonBody(ctx.req, o.maxBodyBytes, bodyTimeoutMs);
          const ops = countOps(body);
          if (ops !== undefined) ctx.ops = ops;
          const r = await runQuery(app, body);
          send(ctx, envelopeStatus(r), r);
        },
      },
    ],
    [
      'mcp',
      {
        method: 'POST',
        label: '/:secret/mcp',
        async handle(ctx, o) {
          // same body limit, content-type check and slow-body timer as the JSON routes
          const body = await readJsonBody(ctx.req, o.maxBodyBytes, bodyTimeoutMs);
          await handleMcp(app, ctx.req, ctx.res, body, {
            onError: (e) => logger.error('mcp error', { request_id: ctx.requestId, error: e instanceof Error ? e.name : typeof e }),
          });
        },
      },
    ],
    [
      'schema',
      {
        method: 'GET',
        label: '/:secret/schema',
        async handle(ctx) {
          send(ctx, 200, getContract());
        },
      },
    ],
  ]);

  async function health(ctx: Ctx): Promise<void> {
    ctx.route = '/health';
    if (ctx.req.method !== 'GET') return sendError(ctx, 405, methodNotAllowed(), { allow: 'GET' });
    if (shuttingDown) return send(ctx, 503, { status: 'shutting_down' });
    let timer: NodeJS.Timeout | undefined;
    try {
      const probe = app.pool.query('SELECT 1');
      probe.catch(() => undefined);
      await Promise.race([
        probe,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('health probe timed out')), HEALTH_TIMEOUT_MS);
        }),
      ]);
    } catch {
      return send(ctx, 503, { status: 'unavailable' });
    } finally {
      if (timer) clearTimeout(timer);
    }
    const degraded = app.registry.status().some((s) => !s.ok);
    send(ctx, 200, { status: degraded ? 'degraded' : 'ok' });
  }

  const methodNotAllowed = (): ApiError => ({ op_index: -1, code: 'invalid_param', message: 'method not allowed' });

  async function route(ctx: Ctx): Promise<void> {
    const { req } = ctx;
    // a request that carries a body we are not going to read must not keep the connection
    ctx.close = req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] ?? 0) > 0;

    const target = req.url ?? '';
    const cut = target.search(/[?#]/);
    const path = cut === -1 ? target : target.slice(0, cut);

    if (shuttingDown) {
      ctx.route = path === '/health' ? '/health' : '(unmatched)';
      if (path === '/health') return send(ctx, 503, { status: 'shutting_down' });
      return sendError(ctx, 503, {
        op_index: -1,
        code: 'internal',
        message: 'server is shutting down',
        details: { reason: 'shutting_down' },
      });
    }
    if (path === '/health') {
      return health(ctx);
    }
    if (!path.startsWith('/')) return notFound(ctx);

    const segs = path.slice(1).split('/');
    // always compare, whatever the shape of the path
    const matched = secretMatches(segs[0] ?? '', opts.secret);
    const r = matched && segs.length === 2 ? routes.get(segs[1]!) : undefined;
    if (!r) return notFound(ctx);

    ctx.route = r.label;
    if (req.method !== r.method) return sendError(ctx, 405, methodNotAllowed(), { allow: r.method });
    if (r.method === 'POST') ctx.close = false; // the body is read (or fails and sets close itself)
    await r.handle(ctx, opts);
  }

  function onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const started = process.hrtime.bigint();
    const ctx: Ctx = { requestId: randomUUID(), req, res, route: '(unmatched)', close: false };
    res.setHeader('x-request-id', ctx.requestId);
    // requests that arrive during shutdown (answered 503 at once) are not drained
    const counted = !shuttingDown;
    if (counted) inflight++;
    res.once('close', () => {
      logger.info('request', {
        request_id: ctx.requestId,
        method: req.method,
        route: ctx.route,
        status: res.writableFinished ? res.statusCode : 'aborted',
        ms: Number(process.hrtime.bigint() - started) / 1e6,
        ...(ctx.ops !== undefined ? { ops: ctx.ops } : {}),
        ...(ctx.code !== undefined ? { code: ctx.code } : {}),
      });
    });

    route(ctx)
      .catch((e: unknown) => {
        if (e instanceof HttpError) {
          if (e.closeConnection) ctx.close = true;
          return sendError(ctx, e.status, { op_index: -1, code: e.code as ErrorCode, message: e.message });
        }
        // nothing about the failure reaches the client; only the error name goes to the info log
        // (messages can echo request data), the stack only to debug
        const name = e instanceof Error ? e.name : typeof e;
        logger.error('unhandled error', { request_id: ctx.requestId, route: ctx.route, error: name });
        if (e instanceof Error) logger.debug('unhandled error stack', { request_id: ctx.requestId, stack: e.stack });
        ctx.close = true;
        sendError(ctx, 500, {
          op_index: -1,
          code: 'internal',
          message: 'internal error',
          details: { request_id: ctx.requestId },
        });
      })
      .finally(() => {
        // the handler's DB work is done here (also after a client abort), so app.close() is safe
        if (!counted) return;
        inflight--;
        if (inflight === 0) idle?.();
      });
  }
  server.on('request', onRequest);
  server.on('error', (e) => logger.error('http server error', { error: e.message }));

  const onPoolError = (e: Error): void => logger.error('database pool error', { error: e.message });

  return {
    server,
    async listen(port, host) {
      await new Promise<void>((resolve, reject) => {
        const fail = (e: Error): void => reject(e);
        server.once('error', fail);
        server.listen(port, host, () => {
          server.off('error', fail);
          resolve();
        });
      });
      if (!poolListening) {
        poolListening = true;
        app.pool.on('error', onPoolError);
      }
      return server.address() as AddressInfo;
    },
    shutdown() {
      return (shutdownPromise ??= (async () => {
        shuttingDown = true;
        // stop listening only: idle keep-alive sockets stay and keep answering 503 until the drain ends
        const closed = new Promise<void>((resolve) => net.Server.prototype.close.call(server, () => resolve()));
        let drained = inflight === 0;
        if (!drained) {
          drained = await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => {
              idle = undefined;
              resolve(false);
            }, opts.shutdownTimeoutMs);
            idle = () => {
              clearTimeout(timer);
              idle = undefined;
              resolve(true);
            };
          });
        }
        if (!drained) logger.warn('shutdown timeout, closing remaining connections', { inflight });
        server.closeIdleConnections();
        if (!drained) {
          server.closeAllConnections();
        } else {
          // responses sent while shutting down carry `Connection: close`; give them a moment, then cut
          const grace = setTimeout(() => server.closeAllConnections(), 1000);
          await closed;
          clearTimeout(grace);
        }
        await closed;
        if (poolListening) {
          poolListening = false;
          app.pool.off('error', onPoolError);
        }
      })());
    },
  };
}

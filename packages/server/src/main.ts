import { RemoraError } from '@remora/sdk';
import { pathToFileURL } from 'node:url';
import { startRemora, type RemoraApp } from './app.js';
import { loadConfig } from './config.js';
import { createHttpServer } from './http/server.js';
import { generateSecret } from './http/secret.js';
import { createLogger } from './log.js';

/** R43 entry point: `gen-secret` prints a secret; otherwise configure, start, listen and serve until a signal. */
export async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<void> {
  if (argv[0] === 'gen-secret') {
    process.stdout.write(`${generateSecret()}\n`);
    return;
  }
  const bootLog = createLogger({ level: 'info' });
  let app: RemoraApp | undefined;
  try {
    const config = loadConfig(env);
    const logger = createLogger({ level: config.logLevel });
    if (config.adminSecret === undefined) {
      logger.warn('REMORA_ADMIN_SECRET is not set: admin routes are disabled');
    }
    app = await startRemora({
      databaseUrl: config.databaseUrl,
      pluginsDir: config.pluginsDir,
      statementTimeoutMs: config.statementTimeoutMs,
      logger,
    });
    const started = app;
    const http = createHttpServer(
      started,
      {
        secret: config.secret,
        adminSecret: config.adminSecret,
        maxBodyBytes: config.maxBodyBytes,
        requestTimeoutMs: config.requestTimeoutMs,
        shutdownTimeoutMs: config.shutdownTimeoutMs,
      },
      logger,
    );
    const addr = await http.listen(config.port, config.host);
    logger.info('listening', { port: addr.port });
    let stopping = false;
    const stop = (signal: string): void => {
      if (stopping) return;
      stopping = true;
      logger.info('shutting down', { signal });
      http
        .shutdown()
        .then(() => started.close())
        .then(
          () => {
            process.exitCode = 0;
          },
          (e: unknown) => {
            logger.error('shutdown failed', e);
            process.exitCode = 1;
          },
        );
    };
    process.once('SIGTERM', () => stop('SIGTERM'));
    process.once('SIGINT', () => stop('SIGINT'));
  } catch (e) {
    bootLog.error('startup failed', {
      error: e instanceof Error ? e.message : String(e),
      ...(e instanceof RemoraError ? { code: e.code, details: e.details } : {}),
    });
    process.exitCode = 1;
    await app?.close().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2), process.env);
}

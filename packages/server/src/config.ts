import { RemoraError } from '@remora/sdk';
import { resolve } from 'node:path';
import { isValidSecret } from './http/secret.js';
import type { LogLevel } from './log.js';

export interface RemoraConfig {
  databaseUrl: string;
  host: string;
  port: number;
  secret: string;
  adminSecret?: string;
  pluginsDir: string;
  maxBodyBytes: number;
  requestTimeoutMs: number;
  statementTimeoutMs: number;
  shutdownTimeoutMs: number;
  dbConnectTimeoutMs: number;
  maxConnections: number;
  logLevel: LogLevel;
}

const LEVELS: readonly string[] = ['debug', 'info', 'warn', 'error'];

/** Violations name the variable and never include its value (secrets). */
function bad(variable: string, what: string): RemoraError {
  return new RemoraError('invalid_config', `${variable} ${what}`, { variable });
}

function required(env: NodeJS.ProcessEnv, variable: string): string {
  const v = env[variable];
  if (v === undefined || v === '') throw bad(variable, 'is required');
  return v;
}

function integer(env: NodeJS.ProcessEnv, variable: string, def: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const raw = env[variable];
  if (raw === undefined || raw === '') return def;
  if (!/^\d+$/.test(raw)) throw bad(variable, 'must be a non-negative integer');
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw bad(variable, `must be an integer from ${min} to ${max}`);
  return n;
}

/** R29/R30/R41: environment configuration. */
export function loadConfig(env: NodeJS.ProcessEnv, cwd: string = process.cwd()): RemoraConfig {
  const databaseUrl = required(env, 'DATABASE_URL');
  const secret = required(env, 'REMORA_SECRET');
  if (!isValidSecret(secret)) throw bad('REMORA_SECRET', 'must be at least 43 characters of [A-Za-z0-9_-] (see gen-secret)');
  const adminRaw = env.REMORA_ADMIN_SECRET;
  let adminSecret: string | undefined;
  if (adminRaw !== undefined && adminRaw !== '') {
    if (!isValidSecret(adminRaw)) throw bad('REMORA_ADMIN_SECRET', 'must be at least 43 characters of [A-Za-z0-9_-] (see gen-secret)');
    if (adminRaw === secret) throw bad('REMORA_ADMIN_SECRET', 'must differ from REMORA_SECRET');
    adminSecret = adminRaw;
  }
  const level = env.LOG_LEVEL === undefined || env.LOG_LEVEL === '' ? 'info' : env.LOG_LEVEL;
  if (!LEVELS.includes(level)) throw bad('LOG_LEVEL', `must be one of ${LEVELS.join(', ')}`);
  return {
    databaseUrl,
    host: env.HOST || '127.0.0.1',
    port: integer(env, 'PORT', 8080, 0, 65535),
    secret,
    adminSecret,
    pluginsDir: resolve(cwd, env.PLUGINS_DIR || 'plugins'),
    maxBodyBytes: integer(env, 'REMORA_MAX_BODY_BYTES', 1_048_576, 1),
    requestTimeoutMs: integer(env, 'REMORA_REQUEST_TIMEOUT_MS', 30_000, 1),
    statementTimeoutMs: integer(env, 'REMORA_STATEMENT_TIMEOUT_MS', 30_000, 0),
    shutdownTimeoutMs: integer(env, 'REMORA_SHUTDOWN_TIMEOUT_MS', 10_000, 0),
    dbConnectTimeoutMs: integer(env, 'REMORA_DB_CONNECT_TIMEOUT_MS', 10_000, 1),
    maxConnections: integer(env, 'REMORA_MAX_CONNECTIONS', 1024, 1),
    logLevel: level as LogLevel,
  };
}

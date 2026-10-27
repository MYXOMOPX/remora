import { RemoraError } from '@remora/sdk';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { generateSecret } from '../src/http/secret.js';

const secret = generateSecret();
const base = { DATABASE_URL: 'postgres://u:p@localhost/db', REMORA_SECRET: secret };

function fails(env: NodeJS.ProcessEnv): RemoraError {
  try {
    loadConfig(env, '/work');
  } catch (e) {
    expect(e).toBeInstanceOf(RemoraError);
    return e as RemoraError;
  }
  throw new Error('expected loadConfig to throw');
}

describe('loadConfig', () => {
  it('applies defaults for a minimal env', () => {
    expect(loadConfig(base, '/work')).toEqual({
      databaseUrl: base.DATABASE_URL,
      host: '0.0.0.0',
      port: 8080,
      secret,
      adminSecret: undefined,
      pluginsDir: expect.stringMatching(/plugins$/),
      maxBodyBytes: 1048576,
      requestTimeoutMs: 30000,
      statementTimeoutMs: 30000,
      shutdownTimeoutMs: 10000,
      logLevel: 'info',
    });
  });

  it('reads every variable', () => {
    const admin = generateSecret();
    const c = loadConfig(
      {
        ...base,
        HOST: '127.0.0.1',
        PORT: '0',
        REMORA_ADMIN_SECRET: admin,
        PLUGINS_DIR: '/p',
        REMORA_MAX_BODY_BYTES: '10',
        REMORA_REQUEST_TIMEOUT_MS: '5',
        REMORA_STATEMENT_TIMEOUT_MS: '0',
        REMORA_SHUTDOWN_TIMEOUT_MS: '7',
        LOG_LEVEL: 'debug',
      },
      '/work',
    );
    expect(c).toMatchObject({
      host: '127.0.0.1',
      port: 0,
      adminSecret: admin,
      maxBodyBytes: 10,
      requestTimeoutMs: 5,
      statementTimeoutMs: 0,
      shutdownTimeoutMs: 7,
      logLevel: 'debug',
    });
    expect(c.pluginsDir).toMatch(/p$/);
  });

  it('missing DATABASE_URL names the variable', () => {
    const e = fails({ REMORA_SECRET: secret });
    expect(e.code).toBe('invalid_config');
    expect(e.details).toMatchObject({ variable: 'DATABASE_URL' });
  });

  it('missing or short secret is invalid and never echoed', () => {
    expect(fails({ DATABASE_URL: base.DATABASE_URL }).details).toMatchObject({ variable: 'REMORA_SECRET' });
    const e = fails({ ...base, REMORA_SECRET: 'tooshort-secret' });
    expect(e.code).toBe('invalid_config');
    expect(e.message).not.toContain('tooshort-secret');
  });

  it('admin secret must be valid and differ from the main one', () => {
    expect(fails({ ...base, REMORA_ADMIN_SECRET: secret }).details).toMatchObject({ variable: 'REMORA_ADMIN_SECRET' });
    const e = fails({ ...base, REMORA_ADMIN_SECRET: 'bad admin!' });
    expect(e.message).not.toContain('bad admin!');
  });

  it.each([
    ['PORT', 'x'],
    ['PORT', '65536'],
    ['PORT', '-1'],
    ['LOG_LEVEL', 'loud'],
    ['REMORA_REQUEST_TIMEOUT_MS', '0'],
    ['REMORA_MAX_BODY_BYTES', '1.5'],
    ['REMORA_STATEMENT_TIMEOUT_MS', '-1'],
    ['REMORA_SHUTDOWN_TIMEOUT_MS', 'abc'],
  ])('%s=%s is invalid_config', (variable, value) => {
    const e = fails({ ...base, [variable]: value });
    expect(e.code).toBe('invalid_config');
    expect(e.details).toMatchObject({ variable });
  });
});

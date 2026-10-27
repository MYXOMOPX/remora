import { join } from 'node:path';
import { RemoraError } from '@remora/sdk';
import pg from 'pg';
import { apply, type ApplyResponse } from './api/apply.js';
import { query, type QueryResponse } from './api/query.js';
import { runMigrations } from './db/migrate.js';
import {
  applyRetention,
  pinEvidence,
  purgeEvidence,
  unpinEvidence,
  type PurgeArgs,
  type RetentionReport,
} from './services/evidence-maintenance.js';
import {
  listPlugins,
  removePlugin,
  setPluginConfig,
  type PluginListRow,
} from './services/plugins-admin.js';
import {
  addPlugin,
  CORE_PLUGIN_NAME,
  loadPlugins,
  type Importer,
  type Logger,
  type PluginRegistry,
} from './plugins/registry.js';
import { pluginImporter } from './plugins/resolve.js';

export interface StartOptions {
  databaseUrl: string;
  importer?: Importer;
  logger?: Logger;
  migrationsDir?: string;
  /** pool statement_timeout in ms (R41); omitted = server default, 0 = disabled */
  statementTimeoutMs?: number;
  /** plugin directory (used by directory loading) */
  pluginsDir?: string;
  /** max wait for the startup advisory lock held by another replica, ms (default 600000) */
  startupLockTimeoutMs?: number;
}

export interface RemoraApp {
  pool: pg.Pool;
  registry: PluginRegistry;
  importer: Importer;
  addPlugin(a: { package: string }): Promise<{ id: number; name: string }>;
  listPlugins(): Promise<PluginListRow[]>;
  setPluginConfig(a: { name: string; config: unknown; confirm?: boolean }): Promise<{ name: string; restartRequired: true }>;
  removePlugin(name: string): Promise<{ name: string; restartRequired: true }>;
  apply(request: unknown): Promise<ApplyResponse>;
  query(request: unknown): Promise<QueryResponse>;
  applyRetention(a?: { source?: string; batchSize?: number; now?: Date }): Promise<RetentionReport>;
  purgeEvidence(a: PurgeArgs): Promise<{ purged: number; skippedPinned: number }>;
  pinEvidence(id: bigint): Promise<void>;
  unpinEvidence(id: bigint): Promise<void>;
  close(): Promise<void>;
}

export async function startRemora(opts: StartOptions): Promise<RemoraApp> {
  const pool = new pg.Pool({
    connectionString: opts.databaseUrl,
    ...(opts.statementTimeoutMs ? { statement_timeout: opts.statementTimeoutMs } : {}),
    // 0 must really disable: pg skips a falsy statement_timeout, so a database default would win
    ...(opts.statementTimeoutMs === 0 ? { options: '-c statement_timeout=0' } : {}),
  });
  // an idle client can emit 'error' (server restart, network); without a listener that crashes the process.
  // The listener stays after app.close().
  pool.on('error', (e) => opts.logger?.error('database pool error', e));
  try {
    const importer = opts.importer ?? pluginImporter(opts.pluginsDir ?? join(process.cwd(), 'plugins'));
    const registry = await startUnderLock(pool, opts, importer);
    let closing: Promise<void> | undefined;
    return {
      pool,
      registry,
      importer,
      addPlugin: (a) => addPlugin(pool, a, importer),
      listPlugins: () => listPlugins(pool, registry),
      setPluginConfig: (a) => setPluginConfig(pool, importer, a),
      removePlugin: (name) => removePlugin(pool, name),
      apply: (request) => apply(pool, registry, request),
      query: (request) => query(pool, registry, request),
      applyRetention: (a) => applyRetention(pool, registry, a),
      purgeEvidence: (a) => purgeEvidence(pool, a),
      pinEvidence: (id) => pinEvidence(pool, id),
      unpinEvidence: (id) => unpinEvidence(pool, id),
      close: () => (closing ??= pool.end()),
    };
  } catch (e) {
    await pool.end();
    throw e;
  }
}

/** R39: serialise migrations, core registration and plugin loading across replicas. */
async function startUnderLock(pool: pg.Pool, opts: StartOptions, importer: Importer): Promise<PluginRegistry> {
  const client = await pool.connect();
  let destroy: Error | undefined;
  // an error while we wait for the lock must reject the start, not crash the process
  client.on('error', (e) => {
    destroy ??= e;
    opts.logger?.error('database connection error during startup', e);
  });
  try {
    // startup may legitimately wait for another replica or run long migrations
    await client.query('SET statement_timeout = 0');
    await acquireStartupLock(client, opts);
    try {
      await runMigrations(client, opts.migrationsDir);
      const core = await client.query('SELECT 1 FROM plugin WHERE name = $1', [CORE_PLUGIN_NAME]);
      if (!core.rowCount) {
        await addPlugin(client, { package: '@remora/core-plugin' }, importer);
      }
      return await loadPlugins(client, { importer, logger: opts.logger });
    } finally {
      try {
        await client.query(`SELECT pg_advisory_unlock(hashtextextended('remora:startup', 0))`);
        await client.query('RESET statement_timeout');
      } catch (e) {
        destroy = e instanceof Error ? e : new Error(String(e));
      }
    }
  } catch (e) {
    destroy ??= e instanceof Error ? e : new Error(String(e));
    throw e;
  } finally {
    client.release(destroy);
  }
}

const LOCK_POLL_MS = 250;
const LOCK_WARN_EVERY_MS = 30_000;

/** Polls pg_try_advisory_lock so the wait is logged and bounded. */
async function acquireStartupLock(client: pg.PoolClient, opts: StartOptions): Promise<void> {
  const limit = opts.startupLockTimeoutMs ?? 600_000;
  const started = Date.now();
  let nextWarn = 0;
  for (;;) {
    const r = await client.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(hashtextextended('remora:startup', 0)) AS ok`);
    if (r.rows[0]?.ok) return;
    const waited = Date.now() - started;
    if (waited >= limit) {
      throw new RemoraError('timeout', 'timed out waiting for the startup lock held by another replica', { waited_ms: waited });
    }
    if (waited >= nextWarn) {
      opts.logger?.warn('waiting for startup lock held by another replica', { waited_ms: waited });
      nextWarn = waited + LOCK_WARN_EVERY_MS;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(LOCK_POLL_MS, Math.max(1, limit - waited))));
  }
}

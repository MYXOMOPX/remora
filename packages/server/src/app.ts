import pg from 'pg';
import corePlugin from '@remora/core-plugin';
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
  addPlugin,
  CORE_PLUGIN_NAME,
  loadPlugins,
  defaultImporter,
  type Importer,
  type Logger,
  type PluginRegistry,
} from './plugins/registry.js';

export interface StartOptions {
  databaseUrl: string;
  importer?: Importer;
  logger?: Logger;
  migrationsDir?: string;
  /** pool statement_timeout in ms (R41); omitted = server default, 0 = disabled */
  statementTimeoutMs?: number;
  /** plugin directory (used by directory loading) */
  pluginsDir?: string;
}

export interface RemoraApp {
  pool: pg.Pool;
  registry: PluginRegistry;
  apply(request: unknown): Promise<ApplyResponse>;
  query(request: unknown): Promise<QueryResponse>;
  applyRetention(a?: { source?: string; batchSize?: number; now?: Date }): Promise<RetentionReport>;
  purgeEvidence(a: PurgeArgs): Promise<{ purged: number; skippedPinned: number }>;
  pinEvidence(id: bigint): Promise<void>;
  unpinEvidence(id: bigint): Promise<void>;
  close(): Promise<void>;
}

const bundledImporter: Importer = async (spec) =>
  spec === '@remora/core-plugin' ? corePlugin : defaultImporter(spec);

export async function startRemora(opts: StartOptions): Promise<RemoraApp> {
  const pool = new pg.Pool({
    connectionString: opts.databaseUrl,
    ...(opts.statementTimeoutMs !== undefined ? { statement_timeout: opts.statementTimeoutMs } : {}),
  });
  try {
    const importer = opts.importer ?? bundledImporter;
    const registry = await startUnderLock(pool, opts, importer);
    let closing: Promise<void> | undefined;
    return {
      pool,
      registry,
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
  try {
    // startup may legitimately wait for another replica or run long migrations
    await client.query('SET statement_timeout = 0');
    await client.query(`SELECT pg_advisory_lock(hashtextextended('remora:startup', 0))`);
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

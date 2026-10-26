import pg from 'pg';
import { runMigrations } from './db/migrate.js';
import {
  addPlugin,
  CORE_PLUGIN_NAME,
  loadPlugins,
  type Importer,
  type Logger,
  type PluginRegistry,
} from './plugins/registry.js';

export interface StartOptions {
  databaseUrl: string;
  importer?: Importer;
  logger?: Logger;
  migrationsDir?: string;
}

export interface RemoraApp {
  pool: pg.Pool;
  registry: PluginRegistry;
  close(): Promise<void>;
}

export async function startRemora(opts: StartOptions): Promise<RemoraApp> {
  const pool = new pg.Pool({ connectionString: opts.databaseUrl });
  try {
    await runMigrations(pool, opts.migrationsDir);
    const core = await pool.query('SELECT 1 FROM plugin WHERE name = $1', [CORE_PLUGIN_NAME]);
    if (!core.rowCount) {
      await addPlugin(pool, { package: '@remora/core-plugin' }, opts.importer);
    }
    const registry = await loadPlugins(pool, { importer: opts.importer, logger: opts.logger });
    return { pool, registry, close: () => pool.end() };
  } catch (e) {
    await pool.end();
    throw e;
  }
}

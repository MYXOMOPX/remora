import { RemoraError, type PluginDef } from '@remora/sdk';
import type pg from 'pg';
import { mapPgError, rollback } from '../api/apply.js';
import type { Queryable } from '../db/types.js';
import {
  asPluginDef,
  assertNameFree,
  assertUniqueNames,
  checkConfig,
  CORE_PLUGIN_NAME,
  validateSetupResult,
  type Importer,
  type PluginRegistry,
} from '../plugins/registry.js';

export interface PluginListRow {
  id: number;
  name: string;
  package: string;
  config: unknown;
  status: 'ok' | 'degraded' | 'pending_restart';
  error?: string;
  axes: string[];
  sources: string[];
}

/**
 * R40 list_plugins: `pending_restart` = a row whose name this process did not load at start.
 * Matching is by name only: a plugin removed and re-added under the same name between restarts,
 * or one whose config was changed, still shows its loaded status until the restart.
 */
export async function listPlugins(db: Queryable, registry: PluginRegistry): Promise<PluginListRow[]> {
  const status = new Map(registry.status().map((s) => [s.name, s]));
  const { rows } = await db.query<{
    id: number;
    name: string;
    package: string;
    config: unknown;
    axes: string[];
    sources: string[];
  }>(
    `SELECT p.id, p.name, p.package, p.config,
            ARRAY(SELECT name FROM time_axis WHERE plugin_id = p.id ORDER BY name) AS axes,
            ARRAY(SELECT name FROM evidence_source WHERE plugin_id = p.id ORDER BY name) AS sources
       FROM plugin p ORDER BY p.id`,
  );
  return rows.map((r) => {
    const s = status.get(r.name);
    const row: PluginListRow = {
      id: r.id,
      name: r.name,
      package: r.package,
      config: r.config,
      status: s === undefined ? 'pending_restart' : s.ok ? 'ok' : 'degraded',
      axes: r.axes,
      sources: r.sources,
    };
    if (s !== undefined && !s.ok && s.error !== undefined) row.error = s.error;
    return row;
  });
}

interface PluginRow {
  id: number;
  name: string;
}

/**
 * Axes and sources of a plugin that hold data (property/relation/event times; evidence rows).
 * Cost: property_version, relation and evidence_log have no index leading with time_axis /
 * source_id, so a plugin without data costs a sequential scan of those tables. This runs only
 * for operator calls; add indexes if it ever matters.
 */
async function ownedWithData(
  db: Queryable,
  pluginId: number,
): Promise<{ axes: string[]; sources: string[]; allAxes: string[]; allSources: string[] }> {
  const axes = await db.query<{ name: string; has_data: boolean }>(
    `SELECT ta.name,
            (EXISTS (SELECT 1 FROM property_version WHERE time_axis = ta.id)
             OR EXISTS (SELECT 1 FROM relation WHERE time_axis = ta.id)
             OR EXISTS (SELECT 1 FROM event_time WHERE time_axis = ta.id)) AS has_data
       FROM time_axis ta WHERE ta.plugin_id = $1 ORDER BY ta.name`,
    [pluginId],
  );
  const sources = await db.query<{ name: string; has_data: boolean }>(
    `SELECT es.name, EXISTS (SELECT 1 FROM evidence_log WHERE source_id = es.id) AS has_data
       FROM evidence_source es WHERE es.plugin_id = $1 ORDER BY es.name`,
    [pluginId],
  );
  return {
    axes: axes.rows.filter((r) => r.has_data).map((r) => r.name),
    sources: sources.rows.filter((r) => r.has_data).map((r) => r.name),
    allAxes: axes.rows.map((r) => r.name),
    allSources: sources.rows.map((r) => r.name),
  };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * R40 set_plugin_config. Validates against the importer's module, which is the one cached by
 * this process: after the package files change on disk the answer stays stale until restart.
 * The new config takes effect after a restart.
 */
export async function setPluginConfig(
  db: Queryable,
  importer: Importer,
  a: { name: string; config: unknown; confirm?: boolean },
): Promise<{ name: string; restartRequired: true }> {
  const found = await db.query<PluginRow & { package: string }>('SELECT id, name, package FROM plugin WHERE name = $1', [
    a.name,
  ]);
  const row = found.rows[0];
  if (row === undefined) throw new RemoraError('not_found', `plugin ${a.name} not found`);
  let def: PluginDef;
  try {
    def = asPluginDef(await importer(row.package), row.package);
  } catch (e) {
    if (e instanceof RemoraError) throw e;
    throw new RemoraError('invalid_plugin', `cannot load package ${row.package}: ${errMsg(e)}`);
  }
  if (def.name !== row.name) {
    throw new RemoraError('invalid_plugin', `package ${row.package} exports plugin ${def.name}, expected ${row.name}`);
  }
  checkConfig(def, a.config, `config of ${row.name}`);
  const setup = (() => {
    try {
      // a copy: setup() must not be able to alter the config that is stored
      return validateSetupResult(def.setup(structuredClone(a.config)), row.name);
    } catch (e) {
      if (e instanceof RemoraError) throw e;
      throw new RemoraError('invalid_config', `setup of ${row.name} rejected the config: ${errMsg(e)}`);
    }
  })();
  assertUniqueNames(setup, row.name);
  for (const x of setup.timeAxes ?? []) await assertNameFree(db, 'time_axis', x.name, row.id);
  for (const x of setup.evidenceSources ?? []) await assertNameFree(db, 'evidence_source', x.name, row.id);

  const data = await ownedWithData(db, row.id);
  if ((data.axes.length > 0 || data.sources.length > 0) && a.confirm !== true) {
    throw new RemoraError(
      'invalid_param',
      'the plugin owns data; a config change may change its encoding, pass confirm: true to store it',
      { reason: 'confirm_required', affected: { axes: data.axes, sources: data.sources } },
    );
  }
  const upd = await db.query('UPDATE plugin SET config = $2::jsonb WHERE id = $1', [row.id, JSON.stringify(a.config)]);
  if (upd.rowCount === 0) throw new RemoraError('not_found', `plugin ${a.name} not found`);
  return { name: row.name, restartRequired: true };
}

/** R40 remove_plugin: refuses the core plugin and any plugin whose axes or sources hold data. */
export async function removePlugin(pool: pg.Pool, name: string): Promise<{ name: string; restartRequired: true }> {
  if (name === CORE_PLUGIN_NAME) throw new RemoraError('invalid_plugin', 'the core plugin cannot be removed');
  const client = await pool.connect();
  let destroy: Error | undefined;
  try {
    await client.query('BEGIN');
    const found = await client.query<PluginRow>('SELECT id, name FROM plugin WHERE name = $1 FOR UPDATE', [name]);
    const row = found.rows[0];
    if (row === undefined) throw new RemoraError('not_found', `plugin ${name} not found`);
    const data = await ownedWithData(client, row.id);
    if (data.axes.length > 0 || data.sources.length > 0) {
      throw new RemoraError('invalid_param', `plugin ${name} owns data and cannot be removed`, {
        reason: 'has_data',
        axes: data.axes,
        sources: data.sources,
      });
    }
    await client.query('DELETE FROM time_axis WHERE plugin_id = $1', [row.id]);
    await client.query('DELETE FROM evidence_source WHERE plugin_id = $1', [row.id]);
    await client.query('DELETE FROM plugin WHERE id = $1', [row.id]);
    await client.query('COMMIT');
    return { name: row.name, restartRequired: true };
  } catch (e) {
    destroy = await rollback(client);
    if (e instanceof RemoraError) throw e;
    // a row written concurrently after the data check: still a has_data refusal
    if ((e as { code?: unknown } | null)?.code === '23503') {
      throw new RemoraError('invalid_param', `plugin ${name} owns data and cannot be removed`, { reason: 'has_data' });
    }
    throw mapPgError(e) ?? e;
  } finally {
    client.release(destroy);
  }
}

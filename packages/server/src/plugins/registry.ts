import { Ajv } from 'ajv';
import {
  RemoraError,
  type EvidenceSourceDef,
  type PluginDef,
  type TimeAxisDef,
} from '@remora/sdk';
import type { Queryable } from '../db/types.js';

export type Importer = (spec: string) => Promise<unknown>;

export interface Logger {
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

export const CORE_PLUGIN_NAME = 'remora-core';

export interface PluginRegistry {
  getAxis(name: string): { id: number; def: TimeAxisDef };
  status(): { name: string; ok: boolean; error?: string }[];
}

const defaultImporter: Importer = async (spec) => ((await import(spec)) as { default: unknown }).default;

const ajv = new Ajv();

function checkConfig(def: PluginDef, config: unknown, what: string): void {
  let ok: boolean;
  let detail: string;
  try {
    const validate = ajv.compile(def.configSchema);
    ok = validate(config) as boolean;
    detail = ajv.errorsText(validate.errors);
  } catch (e) {
    throw new RemoraError('invalid_config', `${what}: configSchema is not a valid schema: ${errMsg(e)}`);
  }
  if (!ok) throw new RemoraError('invalid_config', `${what}: ${detail}`);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function asPluginDef(raw: unknown, spec: string): PluginDef {
  const d = raw as Partial<PluginDef> | null | undefined;
  if (
    d === null ||
    typeof d !== 'object' ||
    typeof d.name !== 'string' ||
    d.name === '' ||
    typeof d.setup !== 'function' ||
    d.configSchema === null ||
    typeof d.configSchema !== 'object'
  ) {
    throw new RemoraError('invalid_plugin', `package ${spec}: default export must have name, configSchema and setup`);
  }
  return d as PluginDef;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateSetupResult(raw: unknown, plugin: string): ReturnType<PluginDef['setup']> {
  const bad = (reason: string) =>
    new RemoraError('invalid_plugin', `plugin ${plugin}: setup() result is malformed: ${reason}`);
  if (raw === null || raw === undefined) return {};
  if (!isObject(raw)) throw bad('expected a plain object');
  if (typeof (raw as { then?: unknown }).then === 'function') throw bad('setup() must be synchronous, got a thenable');
  const nonEmpty = (v: unknown) => typeof v === 'string' && v !== '';
  const { timeAxes, evidenceSources } = raw as { timeAxes?: unknown; evidenceSources?: unknown };
  if (timeAxes !== undefined) {
    if (!Array.isArray(timeAxes)) throw bad('timeAxes must be an array');
    timeAxes.forEach((a: unknown, i) => {
      const at = `timeAxes[${i}]`;
      if (!isObject(a)) throw bad(`${at} must be an object`);
      if (!nonEmpty(a.name)) throw bad(`${at}.name must be a non-empty string`);
      if (!nonEmpty(a.description)) throw bad(`${at}.description must be a non-empty string`);
      if (!isObject(a.valueSchema)) throw bad(`${at}.valueSchema must be an object`);
      if (a.example === undefined) throw bad(`${at}.example must be defined`);
      if (typeof a.encode !== 'function') throw bad(`${at}.encode must be a function`);
      if (typeof a.decode !== 'function') throw bad(`${at}.decode must be a function`);
    });
  }
  if (evidenceSources !== undefined) {
    if (!Array.isArray(evidenceSources)) throw bad('evidenceSources must be an array');
    evidenceSources.forEach((s: unknown, i) => {
      const at = `evidenceSources[${i}]`;
      if (!isObject(s)) throw bad(`${at} must be an object`);
      if (!nonEmpty(s.name)) throw bad(`${at}.name must be a non-empty string`);
      if (!nonEmpty(s.description)) throw bad(`${at}.description must be a non-empty string`);
      if (!isObject(s.payloadSchema)) throw bad(`${at}.payloadSchema must be an object`);
      if (typeof s.ingest !== 'function') throw bad(`${at}.ingest must be a function`);
      if (typeof s.planRetention !== 'function') throw bad(`${at}.planRetention must be a function`);
    });
  }
  return raw as ReturnType<PluginDef['setup']>;
}

export async function addPlugin(
  db: Queryable,
  args: { package: string },
  importer: Importer = defaultImporter,
): Promise<{ id: number; name: string }> {
  let raw: unknown;
  try {
    raw = await importer(args.package);
  } catch (e) {
    throw new RemoraError('invalid_plugin', `cannot load package ${args.package}: ${errMsg(e)}`);
  }
  const def = asPluginDef(raw, args.package);
  checkConfig(def, def.defaultConfig, `defaultConfig of ${def.name}`);

  const dup = await db.query('SELECT 1 FROM plugin WHERE name = $1', [def.name]);
  if (dup.rowCount) throw new RemoraError('name_taken', `plugin ${def.name} already exists`);
  const r = await db.query<{ id: number }>(
    'INSERT INTO plugin (name, package, config) VALUES ($1, $2, $3::jsonb) RETURNING id',
    [def.name, args.package, JSON.stringify(def.defaultConfig)],
  );
  return { id: r.rows[0]!.id, name: def.name };
}

interface PluginRow {
  id: number;
  name: string;
  package: string;
  config: unknown;
}

export async function loadPlugins(
  db: Queryable,
  opts: { importer?: Importer; logger?: Logger } = {},
): Promise<PluginRegistry> {
  const importer = opts.importer ?? defaultImporter;
  const logger: Logger = opts.logger ?? {
    warn: (m, meta) => console.warn(m, meta ?? ''),
    error: (m, meta) => console.error(m, meta ?? ''),
  };

  const { rows: plugins } = await db.query<PluginRow>('SELECT id, name, package, config FROM plugin ORDER BY id');
  const statuses: { name: string; ok: boolean; error?: string }[] = [];
  const axes = new Map<string, { id: number; def: TimeAxisDef }>();
  const unavailableAxes = new Map<string, string>();

  for (const p of plugins) {
    let setupResult: ReturnType<PluginDef['setup']>;
    try {
      let def: PluginDef;
      try {
        def = asPluginDef(await importer(p.package), p.package);
      } catch (e) {
        if (e instanceof RemoraError) throw e;
        throw new RemoraError('invalid_plugin', `cannot load package ${p.package}: ${errMsg(e)}`);
      }
      checkConfig(def, p.config, `stored config of ${p.name}`);
      setupResult = validateSetupResult(def.setup(p.config), p.name);
    } catch (e) {
      if (p.name === CORE_PLUGIN_NAME) {
        throw new RemoraError('invalid_plugin', `core plugin ${CORE_PLUGIN_NAME} failed to load: ${errMsg(e)}`);
      }
      const error = e instanceof RemoraError ? `${e.code}: ${e.message}` : errMsg(e);
      logger.error(`plugin ${p.name} is unavailable`, { error });
      statuses.push({ name: p.name, ok: false, error });
      const { rows } = await db.query<{ name: string }>('SELECT name FROM time_axis WHERE plugin_id = $1', [p.id]);
      for (const r of rows) unavailableAxes.set(r.name, p.name);
      continue;
    }

    for (const a of setupResult.timeAxes ?? []) {
      await assertNameFree(db, 'time_axis', a.name, p.id);
      const r = await db.query<{ id: number }>(
        `INSERT INTO time_axis (name, plugin_id, description, value_schema, example)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
         ON CONFLICT (name) DO UPDATE SET
           description = EXCLUDED.description,
           value_schema = EXCLUDED.value_schema,
           example = EXCLUDED.example
         RETURNING id`,
        [a.name, p.id, a.description, JSON.stringify(a.valueSchema), JSON.stringify(a.example)],
      );
      axes.set(a.name, { id: r.rows[0]!.id, def: a });
    }
    for (const s of setupResult.evidenceSources ?? ([] as EvidenceSourceDef[])) {
      await assertNameFree(db, 'evidence_source', s.name, p.id);
      await db.query(
        `INSERT INTO evidence_source (name, plugin_id, description, payload_schema)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (name) DO UPDATE SET
           description = EXCLUDED.description,
           payload_schema = EXCLUDED.payload_schema`,
        [s.name, p.id, s.description, JSON.stringify(s.payloadSchema)],
      );
    }
    statuses.push({ name: p.name, ok: true });
  }

  return {
    getAxis(name) {
      const hit = axes.get(name);
      if (hit) return hit;
      const owner = unavailableAxes.get(name);
      if (owner !== undefined) {
        throw new RemoraError('axis_unavailable', `time axis ${name} belongs to unavailable plugin ${owner}`);
      }
      throw new RemoraError('unknown_axis', `unknown time axis ${name}`);
    },
    status: () => statuses.map((s) => ({ ...s })),
  };
}

async function assertNameFree(
  db: Queryable,
  table: 'time_axis' | 'evidence_source',
  name: string,
  pluginId: number,
): Promise<void> {
  const { rows } = await db.query<{ plugin_id: number }>(`SELECT plugin_id FROM ${table} WHERE name = $1`, [name]);
  if (rows.length > 0 && rows[0]!.plugin_id !== pluginId) {
    throw new RemoraError('name_taken', `${table} name ${name} is already owned by another plugin`);
  }
}

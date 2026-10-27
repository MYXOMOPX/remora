import {
  RemoraError,
  type EvidenceSourceDef,
  type JsonSchema,
  type RetentionAction,
  type RetentionRow,
} from '@remora/sdk';

export type SourceConfig = {
  name: string;
  description?: string;
  schema: JsonSchema;
  keep?: string[];
  retention?: { after: string; drop: string[] | '*' }[];
};

const UNIT_MS: Record<string, number> = { minute: 60_000, hour: 3_600_000, day: 86_400_000 };

function invalid(name: unknown, reason: string): RemoraError {
  return new RemoraError('invalid_config', `Source "${String(name)}": ${reason}`, { source: name, reason });
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const SOURCE_KEYS = new Set(['name', 'description', 'schema', 'keep', 'retention']);
const STAGE_KEYS = new Set(['after', 'drop']);

export function buildSource(cfg: SourceConfig): EvidenceSourceDef {
  const name = cfg?.name;
  if (typeof name !== 'string' || name === '') throw invalid(name, 'name is required');
  const unknownKey = Object.keys(cfg).find((k) => !SOURCE_KEYS.has(k));
  if (unknownKey !== undefined) throw invalid(name, `unknown key "${unknownKey}"`);
  if (!isObject(cfg.schema)) throw invalid(name, 'schema must be an object');
  if (cfg.keep !== undefined && (!Array.isArray(cfg.keep) || cfg.keep.some((k) => typeof k !== 'string'))) {
    throw invalid(name, 'keep must be an array of strings');
  }
  if (cfg.retention !== undefined && !Array.isArray(cfg.retention)) {
    throw invalid(name, 'retention must be an array');
  }
  const keep = cfg.keep;
  let prev = 0;
  const stages = (cfg.retention ?? []).map((s) => {
    if (!isObject(s)) throw invalid(name, 'every retention stage must be an object');
    const unknownStageKey = Object.keys(s).find((k) => !STAGE_KEYS.has(k));
    if (unknownStageKey !== undefined) throw invalid(name, `unknown key "${unknownStageKey}" in a retention stage`);
    const m = typeof s?.after === 'string' ? /^(\d+) (minute|hour|day)s?$/.exec(s.after) : null;
    if (!m) throw invalid(name, `invalid after: ${String(s?.after)}`);
    const ms = Number(m[1]) * UNIT_MS[m[2]!]!;
    if (ms <= prev) throw invalid(name, 'after values must be strictly increasing');
    prev = ms;
    const drop = s.drop;
    if (drop !== '*' && (!Array.isArray(drop) || drop.some((k) => typeof k !== 'string'))) {
      throw invalid(name, "drop must be an array of strings or '*'");
    }
    return { ms, drop };
  });

  return {
    name,
    description: cfg.description ?? `Evidence source ${name}.`,
    payloadSchema: cfg.schema,
    ingest(payload) {
      if (keep && isObject(payload)) {
        // own properties only; fromEntries defines properties, so a "__proto__" key stays a plain key
        const out = Object.fromEntries(keep.filter((k) => Object.hasOwn(payload, k)).map((k) => [k, payload[k]]));
        return { payload: out, retentionState: { stage: 0 } };
      }
      return { payload, retentionState: { stage: 0 } };
    },
    planRetention(rows: RetentionRow[], now: Date): RetentionAction[] {
      return rows.map((r): RetentionAction => {
        const age = now.getTime() - r.createdAt.getTime();
        const target = stages.filter((s) => s.ms <= age).length;
        const st = isObject(r.retentionState) ? r.retentionState.stage : 0;
        const cur = typeof st === 'number' && Number.isInteger(st) && st >= 0 ? st : 0;
        if (target <= cur) return { id: r.id, action: 'keep' };
        const pending = stages.slice(cur, target);
        if (pending.some((s) => s.drop === '*')) return { id: r.id, action: 'purge' };
        const dropped = new Set(pending.flatMap((s) => s.drop as string[]));
        let payload = r.payload;
        if (isObject(payload)) {
          payload = Object.fromEntries(Object.entries(payload).filter(([k]) => !dropped.has(k)));
        }
        return { id: r.id, action: 'replace', payload, retentionState: { stage: target } };
      });
    },
  };
}

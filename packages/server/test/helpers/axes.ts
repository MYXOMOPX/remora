import { RemoraError, type EvidenceSourceDef, type TimeAxisDef } from '@remora/sdk';
import type { Queryable } from '../../src/db/types.js';
import type { AxisInfo, PluginRegistry, SourceInfo } from '../../src/plugins/registry.js';
import type { Seeded } from './seed.js';

export function intAxis(name: string): TimeAxisDef {
  return {
    name,
    description: `Integer axis ${name}.`,
    valueSchema: { type: 'integer', minimum: 0 },
    example: 1,
    encode: (v) => BigInt(v as number),
    decode: (n) => Number(n),
  };
}

export function bigAxis(name: string): TimeAxisDef {
  return {
    name,
    description: `Big axis ${name}.`,
    valueSchema: {
      type: 'object',
      properties: { v: { type: 'string', pattern: '^[0-9]+$' } },
      required: ['v'],
      additionalProperties: false,
    },
    example: { v: '1' },
    encode: (v) => BigInt((v as { v: string }).v),
    decode: (n) => ({ v: n.toString() }),
  };
}

export function fakeSource(name: string, over: Partial<EvidenceSourceDef> = {}): EvidenceSourceDef {
  return {
    name,
    description: `Source ${name}.`,
    payloadSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    ingest: (p) => ({ payload: p }),
    planRetention: () => [],
    ...over,
  };
}

export function fakeRegistry(
  axes: { id: number; def: TimeAxisDef }[],
  sources: { id: number; def: EvidenceSourceDef }[] = [],
  unavailableSources: string[] = [],
): PluginRegistry {
  const srcInfos: SourceInfo[] = sources.map((x) => ({ id: x.id, name: x.def.name, def: x.def }));
  const infos: AxisInfo[] = axes.map((a) => ({ id: a.id, name: a.def.name, def: a.def }));
  return {
    getAxis(name) {
      const hit = infos.find((a) => a.name === name);
      if (!hit) throw new RemoraError('unknown_axis', `unknown time axis ${name}`);
      return hit;
    },
    getAxisById(id) {
      const hit = infos.find((a) => a.id === id);
      if (!hit) throw new RemoraError('unknown_axis', `unknown time axis id ${id}`);
      return hit;
    },
    getSource(name) {
      const hit = srcInfos.find((x) => x.name === name);
      if (hit) return hit;
      if (unavailableSources.includes(name)) {
        throw new RemoraError('source_unavailable', `evidence source ${name} is unavailable`);
      }
      throw new RemoraError('unknown_source', `unknown evidence source ${name}`);
    },
    listSources: () => [...srcInfos].sort((a, b) => a.id - b.id),
    status: () => [],
  };
}

export async function seedAxes(
  db: Queryable,
  s: Seeded,
  sources: EvidenceSourceDef[] = [],
  unavailableSources: string[] = [],
): Promise<PluginRegistry> {
  const r = await db.query<{ id: number }>(
    `INSERT INTO time_axis (name, plugin_id, description, value_schema, example)
     VALUES ('big', (SELECT id FROM plugin WHERE name = 'test'), 'Big axis.', '{"type":"object"}', '{"v":"1"}')
     RETURNING id`,
  );
  const insertSource = async (name: string, schema: unknown): Promise<number> => {
    const q = await db.query<{ id: number }>(
      `INSERT INTO evidence_source (name, plugin_id, description, payload_schema)
       VALUES ($1, (SELECT id FROM plugin WHERE name = 'test'), $2, $3::jsonb) RETURNING id`,
      [name, `Source ${name}.`, JSON.stringify(schema)],
    );
    return q.rows[0]!.id;
  };
  const served: { id: number; def: EvidenceSourceDef }[] = [];
  for (const def of sources) served.push({ id: await insertSource(def.name, def.payloadSchema), def });
  for (const name of unavailableSources) await insertSource(name, { type: 'object' });
  return fakeRegistry(
    [
      { id: s.axes.gameDay, def: intAxis('game_day') },
      { id: s.axes.real, def: intAxis('real') },
      { id: r.rows[0]!.id, def: bigAxis('big') },
    ],
    served,
    unavailableSources,
  );
}

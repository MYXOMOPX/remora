import { RemoraError, type TimeAxisDef } from '@remora/sdk';
import type { Queryable } from '../../src/db/types.js';
import type { AxisInfo, PluginRegistry } from '../../src/plugins/registry.js';
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

export function fakeRegistry(axes: { id: number; def: TimeAxisDef }[]): PluginRegistry {
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
    status: () => [],
  };
}

export async function seedAxes(db: Queryable, s: Seeded): Promise<PluginRegistry> {
  const r = await db.query<{ id: number }>(
    `INSERT INTO time_axis (name, plugin_id, description, value_schema, example)
     VALUES ('big', (SELECT id FROM plugin WHERE name = 'test'), 'Big axis.', '{"type":"object"}', '{"v":"1"}')
     RETURNING id`,
  );
  return fakeRegistry([
    { id: s.axes.gameDay, def: intAxis('game_day') },
    { id: s.axes.real, def: intAxis('real') },
    { id: r.rows[0]!.id, def: bigAxis('big') },
  ]);
}

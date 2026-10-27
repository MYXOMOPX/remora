import { describe, expect, it } from 'vitest';
import { apply } from '../src/api/apply.js';
import { runMigrations } from '../src/db/migrate.js';
import { APPLY_OPS } from '../src/contract/apply-ops.js';
import { fakeSource, seedAxes } from './helpers/axes.js';
import { seedBasics } from './helpers/seed.js';
import { createTestDb } from './helpers/testDb.js';

// Result keys of every apply op, as documented in its description ("Returns {...}").
const KEYS: Record<string, string[]> = {
  add_evidence: ['id'],
  add_event: ['id'],
  update_event: ['id'],
  retract_event: ['id'],
  create_entity: ['created', 'key'],
  add_property: ['ids'],
  replace_property: ['closed', 'ids', 'retracted'],
  end_property: ['closed'],
  retract_property: ['id'],
  add_relation: ['ids', 'relation_id'],
  end_relation: ['closed'],
  retract_relation: ['retracted'],
  create_relation_type: ['description', 'directed', 'id', 'name'],
  create_property_type: ['description', 'id', 'name', 'single_valued', 'value_type'],
};

describe('apply result shapes match the documented ones', () => {
  it('descriptions name the keys, and a real run returns exactly them', async () => {
    const { pool, drop } = await createTestDb();
    try {
      await runMigrations(pool);
      const seeded = await seedBasics(pool);
      const reg = await seedAxes(pool, seeded, [fakeSource('chat')]);
      const seen: Record<string, string[]> = {};
      const run = async (op: Record<string, unknown>): Promise<Record<string, unknown>> => {
        const r = await apply(pool, reg, { ops: [op] });
        if (!r.ok) throw new Error(`${String(op.op)}: ${JSON.stringify(r.error)}`);
        const res = r.results[0] as Record<string, unknown>;
        seen[String(op.op)] = Object.keys(res).sort();
        return res;
      };
      const t = (at: number) => ({ axis: 'game_day', at });
      await run({ op: 'add_evidence', source: 'chat', payload: { text: 'x' } });
      await run({ op: 'create_entity', key: 'al' });
      await run({ op: 'create_relation_type', name: 'knows', description: 'd', directed: true });
      await run({ op: 'create_property_type', name: 'hobby', description: 'd', value_type: 'text', single_valued: false });
      const added = await run({ op: 'add_property', entity: 'bob', property: 'job_title', value: 'a', time: { axis: 'game_day', from: 1 } });
      await run({ op: 'replace_property', entity: 'bob', property: 'job_title', value: 'b', time: t(5) });
      await run({ op: 'end_property', entity: 'bob', property: 'job_title', time: t(9) });
      await run({ op: 'retract_property', id: (added.ids as number[])[0] });
      const rel = await run({ op: 'add_relation', type: 'knows', from: 'bob', to: 'al', time: { axis: 'game_day', from: 1 } });
      await run({ op: 'end_relation', relation_id: rel.relation_id, time: t(3) });
      await run({ op: 'retract_relation', relation_id: rel.relation_id });
      const ev = await run({ op: 'add_event', summary: 's', time: t(1) });
      await run({ op: 'update_event', id: ev.id, summary: 't' });
      await run({ op: 'retract_event', id: ev.id });

      expect(Object.keys(seen).sort()).toEqual(Object.keys(APPLY_OPS).sort());
      for (const [name, schema] of Object.entries(APPLY_OPS)) {
        expect(seen[name], name).toEqual(KEYS[name]);
        const desc = (schema as { description: string }).description;
        const returns = desc.slice(desc.indexOf('Returns '));
        expect(desc.includes('Returns '), name).toBe(true);
        for (const k of KEYS[name]!) expect(returns, `${name}.${k}`).toContain(k);
      }
    } finally {
      await drop();
    }
  });
});

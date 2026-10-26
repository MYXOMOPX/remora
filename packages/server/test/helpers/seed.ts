import type { Queryable } from '../../src/db/types.js';

export interface Seeded {
  bobId: bigint;
  axes: { gameDay: number; real: number };
  types: { jobTitle: number; nickname: number; height: number };
}

export async function seedBasics(db: Queryable): Promise<Seeded> {
  const plugin = await db.query<{ id: number }>(
    `INSERT INTO plugin (name, package, config) VALUES ('test', 'test', '{}') RETURNING id`,
  );
  const pluginId = plugin.rows[0]!.id;

  const axis = async (name: string, description: string): Promise<number> => {
    const r = await db.query<{ id: number }>(
      `INSERT INTO time_axis (name, plugin_id, description, value_schema, example)
       VALUES ($1, $2, $3, '{"type":"integer"}', '1') RETURNING id`,
      [name, pluginId, description],
    );
    return r.rows[0]!.id;
  };
  const gameDay = await axis('game_day', 'Номер игрового дня, целое число.');
  const real = await axis('real', 'Реальное время в секундах от epoch.');

  const ptype = async (name: string, valueType: string, single: boolean): Promise<number> => {
    const r = await db.query<{ id: number }>(
      `INSERT INTO property_type (name, description, value_type, single_valued)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [name, `Тестовое свойство ${name}.`, valueType, single],
    );
    return r.rows[0]!.id;
  };
  const jobTitle = await ptype('job_title', 'text', true);
  const nickname = await ptype('nickname', 'text', false);
  const height = await ptype('height', 'number', true);

  const bob = await db.query<{ entity_id: string }>(
    `INSERT INTO entity (key) VALUES ('bob') RETURNING entity_id`,
  );

  return {
    bobId: BigInt(bob.rows[0]!.entity_id),
    axes: { gameDay, real },
    types: { jobTitle, nickname, height },
  };
}

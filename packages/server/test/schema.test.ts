import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import type { Queryable } from '../src/db/types.js';
import { seedBasics, type Seeded } from './helpers/seed.js';
import { createTestDb } from './helpers/testDb.js';

interface PropArgs {
  entity: bigint;
  type: number;
  axis?: number;
  span?: string;
  value?: unknown;
  retracted?: boolean;
}

async function insertProp(db: Queryable, a: PropArgs): Promise<number> {
  const r = await db.query<{ id: number }>(
    `INSERT INTO property_version
       (entity_id, property_type_id, time_axis, time_span, value, retracted_at)
     VALUES ($1, $2, $3, $4::int8range, $5::jsonb, CASE WHEN $6::boolean THEN now() END)
     RETURNING id`,
    [
      a.entity,
      a.type,
      a.axis ?? null,
      a.span ?? null,
      JSON.stringify(a.value ?? 'v'),
      a.retracted ?? false,
    ],
  );
  return r.rows[0]!.id;
}

async function withDb(fn: (db: Queryable, s: Seeded, pool: pg.Pool) => Promise<void>): Promise<void> {
  const { pool, drop } = await createTestDb();
  try {
    await runMigrations(pool);
    const seeded = await seedBasics(pool);
    await fn(pool, seeded, pool);
  } finally {
    await drop();
  }
}

describe('schema constraints', () => {
  it('trigger fills single_valued', () =>
    withDb(async (db, s) => {
      await insertProp(db, { entity: s.bobId, type: s.types.jobTitle });
      await insertProp(db, { entity: s.bobId, type: s.types.nickname });
      const { rows } = await db.query(
        `SELECT property_type_id AS t, single_valued AS sv FROM property_version ORDER BY id`,
      );
      expect(rows).toEqual([
        { t: s.types.jobTitle, sv: true },
        { t: s.types.nickname, sv: false },
      ]);
    }));

  it('overlap on one axis rejected', () =>
    withDb(async (db, s) => {
      const base = { entity: s.bobId, type: s.types.jobTitle, axis: s.axes.gameDay };
      await insertProp(db, { ...base, span: '[292,)' });
      await expect(insertProp(db, { ...base, span: '[300,)' })).rejects.toMatchObject({
        code: '23P01',
      });
    }));

  it('other axis allowed', () =>
    withDb(async (db, s) => {
      const base = { entity: s.bobId, type: s.types.jobTitle, span: '[292,)' };
      await insertProp(db, { ...base, axis: s.axes.gameDay });
      await insertProp(db, { ...base, axis: s.axes.real });
    }));

  it('close then insert', () =>
    withDb(async (db, s, pool) => {
      const base = { entity: s.bobId, type: s.types.jobTitle, axis: s.axes.gameDay };
      const id = await insertProp(db, { ...base, span: '[292,)' });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`UPDATE property_version SET time_span = '[292,300)' WHERE id = $1`, [id]);
        await insertProp(client, { ...base, span: '[300,)' });
        await client.query('COMMIT');
      } finally {
        client.release();
      }
    }));

  it('timeless duplicate rejected', () =>
    withDb(async (db, s) => {
      const base = { entity: s.bobId, type: s.types.height };
      await insertProp(db, base);
      await expect(insertProp(db, base)).rejects.toMatchObject({ code: '23P01' });
    }));

  it('timeless and timed do not collide in DB', () =>
    withDb(async (db, s) => {
      const base = { entity: s.bobId, type: s.types.height };
      await insertProp(db, base);
      await insertProp(db, { ...base, axis: s.axes.gameDay, span: '[1,)' });
    }));

  it('multi-valued overlap allowed', () =>
    withDb(async (db, s) => {
      const base = { entity: s.bobId, type: s.types.nickname, axis: s.axes.gameDay };
      await insertProp(db, { ...base, span: '[292,)' });
      await insertProp(db, { ...base, span: '[295,)' });
    }));

  it('retracted row does not block', () =>
    withDb(async (db, s) => {
      const base = { entity: s.bobId, type: s.types.jobTitle, axis: s.axes.gameDay };
      const id = await insertProp(db, { ...base, span: '[292,)' });
      await db.query('UPDATE property_version SET retracted_at = now() WHERE id = $1', [id]);
      await insertProp(db, { ...base, span: '[292,)' });
    }));

  it('axis without span rejected', () =>
    withDb(async (db, s) => {
      await expect(
        insertProp(db, { entity: s.bobId, type: s.types.jobTitle, axis: s.axes.gameDay }),
      ).rejects.toMatchObject({ code: '23514' });
    }));

  it('single_valued flag cannot change under rows', () =>
    withDb(async (db, s) => {
      await insertProp(db, { entity: s.bobId, type: s.types.jobTitle });
      await expect(
        db.query('UPDATE property_type SET single_valued = false WHERE id = $1', [
          s.types.jobTitle,
        ]),
      ).rejects.toMatchObject({ code: '23503' });
    }));

  it('bad evidence_id rejected', () =>
    withDb(async (db, s) => {
      await expect(
        db.query(
          `INSERT INTO property_version (entity_id, property_type_id, value, evidence_id)
           VALUES ($1, $2, '"v"', 999)`,
          [s.bobId, s.types.jobTitle],
        ),
      ).rejects.toMatchObject({ code: '23503' });
    }));

  it('relation: axis without span rejected', () =>
    withDb(async (db, s) => {
      await db.query(
        `INSERT INTO relation_type (name, description, directed) VALUES ('knows', 'Знаком.', false)`,
      );
      await expect(
        db.query(
          `INSERT INTO relation (relation_id, relation_type_id, src, dst, time_axis)
           VALUES (1, 1, $1, $1, $2)`,
          [s.bobId, s.axes.gameDay],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    }));

  it('event_time instant must be [t,t+1)', () =>
    withDb(async (db, s) => {
      const ev = await db.query<{ id: number }>(
        `INSERT INTO event (summary) VALUES ('Боб сделал сальтуху') RETURNING id`,
      );
      const eventId = ev.rows[0]!.id;
      const ins = (span: string) =>
        db.query(
          `INSERT INTO event_time (event_id, time_axis, time_span, instant)
           VALUES ($1, $2, $3::int8range, true)`,
          [eventId, s.axes.gameDay, span],
        );
      await expect(ins('[5,7)')).rejects.toMatchObject({ code: '23514' });
      await expect(ins('[5,)')).rejects.toMatchObject({ code: '23514' });
      await ins('[5,6)');
    }));

  it('empty time_span rejected on property_version, relation and event_time', () =>
    withDb(async (db, s) => {
      await expect(
        insertProp(db, { entity: s.bobId, type: s.types.jobTitle, axis: s.axes.gameDay, span: 'empty' }),
      ).rejects.toMatchObject({ code: '23514' });
      await db.query(
        `INSERT INTO relation_type (name, description, directed) VALUES ('knows', 'Знаком.', false)`,
      );
      await expect(
        db.query(
          `INSERT INTO relation (relation_id, relation_type_id, src, dst, time_axis, time_span)
           VALUES (1, 1, $1, $1, $2, 'empty'::int8range)`,
          [s.bobId, s.axes.gameDay],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      const ev = await db.query<{ id: number }>(`INSERT INTO event (summary) VALUES ('Событие') RETURNING id`);
      await expect(
        db.query(
          `INSERT INTO event_time (event_id, time_axis, time_span, instant)
           VALUES ($1, $2, 'empty'::int8range, false)`,
          [ev.rows[0]!.id, s.axes.gameDay],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    }));

  it('event_entity role defaults', () =>
    withDb(async (db, s) => {
      const ev = await db.query<{ id: number }>(
        `INSERT INTO event (summary) VALUES ('Событие') RETURNING id`,
      );
      await db.query(`INSERT INTO event_entity (event_id, entity_id) VALUES ($1, $2)`, [
        ev.rows[0]!.id,
        s.bobId,
      ]);
      const { rows } = await db.query(`SELECT role FROM event_entity`);
      expect(rows).toEqual([{ role: 'participant' }]);
    }));

  it('event_entity PK allows two roles', () =>
    withDb(async (db, s) => {
      const ev = await db.query<{ id: number }>(
        `INSERT INTO event (summary) VALUES ('Событие') RETURNING id`,
      );
      const add = (role: string) =>
        db.query(`INSERT INTO event_entity (event_id, entity_id, role) VALUES ($1, $2, $3)`, [
          ev.rows[0]!.id,
          s.bobId,
          role,
        ]);
      await add('actor');
      await add('witness');
      await expect(add('actor')).rejects.toMatchObject({ code: '23505' });
    }));

  it('relation_logical_id_seq yields 1 then 2', () =>
    withDb(async (db) => {
      const a = await db.query<{ n: string }>(`SELECT nextval('relation_logical_id_seq') AS n`);
      const b = await db.query<{ n: string }>(`SELECT nextval('relation_logical_id_seq') AS n`);
      expect([a.rows[0]!.n, b.rows[0]!.n]).toEqual(['1', '2']);
    }));
});

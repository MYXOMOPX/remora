import { describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { neighbors, type NeighborsArgs } from '../src/services/neighbors.js';
import { seedAxes } from './helpers/axes.js';
import { seedBasics } from './helpers/seed.js';
import { createTestDb } from './helpers/testDb.js';

const N = 50_000;
const BOUND_MS = 10_000;

describe('neighbors on a hub (no ANALYZE)', () => {
  it('stays fast and correct at depths 2..6', async () => {
    const { pool, drop } = await createTestDb();
    try {
      await runMigrations(pool);
      const seeded = await seedBasics(pool);
      const reg = await seedAxes(pool, seeded);
      await pool.query(
        `INSERT INTO relation_type (name, description, directed) VALUES ('knows', 'Knows.', true)`,
      );
      await pool.query(`INSERT INTO entity (key) VALUES ('s'), ('hub')`);
      await pool.query(`INSERT INTO entity (key) SELECT 'l' || g FROM generate_series(1, $1) g`, [N]);
      await pool.query(`INSERT INTO entity (key) SELECT 'c' || g FROM generate_series(1, $1) g`, [N]);
      const rel = (from: string, to: string): string => `
        INSERT INTO relation (relation_id, relation_type_id, src, dst)
        SELECT nextval('relation_logical_id_seq'), (SELECT id FROM relation_type WHERE name = 'knows'), a.entity_id, b.entity_id
          FROM ${from} JOIN ${to} ON true`;
      await pool.query(rel(`(SELECT entity_id FROM entity WHERE key = 's') a`, `(SELECT entity_id FROM entity WHERE key = 'hub') b`));
      await pool.query(rel(`(SELECT entity_id FROM entity WHERE key = 'hub') a`, `(SELECT entity_id FROM entity WHERE key ~ '^l[0-9]+$') b`));
      await pool.query(`
        INSERT INTO relation (relation_id, relation_type_id, src, dst)
        SELECT nextval('relation_logical_id_seq'), (SELECT id FROM relation_type WHERE name = 'knows'), l.entity_id, c.entity_id
          FROM entity l JOIN entity c ON c.key = 'c' || substr(l.key, 2) WHERE l.key ~ '^l[0-9]+$'`);

      const timed = async (a: Partial<NeighborsArgs>) => {
        const t0 = performance.now();
        const r = await neighbors(pool, reg, { entity: 's', ...a });
        const ms = performance.now() - t0;
        expect(ms).toBeLessThan(BOUND_MS);
        return r;
      };

      const d2 = await timed({ depth: 2 });
      expect(d2.total).toBe(N + 1);
      expect(d2.rows[0]!.entity).toBe('hub');
      expect(d2.rows[0]!.depth).toBe(1);
      expect(d2.rows[0]!.via?.from).toBe('s');
      expect(d2.rows).toHaveLength(50);
      for (const row of d2.rows.slice(1)) {
        expect(row.entity.startsWith('l')).toBe(true);
        expect(row.depth).toBe(2);
        expect(row.via?.from).toBe('hub');
        expect(row.via?.relation).toBe('knows');
        expect(row.viaCount).toBe(1);
      }

      for (const depth of [3, 4, 6]) expect((await timed({ depth })).total).toBe(2 * N + 1);
      expect((await timed({ depth: 6, direction: 'out' })).total).toBe(2 * N + 1);
      await timed({ depth: 2, orderBy: { property: 'height', dir: 'desc' } });
      await timed({ depth: 2, include: ['height'] });
    } finally {
      await drop();
    }
  }, 300_000);
});

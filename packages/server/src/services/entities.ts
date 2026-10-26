import { RemoraError } from '@remora/sdk';
import type { Queryable } from '../db/types.js';
import { clampLimit, wordPatterns } from '../sql/like.js';

export interface EntityRow {
  entityId: bigint;
  key: string;
}

interface RawEntity {
  entity_id: string;
  key: string;
}

function toRow(r: RawEntity): EntityRow {
  return { entityId: BigInt(r.entity_id), key: r.key };
}

export async function createEntity(
  db: Queryable,
  key: string,
): Promise<{ entity: EntityRow; created: boolean }> {
  if (key.trim() === '') {
    throw new RemoraError('invalid_name', 'entity key must not be empty');
  }
  const ins = await db.query<RawEntity>(
    'INSERT INTO entity (key) VALUES ($1) ON CONFLICT (key) DO NOTHING RETURNING entity_id, key',
    [key],
  );
  if (ins.rows[0]) return { entity: toRow(ins.rows[0]), created: true };
  const existing = await getEntity(db, key);
  if (!existing) throw new Error(`entity ${key} vanished after conflict`);
  return { entity: existing, created: false };
}

export async function getEntity(db: Queryable, key: string): Promise<EntityRow | null> {
  const r = await db.query<RawEntity>('SELECT entity_id, key FROM entity WHERE key = $1', [key]);
  return r.rows[0] ? toRow(r.rows[0]) : null;
}

export async function requireEntity(db: Queryable, key: string): Promise<EntityRow> {
  const e = await getEntity(db, key);
  if (!e) throw new RemoraError('unknown_entity', `unknown entity: ${key}`, { key });
  return e;
}

export async function findEntities(
  db: Queryable,
  args: { query: string; limit?: number },
): Promise<{ rows: EntityRow[]; total: number; truncated: boolean }> {
  const patterns = wordPatterns(args.query);
  if (patterns.length === 0) {
    throw new RemoraError('invalid_param', 'query must not be empty');
  }
  const limit = clampLimit(args.limit);
  const where = patterns.map((_, i) => `key ILIKE $${i + 1}`).join(' AND ');
  // Sequential: one client must not have two queries in flight (pg deprecation).
  const rows = await db.query<RawEntity>(
    `SELECT entity_id, key FROM entity WHERE ${where} ORDER BY key LIMIT $${patterns.length + 1}`,
    [...patterns, limit],
  );
  const count = await db.query<{ n: string }>(`SELECT count(*) AS n FROM entity WHERE ${where}`, patterns);
  const total = Number(count.rows[0]!.n);
  return { rows: rows.rows.map(toRow), total, truncated: total > rows.rows.length };
}

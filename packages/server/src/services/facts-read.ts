import type { Queryable } from '../db/types.js';
import type { PluginRegistry } from '../plugins/registry.js';
import { clampLimit } from '../sql/like.js';
import { requireEntity } from './entities.js';
import { resolveProperty } from './properties.js';
import { resolveRelationType } from './relations.js';
import { formatTime, type AxisRef, type TimeOut, type When } from './time.js';

/**
 * SQL predicate "fact is current at / during `when`" for a table with time_axis/time_span.
 * Parameter numbers start at `firstParam`; timeless rows always match.
 */
export function whenClause(
  when: When | undefined,
  firstParam: number,
): { sql: string; params: unknown[] } {
  if (when === undefined) return { sql: 'true', params: [] };
  const n = firstParam;
  if ('at' in when) {
    return {
      sql: `(time_axis IS NULL OR (time_axis = $${n} AND time_span @> $${n + 1}::bigint))`,
      params: [when.axis.id, when.at],
    };
  }
  return {
    sql: `(time_axis IS NULL OR (time_axis = $${n} AND time_span && int8range($${n + 1}, $${n + 2}, '[)')))`,
    params: [when.axis.id, when.from, when.to],
  };
}

export interface PropertyRow {
  id: bigint;
  value: unknown;
  time: TimeOut | null;
  evidenceId: bigint | null;
  recordedAt: Date;
  retractedAt: Date | null;
}

interface RawPropertyRow {
  id: string;
  value: unknown;
  time_axis: number | null;
  lo: string | null;
  hi: string | null;
  evidence_id: string | null;
  recorded_at: Date;
  retracted_at: Date | null;
}

const PROPERTY_COLS = `id, value, time_axis, lower(time_span)::text AS lo, upper(time_span)::text AS hi,
  evidence_id, recorded_at, retracted_at`;

function toPropertyRow(registry: PluginRegistry, r: RawPropertyRow): PropertyRow {
  return {
    id: BigInt(r.id),
    value: r.value,
    time: formatTime(registry, r.time_axis, r.lo, r.hi),
    evidenceId: r.evidence_id === null ? null : BigInt(r.evidence_id),
    recordedAt: r.recorded_at,
    retractedAt: r.retracted_at,
  };
}

export async function propertyAt(
  db: Queryable,
  registry: PluginRegistry,
  a: { entity: string; property: string; when: When },
): Promise<PropertyRow[]> {
  const entity = await requireEntity(db, a.entity);
  const prop = await resolveProperty(db, a.property);
  const w = whenClause(a.when, 3);
  const r = await db.query<RawPropertyRow>(
    `SELECT ${PROPERTY_COLS} FROM property_version
      WHERE entity_id = $1 AND property_type_id = $2 AND retracted_at IS NULL AND ${w.sql}
      ORDER BY id`,
    [entity.entityId, prop.id, ...w.params],
  );
  return r.rows.map((x) => toPropertyRow(registry, x));
}

export async function propertyHistory(
  db: Queryable,
  registry: PluginRegistry,
  a: { entity: string; property: string; axis?: AxisRef; includeRetracted?: boolean },
): Promise<PropertyRow[]> {
  const entity = await requireEntity(db, a.entity);
  const prop = await resolveProperty(db, a.property);
  const params: unknown[] = [entity.entityId, prop.id];
  let axisSql = 'true';
  if (a.axis) {
    params.push(a.axis.id);
    axisSql = `(time_axis IS NULL OR time_axis = $${params.length})`; // R9
  }
  const retractedSql = a.includeRetracted ? 'true' : 'retracted_at IS NULL';
  const r = await db.query<RawPropertyRow>(
    `SELECT ${PROPERTY_COLS} FROM property_version
      WHERE entity_id = $1 AND property_type_id = $2 AND ${retractedSql} AND ${axisSql}
      ORDER BY time_axis NULLS FIRST, lower(time_span) NULLS FIRST, id`,
    params,
  );
  return r.rows.map((x) => toPropertyRow(registry, x));
}

export interface RelationRow {
  id: bigint;
  relationId: bigint;
  type: string;
  from: string;
  to: string;
  time: TimeOut | null;
  evidenceId: bigint | null;
  recordedAt: Date;
  retractedAt: Date | null;
}

interface RawRelationRow {
  id: string;
  relation_id: string;
  type: string;
  src_key: string;
  dst_key: string;
  time_axis: number | null;
  lo: string | null;
  hi: string | null;
  evidence_id: string | null;
  recorded_at: Date;
  retracted_at: Date | null;
}

export async function relationHistory(
  db: Queryable,
  registry: PluginRegistry,
  a: {
    entity: string;
    relationTypes?: string[];
    direction?: 'out' | 'in' | 'both';
    when?: When;
    includeRetracted?: boolean;
    limit?: number;
  },
): Promise<{ rows: RelationRow[]; total: number; truncated: boolean }> {
  const entity = await requireEntity(db, a.entity);
  const limit = clampLimit(a.limit);
  const params: unknown[] = [entity.entityId];
  const conds: string[] = [];

  if (a.relationTypes !== undefined) {
    const ids: number[] = [];
    for (const name of a.relationTypes) ids.push((await resolveRelationType(db, name)).id);
    params.push(ids);
    conds.push(`r.relation_type_id = ANY($${params.length}::smallint[])`);
  }

  // Undirected types match either endpoint whatever the direction.
  const direction = a.direction ?? 'both';
  const dirSql =
    direction === 'out' ? 'r.src = $1' : direction === 'in' ? 'r.dst = $1' : '(r.src = $1 OR r.dst = $1)';
  conds.push(`(NOT rt.directed AND (r.src = $1 OR r.dst = $1) OR rt.directed AND ${dirSql})`);

  if (!a.includeRetracted) conds.push('r.retracted_at IS NULL');

  const w = whenClause(a.when, params.length + 1);
  // time_axis/time_span are unambiguous in this join; qualify nothing.
  conds.push(w.sql);
  params.push(...w.params);

  const where = conds.join(' AND ');
  const from = `FROM relation r
      JOIN relation_type rt ON rt.id = r.relation_type_id
      JOIN entity es ON es.entity_id = r.src
      JOIN entity ed ON ed.entity_id = r.dst
     WHERE ${where}`;
  const [rows, count] = await Promise.all([
    db.query<RawRelationRow>(
      `SELECT r.id, r.relation_id, rt.name AS type, es.key AS src_key, ed.key AS dst_key,
              r.time_axis, lower(r.time_span)::text AS lo, upper(r.time_span)::text AS hi,
              r.evidence_id, r.recorded_at, r.retracted_at
       ${from}
       ORDER BY r.relation_id, r.id
       LIMIT $${params.length + 1}`,
      [...params, limit],
    ),
    db.query<{ n: string }>(`SELECT count(*) AS n ${from}`, params),
  ]);
  const total = Number(count.rows[0]!.n);
  return {
    rows: rows.rows.map((x) => ({
      id: BigInt(x.id),
      relationId: BigInt(x.relation_id),
      type: x.type,
      from: x.src_key,
      to: x.dst_key,
      time: formatTime(registry, x.time_axis, x.lo, x.hi),
      evidenceId: x.evidence_id === null ? null : BigInt(x.evidence_id),
      recordedAt: x.recorded_at,
      retractedAt: x.retracted_at,
    })),
    total,
    truncated: total > rows.rows.length,
  };
}

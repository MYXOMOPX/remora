import { RemoraError } from '@remora/sdk';
import type { Queryable } from '../db/types.js';
import { normalizeName } from './dictionaries.js';
import { requireEntity } from './entities.js';
import type { AxisRef, Moment, Span } from './time.js';

export interface ResolvedRelationType {
  id: number;
  name: string;
  directed: boolean;
}

export type RelationRef = { relationId: bigint } | { type: string; from: string; to: string };

export async function resolveRelationType(db: Queryable, name: string): Promise<ResolvedRelationType> {
  const n = normalizeName(name);
  const r = await db.query<ResolvedRelationType>(
    'SELECT id, name, directed FROM relation_type WHERE name = $1',
    [n],
  );
  const row = r.rows[0];
  if (!row) throw new RemoraError('unknown_type', `unknown relation type: ${name}`, { name: n });
  return { id: row.id, name: row.name, directed: row.directed };
}

export async function addRelation(
  db: Queryable,
  a: { type: string; from: string; to: string; spans: Span[]; evidenceId?: bigint },
): Promise<{ relationId: bigint; ids: bigint[] }> {
  const type = await resolveRelationType(db, a.type);
  const from = await requireEntity(db, a.from);
  const to = await requireEntity(db, a.to);
  const seq = await db.query<{ id: string }>(`SELECT nextval('relation_logical_id_seq') AS id`);
  const relationId = BigInt(seq.rows[0]!.id);
  const targets: (Span | null)[] = a.spans.length === 0 ? [null] : a.spans;
  const ids: bigint[] = [];
  for (const span of targets) {
    const r = await db.query<{ id: string }>(
      `INSERT INTO relation
         (relation_id, relation_type_id, src, dst, time_axis, time_span, evidence_id)
       VALUES ($1, $2, $3, $4, $5::smallint,
               CASE WHEN $5::smallint IS NULL THEN NULL ELSE int8range($6::bigint, $7::bigint, '[)') END,
               $8)
       RETURNING id`,
      [
        relationId,
        type.id,
        from.entityId,
        to.entityId,
        span ? span.axis.id : null,
        span ? span.lo : null,
        span ? span.hi : null,
        a.evidenceId ?? null,
      ],
    );
    ids.push(BigInt(r.rows[0]!.id));
  }
  return { relationId, ids };
}

/**
 * Locks (FOR UPDATE) the non-retracted rows selected by `ref` that also satisfy `extraWhere`.
 * `extraWhere` placeholders are numbered from $1 and are shifted past the selector params.
 */
async function matchRows(
  db: Queryable,
  ref: RelationRef,
  extraWhere: string,
  extraParams: unknown[],
): Promise<{ id: bigint; lo: string | null }[]> {
  let where: string;
  let params: unknown[];
  if ('relationId' in ref) {
    where = 'relation_id = $1';
    params = [ref.relationId];
  } else {
    const type = await resolveRelationType(db, ref.type);
    const from = await requireEntity(db, ref.from);
    const to = await requireEntity(db, ref.to);
    where = type.directed
      ? 'relation_type_id = $1 AND src = $2 AND dst = $3'
      : 'relation_type_id = $1 AND ((src = $2 AND dst = $3) OR (src = $3 AND dst = $2))';
    params = [type.id, from.entityId, to.entityId];
  }
  const shifted = extraWhere.replace(/\$(\d+)/g, (_, d: string) => `$${Number(d) + params.length}`);
  const r = await db.query<{ id: string; lo: string | null }>(
    `SELECT id, lower(time_span)::text AS lo FROM relation
      WHERE retracted_at IS NULL AND ${where}${shifted ? ` AND ${shifted}` : ''}
      ORDER BY id FOR UPDATE`,
    [...params, ...extraParams],
  );
  if (r.rows.length === 0) {
    throw new RemoraError('not_found', 'no matching relation', {
      ref: 'relationId' in ref ? { relation_id: Number(ref.relationId) } : { ...ref },
    });
  }
  return r.rows.map((x) => ({ id: BigInt(x.id), lo: x.lo }));
}

// evidenceId is accepted but ignored (R8): the schema has no "closed by evidence" column in v1.
export async function endRelation(
  db: Queryable,
  a: { ref: RelationRef; moment: Moment; evidenceId?: bigint },
): Promise<{ closed: bigint[] }> {
  const rows = await matchRows(db, a.ref, 'time_axis = $1 AND upper(time_span) IS NULL', [a.moment.axis.id]);
  for (const row of rows) {
    if (row.lo !== null && a.moment.at <= BigInt(row.lo)) {
      throw new RemoraError('invalid_time', 'closing time must be after the start of the open interval', {
        id: Number(row.id),
        from: row.lo,
        at: a.moment.at.toString(),
      });
    }
  }
  const ids = rows.map((r) => r.id);
  await db.query(
    `UPDATE relation SET time_span = int8range(lower(time_span), $2::bigint, '[)')
      WHERE id = ANY($1::bigint[])`,
    [ids.map((i) => i.toString()), a.moment.at],
  );
  return { closed: ids };
}

export async function retractRelation(
  db: Queryable,
  a: { ref: RelationRef; axis?: AxisRef; evidenceId?: bigint },
): Promise<{ retracted: bigint[] }> {
  const rows = a.axis
    ? await matchRows(db, a.ref, 'time_axis = $1', [a.axis.id])
    : await matchRows(db, a.ref, '', []);
  const ids = rows.map((r) => r.id);
  await db.query(
    `UPDATE relation SET retracted_at = now(), retracted_evidence_id = $2
      WHERE id = ANY($1::bigint[])`,
    [ids.map((i) => i.toString()), a.evidenceId ?? null],
  );
  return { retracted: ids };
}

import { RemoraError } from '@remora/sdk';
import type { Queryable } from '../db/types.js';
import { normalizeName, type ValueType } from './dictionaries.js';
import { requireEntity } from './entities.js';
import type { Moment, Span } from './time.js';
import { checkValue } from './values.js';

export interface ResolvedProperty {
  id: number;
  name: string;
  valueType: ValueType;
  singleValued: boolean;
}

export async function resolveProperty(db: Queryable, name: string): Promise<ResolvedProperty> {
  const n = normalizeName(name);
  const r = await db.query<{ id: number; name: string; value_type: ValueType; single_valued: boolean }>(
    'SELECT id, name, value_type, single_valued FROM property_type WHERE name = $1',
    [n],
  );
  const row = r.rows[0];
  if (!row) throw new RemoraError('unknown_type', `unknown property type: ${name}`, { name: n });
  return { id: row.id, name: row.name, valueType: row.value_type, singleValued: row.single_valued };
}

/** R1: serialise all writers of one (entity, property) pair for the rest of the transaction. */
async function lockProperty(db: Queryable, entityId: bigint, typeId: number): Promise<void> {
  await db.query(
    `SELECT pg_advisory_xact_lock(hashtextextended('prop:' || $1::text || ':' || $2::text, 0))`,
    [entityId.toString(), typeId],
  );
}

function serialize(prop: ResolvedProperty, value: unknown): string {
  let s: string | undefined;
  try {
    s = JSON.stringify(value);
  } catch {
    s = undefined;
  }
  if (s === undefined) {
    throw new RemoraError('value_type_mismatch', 'value is not representable as JSON', {
      property: prop.name,
      valueType: prop.valueType,
    });
  }
  return s;
}

function isExclusionViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === '23P01';
}

interface Ctx {
  entity: string;
  property: string;
}

async function insertRow(
  db: Queryable,
  ctx: Ctx,
  entityId: bigint,
  prop: ResolvedProperty,
  json: string,
  span: Span | null,
  evidenceId: bigint | undefined,
): Promise<bigint> {
  try {
    const r = await db.query<{ id: string }>(
      `INSERT INTO property_version
         (entity_id, property_type_id, time_axis, time_span, value, evidence_id)
       VALUES ($1, $2, $3::smallint,
               CASE WHEN $3::smallint IS NULL THEN NULL ELSE int8range($4::bigint, $5::bigint, '[)') END,
               $6::jsonb, $7)
       RETURNING id`,
      [
        entityId,
        prop.id,
        span ? span.axis.id : null,
        span ? span.lo : null,
        span ? span.hi : null,
        json,
        evidenceId ?? null,
      ],
    );
    return BigInt(r.rows[0]!.id);
  } catch (e) {
    if (isExclusionViolation(e)) {
      throw new RemoraError(
        'single_valued_conflict',
        `single-valued property ${prop.name} already has a value overlapping this interval`,
        { entity: ctx.entity, property: ctx.property },
      );
    }
    throw e;
  }
}

/** R3: timeless vs timed on single-valued properties. */
async function checkTimeless(
  db: Queryable,
  ctx: Ctx,
  entityId: bigint,
  prop: ResolvedProperty,
  timed: boolean,
): Promise<void> {
  if (!prop.singleValued) return;
  const r = await db.query(
    `SELECT 1 FROM property_version
      WHERE entity_id = $1 AND property_type_id = $2 AND retracted_at IS NULL
        AND ${timed ? 'time_axis IS NULL' : 'time_axis IS NOT NULL'}
      LIMIT 1`,
    [entityId, prop.id],
  );
  if (r.rows.length > 0) {
    throw new RemoraError(
      'timeless_conflict',
      timed
        ? `property ${prop.name} already has a timeless value`
        : `property ${prop.name} already has timed values`,
      { ...ctx },
    );
  }
}

/** R2/R6: close all open rows on the moment's axis at moment.at. Returns closed ids. */
async function closeOpen(
  db: Queryable,
  entityId: bigint,
  prop: ResolvedProperty,
  moment: Moment,
): Promise<bigint[]> {
  const open = await db.query<{ id: string; lo: string | null }>(
    `SELECT id, lower(time_span) AS lo FROM property_version
      WHERE entity_id = $1 AND property_type_id = $2 AND retracted_at IS NULL
        AND time_axis = $3 AND upper(time_span) IS NULL
      ORDER BY id`,
    [entityId, prop.id, moment.axis.id],
  );
  for (const row of open.rows) {
    if (row.lo !== null && moment.at <= BigInt(row.lo)) {
      throw new RemoraError('invalid_time', 'closing time must be after the start of the open interval', {
        id: Number(row.id),
        from: row.lo,
        at: moment.at.toString(),
      });
    }
  }
  if (open.rows.length === 0) return [];
  const ids = open.rows.map((r) => BigInt(r.id));
  await db.query(
    `UPDATE property_version SET time_span = int8range(lower(time_span), $2::bigint, '[)')
      WHERE id = ANY($1::bigint[])`,
    [ids.map((i) => i.toString()), moment.at],
  );
  return ids;
}

export async function addProperty(
  db: Queryable,
  a: { entity: string; property: string; value: unknown; spans: Span[]; evidenceId?: bigint },
): Promise<{ ids: bigint[] }> {
  const entity = await requireEntity(db, a.entity);
  const prop = await resolveProperty(db, a.property);
  checkValue(prop.valueType, a.value, { property: prop.name });
  const json = serialize(prop, a.value);
  await lockProperty(db, entity.entityId, prop.id);
  const ctx = { entity: a.entity, property: a.property };
  await checkTimeless(db, ctx, entity.entityId, prop, a.spans.length > 0);
  const ids: bigint[] = [];
  const targets: (Span | null)[] = a.spans.length === 0 ? [null] : a.spans;
  for (const span of targets) {
    ids.push(await insertRow(db, ctx, entity.entityId, prop, json, span, a.evidenceId));
  }
  return { ids };
}

export async function replaceProperty(
  db: Queryable,
  a: { entity: string; property: string; value: unknown; moment?: Moment; evidenceId?: bigint },
): Promise<{ closed: bigint[]; retracted: bigint[]; ids: bigint[] }> {
  const entity = await requireEntity(db, a.entity);
  const prop = await resolveProperty(db, a.property);
  checkValue(prop.valueType, a.value, { property: prop.name });
  const json = serialize(prop, a.value);
  await lockProperty(db, entity.entityId, prop.id);
  const ctx = { entity: a.entity, property: a.property };
  await checkTimeless(db, ctx, entity.entityId, prop, a.moment !== undefined);
  if (a.moment) {
    const closed = await closeOpen(db, entity.entityId, prop, a.moment);
    const span: Span = { axis: a.moment.axis, lo: a.moment.at, hi: null };
    const id = await insertRow(db, ctx, entity.entityId, prop, json, span, a.evidenceId);
    return { closed, retracted: [], ids: [id] };
  }
  // R8: the retracted timeless rows carry the same evidence as the new row.
  const old = await db.query<{ id: string }>(
    `UPDATE property_version SET retracted_at = now(), retracted_evidence_id = $3
      WHERE entity_id = $1 AND property_type_id = $2 AND retracted_at IS NULL AND time_axis IS NULL
      RETURNING id`,
    [entity.entityId, prop.id, a.evidenceId ?? null],
  );
  const retracted = old.rows.map((r) => BigInt(r.id)).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  const id = await insertRow(db, ctx, entity.entityId, prop, json, null, a.evidenceId);
  return { closed: [], retracted, ids: [id] };
}

// evidenceId is accepted but ignored (R8): the schema has no "closed by evidence" column in v1.
export async function endProperty(
  db: Queryable,
  a: { entity: string; property: string; moment: Moment; evidenceId?: bigint },
): Promise<{ closed: bigint[] }> {
  const entity = await requireEntity(db, a.entity);
  const prop = await resolveProperty(db, a.property);
  await lockProperty(db, entity.entityId, prop.id);
  const closed = await closeOpen(db, entity.entityId, prop, a.moment);
  if (closed.length === 0) {
    throw new RemoraError('not_found', `no open ${prop.name} value to end on axis ${a.moment.axis.name}`, {
      entity: a.entity,
      property: a.property,
    });
  }
  return { closed };
}

export async function retractProperty(
  db: Queryable,
  a: { id: bigint; evidenceId?: bigint },
): Promise<{ id: bigint }> {
  const notFound = (): RemoraError =>
    new RemoraError('not_found', `property row ${a.id} not found`, { id: Number(a.id) });
  const row = await db.query<{ entity_id: string; property_type_id: number }>(
    'SELECT entity_id, property_type_id FROM property_version WHERE id = $1',
    [a.id],
  );
  if (!row.rows[0]) throw notFound();
  await lockProperty(db, BigInt(row.rows[0].entity_id), row.rows[0].property_type_id);
  const r = await db.query(
    `UPDATE property_version SET retracted_at = now(), retracted_evidence_id = $2
      WHERE id = $1 AND retracted_at IS NULL`,
    [a.id, a.evidenceId ?? null],
  );
  if (r.rowCount === 0) throw notFound();
  return { id: a.id };
}

import { RemoraError } from '@remora/sdk';
import type { Queryable } from '../db/types.js';
import type { PluginRegistry } from '../plugins/registry.js';
import { clampLimit } from '../sql/like.js';
import { requireEntity } from './entities.js';
import { whenClause } from './facts-read.js';
import { resolveProperty } from './properties.js';
import { resolveRelationType } from './relations.js';
import { formatTime, type TimeOut, type When } from './time.js';

export type Direction = 'out' | 'in' | 'both';

export interface NeighborsArgs {
  entity: string;
  relationTypes?: string[];
  direction?: Direction;
  depth?: number;
  when?: When;
  include?: string[];
  orderBy?: { property: string; dir?: 'asc' | 'desc' };
  limit?: number;
  paths?: boolean;
}

export interface NeighborStep {
  relation: string;
  from: string;
  to: string;
  relationId: bigint;
  time: TimeOut | null;
}

export interface NeighborRow {
  entity: string;
  depth: number;
  via?: Omit<NeighborStep, 'to'>;
  viaCount?: number;
  paths?: NeighborStep[][];
  properties?: Record<string, unknown[]>;
}

export const MAX_DEPTH = 6;
export const MAX_PATHS = 10_000;

function invalid(message: string, field: string): RemoraError {
  return new RemoraError('invalid_param', message, { field });
}

/** Type id sets for the two step branches (R11). */
async function typeSets(
  db: Queryable,
  relationTypes: string[] | undefined,
  direction: Direction,
): Promise<{ out: number[]; in: number[] }> {
  let types: { id: number; directed: boolean }[];
  if (relationTypes === undefined) {
    const r = await db.query<{ id: number; directed: boolean }>('SELECT id, directed FROM relation_type');
    types = r.rows;
  } else {
    types = [];
    for (const name of relationTypes) types.push(await resolveRelationType(db, name));
  }
  const out = new Set<number>();
  const inn = new Set<number>();
  for (const t of types) {
    if (!t.directed || direction !== 'in') out.add(t.id);
    if (!t.directed || direction !== 'out') inn.add(t.id);
  }
  return { out: [...out], in: [...inn] };
}

interface PathRec {
  nodes: string[];
  rels: string[];
}

/** Shortest first, then by relation row ids (R14). */
function comparePaths(x: PathRec, y: PathRec): number {
  if (x.rels.length !== y.rels.length) return x.rels.length - y.rels.length;
  for (let i = 0; i < x.rels.length; i++) {
    const d = BigInt(x.rels[i]!) - BigInt(y.rels[i]!);
    if (d !== 0n) return d < 0n ? -1 : 1;
  }
  return 0;
}

/** One traversal step from the lateral alias `from`: columns `next` and, when asked, `rid` (relation row id). */
function edgeSql(
  from: 'p' | 'r',
  side: 'src' | 'dst',
  other: 'dst' | 'src',
  typesParam: number,
  whenSql: string,
  withRid: boolean,
): string {
  return `SELECT rel.${other} AS next${withRid ? ', rel.id AS rid' : ''} FROM relation rel
      WHERE rel.${side} = ${from}.entity_id AND rel.relation_type_id = ANY($${typesParam}::smallint[])
        AND rel.retracted_at IS NULL AND ${whenSql}`;
}

interface Level {
  id: string;
  depth: number;
}

export async function neighbors(
  db: Queryable,
  registry: PluginRegistry,
  a: NeighborsArgs,
): Promise<{ rows: NeighborRow[]; total: number; truncated: boolean }> {
  const depth = a.depth ?? 1;
  if (!Number.isInteger(depth) || depth < 1 || depth > MAX_DEPTH) {
    throw invalid(`depth must be an integer 1..${MAX_DEPTH}`, 'depth');
  }
  if (a.relationTypes !== undefined && a.relationTypes.length === 0) {
    throw invalid('relation_types must not be empty', 'relation_types');
  }
  const direction = a.direction ?? 'both';
  if (direction !== 'out' && direction !== 'in' && direction !== 'both') {
    throw invalid('direction must be out, in or both', 'direction');
  }
  const dir = a.orderBy?.dir ?? 'asc';
  if (dir !== 'asc' && dir !== 'desc') throw invalid('order_by.dir must be asc or desc', 'order_by');
  const limit = clampLimit(a.limit);

  const start = await requireEntity(db, a.entity);
  const types = await typeSets(db, a.relationTypes, direction);
  const included: { id: number; name: string }[] = [];
  for (const name of a.include ?? []) {
    const p = await resolveProperty(db, name);
    if (!included.some((x) => x.id === p.id)) included.push({ id: p.id, name: p.name });
  }
  const sortProp = a.orderBy ? await resolveProperty(db, a.orderBy.property) : undefined;

  // 1. levels: min depth per reachable entity (includes the start at 0).
  const w = whenClause(a.when, 5);
  const startId = start.entityId.toString();
  const pathsByEntity = new Map<string, PathRec[]>();
  let levels: Level[];
  if (a.paths) {
    // R14: enumerate simple paths; the LIMIT lets PG stop the recursion early.
    const pathRes = await db.query<{ entity_id: string; depth: number; nodes: string[]; rels: string[] }>(
      `WITH RECURSIVE paths(entity_id, depth, nodes, rels) AS (
         SELECT $1::bigint, 0, ARRAY[$1::bigint], ARRAY[]::bigint[]
         UNION ALL
         SELECT n.next, p.depth + 1, p.nodes || n.next, p.rels || n.rid
           FROM paths p
          CROSS JOIN LATERAL (
            ${edgeSql('p', 'src', 'dst', 2, w.sql, true)}
            UNION ALL
            ${edgeSql('p', 'dst', 'src', 3, w.sql, true)}
          ) n
          WHERE p.depth < $4::int AND NOT n.next = ANY(p.nodes)
       )
       SELECT entity_id, depth, nodes, rels FROM paths WHERE depth > 0 LIMIT ${MAX_PATHS + 1}`,
      [startId, types.out, types.in, depth, ...w.params],
    );
    if (pathRes.rows.length > MAX_PATHS) {
      throw new RemoraError('too_many_paths', `more than ${MAX_PATHS} paths; reduce depth or filter relation types`, {
        limit: MAX_PATHS,
      });
    }
    for (const r of pathRes.rows) {
      const list = pathsByEntity.get(r.entity_id) ?? [];
      list.push({ nodes: r.nodes, rels: r.rels });
      pathsByEntity.set(r.entity_id, list);
    }
    levels = [{ id: startId, depth: 0 }];
    for (const [id, list] of pathsByEntity) {
      levels.push({ id, depth: list.reduce((m, p) => Math.min(m, p.rels.length), Infinity) });
    }
  } else {
    const levelRes = await db.query<{ entity_id: string; depth: number }>(
      `WITH RECURSIVE reach(entity_id, depth) AS (
         SELECT $1::bigint, 0
         UNION
         SELECT n.next, r.depth + 1
           FROM reach r
          CROSS JOIN LATERAL (
            ${edgeSql('r', 'src', 'dst', 2, w.sql, false)}
            UNION ALL
            ${edgeSql('r', 'dst', 'src', 3, w.sql, false)}
          ) n
          WHERE r.depth < $4::int
       )
       SELECT entity_id, min(depth) AS depth FROM reach GROUP BY entity_id`,
      [startId, types.out, types.in, depth, ...w.params],
    );
    levels = levelRes.rows.map((r) => ({ id: r.entity_id, depth: Number(r.depth) }));
  }
  const reachable = levels.filter((l) => l.id !== startId);
  const total = reachable.length;
  if (total === 0) return { rows: [], total: 0, truncated: false };

  // 2. rank all reachable entities, take the page.
  const rankParams: unknown[] = [reachable.map((l) => l.id), reachable.map((l) => l.depth)];
  let sortJoin = '';
  let sortOrder = '';
  if (sortProp) {
    rankParams.push(sortProp.id);
    const sw = whenClause(a.when, rankParams.length + 1);
    rankParams.push(...sw.params);
    const d = dir === 'desc' ? 'DESC' : 'ASC';
    sortJoin = `LEFT JOIN LATERAL (
        SELECT pv.value FROM property_version pv
         WHERE pv.entity_id = t.entity_id AND pv.property_type_id = $3 AND pv.retracted_at IS NULL AND ${sw.sql}
         ORDER BY pv.value ${d} LIMIT 1
      ) sk ON true`;
    sortOrder = `sk.value ${d} NULLS LAST, `;
  }
  rankParams.push(limit);
  const page = await db.query<{ entity_id: string; key: string; depth: number }>(
    `SELECT t.entity_id, e.key, t.depth
       FROM unnest($1::bigint[], $2::int[]) t(entity_id, depth)
       JOIN entity e ON e.entity_id = t.entity_id
       ${sortJoin}
      ORDER BY ${sortOrder}t.depth, e.key
      LIMIT $${rankParams.length}`,
    rankParams,
  );
  const rows: NeighborRow[] = page.rows.map((r) => ({ entity: r.key, depth: Number(r.depth) }));
  const pageIds = page.rows.map((r) => r.entity_id);
  const pageDepths = page.rows.map((r) => Number(r.depth));
  const byId = new Map(page.rows.map((r, i) => [r.entity_id, rows[i]!]));

  // 3. via + via_count per page entity.
  const vw = whenClause(a.when, 7);
  const via = a.paths ? { rows: [] } : await db.query<{
    entity_id: string;
    type: string;
    pred_key: string;
    relation_id: string;
    time_axis: number | null;
    lo: string | null;
    hi: string | null;
    cnt: string;
  }>(
    `SELECT t.entity_id, rt.name AS type, pe.key AS pred_key, r.relation_id,
            r.time_axis, lower(r.time_span)::text AS lo, upper(r.time_span)::text AS hi, v.cnt
       FROM unnest($1::bigint[], $2::int[]) t(entity_id, depth)
      CROSS JOIN LATERAL (
        SELECT (array_agg(x.id ORDER BY x.relation_id, x.id))[1] AS rel_pk,
               (array_agg(x.pred ORDER BY x.relation_id, x.id))[1] AS pred,
               count(DISTINCT x.relation_id) AS cnt
          FROM (
            SELECT rel.id, rel.relation_id, pl.entity_id AS pred
              FROM unnest($3::bigint[], $4::int[]) pl(entity_id, depth)
              JOIN relation rel
                ON (rel.src = pl.entity_id AND rel.dst = t.entity_id AND rel.relation_type_id = ANY($5::smallint[]))
                OR (rel.dst = pl.entity_id AND rel.src = t.entity_id AND rel.relation_type_id = ANY($6::smallint[]))
             WHERE pl.depth = t.depth - 1 AND rel.retracted_at IS NULL AND ${vw.sql}
          ) x
      ) v
      JOIN relation r ON r.id = v.rel_pk
      JOIN relation_type rt ON rt.id = r.relation_type_id
      JOIN entity pe ON pe.entity_id = v.pred`,
    [pageIds, pageDepths, levels.map((l) => l.id), levels.map((l) => l.depth), types.out, types.in, ...vw.params],
  );
  for (const v of via.rows) {
    const row = byId.get(v.entity_id)!;
    row.via = {
      relation: v.type,
      from: v.pred_key,
      relationId: BigInt(v.relation_id),
      time: formatTime(registry, v.time_axis, v.lo, v.hi),
    };
    row.viaCount = Number(v.cnt);
  }

  // 3b. paths for the page.
  if (a.paths) {
    const relIds = new Set<string>();
    const nodeIds = new Set<string>();
    for (const id of pageIds) {
      for (const p of pathsByEntity.get(id)!) {
        p.rels.forEach((x) => relIds.add(x));
        p.nodes.forEach((x) => nodeIds.add(x));
      }
    }
    const relRes = await db.query<{
      id: string;
      relation_id: string;
      type: string;
      time_axis: number | null;
      lo: string | null;
      hi: string | null;
    }>(
      `SELECT r.id, r.relation_id, rt.name AS type, r.time_axis,
              lower(r.time_span)::text AS lo, upper(r.time_span)::text AS hi
         FROM relation r JOIN relation_type rt ON rt.id = r.relation_type_id
        WHERE r.id = ANY($1::bigint[])`,
      [[...relIds]],
    );
    const keyRes = await db.query<{ entity_id: string; key: string }>(
      'SELECT entity_id, key FROM entity WHERE entity_id = ANY($1::bigint[])',
      [[...nodeIds]],
    );
    const relById = new Map(relRes.rows.map((r) => [r.id, r]));
    const keyById = new Map(keyRes.rows.map((r) => [r.entity_id, r.key]));
    for (const [i, id] of pageIds.entries()) {
      const list = [...pathsByEntity.get(id)!].sort(comparePaths);
      rows[i]!.paths = list.map((p) =>
        p.rels.map((rid, k): NeighborStep => {
          const r = relById.get(rid)!;
          return {
            relation: r.type,
            from: keyById.get(p.nodes[k]!)!,
            to: keyById.get(p.nodes[k + 1]!)!,
            relationId: BigInt(r.relation_id),
            time: formatTime(registry, r.time_axis, r.lo, r.hi),
          };
        }),
      );
    }
  }

  // 4. properties for the page. `include: []` yields an empty `properties` object on every row.
  if (a.include !== undefined) {
    for (const row of rows) {
      row.properties = Object.fromEntries(included.map((p) => [p.name, [] as unknown[]]));
    }
    if (included.length > 0) {
      const pw = whenClause(a.when, 3);
      const props = await db.query<{ entity_id: string; name: string; value: unknown }>(
        `SELECT pv.entity_id, pt.name, pv.value
           FROM property_version pv JOIN property_type pt ON pt.id = pv.property_type_id
          WHERE pv.entity_id = ANY($1::bigint[]) AND pv.property_type_id = ANY($2::smallint[])
            AND pv.retracted_at IS NULL AND ${pw.sql}
          ORDER BY pv.id`,
        [pageIds, included.map((p) => p.id), ...pw.params],
      );
      for (const p of props.rows) byId.get(p.entity_id)!.properties![p.name]!.push(p.value);
    }
  }

  return { rows, total, truncated: total > rows.length };
}

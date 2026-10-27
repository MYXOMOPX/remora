import { RemoraError } from '@remora/sdk';
import type { Queryable } from '../db/types.js';
import type { PluginRegistry } from '../plugins/registry.js';
import { clampLimit, wordPatterns } from '../sql/like.js';
import { requireEntity } from './entities.js';
import { normalizeKeywords } from './events.js';
import { formatEventTime, type EventTimeOut, type When } from './time.js';

export interface EventRow {
  id: bigint;
  summary: string;
  details: string | null;
  keywords: string[];
  time: EventTimeOut[];
  entities: { entity: string; role: string }[];
  evidenceId: bigint | null;
  recordedAt: Date;
  updatedAt: Date | null;
  retractedAt: Date | null;
}

export interface SearchEventsArgs {
  text?: string;
  keywords?: string[];
  match?: 'any' | 'all';
  entities?: string[];
  when?: When;
  limit?: number;
}

interface RawEvent {
  id: string;
  summary: string;
  details: string | null;
  keywords: string[];
  evidence_id: string | null;
  recorded_at: Date;
  updated_at: Date | null;
  retracted_at: Date | null;
}

const EVENT_COLS = `ev.id, ev.summary, ev.details, ev.keywords, ev.evidence_id,
  ev.recorded_at, ev.updated_at, ev.retracted_at`;

function invalid(message: string, field: string): RemoraError {
  return new RemoraError('invalid_param', message, { field });
}

/** Loads times and entity links for the given events (two queries) and assembles rows in input order. */
async function hydrate(db: Queryable, registry: PluginRegistry, raws: RawEvent[]): Promise<EventRow[]> {
  if (raws.length === 0) return [];
  const ids = raws.map((r) => r.id);
  const times = new Map<string, EventTimeOut[]>();
  const tr = await db.query<{
    event_id: string;
    time_axis: number;
    lo: string | null;
    hi: string | null;
    instant: boolean;
  }>(
    `SELECT event_id, time_axis, lower(time_span)::text AS lo, upper(time_span)::text AS hi, instant
       FROM event_time WHERE event_id = ANY($1::bigint[]) ORDER BY event_id, time_axis`,
    [ids],
  );
  for (const t of tr.rows) {
    const list = times.get(t.event_id) ?? [];
    list.push(formatEventTime(registry, t.time_axis, t.lo, t.hi, t.instant));
    times.set(t.event_id, list);
  }
  const links = new Map<string, { entity: string; role: string }[]>();
  const lr = await db.query<{ event_id: string; key: string; role: string }>(
    `SELECT ee.event_id, e.key, ee.role
       FROM event_entity ee JOIN entity e USING (entity_id)
      WHERE ee.event_id = ANY($1::bigint[]) ORDER BY ee.event_id, e.key, ee.role`,
    [ids],
  );
  for (const l of lr.rows) {
    const list = links.get(l.event_id) ?? [];
    list.push({ entity: l.key, role: l.role });
    links.set(l.event_id, list);
  }
  return raws.map((r) => ({
    id: BigInt(r.id),
    summary: r.summary,
    details: r.details,
    keywords: r.keywords,
    time: times.get(r.id) ?? [],
    entities: links.get(r.id) ?? [],
    evidenceId: r.evidence_id === null ? null : BigInt(r.evidence_id),
    recordedAt: r.recorded_at,
    updatedAt: r.updated_at,
    retractedAt: r.retracted_at,
  }));
}

export async function getEvent(db: Queryable, registry: PluginRegistry, id: bigint): Promise<EventRow> {
  const r = await db.query<RawEvent>(`SELECT ${EVENT_COLS} FROM event ev WHERE ev.id = $1`, [id]);
  if (r.rows.length === 0) throw new RemoraError('not_found', `event ${id} not found`, { id: Number(id) });
  return (await hydrate(db, registry, r.rows))[0]!;
}

/** R25 */
export async function searchEvents(
  db: Queryable,
  registry: PluginRegistry,
  a: SearchEventsArgs,
): Promise<{ rows: EventRow[]; total: number; truncated: boolean }> {
  const limit = clampLimit(a.limit);
  const conds: string[] = ['ev.retracted_at IS NULL'];
  const params: unknown[] = [];
  const p = (v: unknown, cast = ''): string => {
    params.push(v);
    return `$${params.length}${cast}`;
  };

  if (a.match !== undefined && a.match !== 'any' && a.match !== 'all') {
    throw invalid('match must be any or all', 'match');
  }
  if (a.text !== undefined) {
    for (const pat of wordPatterns(a.text)) {
      conds.push(`(ev.summary || ' ' || coalesce(ev.details, '')) ILIKE ${p(pat)}`);
    }
  }
  if (a.keywords !== undefined) {
    if (!Array.isArray(a.keywords) || a.keywords.length === 0) {
      throw invalid('keywords must be a non-empty array', 'keywords');
    }
    const op = a.match === 'all' ? '@>' : '&&';
    conds.push(`ev.keywords ${op} ${p(normalizeKeywords(a.keywords), '::text[]')}`);
  }
  if (a.entities !== undefined) {
    if (!Array.isArray(a.entities)) throw invalid('entities must be an array', 'entities');
    const seen = new Set<bigint>();
    for (const key of a.entities) {
      const e = await requireEntity(db, key);
      if (seen.has(e.entityId)) continue;
      seen.add(e.entityId);
      conds.push(
        `EXISTS (SELECT 1 FROM event_entity ee WHERE ee.event_id = ev.id AND ee.entity_id = ${p(e.entityId)})`,
      );
    }
  }
  let order = 'ev.id DESC';
  if (a.when !== undefined) {
    const ax = p(a.when.axis.id, '::smallint');
    const span =
      'at' in a.when
        ? `t.time_span @> ${p(a.when.at, '::bigint')}`
        : `t.time_span && int8range(${p(a.when.from, '::bigint')}, ${p(a.when.to, '::bigint')}, '[)')`;
    conds.push(`EXISTS (SELECT 1 FROM event_time t WHERE t.event_id = ev.id AND t.time_axis = ${ax} AND ${span})`);
    order = `(SELECT lower(t.time_span) FROM event_time t WHERE t.event_id = ev.id AND t.time_axis = ${ax}) DESC NULLS LAST, ev.id DESC`;
  }

  const where = conds.join(' AND ');
  const count = await db.query<{ n: string }>(`SELECT count(*) AS n FROM event ev WHERE ${where}`, params);
  const total = Number(count.rows[0]!.n);
  const page = await db.query<RawEvent>(
    `SELECT ${EVENT_COLS} FROM event ev WHERE ${where} ORDER BY ${order} LIMIT ${p(limit)}`,
    params,
  );
  const rows = await hydrate(db, registry, page.rows);
  return { rows, total, truncated: total > rows.length };
}

export function entityEvents(
  db: Queryable,
  registry: PluginRegistry,
  a: { entity: string; when?: When; limit?: number },
): Promise<{ rows: EventRow[]; total: number; truncated: boolean }> {
  return searchEvents(db, registry, {
    entities: [a.entity],
    ...(a.when !== undefined ? { when: a.when } : {}),
    ...(a.limit !== undefined ? { limit: a.limit } : {}),
  });
}

export async function listEventRoles(db: Queryable): Promise<string[]> {
  const r = await db.query<{ role: string }>(
    `SELECT DISTINCT ee.role FROM event_entity ee JOIN event ev ON ev.id = ee.event_id
      WHERE ev.retracted_at IS NULL ORDER BY ee.role`,
  );
  return r.rows.map((x) => x.role);
}

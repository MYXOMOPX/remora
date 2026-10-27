import { RemoraError } from '@remora/sdk';
import type { Queryable } from '../db/types.js';
import { normalizeName } from './dictionaries.js';
import { requireEntity } from './entities.js';
import type { EventSpan } from './time.js';

export interface EventEntityIn {
  entity: string;
  role?: string;
}

export interface EventUpdate {
  id: bigint;
  summary?: string;
  details?: string | null;
  keywords?: { set: string[] } | { add?: string[]; remove?: string[] };
  times?: EventSpan[];
  entities?: { add?: EventEntityIn[]; remove?: EventEntityIn[] };
  evidenceId?: bigint;
}

const DEFAULT_ROLE = 'participant';

function invalid(message: string, field?: string): RemoraError {
  return new RemoraError('invalid_param', message, field === undefined ? undefined : { field });
}

function notFound(id: bigint): RemoraError {
  return new RemoraError('not_found', `event ${id} not found`, { id: Number(id) });
}

/** R23: NFC, trim, lowercase, de-duplicate (first occurrence wins); an empty keyword is invalid. */
export function normalizeKeywords(raw: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const k of raw) {
    if (typeof k !== 'string') throw invalid('keywords must be strings', 'keywords');
    const n = k.normalize('NFC').trim().toLowerCase();
    if (n === '') throw invalid('keyword must not be empty', 'keywords');
    if (!seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

function cleanSummary(summary: unknown): string {
  if (typeof summary !== 'string' || summary.trim() === '') throw invalid('summary must not be empty', 'summary');
  return summary.trim();
}

function checkDetails(details: unknown): void {
  if (details !== undefined && details !== null && typeof details !== 'string') {
    throw invalid('details must be a string', 'details');
  }
}

interface ResolvedLink {
  entityId: bigint;
  role: string;
}

async function resolveLinks(db: Queryable, items: EventEntityIn[]): Promise<ResolvedLink[]> {
  const out: ResolvedLink[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    const entity = await requireEntity(db, it.entity);
    const role = it.role === undefined ? DEFAULT_ROLE : normalizeName(it.role);
    const k = `${entity.entityId}:${role}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ entityId: entity.entityId, role });
  }
  return out;
}

async function upsertTimes(db: Queryable, eventId: bigint, times: EventSpan[]): Promise<void> {
  for (const t of times) {
    await db.query(
      `INSERT INTO event_time (event_id, time_axis, time_span, instant)
       VALUES ($1, $2::smallint, int8range($3::bigint, $4::bigint, '[)'), $5)
       ON CONFLICT (event_id, time_axis)
       DO UPDATE SET time_span = EXCLUDED.time_span, instant = EXCLUDED.instant`,
      [eventId, t.axis.id, t.lo, t.hi, t.instant],
    );
  }
}

async function insertLinks(db: Queryable, eventId: bigint, links: ResolvedLink[]): Promise<void> {
  for (const l of links) {
    await db.query(
      `INSERT INTO event_entity (event_id, entity_id, role) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [eventId, l.entityId, l.role],
    );
  }
}

export async function addEvent(
  db: Queryable,
  a: {
    summary: string;
    details?: string;
    keywords?: string[];
    times: EventSpan[];
    entities?: EventEntityIn[];
    evidenceId?: bigint;
  },
): Promise<{ id: bigint }> {
  const summary = cleanSummary(a.summary);
  checkDetails(a.details);
  const keywords = normalizeKeywords(a.keywords ?? []);
  if (a.times.length === 0) throw invalid('time is required', 'time');
  const links = await resolveLinks(db, a.entities ?? []);
  const r = await db.query<{ id: string }>(
    `INSERT INTO event (summary, details, keywords, evidence_id)
     VALUES ($1, $2, $3::text[], $4) RETURNING id`,
    [summary, a.details ?? null, keywords, a.evidenceId ?? null],
  );
  const id = BigInt(r.rows[0]!.id);
  await upsertTimes(db, id, a.times);
  await insertLinks(db, id, links);
  return { id };
}

/** R24 */
export async function updateEvent(db: Queryable, u: EventUpdate): Promise<{ id: bigint }> {
  const changes = [u.summary, u.details, u.keywords, u.times, u.entities, u.evidenceId];
  if (changes.every((x) => x === undefined)) throw invalid('update_event needs at least one field to change');
  const summary = u.summary === undefined ? undefined : cleanSummary(u.summary);
  checkDetails(u.details);
  let kw: { set: string[] } | { add: string[]; remove: string[] } | undefined;
  if (u.keywords !== undefined) {
    const k = u.keywords as { set?: string[]; add?: string[]; remove?: string[] };
    const hasSet = k.set !== undefined;
    const hasDelta = k.add !== undefined || k.remove !== undefined;
    if (hasSet === hasDelta) throw invalid('keywords needs either set or add/remove', 'keywords');
    if (hasSet) {
      if (!Array.isArray(k.set)) throw invalid('keywords.set must be an array', 'keywords');
      kw = { set: normalizeKeywords(k.set) };
    } else {
      for (const part of [k.add, k.remove]) {
        if (part !== undefined && !Array.isArray(part)) {
          throw invalid('keywords add/remove must be arrays', 'keywords');
        }
      }
      kw = { add: normalizeKeywords(k.add ?? []), remove: normalizeKeywords(k.remove ?? []) };
    }
  }

  const cur = await db.query<{ keywords: string[] }>(
    'SELECT keywords FROM event WHERE id = $1 AND retracted_at IS NULL FOR UPDATE',
    [u.id],
  );
  if (cur.rows.length === 0) throw notFound(u.id);

  let keywords: string[] | undefined;
  if (kw) {
    if ('set' in kw) keywords = kw.set;
    else {
      const drop = new Set(kw.remove);
      keywords = normalizeKeywords([...cur.rows[0]!.keywords.filter((x) => !drop.has(x)), ...kw.add]);
    }
  }

  const sets: string[] = ['updated_at = now()'];
  const params: unknown[] = [u.id];
  const push = (col: string, v: unknown, cast = ''): void => {
    params.push(v);
    sets.push(`${col} = $${params.length}${cast}`);
  };
  if (summary !== undefined) push('summary', summary);
  if (u.details !== undefined) push('details', u.details);
  if (keywords !== undefined) push('keywords', keywords, '::text[]');
  if (u.evidenceId !== undefined) push('evidence_id', u.evidenceId);
  await db.query(`UPDATE event SET ${sets.join(', ')} WHERE id = $1`, params);

  if (u.times) await upsertTimes(db, u.id, u.times);
  if (u.entities) {
    // remove first, then add: a pair listed in both ends up attached
    for (const rm of u.entities.remove ?? []) {
      const entity = await requireEntity(db, rm.entity);
      const del =
        rm.role === undefined
          ? await db.query('DELETE FROM event_entity WHERE event_id = $1 AND entity_id = $2', [
              u.id,
              entity.entityId,
            ])
          : await db.query('DELETE FROM event_entity WHERE event_id = $1 AND entity_id = $2 AND role = $3', [
              u.id,
              entity.entityId,
              normalizeName(rm.role),
            ]);
      if (del.rowCount === 0) {
        throw new RemoraError('not_found', `entity ${rm.entity} is not attached to event ${u.id}`, {
          id: Number(u.id),
          entity: rm.entity,
        });
      }
    }
    await insertLinks(db, u.id, await resolveLinks(db, u.entities.add ?? []));
  }
  return { id: u.id };
}

export async function retractEvent(
  db: Queryable,
  a: { id: bigint; evidenceId?: bigint },
): Promise<{ id: bigint }> {
  const r = await db.query(
    `UPDATE event SET retracted_at = now(), retracted_evidence_id = $2
      WHERE id = $1 AND retracted_at IS NULL`,
    [a.id, a.evidenceId ?? null],
  );
  if (r.rowCount === 0) throw notFound(a.id);
  return { id: a.id };
}

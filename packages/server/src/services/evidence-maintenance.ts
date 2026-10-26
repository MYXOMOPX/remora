import { RemoraError, type RetentionAction, type RetentionRow } from '@remora/sdk';
import type pg from 'pg';
import { rollback } from '../api/apply.js';
import type { Queryable } from '../db/types.js';
import type { PluginRegistry, SourceInfo } from '../plugins/registry.js';

export const RETENTION_BATCH = 500;
export const PURGE_BATCH = 1000;
const MAX_BATCH = 10_000;

export interface RetentionReport {
  processed: number;
  kept: number;
  replaced: number;
  purged: number;
  skipped: string[];
}

export type PurgeArgs = { ids: bigint[] } | { source: string; olderThan: Date };

/** Runs fn in its own READ COMMITTED transaction on a pooled client. */
async function inTx<T>(pool: pg.Pool, fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let destroy: Error | undefined;
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    destroy = await rollback(client);
    throw e;
  } finally {
    client.release(destroy);
  }
}

function isThenable(x: unknown): boolean {
  return typeof x === 'object' && x !== null && typeof (x as { then?: unknown }).then === 'function';
}

type Planned = { id: bigint; action: 'keep' } | { id: bigint; action: 'purge' } | {
  id: bigint;
  action: 'replace';
  payload: string;
  retentionState: string | null;
};

/** Validates everything a plugin returned before any write happens. */
function validatePlan(source: string, ids: Set<bigint>, plan: unknown): Planned[] {
  const bad = (why: string): RemoraError =>
    new RemoraError('invalid_plugin', `planRetention of source ${source} ${why}`, { source });
  if (isThenable(plan)) {
    (plan as Promise<unknown>).catch(() => undefined);
    throw bad('must be synchronous');
  }
  if (!Array.isArray(plan)) throw bad('did not return an array');
  const seen = new Set<bigint>();
  const out: Planned[] = [];
  const json = (v: unknown): string => {
    let j: string | undefined;
    try {
      j = JSON.stringify(v);
    } catch {
      throw bad('returned a value that is not JSON-serializable');
    }
    if (j === undefined) throw bad('returned a value that is not JSON-serializable');
    return j;
  };
  for (const raw of plan as unknown[]) {
    if (typeof raw !== 'object' || raw === null) throw bad('returned a malformed action');
    const a = raw as Partial<RetentionAction> & { payload?: unknown; retentionState?: unknown };
    if (typeof a.id !== 'bigint' || !ids.has(a.id)) throw bad('returned an action for an id outside the batch');
    if (seen.has(a.id)) throw bad('returned two actions for one id');
    seen.add(a.id);
    if (a.action === 'keep' || a.action === 'purge') {
      out.push({ id: a.id, action: a.action });
    } else if (a.action === 'replace') {
      if (a.payload === undefined) throw bad('returned replace without a payload');
      out.push({
        id: a.id,
        action: 'replace',
        payload: json(a.payload),
        retentionState: a.retentionState === undefined || a.retentionState === null ? null : json(a.retentionState),
      });
    } else {
      throw bad('returned an unknown action');
    }
  }
  return out;
}

async function retainSource(
  pool: pg.Pool,
  info: SourceInfo,
  batchSize: number,
  now: Date,
  report: RetentionReport,
): Promise<void> {
  let last = '0';
  for (;;) {
    const n = await inTx(pool, async (db) => {
      const r = await db.query<{
        id: string;
        payload: unknown;
        retention_state: unknown;
        created_at: Date;
      }>(
        `SELECT id, payload, retention_state, created_at FROM evidence_log
          WHERE source_id = $1 AND NOT pinned AND purged_at IS NULL AND id > $2::bigint
          ORDER BY id LIMIT $3 FOR UPDATE`,
        [info.id, last, batchSize],
      );
      if (r.rows.length === 0) return 0;
      const rows: RetentionRow[] = r.rows.map((x) => ({
        id: BigInt(x.id),
        payload: x.payload,
        retentionState: x.retention_state,
        createdAt: x.created_at,
      }));
      let plan: unknown;
      try {
        plan = info.def.planRetention(rows, now);
      } catch (e) {
        if (e instanceof RemoraError) throw e;
        throw new RemoraError('invalid_plugin', `planRetention of source ${info.name} threw`, {
          source: info.name,
          reason: e instanceof Error ? e.message : String(e),
        });
      }
      const actions = validatePlan(info.name, new Set(rows.map((x) => x.id)), plan);
      let replaced = 0;
      let purged = 0;
      for (const a of actions) {
        if (a.action === 'purge') {
          await db.query(
            `UPDATE evidence_log SET payload = NULL, retention_state = NULL, purged_at = now() WHERE id = $1`,
            [a.id.toString()],
          );
          purged++;
        } else if (a.action === 'replace') {
          await db.query(`UPDATE evidence_log SET payload = $2::jsonb, retention_state = $3::jsonb WHERE id = $1`, [
            a.id.toString(),
            a.payload,
            a.retentionState,
          ]);
          replaced++;
        }
      }
      // counters only change once the whole batch is validated and applied
      report.processed += rows.length;
      report.replaced += replaced;
      report.purged += purged;
      report.kept += rows.length - replaced - purged;
      last = r.rows[r.rows.length - 1]!.id;
      return rows.length;
    });
    if (n < batchSize) return;
  }
}

/** R18: apply each source's retention plan in batches, one transaction per batch. */
export async function applyRetention(
  pool: pg.Pool,
  registry: PluginRegistry,
  a: { source?: string; batchSize?: number; now?: Date } = {},
): Promise<RetentionReport> {
  const batchSize = a.batchSize ?? RETENTION_BATCH;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH) {
    throw new RemoraError('invalid_param', `batchSize must be an integer from 1 to ${MAX_BATCH}`, {
      field: 'batchSize',
    });
  }
  const now = a.now ?? new Date();
  const report: RetentionReport = { processed: 0, kept: 0, replaced: 0, purged: 0, skipped: [] };
  let sources: SourceInfo[];
  if (a.source !== undefined) {
    sources = [registry.getSource(a.source)];
  } else {
    sources = registry.listSources();
    const served = new Set(sources.map((s) => s.name));
    const all = await pool.query<{ name: string }>('SELECT name FROM evidence_source ORDER BY id');
    report.skipped = all.rows.map((r) => r.name).filter((n) => !served.has(n));
  }
  for (const info of sources) await retainSource(pool, info, batchSize, now, report);
  return report;
}

const PURGE_SET = `payload = NULL, retention_state = NULL, purged_at = now()`;

/** R19: manual purge by ids or by source and age; pinned rows are skipped and counted. */
export async function purgeEvidence(
  pool: pg.Pool,
  a: PurgeArgs,
): Promise<{ purged: number; skippedPinned: number }> {
  if ('ids' in a) {
    if (!Array.isArray(a.ids) || a.ids.length === 0 || a.ids.some((i) => typeof i !== 'bigint' || i < 1n)) {
      throw new RemoraError('invalid_param', 'ids must be a non-empty array of positive ids', { field: 'ids' });
    }
    const ids = [...new Set(a.ids.map((i) => i.toString()))];
    const found = await pool.query<{ id: string }>('SELECT id FROM evidence_log WHERE id = ANY($1::bigint[])', [ids]);
    const have = new Set(found.rows.map((r) => r.id));
    const missing = ids.filter((i) => !have.has(i));
    if (missing.length > 0) {
      throw new RemoraError('not_found', 'some evidence ids do not exist', { ids: missing.map(Number) });
    }
    let purged = 0;
    let skippedPinned = 0;
    for (let i = 0; i < ids.length; i += PURGE_BATCH) {
      const batch = ids.slice(i, i + PURGE_BATCH);
      await inTx(pool, async (db) => {
        const p = await db.query(
          `SELECT count(*)::int AS n FROM evidence_log WHERE id = ANY($1::bigint[]) AND pinned AND purged_at IS NULL`,
          [batch],
        );
        skippedPinned += p.rows[0].n;
        const u = await db.query(
          `UPDATE evidence_log SET ${PURGE_SET} WHERE id = ANY($1::bigint[]) AND NOT pinned AND purged_at IS NULL`,
          [batch],
        );
        purged += u.rowCount ?? 0;
      });
    }
    return { purged, skippedPinned };
  }
  if (typeof a.source !== 'string' || !(a.olderThan instanceof Date) || Number.isNaN(a.olderThan.getTime())) {
    throw new RemoraError('invalid_param', 'source and a valid olderThan are required');
  }
  const src = await pool.query<{ id: number }>('SELECT id FROM evidence_source WHERE name = $1', [a.source]);
  if (src.rows.length === 0) throw new RemoraError('unknown_source', `unknown evidence source ${a.source}`);
  const sourceId = src.rows[0]!.id;
  const pinnedCount = await pool.query(
    `SELECT count(*)::int AS n FROM evidence_log
      WHERE source_id = $1 AND created_at < $2 AND pinned AND purged_at IS NULL`,
    [sourceId, a.olderThan],
  );
  let purged = 0;
  for (;;) {
    const n = await inTx(pool, async (db) => {
      const u = await db.query(
        `UPDATE evidence_log SET ${PURGE_SET} WHERE id IN (
           SELECT id FROM evidence_log
            WHERE source_id = $1 AND created_at < $2 AND NOT pinned AND purged_at IS NULL
            ORDER BY id LIMIT $3 FOR UPDATE)`,
        [sourceId, a.olderThan, PURGE_BATCH],
      );
      return u.rowCount ?? 0;
    });
    purged += n;
    if (n < PURGE_BATCH) break;
  }
  return { purged, skippedPinned: pinnedCount.rows[0].n };
}

async function setPinned(db: Queryable, id: bigint, pinned: boolean): Promise<void> {
  const r = await db.query('UPDATE evidence_log SET pinned = $2 WHERE id = $1 RETURNING id', [id.toString(), pinned]);
  if (r.rows.length === 0) throw new RemoraError('not_found', `evidence ${id} not found`, { id: Number(id) });
}

export const pinEvidence = (db: Queryable, id: bigint): Promise<void> => setPinned(db, id, true);
export const unpinEvidence = (db: Queryable, id: bigint): Promise<void> => setPinned(db, id, false);

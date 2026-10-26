import { RemoraError } from '@remora/sdk';
import type { Queryable } from '../db/types.js';
import type { PluginRegistry } from '../plugins/registry.js';
import { compileCached, ajv } from './ajv.js';

export interface EvidenceRow {
  id: bigint;
  source: string;
  payload: unknown;
  createdAt: Date;
  purgedAt: Date | null;
  pinned: boolean;
}

export interface EvidenceSourceRow {
  name: string;
  description: string;
  payloadSchema: unknown;
}

/** R16: validate against the source's payload schema, run the plugin's ingest, store the result. */
export async function addEvidence(
  db: Queryable,
  registry: PluginRegistry,
  a: { source: string; payload: unknown },
): Promise<{ id: bigint }> {
  if (a.payload === undefined) {
    throw new RemoraError('invalid_param', 'payload is required', { field: 'payload' });
  }
  const info = registry.getSource(a.source);
  const validate = compileCached(info.def.payloadSchema);
  if (!validate(a.payload)) {
    throw new RemoraError('invalid_payload', 'payload does not match the source schema', {
      source: a.source,
      reason: ajv.errorsText(validate.errors),
    });
  }
  let out: { payload: unknown; retentionState?: unknown };
  try {
    out = info.def.ingest(a.payload);
  } catch (e) {
    if (e instanceof RemoraError) throw e;
    throw new RemoraError('invalid_payload', 'ingest rejected the payload', {
      source: a.source,
      reason: e instanceof Error ? e.message : String(e),
    });
  }
  if (typeof out !== 'object' || out === null || out.payload === undefined) {
    throw new RemoraError('invalid_plugin', `ingest of source ${a.source} returned no payload`, {
      source: a.source,
    });
  }
  const r = await db.query<{ id: string }>(
    `INSERT INTO evidence_log (source_id, payload, retention_state)
     VALUES ($1, $2::jsonb, $3::jsonb) RETURNING id`,
    [
      info.id,
      JSON.stringify(out.payload),
      out.retentionState === undefined ? null : JSON.stringify(out.retentionState),
    ],
  );
  return { id: BigInt(r.rows[0]!.id) };
}

export async function getEvidence(db: Queryable, id: bigint): Promise<EvidenceRow> {
  const r = await db.query<{
    id: string;
    source: string;
    payload: unknown;
    created_at: Date;
    purged_at: Date | null;
    pinned: boolean;
  }>(
    `SELECT e.id, s.name AS source, e.payload, e.created_at, e.purged_at, e.pinned
       FROM evidence_log e JOIN evidence_source s ON s.id = e.source_id
      WHERE e.id = $1`,
    [id.toString()],
  );
  const row = r.rows[0];
  if (!row) throw new RemoraError('not_found', `evidence ${id} not found`, { id: Number(id) });
  return {
    id: BigInt(row.id),
    source: row.source,
    payload: row.payload,
    createdAt: row.created_at,
    purgedAt: row.purged_at,
    pinned: row.pinned,
  };
}

export async function listEvidenceSources(db: Queryable): Promise<EvidenceSourceRow[]> {
  const r = await db.query<{ name: string; description: string; payload_schema: unknown }>(
    'SELECT name, description, payload_schema FROM evidence_source ORDER BY id',
  );
  return r.rows.map((x) => ({ name: x.name, description: x.description, payloadSchema: x.payload_schema }));
}

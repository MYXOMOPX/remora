import { RemoraError } from '@remora/sdk';
import { mapPgError, type ApiError } from '../api/apply.js';
import { isObj, optBool, optInt, optStr, type Obj } from '../api/args.js';
import type { RemoraApp } from '../app.js';
import { statusFor } from './status.js';

/** R40: operator ops. Bodies are validated by hand; they are not part of the LLM contract. */
export type AdminResult = { status: number; body: unknown };

const MAX_NAME = 200;
const MAX_PACKAGE = 512;
const MAX_IDS = 10_000;
const MAX_CONFIG_DEPTH = 64;
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

type Handler = (app: RemoraApp, body: Obj) => Promise<unknown>;

function bad(field: string, expected: string): RemoraError {
  return new RemoraError('invalid_param', `${field} must be ${expected}`, { field });
}

/** Rejects keys the op does not know (typos must not be ignored silently). */
function only(body: Obj, allowed: readonly string[]): void {
  for (const k of Object.keys(body)) {
    if (!allowed.includes(k)) throw new RemoraError('invalid_param', 'unknown field in request body', { field: k.slice(0, 64) });
  }
}

function name(body: Obj, key: string): string {
  const v = optStr(body, key);
  if (v === undefined || v === '' || v.length > MAX_NAME || hasControl(v)) {
    throw bad(key, `a non-empty string of at most ${MAX_NAME} characters without control characters`);
  }
  return v;
}

function hasControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

function evidenceId(v: unknown, key: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) throw bad(key, 'a positive integer');
  return v;
}

/** A plain JSON tree without prototype-polluting keys, bounded in depth. */
function checkJson(v: unknown, field: string, depth = 0): void {
  if (depth > MAX_CONFIG_DEPTH) throw bad(field, `nested at most ${MAX_CONFIG_DEPTH} levels`);
  if (Array.isArray(v)) {
    for (const x of v) checkJson(x, field, depth + 1);
  } else if (typeof v === 'object' && v !== null) {
    for (const [k, x] of Object.entries(v)) {
      if (FORBIDDEN_KEYS.has(k)) throw bad(field, `free of the key ${k}`);
      checkJson(x, field, depth + 1);
    }
  }
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function isoDate(v: unknown, key: string): Date {
  const m = typeof v === 'string' ? ISO.exec(v) : null;
  if (m === null) throw bad(key, 'an ISO-8601 date or date-time string');
  const d = new Date(v as string);
  const day = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  if (
    Number.isNaN(d.getTime()) ||
    day.getUTCFullYear() !== +m[1]! ||
    day.getUTCMonth() !== +m[2]! - 1 ||
    day.getUTCDate() !== +m[3]!
  ) {
    throw bad(key, 'a valid ISO-8601 date or date-time string');
  }
  return d;
}

const HANDLERS: Record<string, Handler> = {
  async list_plugins(app, body) {
    only(body, []);
    return { rows: await app.listPlugins() };
  },
  async add_plugin(app, body) {
    only(body, ['package']);
    const pkg = optStr(body, 'package');
    if (pkg === undefined || pkg === '' || pkg.length > MAX_PACKAGE || hasControl(pkg)) {
      throw bad('package', `a non-empty string of at most ${MAX_PACKAGE} characters without control characters`);
    }
    const r = await app.addPlugin({ package: pkg });
    return { id: r.id, name: r.name, restart_required: true };
  },
  async set_plugin_config(app, body) {
    only(body, ['name', 'config', 'confirm']);
    const n = name(body, 'name');
    if (!('config' in body) || body.config === undefined) throw bad('config', 'present');
    checkJson(body.config, 'config');
    const confirm = optBool(body, 'confirm');
    const r = await app.setPluginConfig({ name: n, config: body.config, ...(confirm !== undefined ? { confirm } : {}) });
    return { name: r.name, restart_required: true };
  },
  async remove_plugin(app, body) {
    only(body, ['name']);
    const r = await app.removePlugin(name(body, 'name'));
    return { name: r.name, restart_required: true };
  },
  async apply_retention(app, body) {
    only(body, ['source', 'batch_size']);
    const source = optStr(body, 'source');
    if (source !== undefined && (source === '' || source.length > MAX_NAME)) throw bad('source', 'a non-empty string');
    const batchSize = optInt(body, 'batch_size');
    const r = await app.applyRetention({
      ...(source !== undefined ? { source } : {}),
      ...(batchSize !== undefined ? { batchSize } : {}),
    });
    return { processed: r.processed, kept: r.kept, replaced: r.replaced, purged: r.purged, skipped: r.skipped };
  },
  async purge_evidence(app, body) {
    only(body, ['ids', 'source', 'older_than']);
    const hasIds = body.ids !== undefined;
    const hasAge = body.source !== undefined || body.older_than !== undefined;
    if (hasIds === hasAge) throw bad('ids', 'given alone, or source with older_than, not both and not neither');
    let r: { purged: number; skippedPinned: number };
    if (hasIds) {
      const ids = body.ids;
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_IDS) {
        throw bad('ids', `an array of 1 to ${MAX_IDS} positive integers`);
      }
      r = await app.purgeEvidence({ ids: ids.map((i) => BigInt(evidenceId(i, 'ids'))) });
    } else {
      const source = name(body, 'source');
      r = await app.purgeEvidence({ source, olderThan: isoDate(body.older_than, 'older_than') });
    }
    return { purged: r.purged, skipped_pinned: r.skippedPinned };
  },
  async pin_evidence(app, body) {
    only(body, ['id']);
    const id = evidenceId(body.id, 'id');
    await app.pinEvidence(BigInt(id));
    return { id };
  },
  async unpin_evidence(app, body) {
    only(body, ['id']);
    const id = evidenceId(body.id, 'id');
    await app.unpinEvidence(BigInt(id));
    return { id };
  },
};

export const ADMIN_OPS: ReadonlySet<string> = new Set(Object.keys(HANDLERS));

/** Ops that also answer GET (no body). */
export const ADMIN_GET_OPS: ReadonlySet<string> = new Set(['list_plugins']);

function failure(e: ApiError): AdminResult {
  const { op_index: _ignored, ...error } = e;
  return { status: statusFor(e.code), body: { ok: false, error } };
}

export async function handleAdmin(app: RemoraApp, op: string, body: unknown): Promise<AdminResult> {
  const handler = Object.hasOwn(HANDLERS, op) ? HANDLERS[op] : undefined;
  if (handler === undefined) {
    return failure({ op_index: -1, code: 'not_found', message: 'not found' });
  }
  try {
    if (!isObj(body)) throw new RemoraError('invalid_param', 'request body must be a JSON object');
    return { status: 200, body: { ok: true, result: await handler(app, body) } };
  } catch (e) {
    const err = e instanceof RemoraError ? e : mapPgError(e);
    if (err === null) throw e;
    return failure({
      op_index: -1,
      code: err.code,
      message: err.message,
      ...(err.details !== undefined ? { details: err.details as Record<string, unknown> } : {}),
    });
  }
}

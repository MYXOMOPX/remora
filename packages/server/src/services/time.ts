import { RemoraError, type TimeAxisDef } from '@remora/sdk';
import type { PluginRegistry } from '../plugins/registry.js';
import { ajv, compileCached } from './ajv.js';

export interface AxisRef {
  id: number;
  name: string;
  def: TimeAxisDef;
}

export interface Span {
  axis: AxisRef;
  lo: bigint | null;
  hi: bigint | null;
}

export interface Moment {
  axis: AxisRef;
  at: bigint;
}

export type When = { axis: AxisRef; at: bigint } | { axis: AxisRef; from: bigint; to: bigint };

export interface TimeOut {
  axis: string;
  from?: unknown;
  to?: unknown;
}

const INT8_MIN = -(2n ** 63n);
const INT8_MAX = 2n ** 63n - 1n;

function invalidParam(message: string, details?: Record<string, unknown>): RemoraError {
  return new RemoraError('invalid_param', message, details);
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

export function encodeValue(axis: AxisRef, value: unknown): bigint {
  const validate = compileCached(axis.def.valueSchema);
  if (!validate(value)) {
    throw new RemoraError('invalid_time', `value is not valid for axis ${axis.name}`, {
      axis: axis.name,
      reason: ajv.errorsText(validate.errors),
    });
  }
  let n: unknown;
  try {
    n = axis.def.encode(value);
  } catch (e) {
    if (e instanceof RemoraError) throw e;
    throw new RemoraError('invalid_time', `axis ${axis.name} could not encode the value`, {
      axis: axis.name,
      reason: e instanceof Error ? e.message : String(e),
    });
  }
  if (typeof n !== 'bigint' || n < INT8_MIN || n > INT8_MAX) {
    throw new RemoraError('invalid_time', `axis ${axis.name} encoded the value outside the int8 range`, {
      axis: axis.name,
      reason: 'encoded value must be a bigint within -2^63..2^63-1',
    });
  }
  return n;
}

function readAxis(registry: PluginRegistry, obj: Record<string, unknown>): AxisRef {
  if (typeof obj.axis !== 'string' || obj.axis === '') throw invalidParam('time.axis must be a non-empty string');
  return registry.getAxis(obj.axis);
}

function parseSpan(registry: PluginRegistry, raw: unknown): Span {
  if (!isPlainObject(raw)) throw invalidParam('time must be an object {axis, from?, to?}');
  if ('at' in raw || 'during' in raw) throw invalidParam('time on add must not contain at/during; use from/to');
  const axis = readAxis(registry, raw);
  const lo = raw.from === undefined ? null : encodeValue(axis, raw.from);
  const hi = raw.to === undefined ? null : encodeValue(axis, raw.to);
  if (lo !== null && hi !== null && lo >= hi) {
    throw new RemoraError('invalid_time', 'time.from must be less than time.to', { axis: axis.name });
  }
  return { axis, lo, hi };
}

export function parseSpans(registry: PluginRegistry, raw: unknown): Span[] {
  if (raw === undefined) return [];
  let items: unknown[];
  if (Array.isArray(raw)) {
    if (raw.length === 0) throw invalidParam('time must not be an empty array');
    items = raw;
  } else {
    items = [raw];
  }
  const spans = items.map((x) => parseSpan(registry, x));
  const seen = new Set<number>();
  for (const s of spans) {
    if (seen.has(s.axis.id)) throw invalidParam(`duplicate axis ${s.axis.name} in time`, { axis: s.axis.name });
    seen.add(s.axis.id);
  }
  return spans;
}

export function parseMoment(registry: PluginRegistry, raw: unknown): Moment {
  if (!isPlainObject(raw)) throw invalidParam('time must be an object {axis, at}');
  if ('from' in raw || 'to' in raw || 'during' in raw) throw invalidParam('time must contain only axis and at');
  const axis = readAxis(registry, raw);
  if (raw.at === undefined) throw invalidParam('time.at is required');
  return { axis, at: encodeValue(axis, raw.at) };
}

export function parseWhen(registry: PluginRegistry, raw: unknown): When | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) throw invalidParam('when must be an object {axis, at} or {axis, during}');
  if ('from' in raw || 'to' in raw) throw invalidParam('when must not contain from/to');
  const hasAt = raw.at !== undefined;
  const hasDuring = raw.during !== undefined;
  if (hasAt === hasDuring) throw invalidParam('when needs exactly one of at, during');
  const axis = readAxis(registry, raw);
  if (hasAt) return { axis, at: encodeValue(axis, raw.at) };
  if (!Array.isArray(raw.during) || raw.during.length !== 2) {
    throw invalidParam('when.during must be an array [from, to]');
  }
  const from = encodeValue(axis, raw.during[0]);
  const to = encodeValue(axis, raw.during[1]);
  if (from >= to) throw new RemoraError('invalid_time', 'when.during must satisfy from < to', { axis: axis.name });
  return { axis, from, to };
}

export function formatTime(
  registry: PluginRegistry,
  axisId: number | null,
  lo: string | null,
  hi: string | null,
): TimeOut | null {
  if (axisId === null) return null;
  const axis = registry.getAxisById(axisId);
  const out: TimeOut = { axis: axis.name };
  if (lo !== null) out.from = axis.def.decode(BigInt(lo));
  if (hi !== null) out.to = axis.def.decode(BigInt(hi));
  return out;
}

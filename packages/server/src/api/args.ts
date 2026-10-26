import { RemoraError } from '@remora/sdk';

export type Obj = Record<string, unknown>;

export function isObj(x: unknown): x is Obj {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function bad(key: string, expected: string): RemoraError {
  return new RemoraError('invalid_param', `${key} must be ${expected}`, { field: key });
}

export function optStr(o: Obj, key: string): string | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw bad(key, 'a string');
  return v;
}

export function str(o: Obj, key: string): string {
  const v = optStr(o, key);
  if (v === undefined) throw bad(key, 'a string (required)');
  return v;
}

export function optBool(o: Obj, key: string): boolean | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw bad(key, 'a boolean');
  return v;
}

export function bool(o: Obj, key: string): boolean {
  const v = optBool(o, key);
  if (v === undefined) throw bad(key, 'a boolean (required)');
  return v;
}

export function optInt(o: Obj, key: string): number | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw bad(key, 'an integer');
  return v;
}

export function int(o: Obj, key: string): number {
  const v = optInt(o, key);
  if (v === undefined) throw bad(key, 'an integer (required)');
  return v;
}

export function obj(o: Obj, key: string): Obj {
  const v = o[key];
  if (!isObj(v)) throw bad(key, 'an object (required)');
  return v;
}

export function optStrArr(o: Obj, key: string): string[] | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw bad(key, 'an array of strings');
  return v as string[];
}

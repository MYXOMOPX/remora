// Self-contained on purpose (node builtins only): it also runs under plain node in tests.
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

export function isPathSpec(spec: string): boolean {
  return (
    spec.startsWith('.') || spec.startsWith('/') || spec.includes('\\') || /^[A-Za-z]:/.test(spec) || isAbsolute(spec)
  );
}

function pick(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fromConditions(v: unknown): string | undefined {
  return pick(v) ?? (isObject(v) ? (pick(v.import) ?? pick(v.default)) : undefined);
}

function exportsEntry(exp: unknown): string | undefined {
  if (!isObject(exp)) return pick(exp);
  const keys = Object.keys(exp);
  if (keys.some((k) => k.startsWith('.'))) return fromConditions(exp['.']);
  return fromConditions(exp); // top-level conditions without a "." key
}

/** Entry file of a package directory (R37): exports, then main, then index.js. */
export async function directoryEntry(dir: string): Promise<string> {
  let text: string | undefined;
  try {
    text = await readFile(join(dir, 'package.json'), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  let entry: string | undefined;
  if (text !== undefined) {
    let pkg: unknown;
    try {
      pkg = JSON.parse(text);
    } catch {
      throw new Error(`package.json in ${dir} is invalid`);
    }
    if (isObject(pkg)) entry = exportsEntry(pkg.exports) ?? pick(pkg.main);
  }
  return resolve(dir, entry ?? 'index.js');
}

/** Directory of a package name inside `<pluginsDir>/node_modules` (no parent-based resolution). */
export function packageDir(pluginsDir: string, spec: string): string {
  const parts = spec.split('/');
  const scoped = spec.startsWith('@');
  if (
    spec.includes('\\') ||
    parts.length !== (scoped ? 2 : 1) ||
    parts.some((p) => p === '' || p === '.' || p === '..') ||
    (scoped && parts[0] === '@')
  ) {
    throw new Error(`invalid package name ${spec}`);
  }
  return join(pluginsDir, 'node_modules', ...parts);
}

/** Absolute entry file for a package name or path spec under pluginsDir. */
export async function locateEntry(pluginsDir: string, spec: string, isDir: (p: string) => Promise<boolean>): Promise<string> {
  if (isPathSpec(spec)) {
    const target = resolve(pluginsDir, spec);
    return (await isDir(target)) ? directoryEntry(target) : target;
  }
  return directoryEntry(packageDir(pluginsDir, spec));
}

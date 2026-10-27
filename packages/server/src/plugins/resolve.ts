import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import corePlugin from '@remora/core-plugin';
import type { Importer } from './registry.js';

const CORE_PACKAGE = '@remora/core-plugin';

function isPathSpec(spec: string): boolean {
  return spec.startsWith('.') || spec.startsWith('/') || isAbsolute(spec) || /^[A-Za-z]:/.test(spec);
}

function pick(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Entry file of a package directory (R37): exports, then main, then index.js. */
async function directoryEntry(dir: string): Promise<string> {
  let pkg: unknown;
  try {
    pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
  } catch {
    pkg = undefined;
  }
  let entry: string | undefined;
  if (isObject(pkg)) {
    const exp = pkg.exports;
    const dot = isObject(exp) ? exp['.'] : undefined;
    entry =
      pick(exp) ??
      pick(dot) ??
      (isObject(dot) ? (pick(dot.import) ?? pick(dot.default)) : undefined) ??
      pick(pkg.main);
  }
  return resolve(dir, entry ?? 'index.js');
}

async function importDefault(file: string): Promise<unknown> {
  await stat(file);
  const mod = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as { default: unknown };
  return mod.default;
}

/**
 * Importer for plugin specs (R37): the bundled core plugin, a path under pluginsDir
 * (file or package directory), or a package name resolved from pluginsDir/package.json.
 */
export function pluginImporter(pluginsDir: string): Importer {
  return async (spec) => {
    if (spec === CORE_PACKAGE) return corePlugin;
    if (isPathSpec(spec)) {
      const target = resolve(pluginsDir, spec);
      const info = await stat(target);
      return importDefault(info.isDirectory() ? await directoryEntry(target) : target);
    }
    const url = import.meta.resolve(spec, pathToFileURL(join(pluginsDir, 'package.json')).href);
    // the module cache and resolver caches can outlive the files; require them on disk
    return importDefault(fileURLToPath(url));
  };
}

import { stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import corePlugin from '@remora/core-plugin';
import { locateEntry } from './locate.js';
import type { Importer } from './registry.js';

const CORE_PACKAGE = '@remora/core-plugin';

/**
 * Importer for plugin specs (R37): the bundled core plugin, a path under pluginsDir
 * (file or package directory), or a package name looked up in pluginsDir/node_modules.
 */
export function pluginImporter(pluginsDir: string): Importer {
  return async (spec) => {
    if (spec === CORE_PACKAGE) return corePlugin;
    const file = await locateEntry(pluginsDir, spec, async (p) => (await stat(p)).isDirectory());
    // stat first for a clear ENOENT; a module already imported in this process stays cached until restart
    await stat(file);
    return ((await import(/* @vite-ignore */ pathToFileURL(file).href)) as { default: unknown }).default;
  };
}

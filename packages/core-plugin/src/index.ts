import { definePlugin, RemoraError } from '@remora/sdk';
import { buildAxis } from './axes.js';
import { buildSource } from './sources.js';
import { configSchema, defaultConfig, type CoreConfig } from './config.js';

export type { AxisConfig } from './axes.js';
export { buildAxis } from './axes.js';
export type { CoreConfig } from './config.js';
export { buildSource } from './sources.js';
export type { SourceConfig } from './sources.js';

function rejectDuplicates(what: string, names: string[]): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) {
      throw new RemoraError('invalid_config', `Duplicate ${what} name "${name}"`, { name, reason: `duplicate ${what}` });
    }
    seen.add(name);
  }
}

export default definePlugin<CoreConfig>({
  name: 'remora-core',
  configSchema,
  defaultConfig,
  setup: (config) => {
    const timeAxes = config.timeAxes.map(buildAxis);
    const evidenceSources = (config.evidenceSources ?? []).map(buildSource);
    rejectDuplicates('time axis', timeAxes.map((a) => a.name));
    rejectDuplicates('evidence source', evidenceSources.map((s) => s.name));
    return { timeAxes, evidenceSources };
  },
});

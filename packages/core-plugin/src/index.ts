import { definePlugin } from '@remora/sdk';
import { buildAxis } from './axes.js';
import { buildSource } from './sources.js';
import { configSchema, defaultConfig, type CoreConfig } from './config.js';

export type { AxisConfig } from './axes.js';
export { buildAxis } from './axes.js';
export type { CoreConfig } from './config.js';
export { buildSource } from './sources.js';
export type { SourceConfig } from './sources.js';

export default definePlugin<CoreConfig>({
  name: 'remora-core',
  configSchema,
  defaultConfig,
  setup: (config) => ({
    timeAxes: config.timeAxes.map(buildAxis),
    evidenceSources: (config.evidenceSources ?? []).map(buildSource),
  }),
});

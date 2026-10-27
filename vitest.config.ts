import { defineConfig } from 'vitest/config';

// R44: workspace packages resolve to src through the "remora-source" export condition (a bare "source" would also match third-party packages such as eventsource-parser), with or without dist
export default defineConfig({
  resolve: { conditions: ['remora-source'] },
  ssr: { resolve: { conditions: ['remora-source'] } },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['packages/sdk/test/**/*.test.ts', 'packages/core-plugin/test/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'server',
          include: ['packages/server/test/**/*.test.ts'],
          globalSetup: ['packages/server/test/globalSetup.ts'],
        },
      },
    ],
  },
});

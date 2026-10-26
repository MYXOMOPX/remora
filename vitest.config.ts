import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/sdk/test/**/*.test.ts', 'packages/core-plugin/test/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'server',
          include: ['packages/server/test/**/*.test.ts'],
        },
      },
    ],
  },
});

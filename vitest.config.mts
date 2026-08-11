import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.spec.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.spec.ts'],
          environment: 'node',
          globalSetup: ['test/integration/global-setup.ts'],
          // Pulling and starting a Postgres image is slow on a cold cache.
          testTimeout: 60_000,
          hookTimeout: 120_000,
          // Deadlock and serialization tests coordinate two sessions against
          // shared rows. Running files in parallel against one database would
          // make them interfere; the barriers only order sessions within a file.
          fileParallelism: false,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/core/**'],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 90,
        statements: 90,
      },
    },
  },
});

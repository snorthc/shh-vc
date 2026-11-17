import { defineConfig } from 'vitest/config';

// Browser-level tests. Separate from the unit config because they need a
// production build on disk and take an order of magnitude longer.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/e2e/**/*.spec.ts'],
    testTimeout: 90_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});

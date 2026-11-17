import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node', include: ['tests/audio/**/*.ts'], testTimeout: 180_000, hookTimeout: 120_000 },
});

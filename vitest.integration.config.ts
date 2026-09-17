import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.integration-spec.ts'],
    fileParallelism: false,
    setupFiles: ['test/setup.ts'],
    hookTimeout: 60_000,
  },
});

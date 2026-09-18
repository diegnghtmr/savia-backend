import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'test/**/*.spec.ts',
      'test/**/*.e2e-spec.ts',
      'test/platform/tesseract-real-engine.integration-spec.ts',
    ],
    setupFiles: ['test/setup.ts'],
  },
});

import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@actalk/inkos-core/interactive-film/graph-schema': resolve(__dirname, '../core/src/interactive-film/graph-schema.ts'),
      '@actalk/inkos-core': resolve(__dirname, '../core/src/index.ts'),
    },
  },
  test: { include: ['src/**/*.test.ts'], fileParallelism: false, testTimeout: 30_000, hookTimeout: 30_000 },
});

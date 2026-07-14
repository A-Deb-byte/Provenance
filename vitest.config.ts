import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['src/test/setup.ts'],
    css: true,
    // Several Windows integration tests exercise DPAPI subprocesses and
    // hash-chained filesystem commits. Keep their timeout above scheduler
    // jitter while preserving a finite failure bound.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});

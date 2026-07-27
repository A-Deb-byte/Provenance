import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['src/test/setup.ts'],
    css: true,
    // Process-tree, DPAPI, and filesystem integration suites own real Windows
    // resources. Serial execution prevents one suite from delaying another's
    // fail-closed cleanup beyond its fixed timeout.
    maxWorkers: 1,
    // Keep individual operations bounded while allowing authenticated
    // filesystem commits and Windows cleanup to complete on shared runners.
    // The CI shard timeout remains the outer fail-closed bound.
    testTimeout: 90_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});

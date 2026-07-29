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
    // The serial 99-file jsdom/native matrix retains one worker for several
    // minutes. Raising its ceiling avoids a late worker recycle that can leave
    // the next file unassigned; this is a limit, not an up-front reservation.
    execArgv: ['--max-old-space-size=8192'],
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

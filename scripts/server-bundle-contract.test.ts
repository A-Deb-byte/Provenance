import { describe, expect, it } from 'vitest';
import {
  assertServerBundleHasBuiltinOnlyExternals,
  findServerBundleOutput,
} from './server-bundle-contract.mjs';

const metafile = (imports: Array<Record<string, unknown>>) => ({
  outputs: {
    'dist/server.cjs': { imports },
  },
});

describe('packaged server bundle contract', () => {
  it('accepts Node builtins as the only external imports', () => {
    const result = assertServerBundleHasBuiltinOnlyExternals(metafile([
      { path: 'fs', kind: 'require-call', external: true },
      { path: 'node:fs/promises', kind: 'dynamic-import', external: true },
      { path: 'bundled-module', kind: 'require-call' },
    ]));

    expect(result.nonBuiltinExternalImports).toEqual([]);
    expect(result.externalImports).toEqual([
      { path: 'fs', kind: 'require-call' },
      { path: 'node:fs/promises', kind: 'dynamic-import' },
    ]);
  });

  it.each([
    ['supports-color', 'require-call'],
    ['vite', 'dynamic-import'],
    ['C:/unsigned/node_modules/injected/index.js', 'require-call'],
  ])('rejects non-builtin external %s imports', (requestedPath, kind) => {
    expect(() => assertServerBundleHasBuiltinOnlyExternals(metafile([
      { path: requestedPath, kind, external: true },
    ]))).toThrow(/non-builtin external imports/iu);
  });

  it('requires exactly one server output with an import inventory', () => {
    expect(() => findServerBundleOutput({ outputs: {} })).toThrow(/exactly one server\.cjs/iu);
    expect(() => findServerBundleOutput({
      outputs: {
        'dist/server.cjs': { imports: [] },
        'other/dist/server.cjs': { imports: [] },
      },
    })).toThrow(/exactly one server\.cjs/iu);
  });
});

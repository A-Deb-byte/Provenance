import { describe, expect, it } from 'vitest';
import {
  compareAsciiOrdinal,
  createRuntimeResourceManifest,
  RUNTIME_RESOURCE_MANIFEST_KIND,
} from './runtime-resource-manifest.mjs';

describe('runtime resource manifest', () => {
  it('is deterministic, sorted, and binds exact resource bytes', () => {
    const first = createRuntimeResourceManifest([
      { destination: 'node/node.exe', sha256: 'b'.repeat(64), size: 20 },
      { destination: 'dist/server.cjs', sha256: 'a'.repeat(64), size: 10 },
    ]);
    const second = createRuntimeResourceManifest([
      { destination: 'dist/server.cjs', sha256: 'a'.repeat(64), size: 10 },
      { destination: 'node/node.exe', sha256: 'b'.repeat(64), size: 20 },
    ]);
    expect(first).toEqual(second);
    expect(first.manifest).toEqual({
      schemaVersion: 1,
      kind: RUNTIME_RESOURCE_MANIFEST_KIND,
      resources: [
        { path: 'dist/server.cjs', sha256: 'a'.repeat(64), size: 10 },
        { path: 'node/node.exe', sha256: 'b'.repeat(64), size: 20 },
      ],
    });
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('uses the same mixed-case ASCII ordinal order as Rust str ordering', () => {
    const created = createRuntimeResourceManifest([
      { path: 'dist/assets/app.js', sha256: 'a'.repeat(64), size: 1 },
      { path: 'dist/THIRD_PARTY_NOTICES.txt', sha256: 'b'.repeat(64), size: 1 },
      { path: 'LICENSE', sha256: 'c'.repeat(64), size: 1 },
      { path: 'dist/RUST_THIRD_PARTY_NOTICES.txt', sha256: 'd'.repeat(64), size: 1 },
    ]);

    expect(created.manifest.resources.map((resource) => resource.path)).toEqual([
      'LICENSE',
      'dist/RUST_THIRD_PARTY_NOTICES.txt',
      'dist/THIRD_PARTY_NOTICES.txt',
      'dist/assets/app.js',
    ]);
    expect(compareAsciiOrdinal('dist/RUST', 'dist/assets')).toBeLessThan(0);
  });

  it('rejects duplicate, escaping, and incomplete entries', () => {
    expect(() => createRuntimeResourceManifest([
      { path: '../server.cjs', sha256: 'a'.repeat(64), size: 1 },
    ])).toThrow(/canonical relative/iu);
    expect(() => createRuntimeResourceManifest([
      { path: 'dist/server.cjs', sha256: 'a'.repeat(64), size: 1 },
      { destination: 'dist/server.cjs', sha256: 'b'.repeat(64), size: 2 },
    ])).toThrow(/unique/iu);
    expect(() => createRuntimeResourceManifest([
      { path: 'dist/server.cjs', sha256: 'not-a-digest', size: 1 },
    ])).toThrow(/size or hash/iu);
  });
});

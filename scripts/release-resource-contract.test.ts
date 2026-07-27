import { describe, expect, it } from 'vitest';
import { assertRuntimeResourceManifestDigest } from './release-resource-contract.mjs';

describe('release runtime-resource contract', () => {
  it('accepts only the exact digest compiled into the native host', () => {
    const digest = 'a'.repeat(64);
    expect(assertRuntimeResourceManifestDigest({
      compiledSha256: digest,
      currentSha256: digest,
      phase: 'after the native build',
    })).toBe(digest);

    expect(() => assertRuntimeResourceManifestDigest({
      compiledSha256: digest,
      currentSha256: 'b'.repeat(64),
      phase: 'after the native build',
    })).toThrow(/changed after the native build/iu);
  });

  it('rejects malformed digest metadata', () => {
    expect(() => assertRuntimeResourceManifestDigest({
      compiledSha256: 'not-a-digest',
      currentSha256: 'a'.repeat(64),
      phase: 'during staging',
    })).toThrow(/lowercase SHA-256/iu);
  });
});

import { describe, expect, it } from 'vitest';
import { hashArtifactContent } from '../kernel/artifacts/artifactStore';
import { createMemoryDesktopPayloadStore } from './payloadStore';

describe('desktop payload store', () => {
  it('returns artifact-shaped metadata and destructively resolves content once', async () => {
    const store = createMemoryDesktopPayloadStore();
    const metadata = await store.stage('operator-only text');

    expect(metadata).toMatchObject({
      id: expect.stringMatching(/^artifact_/u),
      contentHash: hashArtifactContent('operator-only text'),
      byteLength: Buffer.byteLength('operator-only text'),
    });
    expect(metadata).not.toHaveProperty('content');
    await expect(store.consume(metadata.id)).resolves.toEqual({
      content: 'operator-only text',
      contentHash: metadata.contentHash,
    });
    await expect(store.consume(metadata.id)).resolves.toBeUndefined();
    expect(store.size()).toBe(0);
  });

  it('bounds entries, total bytes, individual payloads, and lifetime', async () => {
    let timestamp = 1_000;
    const store = createMemoryDesktopPayloadStore({
      maxEntries: 2,
      maxPayloadChars: 4,
      maxPayloadBytes: 4,
      maxTotalBytes: 8,
      ttlMs: 50,
      now: () => timestamp,
    });

    await store.stage('1234');
    await store.stage('5678');
    await expect(store.stage('x')).rejects.toThrow(/at capacity/i);
    await expect(store.stage('12345')).rejects.toThrow(/1-4 characters/i);
    await expect(store.stage('\u20ac\u20ac')).rejects.toThrow(/UTF-8 bytes/i);

    timestamp += 51;
    expect(store.size()).toBe(0);
    const replacement = await store.stage('next');
    timestamp += 51;
    await expect(store.consume(replacement.id)).resolves.toBeUndefined();
  });

  it('does not evict an unconsumed payload to make room for another value', async () => {
    const store = createMemoryDesktopPayloadStore({
      maxEntries: 1,
      maxPayloadChars: 8,
      maxPayloadBytes: 8,
      maxTotalBytes: 8,
    });
    const first = await store.stage('first');
    await expect(store.stage('second')).rejects.toThrow(/at capacity/i);
    await expect(store.consume(first.id)).resolves.toMatchObject({ content: 'first' });
  });
});

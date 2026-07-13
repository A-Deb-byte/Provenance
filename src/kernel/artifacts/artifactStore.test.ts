import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileArtifactStore, hashArtifactContent } from './artifactStore';

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'artifacts-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('file artifact store', () => {
  it('creates, hashes, resolves, and lists artifacts', async () => {
    const store = createFileArtifactStore(dir);
    const meta = await store.create('hunter2-search-query');

    expect(meta.id).toMatch(/^artifact_/);
    expect(meta.contentHash).toBe(hashArtifactContent('hunter2-search-query'));
    expect(JSON.stringify(meta)).not.toContain('hunter2-search-query'); // metadata omits content

    const resolved = await store.resolve(meta.id);
    expect(resolved?.content).toBe('hunter2-search-query');
    expect(resolved?.contentHash).toBe(meta.contentHash);

    const list = await store.list();
    expect(list.map((a) => a.id)).toContain(meta.id);
    expect(JSON.stringify(list)).not.toContain('hunter2-search-query');
  });

  it('returns undefined for unknown or malformed ids and empty content', async () => {
    const store = createFileArtifactStore(dir);
    expect(await store.resolve('artifact_missing')).toBeUndefined();
    expect(await store.resolve('../escape')).toBeUndefined();
    await expect(store.create('')).rejects.toThrow(/1-/);
  });

  it('rejects a tampered artifact whose content no longer matches its hash', async () => {
    const store = createFileArtifactStore(dir);
    const meta = await store.create('original');
    const [file] = (await readdir(dir)).filter((f) => f.endsWith('.artifact.json'));
    await writeFile(path.join(dir, file), JSON.stringify({
      id: meta.id, content: 'tampered', contentHash: meta.contentHash, byteLength: 8, createdAt: meta.createdAt,
    }), 'utf8');

    expect(await store.resolve(meta.id)).toBeUndefined();
  });
});

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDesktopReadyPublisher } from './desktopReadiness';

const roots: string[] = [];
const tempDir = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'provenance-desktop-ready-'));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('desktop host readiness publisher', () => {
  it('is a no-op outside a native host launch', () => {
    expect(createDesktopReadyPublisher('C:\\runtime', {}).enabled).toBe(false);
  });

  it('publishes a nonce-bound random-port record atomically in the runtime directory', async () => {
    const runtimeDir = await tempDir();
    const readyPath = path.join(runtimeDir, '.desktop-ready-launch-1234.json');
    const publisher = createDesktopReadyPublisher(runtimeDir, {
      DESKTOP_HOST_NONCE: 'h'.repeat(48),
      DESKTOP_HOST_READY_FILE: readyPath,
      DESKTOP_RUNTIME_OWNER_NONCE: 'o'.repeat(48),
    }, 707);
    await publisher.publish(43123);
    expect(JSON.parse(await readFile(readyPath, 'utf8'))).toEqual({
      schemaVersion: 1, nonce: 'h'.repeat(48), pid: 707, port: 43123,
    });
    await publisher.cleanup();
    await expect(readFile(readyPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects partial configuration, path escape, reuse, and occupied output', async () => {
    const runtimeDir = await tempDir();
    expect(() => createDesktopReadyPublisher(runtimeDir, {
      DESKTOP_HOST_NONCE: 'h'.repeat(48),
    })).toThrow(/requires/);
    expect(() => createDesktopReadyPublisher(runtimeDir, {
      DESKTOP_HOST_NONCE: 'h'.repeat(48),
      DESKTOP_HOST_READY_FILE: path.join(runtimeDir, '..', '.desktop-ready-launch-1234.json'),
      DESKTOP_RUNTIME_OWNER_NONCE: 'o'.repeat(48),
    })).toThrow(/controlled runtime/);

    const readyPath = path.join(runtimeDir, '.desktop-ready-launch-5678.json');
    const publisher = createDesktopReadyPublisher(runtimeDir, {
      DESKTOP_HOST_NONCE: 'h'.repeat(48),
      DESKTOP_HOST_READY_FILE: readyPath,
      DESKTOP_RUNTIME_OWNER_NONCE: 'o'.repeat(48),
    }, 808);
    await writeFile(readyPath, 'occupied');
    await expect(publisher.publish(43123)).rejects.toMatchObject({ code: 'EEXIST' });
  });
});

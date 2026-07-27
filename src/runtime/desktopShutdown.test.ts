import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDesktopShutdownControl } from './desktopShutdown';

const roots: string[] = [];
const secret = 'a'.repeat(43);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('desktop shutdown control', () => {
  it('authenticates one launch token and publishes a nonce-bound receipt', async () => {
    const runtime = await mkdtemp(path.join(os.tmpdir(), 'desktop-shutdown-'));
    roots.push(runtime);
    await mkdir(runtime, { recursive: true });
    const receipt = path.join(runtime, '.desktop-shutdown-launch-1234.json');
    const control = createDesktopShutdownControl(runtime, {
      DESKTOP_HOST_SHUTDOWN_TOKEN: secret,
      DESKTOP_HOST_SHUTDOWN_NONCE: 'b'.repeat(43),
      DESKTOP_HOST_SHUTDOWN_FILE: receipt,
    }, 42);
    expect(control.enabled).toBe(true);
    expect(control.authenticate(secret)).toBe(true);
    expect(control.authenticate('c'.repeat(43))).toBe(false);
    await control.publish();
    expect(JSON.parse(await readFile(receipt, 'utf8'))).toEqual({
      schemaVersion: 1,
      nonce: 'b'.repeat(43),
      pid: 42,
    });
    await expect(control.publish()).rejects.toThrow(/already/);
  });

  it('rejects partial metadata and receipt paths outside the runtime', async () => {
    const runtime = await mkdtemp(path.join(os.tmpdir(), 'desktop-shutdown-'));
    roots.push(runtime);
    expect(() => createDesktopShutdownControl(runtime, {
      DESKTOP_HOST_SHUTDOWN_TOKEN: secret,
    })).toThrow(/requires exact/);
    expect(() => createDesktopShutdownControl(runtime, {
      DESKTOP_HOST_SHUTDOWN_TOKEN: secret,
      DESKTOP_HOST_SHUTDOWN_NONCE: 'b'.repeat(43),
      DESKTOP_HOST_SHUTDOWN_FILE: path.join(os.tmpdir(), '.desktop-shutdown-launch.json'),
    })).toThrow(/controlled runtime/);
  });
});

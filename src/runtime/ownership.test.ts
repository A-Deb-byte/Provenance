import crypto from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireRuntimeOwnership } from './ownership';

const roots: string[] = [];
const tempDir = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'provenance-runtime-owner-'));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('runtime ownership', () => {
  it('allows one standalone owner and releases only its matching record', async () => {
    const runtimeDir = await tempDir();
    const first = await acquireRuntimeOwnership(runtimeDir, {
      pid: 101, randomNonce: () => 'a'.repeat(48), isProcessAlive: (pid) => pid === 101,
      now: () => '2026-07-15T00:00:00.000Z',
    });
    await expect(acquireRuntimeOwnership(runtimeDir, {
      pid: 202, randomNonce: () => 'b'.repeat(48), isProcessAlive: (pid) => pid === 101,
    })).rejects.toThrow(/already owned/);

    expect(JSON.parse(await readFile(first.ownerPath, 'utf8'))).toMatchObject({
      mode: 'node-standalone', pid: 101, nonce: 'a'.repeat(48),
    });
    await first.release();
    const second = await acquireRuntimeOwnership(runtimeDir, {
      pid: 202, randomNonce: () => 'b'.repeat(48), isProcessAlive: () => true,
    });
    await second.release();
  });

  it('reclaims a complete owner record only when its process is dead', async () => {
    const runtimeDir = await tempDir();
    const ownerPath = path.join(runtimeDir, 'runtime-owner.json');
    await writeFile(ownerPath, JSON.stringify({
      schemaVersion: 1, mode: 'node-standalone', nonce: 's'.repeat(48), pid: 303,
      createdAt: '2026-07-15T00:00:00.000Z',
    }));
    const lease = await acquireRuntimeOwnership(runtimeDir, {
      pid: 404, randomNonce: () => 'n'.repeat(48), isProcessAlive: () => false,
    });
    expect(JSON.parse(await readFile(ownerPath, 'utf8')).pid).toBe(404);
    await lease.release();
  });

  it('accepts only the live desktop host secret whose hash is recorded and never removes its record', async () => {
    const runtimeDir = await tempDir();
    const ownerPath = path.join(runtimeDir, 'runtime-owner.json');
    const proof = 'd'.repeat(48);
    await writeFile(ownerPath, JSON.stringify({
      schemaVersion: 1, mode: 'desktop-host',
      proofHash: crypto.createHash('sha256').update(proof).digest('hex'), hostPid: 505,
      createdAt: '2026-07-15T00:00:00.000Z',
    }));
    await expect(acquireRuntimeOwnership(runtimeDir, {
      desktopOwnerNonce: 'wrong'.repeat(10), isProcessAlive: () => true,
    })).rejects.toThrow(/does not match/);

    const lease = await acquireRuntimeOwnership(runtimeDir, {
      desktopOwnerNonce: proof, desktopHostPid: 505, isProcessAlive: (pid) => pid === 505,
    });
    await lease.release();
    expect(JSON.parse(await readFile(ownerPath, 'utf8')).mode).toBe('desktop-host');
  });

  it('rejects a public proof hash used as though it were the private desktop proof', async () => {
    const runtimeDir = await tempDir();
    const ownerPath = path.join(runtimeDir, 'runtime-owner.json');
    const proof = 'private-proof-'.repeat(4);
    const proofHash = crypto.createHash('sha256').update(proof).digest('hex');
    await writeFile(ownerPath, JSON.stringify({
      schemaVersion: 1, mode: 'desktop-host', proofHash, hostPid: 606,
      createdAt: '2026-07-15T00:00:00.000Z',
    }));

    await expect(acquireRuntimeOwnership(runtimeDir, {
      desktopOwnerNonce: proofHash, desktopHostPid: 606, isProcessAlive: () => true,
    })).rejects.toThrow(/does not match/);
  });
});

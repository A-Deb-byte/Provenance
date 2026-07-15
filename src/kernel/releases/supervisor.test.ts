import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeReleaseSupervisor } from './supervisor';
import type { ActiveReleaseManifest, ReleaseProcessCandidate, ReleaseProcessSupervisor } from './types';

const roots: string[] = [];
const supervisors: ReleaseProcessSupervisor[] = [];

afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.shutdown()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const readySource = `
if (process.env.RELEASE_TEST_PARENT_SECRET) process.exit(9);
process.send?.({
  type: 'release.ready',
  nonce: process.env.RELEASE_SUPERVISOR_NONCE,
  targetVersion: process.env.RELEASE_TARGET_VERSION,
  contentHash: process.env.RELEASE_CONTENT_HASH,
});
setInterval(() => undefined, 1000);
`;

const wrongNonceSource = `
process.send?.({
  type: 'release.ready',
  nonce: 'wrong-nonce',
  targetVersion: process.env.RELEASE_TARGET_VERSION,
  contentHash: process.env.RELEASE_CONTENT_HASH,
});
setTimeout(() => process.exit(8), 20);
`;

const unstableSource = `
const readiness = {
  type: 'release.ready',
  nonce: process.env.RELEASE_SUPERVISOR_NONCE,
  targetVersion: process.env.RELEASE_TARGET_VERSION,
  contentHash: process.env.RELEASE_CONTENT_HASH,
};
if (process.send) process.send(readiness, () => process.exit(7));
else process.exit(7);
`;

const candidate = async (
  releaseId: string,
  source = readySource,
): Promise<ReleaseProcessCandidate> => {
  const releaseDir = await mkdtemp(path.join(os.tmpdir(), `release-child-${releaseId}-`));
  roots.push(releaseDir);
  await mkdir(path.join(releaseDir, 'core'), { recursive: true });
  await writeFile(path.join(releaseDir, 'core', 'index.cjs'), source, 'utf8');
  const manifest: ActiveReleaseManifest = {
    schemaVersion: 1,
    releaseId,
    artifactId: `artifact_${releaseId}`,
    targetVersion: releaseId === 'release_1' ? '1.0.0' : '2.0.0',
    contentHash: (releaseId === 'release_1' ? 'a' : 'b').repeat(64),
    releaseDirectory: path.basename(releaseDir),
    entrypoint: 'core/index.cjs',
    activatedAt: '2026-07-13T00:00:00.000Z',
  };
  return { manifest, releaseDir };
};

const processIsRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('Node release process supervisor', () => {
  it('keeps the previous child alive through candidate readiness and stops it only after commit', async () => {
    const supervisor = createNodeReleaseSupervisor({
      readyTimeoutMs: 2_000,
      stabilityWindowMs: 50,
      stopTimeoutMs: 500,
    });
    supervisors.push(supervisor);

    const first = await supervisor.prepare(await candidate('release_1'));
    await supervisor.commit(first);
    const firstPid = supervisor.getStatus().activePid!;
    expect(processIsRunning(firstPid)).toBe(true);

    const second = await supervisor.prepare(await candidate('release_2'));
    expect(supervisor.getStatus()).toMatchObject({
      activeReleaseId: 'release_1',
      activePid: firstPid,
      pendingReleaseIds: ['release_2'],
    });
    expect(processIsRunning(firstPid)).toBe(true);

    await supervisor.commit(second);
    expect(supervisor.getStatus().activeReleaseId).toBe('release_2');
    expect(processIsRunning(firstPid)).toBe(false);
  });

  it('rejects a forged readiness nonce, terminates the candidate, and leaves the active child running', async () => {
    const supervisor = createNodeReleaseSupervisor({
      readyTimeoutMs: 2_000,
      stabilityWindowMs: 50,
      stopTimeoutMs: 250,
    });
    supervisors.push(supervisor);
    const first = await supervisor.prepare(await candidate('release_1'));
    await supervisor.commit(first);
    const firstPid = supervisor.getStatus().activePid!;

    await expect(supervisor.prepare(await candidate('release_2', wrongNonceSource)))
      .rejects.toThrow(/exited before readiness/i);
    expect(supervisor.getStatus()).toMatchObject({ activeReleaseId: 'release_1', pendingReleaseIds: [] });
    expect(processIsRunning(firstPid)).toBe(true);
  });

  it('fails a child that exits during the stability window and does not inherit arbitrary parent secrets', async () => {
    const prior = process.env.RELEASE_TEST_PARENT_SECRET;
    process.env.RELEASE_TEST_PARENT_SECRET = 'must-not-cross';
    try {
      const supervisor = createNodeReleaseSupervisor({
        readyTimeoutMs: 1_000,
        stabilityWindowMs: 100,
        stopTimeoutMs: 250,
      });
      supervisors.push(supervisor);
      const prepared = await supervisor.prepare(await candidate('release_1'));
      await supervisor.abort(prepared);
      await expect(supervisor.prepare(await candidate('release_2', unstableSource)))
        .rejects.toThrow(/stability window/i);
      expect(supervisor.getStatus()).toEqual({ pendingReleaseIds: [] });
    } finally {
      if (prior === undefined) delete process.env.RELEASE_TEST_PARENT_SECRET;
      else process.env.RELEASE_TEST_PARENT_SECRET = prior;
    }
  });

  it('accepts only an installed CommonJS entrypoint and never a package-supplied command', async () => {
    const supervisor = createNodeReleaseSupervisor({ readyTimeoutMs: 100, stabilityWindowMs: 20 });
    supervisors.push(supervisor);
    const invalid = await candidate('release_1');
    invalid.manifest.entrypoint = 'core/index.js';
    await expect(supervisor.prepare(invalid)).rejects.toThrow(/CommonJS Node module/i);
    expect(supervisor.getStatus()).toEqual({ pendingReleaseIds: [] });
  });
});

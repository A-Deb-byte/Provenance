import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeReleaseSupervisor, type NodeReleaseSupervisorOptions } from './supervisor';
import type { ActiveReleaseManifest, ReleaseProcessCandidate, ReleaseProcessSupervisor } from './types';

const roots: string[] = [];
const supervisors: ReleaseProcessSupervisor[] = [];

const readinessPublisherSource = `
const publishReadiness = (record) => {
  const readyPath = process.env.RELEASE_SUPERVISOR_READY_FILE;
  if (!readyPath) {
    process.send?.(record);
    return;
  }
  const fs = require('node:fs');
  const temporaryPath = readyPath + '.' + process.env.RELEASE_SUPERVISOR_NONCE + '.tmp';
  fs.writeFileSync(temporaryPath, JSON.stringify({ schemaVersion: 1, ...record, pid: process.pid }), { flag: 'wx' });
  fs.renameSync(temporaryPath, readyPath);
};
`;

afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.shutdown()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const readySource = `
${readinessPublisherSource}
if (process.env.RELEASE_TEST_PARENT_SECRET) process.exit(9);
publishReadiness({
  type: 'release.ready',
  nonce: process.env.RELEASE_SUPERVISOR_NONCE,
  targetVersion: process.env.RELEASE_TARGET_VERSION,
  contentHash: process.env.RELEASE_CONTENT_HASH,
});
setInterval(() => undefined, 1000);
`;

const nativePolicySource = `
${readinessPublisherSource}
if (process.env.DESKTOP_PACKAGED_RELEASE !== '1') process.exit(10);
if (!/^registry\\.example\\.test\\/node@sha256:[a-f0-9]{64}$/.test(process.env.PROVENANCE_SANDBOX_IMAGE || '')) process.exit(11);
if (process.env.DESKTOP_RUNTIME_OWNER_NONCE || process.env.DESKTOP_BRIDGE_TOKEN) process.exit(12);
if (process.env.PROVENANCE_NATIVE_RELEASE_RUNNER) process.exit(13);
publishReadiness({
  type: 'release.ready',
  nonce: process.env.RELEASE_SUPERVISOR_NONCE,
  targetVersion: process.env.RELEASE_TARGET_VERSION,
  contentHash: process.env.RELEASE_CONTENT_HASH,
});
setInterval(() => undefined, 1000);
`;

const descendantSource = (mode: 'ready' | 'wrong'): string => `
${readinessPublisherSource}
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const path = require('node:path');
const trackerRoot = process.env.RELEASE_TEST_TRACKER_ROOT;
const releaseId = process.env.RELEASE_ID;
const heartbeatProgram = "const { writeFileSync } = require('node:fs'); let beat = 0; const write = () => writeFileSync(process.env.RELEASE_TEST_HEARTBEAT_PATH, String(++beat)); write(); setInterval(write, 20);";
const heartbeatPath = path.join(trackerRoot, releaseId + '.heartbeat');
const descendant = spawn(process.execPath, ['-e', heartbeatProgram], {
  env: { ...process.env, RELEASE_TEST_HEARTBEAT_PATH: heartbeatPath },
  stdio: 'ignore',
  windowsHide: true,
});
writeFileSync(path.join(trackerRoot, releaseId + '.pid'), String(descendant.pid));
const readiness = {
  type: 'release.ready',
  nonce: ${mode === 'wrong' ? "'wrong-nonce'" : 'process.env.RELEASE_SUPERVISOR_NONCE'},
  targetVersion: process.env.RELEASE_TARGET_VERSION,
  contentHash: process.env.RELEASE_CONTENT_HASH,
};
publishReadiness(readiness);
setInterval(() => undefined, 1000);
`;

const disconnectSource = `
${readinessPublisherSource}
if (process.env.RELEASE_TEST_PARENT_SECRET) process.exit(9);
const readiness = {
  type: 'release.ready',
  nonce: process.env.RELEASE_SUPERVISOR_NONCE,
  targetVersion: process.env.RELEASE_TARGET_VERSION,
  contentHash: process.env.RELEASE_CONTENT_HASH,
};
if (process.env.RELEASE_SUPERVISOR_READY_FILE) {
  publishReadiness(readiness);
  setTimeout(() => process.exit(0), 200);
} else if (process.send) {
  process.send(readiness, () => process.disconnect());
}
setInterval(() => undefined, 1000);
`;

const testSupervisorOptions = async (
  options: NodeReleaseSupervisorOptions,
): Promise<NodeReleaseSupervisorOptions> => {
  if (process.platform !== 'win32') return options;
  const runtimeDirectory = await mkdtemp(path.join(os.tmpdir(), 'release-runner-'));
  roots.push(runtimeDirectory);
  const runnerScript = path.join(runtimeDirectory, 'native-runner.cjs');
  await writeFile(runnerScript, `
const { spawn } = require('node:child_process');
const [flag, nodeExecutable, entrypoint, workingDirectory] = process.argv.slice(2);
if (flag !== '--provenance-native-release-runner-v1' || !nodeExecutable || !entrypoint || !workingDirectory) process.exit(125);
const child = spawn(nodeExecutable, [entrypoint], {
  cwd: workingDirectory,
  env: process.env,
  shell: false,
  stdio: 'ignore',
  windowsHide: true,
});
child.once('error', () => process.exit(125));
child.once('exit', (code) => process.exit(Number.isSafeInteger(code) ? code : 125));
setInterval(() => undefined, 1000);
`, 'utf8');
  return {
    ...options,
    nativeRunnerPath: process.execPath,
    nativeRunnerArguments: [runnerScript],
    readinessDirectory: runtimeDirectory,
  };
};

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

const delay = (durationMs: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, durationMs);
});

const createTracker = async (): Promise<string> => {
  const trackerRoot = await mkdtemp(path.join(os.tmpdir(), 'release-descendants-'));
  roots.push(trackerRoot);
  return trackerRoot;
};

const waitForTracker = async (trackerRoot: string, releaseId: string): Promise<{
  pid: number;
  heartbeatPath: string;
}> => {
  const pidPath = path.join(trackerRoot, `${releaseId}.pid`);
  const heartbeatPath = path.join(trackerRoot, `${releaseId}.heartbeat`);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const pid = Number.parseInt(await readFile(pidPath, 'utf8'), 10);
      await readFile(heartbeatPath, 'utf8');
      if (Number.isSafeInteger(pid) && pid > 0) return { pid, heartbeatPath };
    } catch {
      // The candidate and its descendant publish the two files independently.
    }
    await delay(20);
  }
  throw new Error(`Timed out waiting for descendant tracker ${releaseId}.`);
};

const expectTrackerStopped = async (tracker: { pid: number; heartbeatPath: string }): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (processIsRunning(tracker.pid) && Date.now() < deadline) await delay(20);
  expect(processIsRunning(tracker.pid)).toBe(false);
  await delay(80);
  const stoppedAt = await readFile(tracker.heartbeatPath, 'utf8');
  await delay(100);
  expect(await readFile(tracker.heartbeatPath, 'utf8')).toBe(stoppedAt);
};

describe('Node release process supervisor', () => {
  it('keeps the previous child alive through candidate readiness and stops it only after commit', async () => {
    const trackerRoot = await createTracker();
    const supervisor = createNodeReleaseSupervisor(await testSupervisorOptions({
      readyTimeoutMs: 2_000,
      stabilityWindowMs: 50,
      stopTimeoutMs: 5_000,
      environment: { RELEASE_TEST_TRACKER_ROOT: trackerRoot },
    }));
    supervisors.push(supervisor);

    const first = await supervisor.prepare(await candidate('release_1', descendantSource('ready')));
    await supervisor.commit(first);
    const firstPid = supervisor.getStatus().activePid!;
    const firstDescendant = await waitForTracker(trackerRoot, 'release_1');
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
    await expectTrackerStopped(firstDescendant);
  });

  it('rejects a forged readiness nonce, terminates the candidate, and leaves the active child running', async () => {
    const trackerRoot = await createTracker();
    const supervisor = createNodeReleaseSupervisor(await testSupervisorOptions({
      readyTimeoutMs: 2_000,
      stabilityWindowMs: 50,
      stopTimeoutMs: 5_000,
      environment: { RELEASE_TEST_TRACKER_ROOT: trackerRoot },
    }));
    supervisors.push(supervisor);
    const first = await supervisor.prepare(await candidate('release_1'));
    await supervisor.commit(first);
    const firstPid = supervisor.getStatus().activePid!;

    await expect(supervisor.prepare(await candidate('release_2', descendantSource('wrong'))))
      .rejects.toThrow(/readiness proof did not match/i);
    const rejectedDescendant = await waitForTracker(trackerRoot, 'release_2');
    expect(supervisor.getStatus()).toMatchObject({ activeReleaseId: 'release_1', pendingReleaseIds: [] });
    expect(processIsRunning(firstPid)).toBe(true);
    await expectTrackerStopped(rejectedDescendant);
  });

  it('fails a child that disconnects during the stability window and does not inherit arbitrary parent secrets', async () => {
    const prior = process.env.RELEASE_TEST_PARENT_SECRET;
    process.env.RELEASE_TEST_PARENT_SECRET = 'must-not-cross';
    try {
      const supervisor = createNodeReleaseSupervisor(await testSupervisorOptions({
        readyTimeoutMs: 5_000,
        stabilityWindowMs: 1_000,
        stopTimeoutMs: 5_000,
      }));
      supervisors.push(supervisor);
      const prepared = await supervisor.prepare(await candidate('release_1'));
      await supervisor.abort(prepared);
      await expect(supervisor.prepare(await candidate('release_2', disconnectSource)))
        .rejects.toThrow(/disconnected|exited during the stability window/i);
      expect(supervisor.getStatus()).toEqual({ pendingReleaseIds: [] });
    } finally {
      if (prior === undefined) delete process.env.RELEASE_TEST_PARENT_SECRET;
      else process.env.RELEASE_TEST_PARENT_SECRET = prior;
    }
  });

  it('preserves packaged command policy without forwarding native credentials', async () => {
    const priorPackaged = process.env.DESKTOP_PACKAGED_RELEASE;
    const priorImage = process.env.PROVENANCE_SANDBOX_IMAGE;
    const priorOwner = process.env.DESKTOP_RUNTIME_OWNER_NONCE;
    const priorBridge = process.env.DESKTOP_BRIDGE_TOKEN;
    process.env.DESKTOP_PACKAGED_RELEASE = '1';
    process.env.PROVENANCE_SANDBOX_IMAGE = `registry.example.test/node@sha256:${'a'.repeat(64)}`;
    process.env.DESKTOP_RUNTIME_OWNER_NONCE = 'must-not-cross';
    process.env.DESKTOP_BRIDGE_TOKEN = 'must-not-cross';
    try {
      const supervisor = createNodeReleaseSupervisor(await testSupervisorOptions({
        readyTimeoutMs: 2_000,
        stabilityWindowMs: 50,
        stopTimeoutMs: 5_000,
      }));
      supervisors.push(supervisor);
      const prepared = await supervisor.prepare(await candidate('release_1', nativePolicySource));
      await supervisor.abort(prepared);
    } finally {
      for (const [name, value] of [
        ['DESKTOP_PACKAGED_RELEASE', priorPackaged],
        ['PROVENANCE_SANDBOX_IMAGE', priorImage],
        ['DESKTOP_RUNTIME_OWNER_NONCE', priorOwner],
        ['DESKTOP_BRIDGE_TOKEN', priorBridge],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
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

  it.skipIf(process.platform !== 'win32')('fails closed when native Windows launch authority is unavailable', async () => {
    const runtimeDirectory = await mkdtemp(path.join(os.tmpdir(), 'release-no-runner-'));
    roots.push(runtimeDirectory);
    const priorRunner = process.env.PROVENANCE_NATIVE_RELEASE_RUNNER;
    delete process.env.PROVENANCE_NATIVE_RELEASE_RUNNER;
    try {
      const supervisor = createNodeReleaseSupervisor({
        readyTimeoutMs: 100,
        stabilityWindowMs: 20,
        readinessDirectory: runtimeDirectory,
      });
      supervisors.push(supervisor);
      await expect(supervisor.prepare(await candidate('release_1')))
        .rejects.toThrow(/trusted native release runner/i);
      expect(supervisor.getStatus()).toEqual({ pendingReleaseIds: [] });
    } finally {
      if (priorRunner === undefined) delete process.env.PROVENANCE_NATIVE_RELEASE_RUNNER;
      else process.env.PROVENANCE_NATIVE_RELEASE_RUNNER = priorRunner;
    }
  });

  it('terminates a prepared candidate descendant on abort', async () => {
    const trackerRoot = await createTracker();
    const supervisor = createNodeReleaseSupervisor(await testSupervisorOptions({
      readyTimeoutMs: 2_000,
      stabilityWindowMs: 50,
      stopTimeoutMs: 5_000,
      environment: { RELEASE_TEST_TRACKER_ROOT: trackerRoot },
    }));
    supervisors.push(supervisor);
    const prepared = await supervisor.prepare(await candidate('release_1', descendantSource('ready')));
    const descendant = await waitForTracker(trackerRoot, 'release_1');

    await supervisor.abort(prepared);

    expect(supervisor.getStatus()).toEqual({ pendingReleaseIds: [] });
    await expectTrackerStopped(descendant);
  });

  it('terminates active and prepared descendant trees during shutdown', async () => {
    const trackerRoot = await createTracker();
    const supervisor = createNodeReleaseSupervisor(await testSupervisorOptions({
      readyTimeoutMs: 2_000,
      stabilityWindowMs: 50,
      stopTimeoutMs: 5_000,
      environment: { RELEASE_TEST_TRACKER_ROOT: trackerRoot },
    }));
    supervisors.push(supervisor);
    const first = await supervisor.prepare(await candidate('release_1', descendantSource('ready')));
    await supervisor.commit(first);
    await supervisor.prepare(await candidate('release_2', descendantSource('ready')));
    const activeDescendant = await waitForTracker(trackerRoot, 'release_1');
    const pendingDescendant = await waitForTracker(trackerRoot, 'release_2');

    await supervisor.shutdown();

    expect(supervisor.getStatus()).toEqual({ pendingReleaseIds: [] });
    await Promise.all([
      expectTrackerStopped(activeDescendant),
      expectTrackerStopped(pendingDescendant),
    ]);
  });

  it('deduplicates concurrent cleanup for the same supervised process tree', async () => {
    let terminationStarts = 0;
    const supervisor = createNodeReleaseSupervisor(await testSupervisorOptions({
      readyTimeoutMs: 2_000,
      stabilityWindowMs: 50,
      stopTimeoutMs: 5_000,
      onTerminationStart: () => { terminationStarts += 1; },
    }));
    supervisors.push(supervisor);
    const prepared = await supervisor.prepare(await candidate('release_1'));

    await Promise.all([
      supervisor.abort(prepared),
      supervisor.shutdown(),
      supervisor.shutdown(),
    ]);

    expect(terminationStarts).toBe(1);
    expect(supervisor.getStatus()).toEqual({ pendingReleaseIds: [] });
  });

  it.skipIf(process.platform !== 'win32')('retains a candidate and propagates failure until tree cleanup can be retried', async () => {
    const trackerRoot = await createTracker();
    const supervisor = createNodeReleaseSupervisor(await testSupervisorOptions({
      readyTimeoutMs: 2_000,
      stabilityWindowMs: 50,
      stopTimeoutMs: 5_000,
      environment: { RELEASE_TEST_TRACKER_ROOT: trackerRoot },
    }));
    supervisors.push(supervisor);
    const prepared = await supervisor.prepare(await candidate('release_1', descendantSource('ready')));
    const descendant = await waitForTracker(trackerRoot, 'release_1');
    const systemRoot = process.env.SystemRoot;
    process.env.SystemRoot = 'untrusted-relative-root';
    try {
      await expect(supervisor.abort(prepared)).rejects.toThrow(/process-tree termination could not be confirmed/i);
      expect(supervisor.getStatus().pendingReleaseIds).toEqual(['release_1']);
      const before = await readFile(descendant.heartbeatPath, 'utf8');
      await delay(100);
      expect(await readFile(descendant.heartbeatPath, 'utf8')).not.toBe(before);
    } finally {
      if (systemRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = systemRoot;
    }

    await supervisor.abort(prepared);
    expect(supervisor.getStatus()).toEqual({ pendingReleaseIds: [] });
    await expectTrackerStopped(descendant);
  });
});

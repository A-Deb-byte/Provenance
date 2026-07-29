import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createKernelService } from './kernel';
import { appendKernelEvent } from './ledger';

const roots: string[] = [];

const makeRoot = async (prefix: string): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('authenticated observatory state cache', () => {
  it('serves the last authenticated state with a verified tail and invalidates it before a failed state read', async () => {
    const runtimeDir = await makeRoot('observatory-cache-runtime-');
    const workspaceRoot = await makeRoot('observatory-cache-workspace-');
    const kernel = createKernelService({ runtimeDir, allowedWorkspaceRoot: workspaceRoot });
    await kernel.createGoal({
      objective: 'Exercise the observatory cache',
      successCriteria: ['The authenticated projection remains available'],
      constraints: ['Do not trust unauthenticated state files'],
      autonomyLevel: 'bounded',
      workspaceRoot,
      verificationCommands: ['npm test'],
      budget: {
        maxOperations: 1,
        maxCommandRuntimeMs: 1_000,
        maxApprovals: 0,
        maxProviderCalls: 0,
      },
    });

    const authenticated = await kernel.getObservatoryData();
    await Promise.all([
      rm(path.join(runtimeDir, 'state.json')),
      rm(path.join(runtimeDir, 'state.authenticated.json')),
    ]);

    const cached = await kernel.getObservatoryData();
    expect(cached.state.goals[0]?.objective).toBe('Exercise the observatory cache');
    expect(cached.state.lastEventHash).toBe(authenticated.state.lastEventHash);

    await expect(kernel.getState()).rejects.toThrow(/snapshot integrity/i);
    await expect(kernel.getObservatoryData()).rejects.toThrow(/snapshot integrity/i);
  });

  it('refreshes the cached state after a new authenticated commit', async () => {
    const runtimeDir = await makeRoot('observatory-refresh-runtime-');
    const workspaceRoot = await makeRoot('observatory-refresh-workspace-');
    const kernel = createKernelService({ runtimeDir, allowedWorkspaceRoot: workspaceRoot });
    const before = await kernel.getObservatoryData();

    await kernel.setStopAll(true, 'Bounded operator stop reason.');
    const after = await kernel.getObservatoryData();

    expect(after.state.controls).toMatchObject({
      stopAll: true,
      stopAllReason: 'Bounded operator stop reason.',
    });
    expect(after.state.lastEventHash).not.toBe(before.state.lastEventHash);
    expect(after.events.at(-1)?.hash).toBe(after.state.lastEventHash);
  });

  it('fails closed when the on-disk ledger advances beyond the cached authenticated head', async () => {
    const runtimeDir = await makeRoot('observatory-divergence-runtime-');
    const workspaceRoot = await makeRoot('observatory-divergence-workspace-');
    const kernel = createKernelService({ runtimeDir, allowedWorkspaceRoot: workspaceRoot });
    const authenticated = await kernel.getObservatoryData();

    await appendKernelEvent(runtimeDir, authenticated.state.lastEventHash, {
      actor: 'system',
      type: 'fixture.uncommitted_tail',
      entityId: 'fixture',
      entityType: 'system',
      payload: {},
    });

    await expect(kernel.getObservatoryData()).rejects.toThrow(/authenticated snapshot head/i);
  });
});

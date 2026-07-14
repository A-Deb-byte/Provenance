import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createKernelService } from './kernel';
import { appendKernelEvent, readKernelEvents } from './ledger';
import {
  hashKernelStateContent,
  writePendingKernelSnapshot,
} from './store';

let runtimeDir = '';
let workspaceRoot = '';

const goalInput = (objective: string) => ({
  objective,
  successCriteria: ['Snapshot verification passes'],
  constraints: ['Stay inside workspace'],
  autonomyLevel: 'supervised' as const,
  workspaceRoot,
  verificationCommands: ['npm test'],
  budget: {
    maxOperations: 4,
    maxCommandRuntimeMs: 120000,
    maxApprovals: 1,
    maxProviderCalls: 0,
  },
});

const tamperObjective = async (file: string): Promise<void> => {
  const parsed = JSON.parse(await readFile(file, 'utf8')) as { goals: Array<{ objective: string }> };
  parsed.goals[0].objective = 'tampered objective';
  await writeFile(file, JSON.stringify(parsed), 'utf8');
};

beforeEach(async () => {
  runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'kernel-snapshot-'));
  workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'kernel-snapshot-workspace-'));
});

afterEach(async () => {
  await Promise.all([
    rm(runtimeDir, { recursive: true, force: true }),
    rm(workspaceRoot, { recursive: true, force: true }),
  ]);
});

describe('authenticated kernel snapshots', () => {
  it('restores a tampered primary snapshot from an authenticated replica and rejects two-copy tampering', async () => {
    const kernel = createKernelService({ runtimeDir, allowedWorkspaceRoot: workspaceRoot });
    await kernel.createGoal(goalInput('Original objective'));

    await tamperObjective(path.join(runtimeDir, 'state.json'));
    const restored = await createKernelService({ runtimeDir, allowedWorkspaceRoot: workspaceRoot }).getState();
    expect(restored.goals[0].objective).toBe('Original objective');

    await Promise.all([
      tamperObjective(path.join(runtimeDir, 'state.json')),
      tamperObjective(path.join(runtimeDir, 'state.authenticated.json')),
    ]);
    await expect(
      createKernelService({ runtimeDir, allowedWorkspaceRoot: workspaceRoot }).getState(),
    ).rejects.toThrow(/snapshot integrity/i);
  });

  it('finishes a pending snapshot whose domain event reached the ledger before the commit event', async () => {
    const kernel = createKernelService({ runtimeDir, allowedWorkspaceRoot: workspaceRoot });
    await kernel.createGoal(goalInput('Recover pending state'));
    const state = await kernel.getState();
    const domainEvent = await appendKernelEvent(runtimeDir, state.lastEventHash, {
      actor: 'system',
      type: 'control.stop_all',
      entityId: 'kernel-controls',
      entityType: 'control',
      payload: { reasonHash: 'a'.repeat(64) },
    });
    const targetContent = {
      ...state,
      controls: { stopAll: true, stopAllReason: 'Recovered pending mutation.' },
      lastEventHash: domainEvent.hash,
    };
    const stateHash = hashKernelStateContent(targetContent);
    const prepared = await appendKernelEvent(runtimeDir, domainEvent.hash, {
      actor: 'system',
      type: 'system.snapshot_prepared',
      entityId: 'kernel-state',
      entityType: 'system',
      payload: { schemaVersion: 1, baseEventHash: domainEvent.hash, stateHash },
    });
    const target = { ...targetContent, lastEventHash: prepared.hash };
    await writePendingKernelSnapshot(runtimeDir, {
      schemaVersion: 1,
      baseEventHash: prepared.hash,
      stateHash,
      state: target,
    });

    const recovered = await createKernelService({ runtimeDir, allowedWorkspaceRoot: workspaceRoot }).getState();
    expect(recovered.controls).toMatchObject({ stopAll: true, stopAllReason: 'Recovered pending mutation.' });
    expect((await readKernelEvents(runtimeDir)).at(-1)?.type).toBe('system.snapshot_committed');
  });

  it('publishes a pending snapshot when its commit event exists but state publication was interrupted', async () => {
    const kernel = createKernelService({ runtimeDir, allowedWorkspaceRoot: workspaceRoot });
    await kernel.createGoal(goalInput('Recover committed state'));
    const state = await kernel.getState();
    const domainEvent = await appendKernelEvent(runtimeDir, state.lastEventHash, {
      actor: 'system',
      type: 'control.stop_all',
      entityId: 'kernel-controls',
      entityType: 'control',
      payload: { reasonHash: 'b'.repeat(64) },
    });
    const targetContent = {
      ...state,
      controls: { stopAll: true, stopAllReason: 'Publish committed pending state.' },
      lastEventHash: domainEvent.hash,
    };
    const stateHash = hashKernelStateContent(targetContent);
    const prepared = await appendKernelEvent(runtimeDir, domainEvent.hash, {
      actor: 'system',
      type: 'system.snapshot_prepared',
      entityId: 'kernel-state',
      entityType: 'system',
      payload: { schemaVersion: 1, baseEventHash: domainEvent.hash, stateHash },
    });
    const target = { ...targetContent, lastEventHash: prepared.hash };
    await writePendingKernelSnapshot(runtimeDir, {
      schemaVersion: 1,
      baseEventHash: prepared.hash,
      stateHash,
      state: target,
    });
    const commitEvent = await appendKernelEvent(runtimeDir, prepared.hash, {
      actor: 'system',
      type: 'system.snapshot_committed',
      entityId: 'kernel-state',
      entityType: 'system',
      payload: {
        schemaVersion: 1,
        baseEventHash: prepared.hash,
        preparedEventHash: prepared.hash,
        stateHash,
      },
    });

    const recovered = await createKernelService({ runtimeDir, allowedWorkspaceRoot: workspaceRoot }).getState();
    expect(recovered.lastEventHash).toBe(commitEvent.hash);
    expect(recovered.controls.stopAllReason).toBe('Publish committed pending state.');
  });

  it('preserves and marks an uncommitted ledger tail while rolling back to the latest authenticated state', async () => {
    const kernel = createKernelService({ runtimeDir, allowedWorkspaceRoot: workspaceRoot });
    await kernel.createGoal(goalInput('Keep authenticated state'));
    const state = await kernel.getState();
    const abandoned = await appendKernelEvent(runtimeDir, state.lastEventHash, {
      actor: 'system',
      type: 'control.stop_all',
      entityId: 'kernel-controls',
      entityType: 'control',
      payload: { reasonHash: 'c'.repeat(64) },
    });

    const recovered = await createKernelService({ runtimeDir, allowedWorkspaceRoot: workspaceRoot }).getState();
    expect(recovered.controls.stopAll).toBe(false);
    const events = await readKernelEvents(runtimeDir);
    const recovery = events.find((event) => event.type === 'system.snapshot_recovered');
    expect(recovery?.payload.abandonedTailHashes).toContain(abandoned.hash);
    expect(events.at(-1)?.type).toBe('system.snapshot_committed');
  });

  it('rejects replay of an older valid snapshot after a newer snapshot was committed', async () => {
    const kernel = createKernelService({ runtimeDir, allowedWorkspaceRoot: workspaceRoot });
    await kernel.createGoal(goalInput('Reject snapshot rollback'));
    const staleState = await readFile(path.join(runtimeDir, 'state.json'), 'utf8');
    await kernel.setStopAll(true, 'Create a newer authenticated snapshot.');
    await Promise.all([
      writeFile(path.join(runtimeDir, 'state.json'), staleState, 'utf8'),
      writeFile(path.join(runtimeDir, 'state.authenticated.json'), staleState, 'utf8'),
    ]);

    await expect(
      createKernelService({ runtimeDir, allowedWorkspaceRoot: workspaceRoot }).getState(),
    ).rejects.toThrow(/newer committed snapshot is unavailable/i);
  });
});

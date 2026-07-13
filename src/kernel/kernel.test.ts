import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createKernelService } from './kernel';
import { writeKernelState } from './store';

let runtimeDir = '';
let workspaceRoot = '';

const goalInput = (objective: string) => ({
  objective,
  successCriteria: ['Verification passes'],
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

beforeEach(async () => {
  runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'kernel-service-'));
  workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'kernel-workspace-'));
  await writeFile(path.join(workspaceRoot, 'package.json'), JSON.stringify({
    private: true,
    scripts: { test: "node -e \"process.stdout.write('kernel-ok')\"" },
  }), 'utf8');
});

afterEach(async () => {
  await Promise.all([
    rm(runtimeDir, { recursive: true, force: true }),
    rm(workspaceRoot, { recursive: true, force: true }),
  ]);
});

describe('kernel service', () => {
  it('creates a goal with tasks and ledger events', async () => {
    const kernel = createKernelService({ runtimeDir, allowedWorkspaceRoot: workspaceRoot });
    const goal = await kernel.createGoal(goalInput('Run tests'));

    const state = await kernel.getState();
    expect(goal.status).toBe('active');
    expect(state.tasks).toHaveLength(1);
    expect(state.tasks[0].status).toBe('ready');
    expect((await kernel.getEvents()).map((event) => event.type)).toEqual([
      'goal.created',
      'task.created',
    ]);
  });

  it('executes the next task, records evidence, and completes the goal', async () => {
    const kernel = createKernelService({ runtimeDir, allowedWorkspaceRoot: workspaceRoot });
    const goal = await kernel.createGoal(goalInput('Verify fixture'));

    const result = await kernel.stepGoal(goal.id);
    const state = await kernel.getState();
    const events = await kernel.getEvents();

    expect(result.status).toBe('passed');
    expect(result.evidence?.stdout).toContain('kernel-ok');
    expect(state.tasks[0].status).toBe('passed');
    expect(state.tasks[0].evidenceEventIds).toHaveLength(1);
    expect(state.goals[0].status).toBe('completed');
    expect(state.goals[0].usage.operations).toBe(1);
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
      'task.started',
      'capability.issued',
      'task.passed',
      'goal.completed',
    ]));
  });

  it('serializes concurrent mutations without losing goals or event links', async () => {
    const kernel = createKernelService({ runtimeDir, allowedWorkspaceRoot: workspaceRoot });

    await Promise.all([
      kernel.createGoal(goalInput('First concurrent goal')),
      kernel.createGoal(goalInput('Second concurrent goal')),
    ]);

    const state = await kernel.getState();
    const events = await kernel.getEvents();
    expect(state.goals).toHaveLength(2);
    expect(state.tasks).toHaveLength(2);
    expect(events).toHaveLength(4);
    events.forEach((event, index) => {
      expect(event.previousHash).toBe(index === 0 ? null : events[index - 1].hash);
    });
  });

  it('fails closed when the snapshot head no longer matches the ledger', async () => {
    const kernel = createKernelService({ runtimeDir, allowedWorkspaceRoot: workspaceRoot });
    await kernel.createGoal(goalInput('Detect stale snapshot'));
    const state = await kernel.getState();
    await writeKernelState(runtimeDir, { ...state, lastEventHash: null });

    await expect(kernel.getState()).rejects.toThrow('snapshot');
  });
});

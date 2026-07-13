import { describe, expect, it } from 'vitest';
import { createEmptyUsage } from './budget';
import { buildInitialTaskGraph, getNextReadyTask, markTaskStatus } from './taskGraph';

describe('task graph', () => {
  const goal = {
    id: 'goal_1',
    objective: 'Verify project',
    successCriteria: ['Tests pass'],
    constraints: ['Stay inside workspace'],
    autonomyLevel: 'supervised' as const,
    workspaceRoot: 'C:/workspace/project',
    verificationCommands: ['npm test'],
    budget: { maxOperations: 4, maxCommandRuntimeMs: 120000, maxApprovals: 1, maxProviderCalls: 0 },
    usage: createEmptyUsage(),
    status: 'active' as const,
    createdAt: '2026-06-21T00:00:00.000Z',
    updatedAt: '2026-06-21T00:00:00.000Z',
  };

  it('creates verification tasks from commands', () => {
    const tasks = buildInitialTaskGraph(goal, '2026-06-21T00:00:00.000Z');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].commandRequest?.args).toEqual(['test']);
    expect(getNextReadyTask(tasks)?.id).toBe(tasks[0].id);
  });

  it('marks task status immutably', () => {
    const [task] = buildInitialTaskGraph(goal, '2026-06-21T00:00:00.000Z');
    const updated = markTaskStatus([task], task.id, 'passed', '2026-06-21T00:00:01.000Z');
    expect(updated[0].status).toBe('passed');
    expect(task.status).toBe('ready');
  });

  it('blocks tasks whose declared dependency is missing', () => {
    const [task] = buildInitialTaskGraph(goal, '2026-06-21T00:00:00.000Z');
    expect(getNextReadyTask([{ ...task, dependsOn: ['task_missing'] }])).toBeUndefined();
  });
});

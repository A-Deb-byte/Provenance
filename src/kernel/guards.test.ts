import { describe, expect, it } from 'vitest';
import { isGoalContractInput, isKernelCommandRequest, isRiskLevel } from './guards';

describe('kernel guards', () => {
  it('accepts a valid goal contract input', () => {
    expect(isGoalContractInput({
      objective: 'Run project verification',
      successCriteria: ['Tests pass', 'Build passes'],
      constraints: ['Stay inside workspace'],
      autonomyLevel: 'supervised',
      workspaceRoot: 'C:/workspace/project',
      verificationCommands: ['npm test'],
      budget: {
        maxOperations: 8,
        maxCommandRuntimeMs: 120000,
        maxApprovals: 2,
        maxProviderCalls: 0,
      },
    })).toBe(true);
  });

  it('rejects vague or malformed goal input', () => {
    expect(isGoalContractInput({ objective: '', successCriteria: [] })).toBe(false);
    expect(isGoalContractInput({ objective: 'x', successCriteria: ['ok'], autonomyLevel: 'silent' })).toBe(false);
    expect(isGoalContractInput({
      objective: 'No tasks',
      successCriteria: ['Done'],
      constraints: ['Stay local'],
      autonomyLevel: 'supervised',
      workspaceRoot: 'C:/workspace/project',
      verificationCommands: [],
      budget: { maxOperations: 1, maxCommandRuntimeMs: 1000, maxApprovals: 0, maxProviderCalls: 0 },
    })).toBe(false);
    expect(isGoalContractInput({
      objective: 'Fractional budget',
      successCriteria: ['Done'],
      constraints: ['Stay local'],
      autonomyLevel: 'supervised',
      workspaceRoot: 'C:/workspace/project',
      verificationCommands: ['npm test'],
      budget: { maxOperations: 1.5, maxCommandRuntimeMs: Infinity, maxApprovals: 0, maxProviderCalls: 0 },
    })).toBe(false);
    expect(isGoalContractInput({
      objective: 'Unsupported verification',
      successCriteria: ['Done'],
      constraints: ['Stay local'],
      autonomyLevel: 'supervised',
      workspaceRoot: 'C:/workspace/project',
      verificationCommands: ['npm publish'],
      budget: { maxOperations: 1, maxCommandRuntimeMs: 1000, maxApprovals: 0, maxProviderCalls: 0 },
    })).toBe(false);
  });

  it('validates risk levels and command requests', () => {
    expect(isRiskLevel('L1')).toBe(true);
    expect(isRiskLevel('L9')).toBe(false);
    expect(isKernelCommandRequest({
      command: 'npm',
      args: ['test'],
      cwd: 'C:/workspace/project',
      expectedEvidence: 'Vitest passes',
    })).toBe(true);
    expect(isKernelCommandRequest({ command: 'rm', args: ['-rf', '.'] })).toBe(false);
  });
});

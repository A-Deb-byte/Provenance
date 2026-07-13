import { describe, expect, it } from 'vitest';
import { createCapabilityToken, useCapabilityToken } from './capabilities';

describe('capability tokens', () => {
  it('tracks operation usage and expiry', () => {
    const token = createCapabilityToken({
      family: 'command.run',
      goalId: 'goal_1',
      taskId: 'task_1',
      workspaceRoot: 'C:/workspace/project',
      command: 'npm',
      riskLevel: 'L1',
      maxOperations: 1,
      expiresAt: '2026-06-21T00:01:00.000Z',
    });

    const used = useCapabilityToken(token, '2026-06-21T00:00:30.000Z');
    expect(used.allowed).toBe(true);
    expect(useCapabilityToken(used.token, '2026-06-21T00:00:31.000Z').allowed).toBe(false);
    expect(useCapabilityToken(token, '2026-06-21T00:02:00.000Z').allowed).toBe(false);
    expect(useCapabilityToken(token, '2026-06-21T00:01:00.000Z').allowed).toBe(false);
    expect(useCapabilityToken({ ...token, expiresAt: 'not-a-date' }, '2026-06-21T00:00:30.000Z').allowed).toBe(false);
  });
});

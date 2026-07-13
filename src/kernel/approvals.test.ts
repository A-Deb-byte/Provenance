import { describe, expect, it } from 'vitest';
import { createApprovalRecord, decideApprovalRecord } from './approvals';

describe('approval broker', () => {
  it('creates and decides approval records', () => {
    const approval = createApprovalRecord({
      goalId: 'goal_1',
      taskId: 'task_1',
      requestedAction: 'Run external connector',
      riskLevel: 'L2',
      reason: 'External side effect',
    }, '2026-06-21T00:00:00.000Z');

    expect(approval.status).toBe('pending');
    const decided = decideApprovalRecord(approval, 'approved', 'User approved scoped action', '2026-06-21T00:00:01.000Z');
    expect(decided.status).toBe('approved');
    expect(decided.decidedAt).toBe('2026-06-21T00:00:01.000Z');
    expect(() => decideApprovalRecord(decided, 'denied', 'Changed mind')).toThrow('pending');
  });
});

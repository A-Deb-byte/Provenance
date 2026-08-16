import { describe, expect, it } from 'vitest';
import { createApprovalRecord, decideApprovalRecord, isIndependentlyVerified } from './approvals';
import { approvalDecisionPrincipalFor } from '../auth/accessControl';
import type { ApprovalDecisionPrincipal } from './types';

const pending = (id: string) => createApprovalRecord({
  goalId: 'goal_1',
  taskId: `task_${id}`,
  requestedAction: 'Run external connector',
  riskLevel: 'L2',
  reason: 'External side effect',
}, '2026-06-21T00:00:00.000Z');

const decidedBy = (
  principalId: string,
  attribution: ApprovalDecisionPrincipal['attribution'] = 'natural_person',
): ApprovalDecisionPrincipal => ({
  principalId,
  mode: attribution === 'natural_person' ? 'multi_user' : 'operator_token',
  role: 'operator',
  attribution,
});

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

describe('oversight attribution', () => {
  it('records which principal decided, and whether it identified a person', () => {
    const decided = decideApprovalRecord(
      pending('a'), 'approved', 'Approved by the on-call operator',
      '2026-06-21T00:00:01.000Z', decidedBy('user:alice'),
    );

    expect(decided.decidedBy).toEqual({
      principalId: 'user:alice',
      mode: 'multi_user',
      role: 'operator',
      attribution: 'natural_person',
    });
  });

  it('classifies only multi-user sessions as an identified natural person', () => {
    expect(approvalDecisionPrincipalFor({
      principalId: 'user:alice', mode: 'multi_user', role: 'operator',
    })?.attribution).toBe('natural_person');

    // An operator token is shared by construction and loopback-open
    // authenticates nobody; neither identifies a human.
    expect(approvalDecisionPrincipalFor({
      principalId: 'access:shared-operator-token', mode: 'operator_token', role: 'admin',
    })?.attribution).toBe('shared_credential');
    expect(approvalDecisionPrincipalFor({
      principalId: 'access:loopback-open', mode: 'open', role: 'admin',
    })?.attribution).toBe('shared_credential');

    expect(approvalDecisionPrincipalFor(undefined)).toBeUndefined();
  });

  it('accepts two distinct identified people as independent verification', () => {
    const first = decideApprovalRecord(pending('a'), 'approved', 'First reviewer', '2026-06-21T00:00:01.000Z', decidedBy('user:alice'));
    const second = decideApprovalRecord(pending('b'), 'approved', 'Second reviewer', '2026-06-21T00:00:02.000Z', decidedBy('user:bob'));

    expect(isIndependentlyVerified(first, second)).toBe(true);
  });

  it('refuses to count one person, one shared token, or missing attribution as two', () => {
    const alice = decideApprovalRecord(pending('a'), 'approved', 'First', '2026-06-21T00:00:01.000Z', decidedBy('user:alice'));
    const aliceAgain = decideApprovalRecord(pending('b'), 'approved', 'Again', '2026-06-21T00:00:02.000Z', decidedBy('user:alice'));
    expect(isIndependentlyVerified(alice, aliceAgain)).toBe(false);

    // The case that would manufacture false assurance: two approvals through
    // one shared token prove nothing about how many people were involved.
    const tokenOne = decideApprovalRecord(pending('c'), 'approved', 'One', '2026-06-21T00:00:03.000Z', decidedBy('access:shared-operator-token', 'shared_credential'));
    const tokenTwo = decideApprovalRecord(pending('d'), 'approved', 'Two', '2026-06-21T00:00:04.000Z', decidedBy('access:shared-operator-token', 'shared_credential'));
    expect(isIndependentlyVerified(tokenOne, tokenTwo)).toBe(false);

    const unattributed = decideApprovalRecord(pending('e'), 'approved', 'Legacy', '2026-06-21T00:00:05.000Z');
    expect(unattributed.decidedBy).toBeUndefined();
    expect(isIndependentlyVerified(alice, unattributed)).toBe(false);

    // The same decision cannot verify itself.
    expect(isIndependentlyVerified(alice, alice)).toBe(false);
  });
});

import { createKernelId } from './ids';
import { ApprovalDecisionPrincipal, ApprovalRecord, ApprovalStatus, RiskLevel } from './types';

export interface CreateApprovalInput {
  goalId: string;
  taskId: string;
  requestedAction: string;
  authorityBindingHash?: string;
  riskLevel: RiskLevel;
  reason: string;
}

export const createApprovalRecord = (input: CreateApprovalInput, now = new Date().toISOString()): ApprovalRecord => ({
  id: createKernelId('approval'),
  goalId: input.goalId,
  taskId: input.taskId,
  status: 'pending',
  requestedAction: input.requestedAction,
  authorityBindingHash: input.authorityBindingHash,
  riskLevel: input.riskLevel,
  reason: input.reason,
  createdAt: now,
  updatedAt: now,
});

export const decideApprovalRecord = (
  approval: ApprovalRecord,
  status: Extract<ApprovalStatus, 'approved' | 'denied'>,
  decisionReason: string,
  now = new Date().toISOString(),
  decidedBy?: ApprovalDecisionPrincipal,
): ApprovalRecord => {
  if (approval.status !== 'pending') {
    throw new Error('Only pending approvals can be decided.');
  }
  if (!decisionReason.trim()) {
    throw new Error('Approval decision reason is required.');
  }
  return {
    ...approval,
    status,
    updatedAt: now,
    decidedAt: now,
    decisionReason,
    decidedBy,
  };
};

/**
 * True only when two decisions were made by two different identified people.
 *
 * Shared credentials are rejected outright: two approvals through one operator
 * token prove nothing about how many people were involved, and a check that
 * accepted them would manufacture false assurance.
 */
export const isIndependentlyVerified = (
  first: ApprovalRecord,
  second: ApprovalRecord,
): boolean => (
  first.id !== second.id &&
  first.decidedBy?.attribution === 'natural_person' &&
  second.decidedBy?.attribution === 'natural_person' &&
  first.decidedBy.principalId !== second.decidedBy.principalId
);

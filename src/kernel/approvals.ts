import { createKernelId } from './ids';
import { ApprovalRecord, ApprovalStatus, RiskLevel } from './types';

export interface CreateApprovalInput {
  goalId: string;
  taskId: string;
  requestedAction: string;
  riskLevel: RiskLevel;
  reason: string;
}

export const createApprovalRecord = (input: CreateApprovalInput, now = new Date().toISOString()): ApprovalRecord => ({
  id: createKernelId('approval'),
  goalId: input.goalId,
  taskId: input.taskId,
  status: 'pending',
  requestedAction: input.requestedAction,
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
  };
};

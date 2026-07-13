import { createKernelId } from './ids';
import { CapabilityFamily, CapabilityToken, RiskLevel } from './types';

interface CreateCapabilityTokenInput {
  family: CapabilityFamily;
  goalId: string;
  taskId: string;
  workspaceRoot: string;
  command?: string;
  args?: string[];
  cwd?: string;
  providerIds?: string[];
  models?: string[];
  requestHash?: string;
  riskLevel: RiskLevel;
  maxOperations: number;
  expiresAt: string;
}

export const createCapabilityToken = (input: CreateCapabilityTokenInput): CapabilityToken => ({
  id: createKernelId('cap'),
  family: input.family,
  goalId: input.goalId,
  taskId: input.taskId,
  riskLevel: input.riskLevel,
  scope: {
    workspaceRoot: input.workspaceRoot,
    command: input.command,
    args: input.args ? [...input.args] : undefined,
    cwd: input.cwd,
    providerIds: input.providerIds ? [...input.providerIds] : undefined,
    models: input.models ? [...input.models] : undefined,
    requestHash: input.requestHash,
  },
  expiresAt: input.expiresAt,
  maxOperations: input.maxOperations,
  usedOperations: 0,
});

export const useCapabilityToken = (
  token: CapabilityToken,
  now = new Date().toISOString(),
): { allowed: boolean; reason: string; token: CapabilityToken } => {
  const nowTime = new Date(now).getTime();
  const expiryTime = new Date(token.expiresAt).getTime();
  if (!Number.isFinite(nowTime) || !Number.isFinite(expiryTime)) {
    return { allowed: false, reason: 'Capability token has an invalid timestamp.', token };
  }
  if (nowTime >= expiryTime) {
    return { allowed: false, reason: 'Capability token expired.', token };
  }
  if (token.usedOperations >= token.maxOperations) {
    return { allowed: false, reason: 'Capability operation limit exhausted.', token };
  }
  return {
    allowed: true,
    reason: 'Capability operation allowed.',
    token: { ...token, usedOperations: token.usedOperations + 1 },
  };
};

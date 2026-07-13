import { isKernelCommandRequest } from './guards';
import { KernelCommandRequest, PolicyDecision, RiskLevel } from './types';

export const decidePolicyForRisk = (riskLevel: RiskLevel): PolicyDecision => {
  if (riskLevel === 'L0' || riskLevel === 'L1') {
    return { kind: 'allow', riskLevel, reason: `${riskLevel} is allowed inside the local workspace policy.` };
  }
  if (riskLevel === 'L2' || riskLevel === 'L3') {
    return { kind: 'approval_required', riskLevel, reason: `${riskLevel} requires explicit local approval.` };
  }
  return { kind: 'deny', riskLevel, reason: 'L4 actions are outside Phase 1 policy.' };
};

export const decidePolicyForCommand = (request: KernelCommandRequest): PolicyDecision => {
  if (!isKernelCommandRequest(request)) {
    return { kind: 'deny', riskLevel: 'L4', reason: 'Command is not allowlisted for Phase 1 execution.' };
  }
  return decidePolicyForRisk('L1');
};

import { AutomationContract } from './types';
import { minimumRiskForAction } from './policy';
import { isActionWithinScope, isCapabilityAction, isCapabilityScope } from './validators';

export interface AutomationValidationResult {
  valid: boolean;
  errors: string[];
}

const rank = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 } as const;
const isPositiveInteger = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0;

export const validateAutomationContract = (contract: AutomationContract): AutomationValidationResult => {
  const errors: string[] = [];
  if (contract.schemaVersion !== 1) errors.push('Unsupported automation schema version.');
  if (!contract.id?.trim() || !contract.name?.trim() || !contract.goalId?.trim() || !contract.workerId?.trim()) {
    errors.push('Automation identity fields are required.');
  }
  if (contract.riskLevel === 'L4') errors.push('L4 automations are forbidden.');
  if (contract.riskLevel === 'L3' && contract.approvalMode !== 'per_run') {
    errors.push('L3 automations require approval for every run.');
  }
  if (!isCapabilityAction(contract.action) || !isCapabilityScope(contract.scope) ||
    !isActionWithinScope(contract.action, contract.scope)) {
    errors.push('Automation action is outside its declared scope.');
  } else if (rank[contract.riskLevel] < rank[minimumRiskForAction(contract.action)]) {
    errors.push('Automation risk level understates its action.');
  }
  if (contract.trigger?.type === 'interval') {
    if (!isPositiveInteger(contract.trigger.everyMinutes) || contract.trigger.everyMinutes > 525600) {
      errors.push('Automation interval must be between 1 and 525600 minutes.');
    }
    if (contract.trigger.startsAt !== undefined && !Number.isFinite(Date.parse(contract.trigger.startsAt))) {
      errors.push('Automation interval start timestamp is invalid.');
    }
  } else if (contract.trigger?.type === 'schedule') {
    if (!contract.trigger.cron?.trim() || contract.trigger.cron.length > 120 || !contract.trigger.timezone?.trim()) {
      errors.push('Scheduled automations require bounded cron and timezone values.');
    }
  } else if (contract.trigger?.type !== 'manual') {
    errors.push('Automation trigger is invalid.');
  }
  if (!isPositiveInteger(contract.budget?.maxRuns) || contract.budget.maxRuns > 10000) {
    errors.push('Automation maxRuns must be between 1 and 10000.');
  }
  if (!isPositiveInteger(contract.budget?.maxConsecutiveFailures) || contract.budget.maxConsecutiveFailures > 100) {
    errors.push('Automation maxConsecutiveFailures must be between 1 and 100.');
  }
  if (!isPositiveInteger(contract.budget?.maxRuntimeMsPerRun) || contract.budget.maxRuntimeMsPerRun > 24 * 60 * 60 * 1000) {
    errors.push('Automation per-run runtime must be between 1 ms and 24 hours.');
  }
  if (!Number.isFinite(Date.parse(contract.createdAt)) || !Number.isFinite(Date.parse(contract.updatedAt))) {
    errors.push('Automation timestamps are invalid.');
  }
  return { valid: errors.length === 0, errors };
};

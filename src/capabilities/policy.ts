import { ActionIntent, CapabilityAction, CapabilityRiskLevel } from './types';
import { WorkerRegistry } from './registry';
import {
  familyForAction,
  isActionIntent,
  isActionWithinScope,
  isScopeWithinScope,
} from './validators';

export type CapabilityPolicyReasonCode =
  | 'allowed'
  | 'approval_required'
  | 'invalid_intent'
  | 'untrusted_authority'
  | 'forbidden_risk'
  | 'risk_understated'
  | 'worker_unknown'
  | 'worker_unavailable'
  | 'worker_action_unsupported'
  | 'scope_mismatch'
  | 'scope_not_configured';

export interface CapabilityPolicyDecision {
  kind: 'allow' | 'approval_required' | 'deny';
  reasonCode: CapabilityPolicyReasonCode;
  reason: string;
  riskLevel: CapabilityRiskLevel;
}

const riskRank: Record<CapabilityRiskLevel, number> = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 };

export const minimumRiskForAction = (action: CapabilityAction): CapabilityRiskLevel => {
  switch (action.type) {
    case 'browser.inspect':
    case 'desktop.discover':
    case 'desktop.inspect':
      return 'L0';
    case 'browser.navigate':
    case 'browser.click':
    case 'browser.type':
    case 'browser.download':
      return 'L2';
    case 'desktop.click':
    case 'desktop.type':
    case 'desktop.shortcut':
      return 'L2';
    case 'connector.read':
    case 'connector.draft':
      return 'L2';
    case 'connector.send':
    case 'connector.delete':
      return 'L3';
  }
};

const deny = (
  riskLevel: CapabilityRiskLevel,
  reasonCode: CapabilityPolicyReasonCode,
  reason: string,
): CapabilityPolicyDecision => ({ kind: 'deny', reasonCode, reason, riskLevel });

export const decideActionPolicy = (
  intent: ActionIntent,
  registry: WorkerRegistry,
): CapabilityPolicyDecision => {
  const rawIntent: unknown = intent;
  const suppliedRisk = ['L0', 'L1', 'L2', 'L3', 'L4'].includes(String(intent?.riskLevel))
    ? intent.riskLevel
    : 'L4';
  const rawAuthority = (intent as unknown as { authority?: { kind?: unknown } })?.authority;
  if (!rawAuthority || !['user_request', 'kernel_policy', 'approval'].includes(String(rawAuthority.kind))) {
    return deny(suppliedRisk, 'untrusted_authority', 'Untrusted observations cannot grant action authority.');
  }
  if (!isActionIntent(rawIntent)) return deny(suppliedRisk, 'invalid_intent', 'Action intent validation failed.');
  const validIntent = rawIntent;
  if (validIntent.riskLevel === 'L4') return deny('L4', 'forbidden_risk', 'L4 actions are forbidden by policy.');
  const minimumRisk = minimumRiskForAction(validIntent.action);
  if (riskRank[validIntent.riskLevel] < riskRank[minimumRisk]) {
    return deny(validIntent.riskLevel, 'risk_understated', `Action requires at least ${minimumRisk}.`);
  }
  const worker = registry.get(validIntent.workerId);
  if (!worker) return deny(validIntent.riskLevel, 'worker_unknown', 'Requested worker is not registered.');
  if (worker.availability !== 'available') {
    return deny(validIntent.riskLevel, 'worker_unavailable', 'Requested worker is not currently available.');
  }
  if (worker.family !== familyForAction(validIntent.action) || !worker.supportedActions.includes(validIntent.action.type)) {
    return deny(validIntent.riskLevel, 'worker_action_unsupported', 'Worker does not support this action.');
  }
  if (!isActionWithinScope(validIntent.action, validIntent.scope)) {
    return deny(validIntent.riskLevel, 'scope_mismatch', 'Action is outside the intent scope.');
  }
  if (!worker.configuredScopes.some((configured) => isScopeWithinScope(validIntent.scope, configured))) {
    return deny(validIntent.riskLevel, 'scope_not_configured', 'Intent scope is outside the worker configuration.');
  }
  if (validIntent.riskLevel === 'L2' || validIntent.riskLevel === 'L3') {
    if (validIntent.authority.kind === 'approval') {
      return {
        kind: 'allow',
        reasonCode: 'allowed',
        reason: `${validIntent.riskLevel} action is bound to an explicit approval.`,
        riskLevel: validIntent.riskLevel,
      };
    }
    return {
      kind: 'approval_required',
      reasonCode: 'approval_required',
      reason: `${validIntent.riskLevel} actions require an explicit approval grant.`,
      riskLevel: validIntent.riskLevel,
    };
  }
  return { kind: 'allow', reasonCode: 'allowed', reason: 'Action is allowed inside the configured scope.', riskLevel: validIntent.riskLevel };
};

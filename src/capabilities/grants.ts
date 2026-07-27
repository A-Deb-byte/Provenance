import {
  ActionIntent,
  CapabilityGrant,
  CapabilityScope,
  WorkerRegistration,
} from './types';
import { stableSha256 } from './hash';
import {
  familyForAction,
  isActionIntent,
  isActionWithinScope,
  isCapabilityGrant,
  isScopeWithinScope,
  isWorkerRegistration,
} from './validators';

export interface CreateCapabilityGrantInput {
  id: string;
  issuedAt: string;
  expiresAt: string;
  maxOps: number;
  approvalId?: string;
}

export type GrantFailureReason =
  | 'grant_invalid'
  | 'grant_revoked'
  | 'grant_consumed'
  | 'grant_not_yet_valid'
  | 'grant_expired'
  | 'intent_mismatch'
  | 'approval_mismatch'
  | 'worker_mismatch'
  | 'worker_unavailable'
  | 'scope_mismatch'
  | 'operation_budget_exceeded';

export interface GrantValidationResult {
  allowed: boolean;
  reasonCode?: GrantFailureReason;
  reason: string;
}

export interface ConsumeGrantInput {
  now: string;
  operationsUsed: number;
}

export interface ConsumeGrantResult extends GrantValidationResult {
  grant: CapabilityGrant;
}

/**
 * Version of the observable grant-validation and consumption semantics.
 * Bump this whenever validation order, reason codes, status transitions, or
 * operation-budget behavior changes.
 */
export const CAPABILITY_GRANT_POLICY_VERSION = '2026-07-26.2';

const normalizeScope = (scope: CapabilityScope): CapabilityScope => {
  if (scope.family === 'browser') return {
    ...scope,
    operations: [...scope.operations].sort(),
    origins: [...new Set(scope.origins)].sort(),
    downloadRoots: [...new Set(scope.downloadRoots)].sort(),
  };
  if (scope.family === 'desktop') return { ...scope, operations: [...scope.operations].sort() };
  return {
    ...scope,
    operations: [...scope.operations].sort(),
    resourceRoots: [...new Set(scope.resourceRoots)].sort(),
  };
};

const normalizedIntent = (intent: ActionIntent) => ({
  ...intent,
  scope: normalizeScope(intent.scope),
  untrustedObservationIds: [...new Set(intent.untrustedObservationIds)].sort(),
});

export const hashActionIntent = (intent: ActionIntent): string => stableSha256(normalizedIntent(intent));

export const createCapabilityGrant = (
  intent: ActionIntent,
  input: CreateCapabilityGrantInput,
): CapabilityGrant => {
  if (!isActionIntent(intent)) throw new Error('Cannot issue a grant for an invalid action intent.');
  if (intent.riskLevel === 'L4') throw new Error('Cannot issue a grant for a forbidden L4 action.');
  if (intent.riskLevel === 'L2' || intent.riskLevel === 'L3') {
    if (!input.approvalId?.trim()) {
      throw new Error(`${intent.riskLevel} grants require an approval id.`);
    }
    if (
      intent.authority.kind !== 'approval' ||
      intent.authority.referenceId !== input.approvalId
    ) {
      throw new Error(`${intent.riskLevel} grants require intent authority bound to the exact approval id.`);
    }
  }
  const issuedAt = Date.parse(input.issuedAt);
  const expiresAt = Date.parse(input.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) {
    throw new Error('Capability grant expiry must be after issuance.');
  }
  if (expiresAt - issuedAt > 24 * 60 * 60 * 1000) throw new Error('Capability grants cannot exceed 24 hours.');
  if (!Number.isInteger(input.maxOps) || input.maxOps < 1 || input.maxOps > 1000) {
    throw new Error('Capability grant maxOps must be between 1 and 1000.');
  }
  if (!input.id.trim()) throw new Error('Capability grant id is required.');
  return {
    schemaVersion: 1,
    id: input.id,
    intentId: intent.id,
    intentHash: hashActionIntent(intent),
    workerId: intent.workerId,
    scope: normalizeScope(intent.scope),
    riskLevel: intent.riskLevel,
    status: 'active',
    issuedBy: 'kernel',
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    maxOps: input.maxOps,
    usedOps: 0,
    approvalId: input.approvalId,
  };
};

const rejected = (reasonCode: GrantFailureReason, reason: string): GrantValidationResult => ({
  allowed: false, reasonCode, reason,
});

export const validateCapabilityGrant = (
  grant: CapabilityGrant,
  intent: ActionIntent,
  worker: WorkerRegistration,
  now: string,
): GrantValidationResult => {
  if (!isCapabilityGrant(grant as unknown)) return rejected('grant_invalid', 'Persisted capability grant is invalid.');
  if (!isActionIntent(intent as unknown)) return rejected('intent_mismatch', 'Action intent is invalid.');
  if (grant.status === 'revoked') return rejected('grant_revoked', 'Capability grant was revoked.');
  if (grant.status === 'consumed') return rejected('grant_consumed', 'Capability grant has already been consumed.');
  const validatedAt = Date.parse(now);
  if (!Number.isFinite(validatedAt)) {
    return rejected('grant_expired', 'Capability grant is expired.');
  }
  if (validatedAt < Date.parse(grant.issuedAt)) {
    return rejected('grant_not_yet_valid', 'Capability grant is not yet valid.');
  }
  if (validatedAt >= Date.parse(grant.expiresAt)) {
    return rejected('grant_expired', 'Capability grant is expired.');
  }
  if (
    grant.intentId !== intent.id ||
    grant.intentHash !== hashActionIntent(intent) ||
    grant.riskLevel !== intent.riskLevel
  ) {
    return rejected('intent_mismatch', 'Capability grant does not match the action intent.');
  }
  if (
    (grant.riskLevel === 'L2' || grant.riskLevel === 'L3') &&
    (
      intent.authority.kind !== 'approval' ||
      grant.approvalId !== intent.authority.referenceId
    )
  ) {
    return rejected(
      'approval_mismatch',
      'Capability grant does not match the intent approval authority.',
    );
  }
  if (grant.workerId !== intent.workerId || worker.id !== grant.workerId) {
    return rejected('worker_mismatch', 'Capability grant does not match the worker.');
  }
  if (!isWorkerRegistration(worker as unknown) || worker.availability !== 'available') {
    return rejected('worker_unavailable', 'Worker is not currently available.');
  }
  if (worker.family !== familyForAction(intent.action) || !worker.supportedActions.includes(intent.action.type)) {
    return rejected('worker_mismatch', 'Worker does not support the granted action.');
  }
  if (!isActionWithinScope(intent.action, grant.scope) || !isScopeWithinScope(intent.scope, grant.scope)) {
    return rejected('scope_mismatch', 'Capability grant scope does not cover the action intent.');
  }
  if (!worker.configuredScopes.some((configured) => isScopeWithinScope(grant.scope, configured))) {
    return rejected('scope_mismatch', 'Worker configuration no longer covers the capability grant scope.');
  }
  return { allowed: true, reason: 'Capability grant is valid for one dispatch.' };
};

export const consumeCapabilityGrant = (
  grant: CapabilityGrant,
  intent: ActionIntent,
  worker: WorkerRegistration,
  input: ConsumeGrantInput,
): ConsumeGrantResult => {
  const validation = validateCapabilityGrant(grant, intent, worker, input.now);
  if (!validation.allowed) return { ...validation, grant: { ...grant } };
  if (!Number.isInteger(input.operationsUsed) || input.operationsUsed < 1 || input.operationsUsed > grant.maxOps) {
    return {
      allowed: false,
      reasonCode: 'operation_budget_exceeded',
      reason: 'Reported operation use exceeds the capability grant budget.',
      grant: { ...grant },
    };
  }
  return {
    allowed: true,
    reason: 'Capability grant consumed.',
    grant: {
      ...grant,
      status: 'consumed',
      usedOps: input.operationsUsed,
      consumedAt: input.now,
    },
  };
};

export const revokeCapabilityGrant = (
  grant: CapabilityGrant,
  reason: string,
  revokedAt: string,
): CapabilityGrant => {
  if (grant.status !== 'active') throw new Error('Only an active capability grant can be revoked.');
  if (!reason.trim()) throw new Error('Capability revocation reason is required.');
  if (!Number.isFinite(Date.parse(revokedAt))) throw new Error('Capability revocation timestamp is invalid.');
  return { ...grant, status: 'revoked', revokedAt, revocationReason: reason.trim() };
};

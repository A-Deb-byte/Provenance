import {
  consumeCapabilityGrant,
  hashActionIntent,
  revokeCapabilityGrant,
  type GrantFailureReason,
} from './grants';
import type { CapabilityGrantStore } from './grantStore';
import type { ActionIntent, CapabilityGrant, WorkerRegistration } from './types';

export type DispatchFailureReason = GrantFailureReason
  | 'grant_not_found'
  | 'grant_persistence_conflict'
  | 'authorization_invalid'
  | 'authorization_reused';

export interface CapabilityDispatchAuthorization {
  readonly grantId: string;
  readonly intentId: string;
  readonly intentHash: string;
  readonly workerId: string;
  readonly operationsAuthorized: number;
  readonly authorizedAt: string;
}

export interface DispatchAuthorizationResult {
  allowed: boolean;
  reason: string;
  reasonCode?: DispatchFailureReason;
  grant?: CapabilityGrant;
  authorization?: CapabilityDispatchAuthorization;
}

const liveAuthorizations = new WeakSet<object>();
const claimedAuthorizations = new WeakSet<object>();

const mintAuthorization = (
  grant: CapabilityGrant,
  intent: ActionIntent,
  operationsAuthorized: number,
  now: string,
): CapabilityDispatchAuthorization => {
  const authorization = Object.freeze({
    grantId: grant.id,
    intentId: intent.id,
    intentHash: hashActionIntent(intent),
    workerId: intent.workerId,
    operationsAuthorized,
    authorizedAt: now,
  });
  liveAuthorizations.add(authorization);
  return authorization;
};

/**
 * Atomically consumes the persisted grant before returning an opaque, one-use
 * dispatch authorization. A persistence conflict produces no authorization.
 */
export const authorizeCapabilityDispatch = async (
  store: CapabilityGrantStore,
  grantId: string,
  intent: ActionIntent,
  worker: WorkerRegistration,
  input: { now: string; operationsUsed: number },
): Promise<DispatchAuthorizationResult> => {
  const grant = await store.get(grantId);
  if (!grant) return { allowed: false, reasonCode: 'grant_not_found', reason: 'Capability grant was not found.' };

  const consumed = consumeCapabilityGrant(grant, intent, worker, input);
  if (!consumed.allowed) {
    return { allowed: false, reasonCode: consumed.reasonCode, reason: consumed.reason, grant: consumed.grant };
  }

  const persisted = await store.transitionActive(grant.id, grant.intentHash, consumed.grant);
  if (!persisted) {
    return {
      allowed: false,
      reasonCode: 'grant_persistence_conflict',
      reason: 'Capability grant changed before dispatch authorization could be persisted.',
    };
  }

  return {
    allowed: true,
    reason: 'Capability grant was consumed and persisted before dispatch.',
    grant: consumed.grant,
    authorization: mintAuthorization(consumed.grant, intent, input.operationsUsed, input.now),
  };
};

/** Claims the opaque authorization exactly once, immediately before I/O. */
export const claimCapabilityDispatchAuthorization = (
  authorization: CapabilityDispatchAuthorization | undefined,
  intent: ActionIntent,
  workerId: string,
): { allowed: boolean; reasonCode?: DispatchFailureReason; reason: string } => {
  if (!authorization || !liveAuthorizations.has(authorization)) {
    return { allowed: false, reasonCode: 'authorization_invalid', reason: 'A persisted pre-dispatch authorization is required.' };
  }
  if (claimedAuthorizations.has(authorization)) {
    return { allowed: false, reasonCode: 'authorization_reused', reason: 'Dispatch authorization has already been claimed.' };
  }
  if (
    authorization.intentId !== intent.id ||
    authorization.intentHash !== hashActionIntent(intent) ||
    authorization.workerId !== workerId
  ) {
    return { allowed: false, reasonCode: 'authorization_invalid', reason: 'Dispatch authorization does not match this intent and worker.' };
  }
  claimedAuthorizations.add(authorization);
  return { allowed: true, reason: 'Dispatch authorization claimed.' };
};

export const revokePersistedCapabilityGrant = async (
  store: CapabilityGrantStore,
  grantId: string,
  reason: string,
  revokedAt: string,
): Promise<CapabilityGrant | undefined> => {
  const grant = await store.get(grantId);
  if (!grant) return undefined;
  const revoked = revokeCapabilityGrant(grant, reason, revokedAt);
  const persisted = await store.transitionActive(grant.id, grant.intentHash, revoked);
  if (!persisted) throw new Error('Capability grant changed before revocation could be persisted.');
  return revoked;
};

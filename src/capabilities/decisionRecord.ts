import path from 'node:path';
import {
  CAPABILITY_GRANT_POLICY_VERSION,
  hashActionIntent,
  type GrantFailureReason,
} from './grants';
import { stableSha256, sha256Text } from './hash';
import { CAPABILITY_POLICY_VERSION, type CapabilityPolicyDecision } from './policy';
import type {
  ActionIntent,
  CapabilityAction,
  CapabilityActionType,
  CapabilityGrant,
  CapabilityRiskLevel,
  CapabilityScope,
  WorkerRegistration,
} from './types';

/**
 * Schema 2 is deliberately a semantic commitment rather than a copy of the
 * live authority objects. A ledger is durable and routinely exported for
 * support/audit; raw URLs, connector resources, selectors, and local paths do
 * not belong in it.
 *
 * The commitments preserve every equality, containment, prefix, basename, and
 * presence relation consulted by policy/grant validation. This lets the
 * standalone replayer derive the decision while keeping the underlying
 * resource private.
 */
export const CAPABILITY_DECISION_RECORD_SCHEMA_VERSION = 2;

export type PathSemantics = 'win32' | 'posix';

export interface ReplayPathContract {
  semantics: PathSemantics;
  cwdHash: string;
}

export interface ReplayPathCommitment {
  semantics: PathSemantics;
  valueHash: string;
  resolvedHash: string;
  basenameHash: string;
}

export interface ReplayResourceCommitment {
  valueHash: string;
  ancestorHashes: string[];
}

export interface ReplayUrlCommitment {
  valueHash: string;
  originHash: string;
  hasCredentials: boolean;
}

export interface ReplayActionEvidence {
  type: CapabilityActionType;
  originHash?: string;
  url?: ReplayUrlCommitment;
  selectorHash?: string;
  payloadArtifactIdHash?: string;
  payloadHash?: string;
  downloadRoot?: ReplayPathCommitment;
  fileName?: ReplayPathCommitment;
  appIdHash?: string;
  windowIdHash?: string;
  treeRevisionHash?: string;
  nodeIdHash?: string;
  keyHashes?: string[];
  connectorIdHash?: string;
  resource?: ReplayResourceCommitment;
}

export interface ReplayScopeEvidence {
  family: 'browser' | 'desktop' | 'connector';
  operations: CapabilityActionType[];
  originHashes?: string[];
  downloadRoots?: ReplayPathCommitment[];
  appIdHash?: string;
  windowIdHash?: string;
  treeRevisionHash?: string;
  connectorIdHash?: string;
  resourceRoots?: ReplayResourceCommitment[];
}

export interface ReplayIntentEvidence {
  schemaVersion: 1;
  id: string;
  goalId: string;
  taskId: string;
  workerId: string;
  riskLevel: CapabilityRiskLevel;
  action: ReplayActionEvidence;
  scope: ReplayScopeEvidence;
  authority: {
    kind: 'user_request' | 'kernel_policy' | 'approval';
    referenceId: string;
  };
  untrustedObservationIdHashes: string[];
  createdAt: string;
  sourceIntentHash: string;
}

export interface ReplayWorkerEvidence {
  id: string;
  family: 'browser' | 'desktop' | 'connector';
  availability: 'available' | 'configured' | 'unavailable';
  supportedActions: CapabilityActionType[];
  configuredScopes: ReplayScopeEvidence[];
  registeredAt: string;
  lastSeenAt?: string;
  unavailableReasonHash?: string;
}

export interface ReplayGrantEvidence {
  schemaVersion: 1;
  id: string;
  intentId: string;
  intentHash: string;
  workerId: string;
  scope: ReplayScopeEvidence;
  riskLevel: CapabilityRiskLevel;
  status: 'active' | 'revoked' | 'consumed';
  issuedBy: 'kernel';
  issuedAt: string;
  expiresAt: string;
  maxOps: number;
  usedOps: number;
  approvalId?: string;
  consumedAt?: string;
  revokedAt?: string;
  revocationReasonHash?: string;
}

export interface DispatchDecisionSourceInputs {
  /** Grant state before consumption. */
  grant: CapabilityGrant;
  intent: ActionIntent;
  worker: WorkerRegistration;
  now: string;
  operationsUsed: number;
}

export interface DispatchDecisionInputs {
  pathContract: ReplayPathContract;
  grant: ReplayGrantEvidence;
  intent: ReplayIntentEvidence;
  worker: ReplayWorkerEvidence;
  now: string;
  operationsUsed: number;
  authorityBindingHash: string;
}

export interface DispatchDecisionOutcome {
  allowed: boolean;
  reasonCode: 'allowed' | GrantFailureReason;
  reason: string;
  riskLevel: CapabilityRiskLevel;
  grantStatus: CapabilityGrant['status'];
  usedOps: number;
  consumedAt: string | null;
}

export interface DispatchDecisionRecord {
  schemaVersion: typeof CAPABILITY_DECISION_RECORD_SCHEMA_VERSION;
  policyVersion: string;
  grantPolicyVersion: string;
  decisionKind: 'dispatch';
  inputs: DispatchDecisionInputs;
  outcome: DispatchDecisionOutcome;
  inputsHash: string;
}

export interface PolicyDecisionSourceInputs {
  intent: ActionIntent;
  worker?: WorkerRegistration;
  now: string;
}

export interface PolicyDecisionInputs {
  pathContract: ReplayPathContract;
  intent: ReplayIntentEvidence;
  worker?: ReplayWorkerEvidence;
  now: string;
  authorityBindingHash: string;
}

export interface PolicyDecisionRecord {
  schemaVersion: typeof CAPABILITY_DECISION_RECORD_SCHEMA_VERSION;
  policyVersion: string;
  decisionKind: 'policy';
  inputs: PolicyDecisionInputs;
  outcome: {
    kind: CapabilityPolicyDecision['kind'];
    reasonCode: CapabilityPolicyDecision['reasonCode'];
    reason: string;
    riskLevel: CapabilityPolicyDecision['riskLevel'];
  };
  inputsHash: string;
}

export type CapabilityDecisionRecord = DispatchDecisionRecord | PolicyDecisionRecord;

const semanticsForHost = (): PathSemantics => process.platform === 'win32' ? 'win32' : 'posix';

const pathApi = (semantics: PathSemantics): typeof path.win32 => (
  semantics === 'win32' ? path.win32 : path.posix
);

const currentPathContract = (): ReplayPathContract => {
  const semantics = semanticsForHost();
  return {
    semantics,
    cwdHash: sha256Text(pathApi(semantics).resolve('.')),
  };
};

const commitPath = (value: string, contract: ReplayPathContract): ReplayPathCommitment => {
  const api = pathApi(contract.semantics);
  return {
    semantics: contract.semantics,
    valueHash: sha256Text(value),
    resolvedHash: sha256Text(api.resolve(value)),
    basenameHash: sha256Text(api.basename(value)),
  };
};

const commitResource = (value: string): ReplayResourceCommitment => {
  const ancestorHashes: string[] = [];
  // String#slice consumes UTF-16 code-unit offsets. Iterate in the same index
  // space so non-BMP resource names cannot shift slash boundaries.
  for (let index = 1; index < value.length; index += 1) {
    if (value[index] === '/') ancestorHashes.push(sha256Text(value.slice(0, index)));
  }
  return { valueHash: sha256Text(value), ancestorHashes };
};

const commitUrl = (value: string): ReplayUrlCommitment => {
  const parsed = new URL(value);
  return {
    // Preserve exact action/approval binding without recording any URL
    // component in plaintext.
    valueHash: sha256Text(`url\u0000${value}`),
    originHash: sha256Text(parsed.origin),
    hasCredentials: Boolean(parsed.username || parsed.password),
  };
};

const commitAction = (
  action: CapabilityAction,
  contract: ReplayPathContract,
): ReplayActionEvidence => {
  switch (action.type) {
    case 'browser.inspect':
      return {
        type: action.type,
        originHash: sha256Text(action.origin),
        url: commitUrl(action.url),
        selectorHash: action.selector === undefined ? undefined : sha256Text(action.selector),
      };
    case 'browser.navigate':
      return { type: action.type, originHash: sha256Text(action.origin), url: commitUrl(action.url) };
    case 'browser.click':
      return {
        type: action.type,
        originHash: sha256Text(action.origin),
        url: commitUrl(action.url),
        selectorHash: sha256Text(action.selector),
      };
    case 'browser.type':
      return {
        type: action.type,
        originHash: sha256Text(action.origin),
        url: commitUrl(action.url),
        selectorHash: sha256Text(action.selector),
        payloadArtifactIdHash: sha256Text(action.payloadArtifactId),
        payloadHash: action.payloadHash,
      };
    case 'browser.download':
      return {
        type: action.type,
        originHash: sha256Text(action.origin),
        url: commitUrl(action.url),
        downloadRoot: commitPath(action.downloadRoot, contract),
        fileName: commitPath(action.fileName, contract),
      };
    case 'desktop.discover':
      return { type: action.type, appIdHash: sha256Text(action.appId) };
    case 'desktop.inspect':
      return {
        type: action.type,
        appIdHash: sha256Text(action.appId),
        windowIdHash: sha256Text(action.windowId),
        treeRevisionHash: sha256Text(action.treeRevision),
      };
    case 'desktop.click':
      return {
        type: action.type,
        appIdHash: sha256Text(action.appId),
        windowIdHash: sha256Text(action.windowId),
        treeRevisionHash: sha256Text(action.treeRevision),
        nodeIdHash: sha256Text(action.nodeId),
      };
    case 'desktop.type':
      return {
        type: action.type,
        appIdHash: sha256Text(action.appId),
        windowIdHash: sha256Text(action.windowId),
        treeRevisionHash: sha256Text(action.treeRevision),
        nodeIdHash: sha256Text(action.nodeId),
        payloadArtifactIdHash: sha256Text(action.payloadArtifactId),
        payloadHash: action.payloadHash,
      };
    case 'desktop.shortcut':
      return {
        type: action.type,
        appIdHash: sha256Text(action.appId),
        windowIdHash: sha256Text(action.windowId),
        treeRevisionHash: sha256Text(action.treeRevision),
        keyHashes: action.keys.map(sha256Text),
      };
    case 'connector.read':
    case 'connector.delete':
      return {
        type: action.type,
        connectorIdHash: sha256Text(action.connectorId),
        resource: commitResource(action.resourceId),
      };
    case 'connector.draft':
      return {
        type: action.type,
        connectorIdHash: sha256Text(action.connectorId),
        resource: commitResource(action.resourceId),
        payloadArtifactIdHash: sha256Text(action.payloadArtifactId),
        payloadHash: action.payloadHash,
      };
    case 'connector.send':
      return {
        type: action.type,
        connectorIdHash: sha256Text(action.connectorId),
        resource: commitResource(action.resourceId),
        payloadArtifactIdHash: action.payloadArtifactId === undefined
          ? undefined
          : sha256Text(action.payloadArtifactId),
        payloadHash: action.payloadHash,
      };
  }
};

const commitScope = (
  scope: CapabilityScope,
  contract: ReplayPathContract,
): ReplayScopeEvidence => {
  if (scope.family === 'browser') {
    return {
      family: scope.family,
      operations: [...scope.operations],
      originHashes: scope.origins.map(sha256Text),
      downloadRoots: scope.downloadRoots.map((root) => commitPath(root, contract)),
    };
  }
  if (scope.family === 'desktop') {
    return {
      family: scope.family,
      operations: [...scope.operations],
      appIdHash: sha256Text(scope.appId),
      windowIdHash: scope.windowId === undefined ? undefined : sha256Text(scope.windowId),
      treeRevisionHash: scope.treeRevision === undefined ? undefined : sha256Text(scope.treeRevision),
    };
  }
  return {
    family: scope.family,
    operations: [...scope.operations],
    connectorIdHash: sha256Text(scope.connectorId),
    resourceRoots: scope.resourceRoots.map(commitResource),
  };
};

const commitIntent = (
  intent: ActionIntent,
  contract: ReplayPathContract,
): ReplayIntentEvidence => ({
  schemaVersion: intent.schemaVersion,
  id: intent.id,
  goalId: intent.goalId,
  taskId: intent.taskId,
  workerId: intent.workerId,
  riskLevel: intent.riskLevel,
  action: commitAction(intent.action, contract),
  scope: commitScope(intent.scope, contract),
  authority: { ...intent.authority },
  untrustedObservationIdHashes: intent.untrustedObservationIds.map(sha256Text),
  createdAt: intent.createdAt,
  sourceIntentHash: hashActionIntent(intent),
});

const commitWorker = (
  worker: WorkerRegistration,
  contract: ReplayPathContract,
): ReplayWorkerEvidence => ({
  id: worker.id,
  family: worker.family,
  availability: worker.availability,
  supportedActions: [...worker.supportedActions],
  configuredScopes: worker.configuredScopes.map((scope) => commitScope(scope, contract)),
  registeredAt: worker.registeredAt,
  lastSeenAt: worker.lastSeenAt,
  unavailableReasonHash: worker.unavailableReason === undefined
    ? undefined
    : sha256Text(worker.unavailableReason),
});

const commitGrant = (
  grant: CapabilityGrant,
  contract: ReplayPathContract,
): ReplayGrantEvidence => ({
  schemaVersion: grant.schemaVersion,
  id: grant.id,
  intentId: grant.intentId,
  intentHash: grant.intentHash,
  workerId: grant.workerId,
  scope: commitScope(grant.scope, contract),
  riskLevel: grant.riskLevel,
  status: grant.status,
  issuedBy: grant.issuedBy,
  issuedAt: grant.issuedAt,
  expiresAt: grant.expiresAt,
  maxOps: grant.maxOps,
  usedOps: grant.usedOps,
  approvalId: grant.approvalId,
  consumedAt: grant.consumedAt,
  revokedAt: grant.revokedAt,
  revocationReasonHash: grant.revocationReason === undefined
    ? undefined
    : sha256Text(grant.revocationReason),
});

export const hashReplayIntentAuthorityBinding = (
  intent: ReplayIntentEvidence,
): string => stableSha256({
  goalId: intent.goalId,
  taskId: intent.taskId,
  workerId: intent.workerId,
  riskLevel: intent.riskLevel,
  action: intent.action,
  scope: intent.scope,
});

export const hashIntentAuthorityBinding = (intent: ActionIntent): string => {
  const contract = currentPathContract();
  return hashReplayIntentAuthorityBinding(commitIntent(intent, contract));
};

export const hashDecisionInputs = (inputs: DispatchDecisionInputs | PolicyDecisionInputs): string =>
  stableSha256(inputs);

export const buildDispatchDecisionRecord = (
  source: DispatchDecisionSourceInputs,
  outcome: DispatchDecisionOutcome,
): DispatchDecisionRecord => {
  const pathContract = currentPathContract();
  const intent = commitIntent(source.intent, pathContract);
  const inputs: DispatchDecisionInputs = {
    pathContract,
    grant: commitGrant(source.grant, pathContract),
    intent,
    worker: commitWorker(source.worker, pathContract),
    now: source.now,
    operationsUsed: source.operationsUsed,
    authorityBindingHash: hashReplayIntentAuthorityBinding(intent),
  };
  return {
    schemaVersion: CAPABILITY_DECISION_RECORD_SCHEMA_VERSION,
    policyVersion: CAPABILITY_POLICY_VERSION,
    grantPolicyVersion: CAPABILITY_GRANT_POLICY_VERSION,
    decisionKind: 'dispatch',
    inputs,
    outcome: { ...outcome },
    inputsHash: hashDecisionInputs(inputs),
  };
};

export const buildPolicyDecisionRecord = (
  source: PolicyDecisionSourceInputs,
  decision: CapabilityPolicyDecision,
): PolicyDecisionRecord => {
  const pathContract = currentPathContract();
  const intent = commitIntent(source.intent, pathContract);
  const inputs: PolicyDecisionInputs = {
    pathContract,
    intent,
    worker: source.worker === undefined ? undefined : commitWorker(source.worker, pathContract),
    now: source.now,
    authorityBindingHash: hashReplayIntentAuthorityBinding(intent),
  };
  return {
    schemaVersion: CAPABILITY_DECISION_RECORD_SCHEMA_VERSION,
    policyVersion: CAPABILITY_POLICY_VERSION,
    decisionKind: 'policy',
    inputs,
    outcome: {
      kind: decision.kind,
      reasonCode: decision.reasonCode,
      reason: decision.reason,
      riskLevel: decision.riskLevel,
    },
    inputsHash: hashDecisionInputs(inputs),
  };
};

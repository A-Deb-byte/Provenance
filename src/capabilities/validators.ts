import path from 'node:path';
import {
  ActionIntent,
  ActionResult,
  BrowserAction,
  BrowserCapabilityScope,
  CapabilityGrant,
  CapabilityAction,
  CapabilityActionType,
  CapabilityScope,
  ConnectorAction,
  ConnectorCapabilityScope,
  DesktopAction,
  DesktopCapabilityScope,
  TrustedAuthority,
  UntrustedObservation,
  WorkerFamily,
  WorkerRegistration,
} from './types';

const riskLevels = new Set(['L0', 'L1', 'L2', 'L3', 'L4']);
const authorityKinds = new Set(['user_request', 'kernel_policy', 'approval']);
const observationSources = new Set(['web', 'document', 'screen', 'tool_output']);
const availabilities = new Set(['available', 'configured', 'unavailable']);
const browserOperations = new Set<CapabilityActionType>([
  'browser.inspect', 'browser.navigate', 'browser.click', 'browser.type', 'browser.download',
]);
const desktopOperations = new Set<CapabilityActionType>([
  'desktop.discover', 'desktop.inspect', 'desktop.click', 'desktop.type', 'desktop.shortcut',
]);
const connectorOperations = new Set<CapabilityActionType>([
  'connector.read', 'connector.draft', 'connector.send', 'connector.delete',
]);

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);
const isText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const isTextArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(isText);
const isSha256 = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const isIsoDate = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

export const familyForAction = (action: CapabilityAction): WorkerFamily => {
  if (action.type.startsWith('browser.')) return 'browser';
  if (action.type.startsWith('desktop.')) return 'desktop';
  return 'connector';
};

const isCanonicalOrigin = (origin: string): boolean => {
  try {
    const parsed = new URL(origin);
    return !parsed.username && !parsed.password && parsed.origin === origin;
  } catch {
    return false;
  }
};

const isBrowserAction = (value: Record<string, unknown>): value is BrowserAction => {
  if (!isText(value.type) || !browserOperations.has(value.type as CapabilityActionType)) return false;
  if (!isText(value.origin) || !isText(value.url)) return false;
  try {
    const parsed = new URL(value.url);
    if (parsed.origin !== value.origin || parsed.username || parsed.password || !isCanonicalOrigin(value.origin)) return false;
  } catch {
    return false;
  }
  if (value.type === 'browser.click') return isText(value.selector);
  if (value.type === 'browser.type') {
    return isText(value.selector) && isText(value.payloadArtifactId) && isSha256(value.payloadHash);
  }
  if (value.type === 'browser.download') {
    return isText(value.downloadRoot) && isText(value.fileName);
  }
  return value.selector === undefined || typeof value.selector === 'string';
};

const isDesktopAction = (value: Record<string, unknown>): value is DesktopAction => {
  if (!isText(value.type) || !desktopOperations.has(value.type as CapabilityActionType)) return false;
  if (!isText(value.appId)) return false;
  if (value.type === 'desktop.discover') return true;
  if (!isText(value.windowId) || !isText(value.treeRevision)) return false;
  if (value.type === 'desktop.click') return isText(value.nodeId);
  if (value.type === 'desktop.type') {
    return isText(value.nodeId) && isText(value.payloadArtifactId) && isSha256(value.payloadHash);
  }
  if (value.type === 'desktop.shortcut') return isTextArray(value.keys) && value.keys.length <= 8;
  return true;
};

const isConnectorAction = (value: Record<string, unknown>): value is ConnectorAction => {
  if (!isText(value.type) || !connectorOperations.has(value.type as CapabilityActionType)) return false;
  if (!isText(value.connectorId) || !isText(value.resourceId)) return false;
  if (value.type === 'connector.draft') {
    return isText(value.payloadArtifactId) && isSha256(value.payloadHash);
  }
  if (value.type === 'connector.send') {
    return isSha256(value.payloadHash) && (value.payloadArtifactId === undefined || isText(value.payloadArtifactId));
  }
  return true;
};

export const isCapabilityAction = (value: unknown): value is CapabilityAction => {
  if (!isRecord(value) || !isText(value.type)) return false;
  if (value.type.startsWith('browser.')) return isBrowserAction(value);
  if (value.type.startsWith('desktop.')) return isDesktopAction(value);
  if (value.type.startsWith('connector.')) return isConnectorAction(value);
  return false;
};

const operationsMatchFamily = (operations: unknown, family: WorkerFamily): operations is CapabilityActionType[] => {
  if (!Array.isArray(operations) || operations.length === 0) return false;
  const allowed = family === 'browser' ? browserOperations : family === 'desktop' ? desktopOperations : connectorOperations;
  return operations.every((item) => typeof item === 'string' && allowed.has(item as CapabilityActionType));
};

export const isCapabilityScope = (value: unknown): value is CapabilityScope => {
  if (!isRecord(value) || !isText(value.family)) return false;
  if (value.family === 'browser') {
    return operationsMatchFamily(value.operations, 'browser') &&
      isTextArray(value.origins) && value.origins.every(isCanonicalOrigin) &&
      Array.isArray(value.downloadRoots) && value.downloadRoots.every(isText);
  }
  if (value.family === 'desktop') {
    const hasWindow = value.windowId !== undefined;
    const hasRevision = value.treeRevision !== undefined;
    return operationsMatchFamily(value.operations, 'desktop') &&
      isText(value.appId) && hasWindow === hasRevision &&
      (!hasWindow || (isText(value.windowId) && isText(value.treeRevision)));
  }
  if (value.family === 'connector') {
    return operationsMatchFamily(value.operations, 'connector') &&
      isText(value.connectorId) && isTextArray(value.resourceRoots);
  }
  return false;
};

const resourceWithinRoot = (resource: string, root: string): boolean => (
  resource === root || resource.startsWith(`${root}/`)
);

export const isActionWithinScope = (action: CapabilityAction, scope: CapabilityScope): boolean => {
  if (!isCapabilityAction(action) || !isCapabilityScope(scope)) return false;
  if (familyForAction(action) !== scope.family || !scope.operations.includes(action.type as never)) return false;
  if (scope.family === 'browser' && action.type.startsWith('browser.')) {
    const browserAction = action as BrowserAction;
    if (!scope.origins.includes(browserAction.origin)) return false;
    if (browserAction.type !== 'browser.download') return true;
    const exactRoot = scope.downloadRoots.some((root) => path.resolve(root) === path.resolve(browserAction.downloadRoot));
    return exactRoot && path.basename(browserAction.fileName) === browserAction.fileName;
  }
  if (scope.family === 'desktop' && action.type.startsWith('desktop.')) {
    const desktopAction = action as DesktopAction;
    if (desktopAction.appId !== scope.appId) return false;
    if (desktopAction.type === 'desktop.discover') {
      return scope.windowId === undefined && scope.treeRevision === undefined;
    }
    return desktopAction.windowId === scope.windowId && desktopAction.treeRevision === scope.treeRevision;
  }
  if (scope.family === 'connector' && action.type.startsWith('connector.')) {
    const connectorAction = action as ConnectorAction;
    return connectorAction.connectorId === scope.connectorId &&
      scope.resourceRoots.some((root) => resourceWithinRoot(connectorAction.resourceId, root));
  }
  return false;
};

const isStringSubset = (requested: string[], configured: string[]): boolean => (
  requested.every((item) => configured.includes(item))
);

export const isScopeWithinScope = (requested: CapabilityScope, configured: CapabilityScope): boolean => {
  if (!isCapabilityScope(requested) || !isCapabilityScope(configured) || requested.family !== configured.family) return false;
  if (!isStringSubset(requested.operations, configured.operations)) return false;
  if (requested.family === 'browser' && configured.family === 'browser') {
    return isStringSubset(requested.origins, configured.origins) &&
      requested.downloadRoots.every((root) => configured.downloadRoots.some((allowed) => path.resolve(root) === path.resolve(allowed)));
  }
  if (requested.family === 'desktop' && configured.family === 'desktop') {
    if (requested.appId !== configured.appId) return false;
    if (configured.windowId !== undefined && requested.windowId !== configured.windowId) return false;
    if (configured.treeRevision !== undefined && requested.treeRevision !== configured.treeRevision) return false;
    return true;
  }
  if (requested.family === 'connector' && configured.family === 'connector') {
    return requested.connectorId === configured.connectorId &&
      requested.resourceRoots.every((root) => configured.resourceRoots.some((allowed) => resourceWithinRoot(root, allowed)));
  }
  return false;
};

const isTrustedAuthority = (value: unknown): value is TrustedAuthority => (
  isRecord(value) && isText(value.kind) && authorityKinds.has(value.kind) && isText(value.referenceId)
);

export const isActionIntent = (value: unknown): value is ActionIntent => {
  if (!isRecord(value) || value.schemaVersion !== 1) return false;
  return isText(value.id) && isText(value.goalId) && isText(value.taskId) && isText(value.workerId) &&
    typeof value.riskLevel === 'string' && riskLevels.has(value.riskLevel) &&
    isCapabilityAction(value.action) && isCapabilityScope(value.scope) &&
    isActionWithinScope(value.action, value.scope) && isTrustedAuthority(value.authority) &&
    isTextArray(value.untrustedObservationIds) && isIsoDate(value.createdAt);
};

export const isUntrustedObservation = (value: unknown): value is UntrustedObservation => {
  if (!isRecord(value)) return false;
  return isText(value.id) && typeof value.source === 'string' && observationSources.has(value.source) &&
    isText(value.sourceRef) && isSha256(value.contentHash) && isIsoDate(value.capturedAt) &&
    value.canGrantAuthority === false && Array.isArray(value.injectionSignalCodes) &&
    value.injectionSignalCodes.every((item) => typeof item === 'string');
};

export const isActionResult = (value: unknown): value is ActionResult => {
  if (!isRecord(value) || value.schemaVersion !== 1) return false;
  return isText(value.intentId) && isText(value.grantId) && isText(value.workerId) &&
    (value.status === 'succeeded' || value.status === 'failed' || value.status === 'denied') &&
    Number.isInteger(value.operationsUsed) && (value.operationsUsed as number) >= 0 &&
    isIsoDate(value.startedAt) && isIsoDate(value.finishedAt) &&
    Array.isArray(value.evidenceHashes) && value.evidenceHashes.every(isSha256) &&
    Array.isArray(value.observationIds) && value.observationIds.every(isText) &&
    (value.errorCode === undefined || isText(value.errorCode));
};

export const isCapabilityGrant = (value: unknown): value is CapabilityGrant => {
  if (!isRecord(value) || value.schemaVersion !== 1) return false;
  if (!isText(value.id) || !isText(value.intentId) || !isSha256(value.intentHash) ||
    !isText(value.workerId) || !isCapabilityScope(value.scope) ||
    typeof value.riskLevel !== 'string' || !riskLevels.has(value.riskLevel) ||
    value.issuedBy !== 'kernel' || !isIsoDate(value.issuedAt) || !isIsoDate(value.expiresAt) ||
    Date.parse(value.expiresAt) <= Date.parse(value.issuedAt) ||
    !Number.isInteger(value.maxOps) || (value.maxOps as number) < 1 ||
    !Number.isInteger(value.usedOps) || (value.usedOps as number) < 0 || (value.usedOps as number) > (value.maxOps as number)) {
    return false;
  }
  if ((value.riskLevel === 'L2' || value.riskLevel === 'L3') && !isText(value.approvalId)) return false;
  if (value.status === 'active') return value.usedOps === 0 && value.consumedAt === undefined && value.revokedAt === undefined;
  if (value.status === 'consumed') {
    return (value.usedOps as number) > 0 && isIsoDate(value.consumedAt) && value.revokedAt === undefined;
  }
  if (value.status === 'revoked') {
    return value.usedOps === 0 && isIsoDate(value.revokedAt) && isText(value.revocationReason) && value.consumedAt === undefined;
  }
  return false;
};

export const isWorkerRegistration = (value: unknown): value is WorkerRegistration => {
  if (!isRecord(value) || !isText(value.id) || !isText(value.family) || !isText(value.availability)) return false;
  if (!['browser', 'desktop', 'connector'].includes(value.family) || !availabilities.has(value.availability)) return false;
  const familyActions = value.family === 'browser'
    ? browserOperations
    : value.family === 'desktop' ? desktopOperations : connectorOperations;
  if (!Array.isArray(value.supportedActions) || value.supportedActions.length === 0 ||
    !value.supportedActions.every((item) => typeof item === 'string' && familyActions.has(item as CapabilityActionType))) return false;
  if (!Array.isArray(value.configuredScopes) || value.configuredScopes.length === 0 ||
    !value.configuredScopes.every((scope) => isCapabilityScope(scope) && scope.family === value.family)) return false;
  if (!isIsoDate(value.registeredAt) || (value.lastSeenAt !== undefined && !isIsoDate(value.lastSeenAt))) return false;
  if (value.availability === 'unavailable' && !isText(value.unavailableReason)) return false;
  return value.unavailableReason === undefined || typeof value.unavailableReason === 'string';
};

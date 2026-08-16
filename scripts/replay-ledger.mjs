#!/usr/bin/env node
/**
 * Independent replay of privacy-preserving capability decision evidence.
 *
 * This file intentionally imports no project code. It validates the recorded
 * schema and independently implements the policy-equivalent relations exposed
 * by schema 2 commitments. It does not claim to reconstruct redacted resources.
 *
 * Default operation is a release gate: missing evidence, legacy outcome-only
 * events, unsupported versions, and zero replayable decisions all fail.
 * `--allow-empty` exists only for explicit inspection of a pre-rollout ledger.
 */
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const RECORD_SCHEMA = 2;
const POLICY_VERSION = '2026-07-25.1';
const GRANT_POLICY_VERSION = '2026-07-26.2';

let emitJson = false;
let strict = false;
let allowEmpty = false;
let runtimeDir = '.agent-kernel';
let runtimeDirProvided = false;

const fail = (message) => {
  const result = { ok: false, error: message };
  if (emitJson) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else console.error(`REPLAY FAILURE: ${message}`);
  process.exit(1);
};

for (const argument of process.argv.slice(2)) {
  if (argument === '--json') { emitJson = true; continue; }
  if (argument === '--strict') { strict = true; continue; }
  if (argument === '--allow-empty') { allowEmpty = true; continue; }
  // Retained as a compatibility alias; evidence is required by default.
  if (argument === '--require-decisions') continue;
  if (argument.startsWith('--')) fail(`unknown option ${argument}.`);
  if (runtimeDirProvided) fail('expected at most one runtime directory.');
  runtimeDir = argument;
  runtimeDirProvided = true;
}

const canonical = (value, seen = new Set()) => {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical JSON requires finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error('canonical JSON does not support cycles');
    seen.add(value);
    const output = `[${value.map((item) => canonical(item, seen)).join(',')}]`;
    seen.delete(value);
    return output;
  }
  if (typeof value === 'object' && value !== null) {
    if (seen.has(value)) throw new Error('canonical JSON does not support cycles');
    seen.add(value);
    const output = `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key], seen)}`)
      .join(',')}}`;
    seen.delete(value);
    return output;
  }
  throw new Error(`canonical JSON does not support ${typeof value}`);
};

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const canonicalHash = (value) => sha256(canonical(value));
// Canonical, matching the kernel: the chain digest depends on each event's
// value, not on the property order a particular runtime happened to produce.
const hashEvent = (event) => {
  const { hash, ...withoutHash } = event;
  return canonicalHash(withoutHash);
};

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim().length > 0;
const isSha = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const isIso = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const isRisk = (value) => ['L0', 'L1', 'L2', 'L3', 'L4'].includes(value);
const unique = (items) => new Set(items).size === items.length;
const exactKeys = (value, required, optional = []) => {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key));
};

const BROWSER_OPS = new Set([
  'browser.inspect', 'browser.navigate', 'browser.click', 'browser.type', 'browser.download',
]);
const DESKTOP_OPS = new Set([
  'desktop.discover', 'desktop.inspect', 'desktop.click', 'desktop.type', 'desktop.shortcut',
]);
const CONNECTOR_OPS = new Set([
  'connector.read', 'connector.draft', 'connector.send', 'connector.delete',
]);
const ALL_OPS = new Set([...BROWSER_OPS, ...DESKTOP_OPS, ...CONNECTOR_OPS]);
const RISK_RANK = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 };
const RISK_FLOOR = {
  'browser.inspect': 'L0',
  'desktop.discover': 'L0',
  'desktop.inspect': 'L0',
  'browser.navigate': 'L2',
  'browser.click': 'L2',
  'browser.type': 'L2',
  'browser.download': 'L2',
  'desktop.click': 'L2',
  'desktop.type': 'L2',
  'desktop.shortcut': 'L2',
  'connector.read': 'L2',
  'connector.draft': 'L2',
  'connector.send': 'L3',
  'connector.delete': 'L3',
};

const familyForAction = (action) => {
  if (BROWSER_OPS.has(action?.type)) return 'browser';
  if (DESKTOP_OPS.has(action?.type)) return 'desktop';
  if (CONNECTOR_OPS.has(action?.type)) return 'connector';
  return undefined;
};

const isPathContract = (value) => exactKeys(value, ['semantics', 'cwdHash']) &&
  ['win32', 'posix'].includes(value.semantics) && isSha(value.cwdHash);

const isPathCommitment = (value, contract) =>
  exactKeys(value, ['semantics', 'valueHash', 'resolvedHash', 'basenameHash']) &&
  value.semantics === contract.semantics &&
  isSha(value.valueHash) && isSha(value.resolvedHash) && isSha(value.basenameHash);

const isResourceCommitment = (value) =>
  exactKeys(value, ['valueHash', 'ancestorHashes']) &&
  isSha(value.valueHash) &&
  Array.isArray(value.ancestorHashes) &&
  value.ancestorHashes.every(isSha) &&
  unique(value.ancestorHashes);

const isUrlCommitment = (value) =>
  exactKeys(value, ['valueHash', 'originHash', 'hasCredentials']) &&
  isSha(value.valueHash) &&
  isSha(value.originHash) &&
  value.hasCredentials === false;

const hashFields = (value, fields) => fields.every((field) => isSha(value[field]));

const isActionEvidence = (value, contract) => {
  if (!isRecord(value) || !ALL_OPS.has(value.type)) return false;
  const browserBase = ['type', 'originHash', 'url'];
  if (BROWSER_OPS.has(value.type)) {
    if (!isSha(value.originHash) ||
      !isUrlCommitment(value.url) ||
      value.url.originHash !== value.originHash) return false;
    if (value.type === 'browser.inspect') {
      return exactKeys(value, browserBase, ['selectorHash']) &&
        (value.selectorHash === undefined || isSha(value.selectorHash));
    }
    if (value.type === 'browser.navigate') return exactKeys(value, browserBase);
    if (value.type === 'browser.click') {
      return exactKeys(value, [...browserBase, 'selectorHash']) && isSha(value.selectorHash);
    }
    if (value.type === 'browser.type') {
      return exactKeys(value, [...browserBase, 'selectorHash', 'payloadArtifactIdHash', 'payloadHash']) &&
        hashFields(value, ['selectorHash', 'payloadArtifactIdHash', 'payloadHash']);
    }
    return exactKeys(value, [...browserBase, 'downloadRoot', 'fileName']) &&
      isPathCommitment(value.downloadRoot, contract) &&
      isPathCommitment(value.fileName, contract);
  }
  if (DESKTOP_OPS.has(value.type)) {
    if (value.type === 'desktop.discover') {
      return exactKeys(value, ['type', 'appIdHash']) && isSha(value.appIdHash);
    }
    const base = ['type', 'appIdHash', 'windowIdHash', 'treeRevisionHash'];
    if (!hashFields(value, base.slice(1))) return false;
    if (value.type === 'desktop.inspect') return exactKeys(value, base);
    if (value.type === 'desktop.click') {
      return exactKeys(value, [...base, 'nodeIdHash']) && isSha(value.nodeIdHash);
    }
    if (value.type === 'desktop.type') {
      return exactKeys(value, [...base, 'nodeIdHash', 'payloadArtifactIdHash', 'payloadHash']) &&
        hashFields(value, ['nodeIdHash', 'payloadArtifactIdHash', 'payloadHash']);
    }
    return exactKeys(value, [...base, 'keyHashes']) &&
      Array.isArray(value.keyHashes) &&
      value.keyHashes.length > 0 &&
      value.keyHashes.length <= 8 &&
      value.keyHashes.every(isSha);
  }
  const connectorBase = ['type', 'connectorIdHash', 'resource'];
  if (!isSha(value.connectorIdHash) || !isResourceCommitment(value.resource)) return false;
  if (value.type === 'connector.read' || value.type === 'connector.delete') {
    return exactKeys(value, connectorBase);
  }
  if (value.type === 'connector.draft') {
    return exactKeys(value, [...connectorBase, 'payloadArtifactIdHash', 'payloadHash']) &&
      hashFields(value, ['payloadArtifactIdHash', 'payloadHash']);
  }
  return exactKeys(value, [...connectorBase, 'payloadHash'], ['payloadArtifactIdHash']) &&
    isSha(value.payloadHash) &&
    (value.payloadArtifactIdHash === undefined || isSha(value.payloadArtifactIdHash));
};

const operationsForFamily = (family) =>
  family === 'browser' ? BROWSER_OPS : family === 'desktop' ? DESKTOP_OPS : CONNECTOR_OPS;

const isScopeEvidence = (value, contract) => {
  if (!isRecord(value) || !['browser', 'desktop', 'connector'].includes(value.family)) return false;
  const allowed = operationsForFamily(value.family);
  if (!Array.isArray(value.operations) || value.operations.length === 0 ||
    !value.operations.every((operation) => allowed.has(operation))) return false;
  if (value.family === 'browser') {
    return exactKeys(value, ['family', 'operations', 'originHashes', 'downloadRoots']) &&
      Array.isArray(value.originHashes) && value.originHashes.every(isSha) &&
      Array.isArray(value.downloadRoots) &&
      value.downloadRoots.every((root) => isPathCommitment(root, contract));
  }
  if (value.family === 'desktop') {
    const hasWindow = value.windowIdHash !== undefined;
    const hasRevision = value.treeRevisionHash !== undefined;
    return exactKeys(
      value,
      ['family', 'operations', 'appIdHash'],
      ['windowIdHash', 'treeRevisionHash'],
    ) &&
      isSha(value.appIdHash) &&
      hasWindow === hasRevision &&
      (!hasWindow || (isSha(value.windowIdHash) && isSha(value.treeRevisionHash)));
  }
  return exactKeys(value, ['family', 'operations', 'connectorIdHash', 'resourceRoots']) &&
    isSha(value.connectorIdHash) &&
    Array.isArray(value.resourceRoots) &&
    value.resourceRoots.every(isResourceCommitment);
};

const resourceWithinRoot = (resource, root) =>
  resource.valueHash === root.valueHash || resource.ancestorHashes.includes(root.valueHash);

const isSubset = (requested, configured) =>
  requested.every((item) => configured.includes(item));

const actionWithinScope = (action, scope) => {
  const family = familyForAction(action);
  if (!family || family !== scope.family || !scope.operations.includes(action.type)) return false;
  if (family === 'browser') {
    if (!scope.originHashes.includes(action.originHash)) return false;
    if (action.type !== 'browser.download') return true;
    return scope.downloadRoots.some((root) => root.resolvedHash === action.downloadRoot.resolvedHash) &&
      action.fileName.valueHash === action.fileName.basenameHash;
  }
  if (family === 'desktop') {
    if (action.appIdHash !== scope.appIdHash) return false;
    if (action.type === 'desktop.discover') {
      return scope.windowIdHash === undefined && scope.treeRevisionHash === undefined;
    }
    return action.windowIdHash === scope.windowIdHash &&
      action.treeRevisionHash === scope.treeRevisionHash;
  }
  return action.connectorIdHash === scope.connectorIdHash &&
    scope.resourceRoots.some((root) => resourceWithinRoot(action.resource, root));
};

const scopeWithinScope = (requested, configured) => {
  if (requested.family !== configured.family ||
    !isSubset(requested.operations, configured.operations)) return false;
  if (requested.family === 'browser') {
    return isSubset(requested.originHashes, configured.originHashes) &&
      requested.downloadRoots.every((root) =>
        configured.downloadRoots.some((allowed) => root.resolvedHash === allowed.resolvedHash));
  }
  if (requested.family === 'desktop') {
    if (requested.appIdHash !== configured.appIdHash) return false;
    if (configured.windowIdHash !== undefined && requested.windowIdHash !== configured.windowIdHash) return false;
    if (configured.treeRevisionHash !== undefined &&
      requested.treeRevisionHash !== configured.treeRevisionHash) return false;
    return true;
  }
  return requested.connectorIdHash === configured.connectorIdHash &&
    requested.resourceRoots.every((root) =>
      configured.resourceRoots.some((allowed) => resourceWithinRoot(root, allowed)));
};

const isIntentEvidence = (value, contract) =>
  exactKeys(value, [
    'schemaVersion', 'id', 'goalId', 'taskId', 'workerId', 'riskLevel',
    'action', 'scope', 'authority', 'untrustedObservationIdHashes',
    'createdAt', 'sourceIntentHash',
  ]) &&
  value.schemaVersion === 1 &&
  [value.id, value.goalId, value.taskId, value.workerId].every(isText) &&
  isRisk(value.riskLevel) &&
  isActionEvidence(value.action, contract) &&
  isScopeEvidence(value.scope, contract) &&
  actionWithinScope(value.action, value.scope) &&
  exactKeys(value.authority, ['kind', 'referenceId']) &&
  ['user_request', 'kernel_policy', 'approval'].includes(value.authority.kind) &&
  isText(value.authority.referenceId) &&
  Array.isArray(value.untrustedObservationIdHashes) &&
  value.untrustedObservationIdHashes.every(isSha) &&
  isIso(value.createdAt) &&
  isSha(value.sourceIntentHash);

const isWorkerEvidence = (value, contract) => {
  if (!exactKeys(
    value,
    ['id', 'family', 'availability', 'supportedActions', 'configuredScopes', 'registeredAt'],
    ['lastSeenAt', 'unavailableReasonHash'],
  )) return false;
  if (!isText(value.id) || !['browser', 'desktop', 'connector'].includes(value.family) ||
    !['available', 'configured', 'unavailable'].includes(value.availability)) return false;
  const allowed = operationsForFamily(value.family);
  if (!Array.isArray(value.supportedActions) || value.supportedActions.length === 0 ||
    !value.supportedActions.every((action) => allowed.has(action))) return false;
  if (!Array.isArray(value.configuredScopes) || value.configuredScopes.length === 0 ||
    !value.configuredScopes.every((scope) =>
      isScopeEvidence(scope, contract) && scope.family === value.family)) return false;
  if (!isIso(value.registeredAt) || (value.lastSeenAt !== undefined && !isIso(value.lastSeenAt))) return false;
  if (value.availability === 'unavailable' && !isSha(value.unavailableReasonHash)) return false;
  return value.unavailableReasonHash === undefined || isSha(value.unavailableReasonHash);
};

const isGrantEvidence = (value, contract) => {
  if (!exactKeys(
    value,
    [
      'schemaVersion', 'id', 'intentId', 'intentHash', 'workerId', 'scope',
      'riskLevel', 'status', 'issuedBy', 'issuedAt', 'expiresAt', 'maxOps', 'usedOps',
    ],
    ['approvalId', 'consumedAt', 'revokedAt', 'revocationReasonHash'],
  )) return false;
  if (value.schemaVersion !== 1 ||
    ![value.id, value.intentId, value.workerId].every(isText) ||
    !isSha(value.intentHash) ||
    !isScopeEvidence(value.scope, contract) ||
    !isRisk(value.riskLevel) ||
    value.issuedBy !== 'kernel' ||
    !isIso(value.issuedAt) || !isIso(value.expiresAt) ||
    Date.parse(value.expiresAt) <= Date.parse(value.issuedAt) ||
    !Number.isInteger(value.maxOps) || value.maxOps < 1 ||
    !Number.isInteger(value.usedOps) || value.usedOps < 0 || value.usedOps > value.maxOps) return false;
  if ((value.riskLevel === 'L2' || value.riskLevel === 'L3') && !isText(value.approvalId)) return false;
  if (value.status === 'active') {
    return value.usedOps === 0 && value.consumedAt === undefined && value.revokedAt === undefined &&
      value.revocationReasonHash === undefined;
  }
  if (value.status === 'consumed') {
    return value.usedOps > 0 && isIso(value.consumedAt) && value.revokedAt === undefined &&
      value.revocationReasonHash === undefined;
  }
  if (value.status === 'revoked') {
    return value.usedOps === 0 && isIso(value.revokedAt) && isSha(value.revocationReasonHash) &&
      value.consumedAt === undefined;
  }
  return false;
};

const authorityBindingHash = (intent) => canonicalHash({
  goalId: intent.goalId,
  taskId: intent.taskId,
  workerId: intent.workerId,
  riskLevel: intent.riskLevel,
  action: intent.action,
  scope: intent.scope,
});

const isDispatchInputs = (value) =>
  exactKeys(value, [
    'pathContract', 'grant', 'intent', 'worker', 'now', 'operationsUsed',
    'authorityBindingHash',
  ]) &&
  isPathContract(value.pathContract) &&
  isGrantEvidence(value.grant, value.pathContract) &&
  isIntentEvidence(value.intent, value.pathContract) &&
  isWorkerEvidence(value.worker, value.pathContract) &&
  isIso(value.now) &&
  Number.isInteger(value.operationsUsed) &&
  isSha(value.authorityBindingHash) &&
  value.authorityBindingHash === authorityBindingHash(value.intent);

const isPolicyInputs = (value) =>
  exactKeys(
    value,
    ['pathContract', 'intent', 'now', 'authorityBindingHash'],
    ['worker'],
  ) &&
  isPathContract(value.pathContract) &&
  isIntentEvidence(value.intent, value.pathContract) &&
  (value.worker === undefined || isWorkerEvidence(value.worker, value.pathContract)) &&
  isIso(value.now) &&
  isSha(value.authorityBindingHash) &&
  value.authorityBindingHash === authorityBindingHash(value.intent);

const GRANT_REASON_CODES = new Set([
  'allowed', 'grant_invalid', 'grant_revoked', 'grant_consumed',
  'grant_not_yet_valid', 'grant_expired', 'intent_mismatch',
  'approval_mismatch', 'worker_mismatch', 'worker_unavailable',
  'scope_mismatch', 'operation_budget_exceeded',
]);

const isDispatchOutcome = (value) => {
  if (!exactKeys(value, [
    'allowed', 'reasonCode', 'reason', 'riskLevel', 'grantStatus', 'usedOps', 'consumedAt',
  ]) ||
    typeof value.allowed !== 'boolean' ||
    !GRANT_REASON_CODES.has(value.reasonCode) ||
    !isText(value.reason) ||
    !isRisk(value.riskLevel) ||
    !['active', 'revoked', 'consumed'].includes(value.grantStatus) ||
    !Number.isInteger(value.usedOps) ||
    value.usedOps < 0 ||
    (value.consumedAt !== null && !isIso(value.consumedAt))) return false;
  if (value.allowed) {
    return value.reasonCode === 'allowed' &&
      value.reason === 'Capability grant consumed.' &&
      value.grantStatus === 'consumed' &&
      value.usedOps > 0 &&
      isIso(value.consumedAt);
  }
  return value.reasonCode !== 'allowed';
};

const POLICY_REASON_CODES = new Set([
  'allowed', 'approval_required', 'invalid_intent', 'untrusted_authority',
  'forbidden_risk', 'risk_understated', 'worker_unknown', 'worker_unavailable',
  'worker_action_unsupported', 'scope_mismatch', 'scope_not_configured',
]);

const isPolicyOutcome = (value) =>
  exactKeys(value, ['kind', 'reasonCode', 'reason', 'riskLevel']) &&
  ['allow', 'approval_required', 'deny'].includes(value.kind) &&
  POLICY_REASON_CODES.has(value.reasonCode) &&
  isText(value.reason) &&
  isRisk(value.riskLevel);

const deny = (riskLevel, reasonCode, reason) => ({ kind: 'deny', reasonCode, reason, riskLevel });
const decidePolicy = (intent, worker) => {
  // Schema validation has already independently established a valid intent.
  if (intent.riskLevel === 'L4') {
    return deny('L4', 'forbidden_risk', 'L4 actions are forbidden by policy.');
  }
  const minimumRisk = RISK_FLOOR[intent.action.type];
  if (RISK_RANK[intent.riskLevel] < RISK_RANK[minimumRisk]) {
    return deny(intent.riskLevel, 'risk_understated', `Action requires at least ${minimumRisk}.`);
  }
  if (!worker) {
    return deny(intent.riskLevel, 'worker_unknown', 'Requested worker is not registered.');
  }
  if (worker.availability !== 'available') {
    return deny(intent.riskLevel, 'worker_unavailable', 'Requested worker is not currently available.');
  }
  if (worker.family !== familyForAction(intent.action) ||
    !worker.supportedActions.includes(intent.action.type)) {
    return deny(intent.riskLevel, 'worker_action_unsupported', 'Worker does not support this action.');
  }
  if (!actionWithinScope(intent.action, intent.scope)) {
    return deny(intent.riskLevel, 'scope_mismatch', 'Action is outside the intent scope.');
  }
  if (!worker.configuredScopes.some((configured) => scopeWithinScope(intent.scope, configured))) {
    return deny(intent.riskLevel, 'scope_not_configured', 'Intent scope is outside the worker configuration.');
  }
  if (intent.riskLevel === 'L2' || intent.riskLevel === 'L3') {
    if (intent.authority.kind === 'approval') {
      return {
        kind: 'allow',
        reasonCode: 'allowed',
        reason: `${intent.riskLevel} action is bound to an explicit approval.`,
        riskLevel: intent.riskLevel,
      };
    }
    return {
      kind: 'approval_required',
      reasonCode: 'approval_required',
      reason: `${intent.riskLevel} actions require an explicit approval grant.`,
      riskLevel: intent.riskLevel,
    };
  }
  return {
    kind: 'allow',
    reasonCode: 'allowed',
    reason: 'Action is allowed inside the configured scope.',
    riskLevel: intent.riskLevel,
  };
};

const rejectedGrant = (grant, intent, reasonCode, reason) => ({
  allowed: false,
  reasonCode,
  reason,
  riskLevel: intent.riskLevel,
  grantStatus: grant.status,
  usedOps: grant.usedOps,
  consumedAt: grant.consumedAt ?? null,
});

const consumeGrant = (grant, intent, worker, now, operationsUsed) => {
  if (grant.status === 'revoked') {
    return rejectedGrant(grant, intent, 'grant_revoked', 'Capability grant was revoked.');
  }
  if (grant.status === 'consumed') {
    return rejectedGrant(grant, intent, 'grant_consumed', 'Capability grant has already been consumed.');
  }
  const validatedAt = Date.parse(now);
  if (!Number.isFinite(validatedAt)) {
    return rejectedGrant(grant, intent, 'grant_expired', 'Capability grant is expired.');
  }
  if (validatedAt < Date.parse(grant.issuedAt)) {
    return rejectedGrant(
      grant,
      intent,
      'grant_not_yet_valid',
      'Capability grant is not yet valid.',
    );
  }
  if (validatedAt >= Date.parse(grant.expiresAt)) {
    return rejectedGrant(grant, intent, 'grant_expired', 'Capability grant is expired.');
  }
  if (
    grant.intentId !== intent.id ||
    grant.intentHash !== intent.sourceIntentHash ||
    grant.riskLevel !== intent.riskLevel
  ) {
    return rejectedGrant(grant, intent, 'intent_mismatch', 'Capability grant does not match the action intent.');
  }
  if (
    (grant.riskLevel === 'L2' || grant.riskLevel === 'L3') &&
    (
      intent.authority.kind !== 'approval' ||
      grant.approvalId !== intent.authority.referenceId
    )
  ) {
    return rejectedGrant(
      grant,
      intent,
      'approval_mismatch',
      'Capability grant does not match the intent approval authority.',
    );
  }
  if (grant.workerId !== intent.workerId || worker.id !== grant.workerId) {
    return rejectedGrant(grant, intent, 'worker_mismatch', 'Capability grant does not match the worker.');
  }
  if (worker.availability !== 'available') {
    return rejectedGrant(grant, intent, 'worker_unavailable', 'Worker is not currently available.');
  }
  if (worker.family !== familyForAction(intent.action) ||
    !worker.supportedActions.includes(intent.action.type)) {
    return rejectedGrant(grant, intent, 'worker_mismatch', 'Worker does not support the granted action.');
  }
  if (!actionWithinScope(intent.action, grant.scope) ||
    !scopeWithinScope(intent.scope, grant.scope)) {
    return rejectedGrant(grant, intent, 'scope_mismatch', 'Capability grant scope does not cover the action intent.');
  }
  if (!worker.configuredScopes.some((configured) => scopeWithinScope(grant.scope, configured))) {
    return rejectedGrant(
      grant,
      intent,
      'scope_mismatch',
      'Worker configuration no longer covers the capability grant scope.',
    );
  }
  if (!Number.isInteger(operationsUsed) || operationsUsed < 1 || operationsUsed > grant.maxOps) {
    return rejectedGrant(
      grant,
      intent,
      'operation_budget_exceeded',
      'Reported operation use exceeds the capability grant budget.',
    );
  }
  return {
    allowed: true,
    reasonCode: 'allowed',
    reason: 'Capability grant consumed.',
    riskLevel: intent.riskLevel,
    grantStatus: 'consumed',
    usedOps: operationsUsed,
    consumedAt: now,
  };
};

const ledgerPath = path.join(runtimeDir, 'events.jsonl');
let raw;
try {
  raw = readFileSync(ledgerPath, 'utf8');
} catch (error) {
  if (error.code === 'ENOENT' && allowEmpty) {
    const result = { ok: true, events: 0, decisionsReplayed: 0, explicitlyAllowedEmpty: true };
    process.stdout.write(emitJson ? `${JSON.stringify(result, null, 2)}\n` : 'No ledger found; explicitly allowed.\n');
    process.exit(0);
  }
  if (error.code === 'ENOENT') fail('required ledger events.jsonl was not found.');
  throw error;
}

const events = [];
let previousHash = null;
for (const line of raw.split('\n').map((item) => item.trim()).filter(Boolean)) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    fail(`event ${events.length + 1} is not valid JSON (truncated or corrupt).`);
  }
  if (event.previousHash !== previousHash) {
    fail(`event ${event.id ?? events.length + 1} does not link to the prior event.`);
  }
  if (hashEvent(event) !== event.hash) {
    fail(`event ${event.id ?? events.length + 1} hash does not match its content.`);
  }
  previousHash = event.hash;
  events.push(event);
}

const divergences = [];
const warnings = [];
const approvals = new Map();
const consumedGrantIds = new Map();
const consumedApprovalIds = new Map();
let decisionsReplayed = 0;
let outcomeOnlyDecisions = 0;

const note = (list, event, code, detail) => list.push({
  eventId: event.id,
  type: event.type,
  timestamp: event.timestamp,
  code,
  detail,
});

const bindApprovalEvent = (event) => {
  if (event.entityType !== 'approval' || !isText(event.entityId)) {
    note(divergences, event, 'approval_envelope_mismatch', 'approval event envelope is invalid');
    return;
  }
  if (event.type === 'approval.requested') {
    if (event.actor !== 'kernel') {
      note(divergences, event, 'approval_actor_mismatch', 'approval requests must be emitted by the kernel');
    }
    if (approvals.has(event.entityId)) {
      note(divergences, event, 'approval_duplicate_request', `approval ${event.entityId} was requested twice`);
      return;
    }
    approvals.set(event.entityId, {
      status: 'pending',
      goalId: event.payload?.goalId,
      taskId: event.payload?.taskId,
      riskLevel: event.payload?.riskLevel,
      authorityBindingHash: event.payload?.authorityBindingHash,
      automationId: event.payload?.automationId,
      requestedAt: event.timestamp,
    });
    return;
  }
  if (event.actor !== 'user') {
    note(divergences, event, 'approval_actor_mismatch', 'approval decisions must be emitted by the user');
  }
  const request = approvals.get(event.entityId);
  if (!request || request.status !== 'pending') {
    note(divergences, event, 'approval_without_request', `approval ${event.entityId} has no pending request`);
    return;
  }
  for (const field of ['goalId', 'taskId', 'automationId', 'riskLevel', 'authorityBindingHash']) {
    if (event.payload?.[field] !== request[field]) {
      note(divergences, event, 'approval_binding_mismatch', `approval ${field} changed between request and decision`);
    }
  }
  request.status = event.type === 'approval.approved' ? 'approved' : 'denied';
  request.decidedAt = event.timestamp;
};

const requireApproval = (event, record, approvalId, expectedStatus) => {
  const intent = record.inputs.intent;
  const approval = approvals.get(approvalId);
  if (!approval || approval.status !== expectedStatus) {
    note(divergences, event, 'approval_status_mismatch',
      `approval ${approvalId} is not ${expectedStatus} before this decision`);
    return undefined;
  }
  if (
    approval.goalId !== intent.goalId ||
    approval.taskId !== intent.taskId ||
    approval.riskLevel !== intent.riskLevel ||
    approval.authorityBindingHash !== record.inputs.authorityBindingHash
  ) {
    note(divergences, event, 'approval_authority_mismatch',
      `approval ${approvalId} is not bound to this intent authority`);
    return undefined;
  }
  if (Date.parse(approval.requestedAt) > Date.parse(event.timestamp)) {
    note(divergences, event, 'approval_time_mismatch',
      `approval ${approvalId} was requested after the decision that cites it`);
    return undefined;
  }
  if (expectedStatus === 'approved' && !isIso(approval.decidedAt)) {
    note(divergences, event, 'approval_time_mismatch',
      `approval ${approvalId} has no causal user-decision timestamp`);
    return undefined;
  }
  return approval;
};

let priorTimestamp = null;
for (const event of events) {
  const timestamp = Date.parse(event.timestamp);
  if (!Number.isFinite(timestamp)) {
    note(divergences, event, 'invalid_event_timestamp', 'event timestamp is not an ISO-compatible timestamp');
  } else if (priorTimestamp !== null && timestamp < priorTimestamp) {
    note(divergences, event, 'timestamp_regression', 'event timestamp precedes the prior event');
  } else {
    priorTimestamp = timestamp;
  }

  if (event.type === 'approval.requested' ||
    event.type === 'approval.approved' ||
    event.type === 'approval.denied') {
    bindApprovalEvent(event);
  }

  const isDecisionEvent = [
    'capability.grant_consumed', 'automation.run_blocked', 'automation.run_denied',
  ].includes(event.type);
  if (isDecisionEvent && event.actor !== 'kernel') {
    note(divergences, event, 'decision_actor_mismatch',
      'capability and automation decisions must be emitted by the kernel');
  }
  const record = event.payload?.decision;
  if (!record) {
    if (isDecisionEvent) {
      outcomeOnlyDecisions += 1;
      note(divergences, event, 'missing_decision_evidence',
        'authorization event has no schema-2 replay evidence');
    }
    continue;
  }

  if (!isRecord(record) || record.schemaVersion !== RECORD_SCHEMA) {
    note(divergences, event, 'unsupported_record_schema',
      `decision record schema ${record?.schemaVersion ?? 'missing'} is not supported`);
    continue;
  }
  if (record.policyVersion !== POLICY_VERSION) {
    note(divergences, event, 'unknown_policy_version',
      `policy ${record.policyVersion ?? 'missing'} is not implemented by this replayer`);
    continue;
  }
  if (record.decisionKind === 'dispatch' && record.grantPolicyVersion !== GRANT_POLICY_VERSION) {
    note(divergences, event, 'unknown_grant_policy_version',
      `grant policy ${record.grantPolicyVersion ?? 'missing'} is not implemented by this replayer`);
    continue;
  }
  if (record.decisionKind !== 'dispatch' && record.decisionKind !== 'policy') {
    note(divergences, event, 'unknown_decision_kind', `unrecognized decisionKind ${record.decisionKind}`);
    continue;
  }
  if (canonicalHash(record.inputs) !== record.inputsHash) {
    note(divergences, event, 'inputs_hash_mismatch', 'decision inputs do not match their commitment');
    continue;
  }

  if (record.decisionKind === 'dispatch') {
    if (!exactKeys(
      record,
      ['schemaVersion', 'policyVersion', 'grantPolicyVersion', 'decisionKind', 'inputs', 'outcome', 'inputsHash'],
    ) || !isDispatchInputs(record.inputs) || !isDispatchOutcome(record.outcome)) {
      note(divergences, event, 'invalid_dispatch_record', 'dispatch evidence fails independent schema validation');
      continue;
    }
    if (event.type !== 'capability.grant_consumed' ||
      event.entityType !== 'capability' ||
      event.entityId !== record.inputs.grant.id ||
      event.payload?.grantId !== record.inputs.grant.id ||
      event.payload?.intentId !== record.inputs.intent.id ||
      event.payload?.grantStatus !== record.outcome.grantStatus) {
      note(divergences, event, 'dispatch_envelope_mismatch',
        'event entity/grant/intent/status does not exactly bind the decision record');
    }
    if (
      !record.outcome.allowed ||
      record.outcome.reasonCode !== 'allowed' ||
      record.outcome.grantStatus !== 'consumed'
    ) {
      note(divergences, event, 'dispatch_event_outcome_mismatch',
        'grant_consumed must carry an allowed, consumed dispatch outcome');
    }
    if (record.inputs.now !== record.outcome.consumedAt && record.outcome.allowed) {
      note(divergences, event, 'dispatch_time_mismatch', 'allowed dispatch consumption time differs from decision time');
    }
    if (Date.parse(event.timestamp) < Date.parse(record.inputs.now)) {
      note(divergences, event, 'decision_after_event', 'dispatch decision time is after its ledger event');
    }
    const grantId = record.inputs.grant.id;
    if (consumedGrantIds.has(grantId)) {
      note(divergences, event, 'grant_reused',
        `grant ${grantId} was already consumed at ${consumedGrantIds.get(grantId)}`);
    }
    consumedGrantIds.set(grantId, event.timestamp);

    const derived = consumeGrant(
      record.inputs.grant,
      record.inputs.intent,
      record.inputs.worker,
      record.inputs.now,
      record.inputs.operationsUsed,
    );
    if (canonical(derived) !== canonical(record.outcome)) {
      note(divergences, event, 'dispatch_outcome_mismatch',
        `recorded ${record.outcome.reasonCode}; replay derived ${derived.reasonCode}`);
    }
    const policy = decidePolicy(record.inputs.intent, record.inputs.worker);
    if (derived.allowed && policy.kind !== 'allow') {
      note(divergences, event, 'dispatch_without_policy_allow',
        `grant was consumed while policy derives ${policy.kind}/${policy.reasonCode}`);
    }

    const { intent, grant } = record.inputs;
    const taskAutomationId = intent.taskId.startsWith('automation:')
      ? intent.taskId.slice('automation:'.length)
      : undefined;
    const eventAutomationId = event.payload?.automationId;
    if (
      taskAutomationId !== undefined ||
      eventAutomationId !== undefined
    ) {
      if (
        !isText(taskAutomationId) ||
        !isText(eventAutomationId) ||
        taskAutomationId !== eventAutomationId
      ) {
        note(divergences, event, 'automation_binding_mismatch',
          'automation dispatch must bind payload automationId to intent taskId');
      }
    }
    if (intent.riskLevel === 'L2' || intent.riskLevel === 'L3') {
      const approvalId = grant.approvalId;
      if (!approvalId ||
        intent.authority.kind !== 'approval' ||
        intent.authority.referenceId !== approvalId ||
        event.payload?.approvalId !== approvalId) {
        note(divergences, event, 'dispatch_approval_envelope_mismatch',
          'L2/L3 grant, intent authority, and event do not cite the same approval');
      } else {
        const approval = requireApproval(event, record, approvalId, 'approved');
        if (approval) {
          if (
            Date.parse(approval.decidedAt) > Date.parse(intent.createdAt) ||
            Date.parse(approval.decidedAt) > Date.parse(grant.issuedAt) ||
            Date.parse(approval.decidedAt) > Date.parse(record.inputs.now)
          ) {
            note(divergences, event, 'approval_time_mismatch',
              `approval ${approvalId} was decided after the intent, grant, or dispatch that cites it`);
          }
          if (consumedApprovalIds.has(approvalId)) {
            note(divergences, event, 'approval_reused',
              `approval ${approvalId} was already consumed at ${consumedApprovalIds.get(approvalId)}`);
          } else if (record.outcome.allowed) {
            consumedApprovalIds.set(approvalId, event.timestamp);
          }
          if (isText(eventAutomationId)) {
            if (
              approval.automationId !== eventAutomationId ||
              approval.blockedAutomationId !== eventAutomationId ||
              approval.blockedAuthorityBindingHash !== record.inputs.authorityBindingHash
            ) {
              note(divergences, event, 'blocked_dispatch_mismatch',
                'automation dispatch is not linked to the blocked request for this exact approval');
            }
          }
        }
      }
    } else if (event.payload?.approvalId !== grant.approvalId) {
      note(divergences, event, 'dispatch_approval_envelope_mismatch',
        'event approval id differs from the grant approval id');
    }
    decisionsReplayed += 1;
    continue;
  }

  if (!exactKeys(
    record,
    ['schemaVersion', 'policyVersion', 'decisionKind', 'inputs', 'outcome', 'inputsHash'],
  ) || !isPolicyInputs(record.inputs) || !isPolicyOutcome(record.outcome)) {
    note(divergences, event, 'invalid_policy_record', 'policy evidence fails independent schema validation');
    continue;
  }
  if (!['automation.run_blocked', 'automation.run_denied'].includes(event.type) ||
    event.entityType !== 'automation' ||
    event.entityId !== event.payload?.automationId ||
    event.payload?.intentId !== record.inputs.intent.id ||
    event.payload?.reasonCode !== record.outcome.reasonCode ||
    event.payload?.reason !== record.outcome.reason ||
    event.payload?.riskLevel !== record.outcome.riskLevel) {
    note(divergences, event, 'policy_envelope_mismatch',
      'event entity/intent/risk/reason does not exactly bind the policy record');
  }
  if (Date.parse(event.timestamp) < Date.parse(record.inputs.now)) {
    note(divergences, event, 'decision_after_event', 'policy decision time is after its ledger event');
  }
  const automationId = event.payload?.automationId;
  if (
    !isText(automationId) ||
    record.inputs.intent.taskId !== `automation:${automationId}`
  ) {
    note(divergences, event, 'automation_binding_mismatch',
      'automation policy decision must bind entity automationId to intent taskId');
  }
  const derived = decidePolicy(record.inputs.intent, record.inputs.worker);
  if (canonical(derived) !== canonical(record.outcome)) {
    note(divergences, event, 'policy_outcome_mismatch',
      `recorded ${record.outcome.kind}/${record.outcome.reasonCode}; replay derived ${derived.kind}/${derived.reasonCode}`);
  }
  if (event.type === 'automation.run_blocked') {
    const approvalId = event.payload?.approvalId;
    if (!isText(approvalId) || record.outcome.kind !== 'approval_required') {
      note(divergences, event, 'blocked_approval_mismatch',
        'blocked event must cite its pending approval and derive approval_required');
    } else {
      const approval = requireApproval(event, record, approvalId, 'pending');
      if (
        record.inputs.intent.authority.kind !== 'kernel_policy' ||
        record.inputs.intent.authority.referenceId !== automationId
      ) {
        note(divergences, event, 'blocked_authority_mismatch',
          'blocked automation intent must be kernel authority bound to the automation');
      }
      if (approval) {
        if (approval.automationId !== automationId) {
          note(divergences, event, 'blocked_approval_mismatch',
            'blocked automation does not match the approval request automation');
        }
        approval.blockedAutomationId = automationId;
        approval.blockedAuthorityBindingHash = record.inputs.authorityBindingHash;
        approval.blockedAt = event.timestamp;
      }
    }
  } else if (record.outcome.kind !== 'deny') {
    note(divergences, event, 'denied_outcome_mismatch',
      'run_denied must carry a denied policy outcome');
  }
  decisionsReplayed += 1;
}

if (decisionsReplayed === 0 && !allowEmpty) {
  const synthetic = {
    id: 'ledger',
    type: 'ledger',
    timestamp: '',
  };
  note(divergences, synthetic, 'no_replayable_decisions',
    'no supported decision evidence was replayed');
}

const ok = divergences.length === 0 && (!strict || warnings.length === 0);
const report = {
  ok,
  events: events.length,
  head: previousHash,
  decisionsReplayed,
  outcomeOnlyDecisions,
  divergences,
  warnings,
  explicitlyAllowedEmpty: allowEmpty && decisionsReplayed === 0,
};

if (emitJson) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else if (!ok) {
  console.error(`REPLAY FAILURE: ${divergences.length} divergence(s), ${warnings.length} warning(s).`);
  for (const item of [...divergences, ...warnings]) {
    console.error(`  [${item.code}] ${item.type} ${item.eventId}: ${item.detail}`);
  }
} else {
  console.log(`Ledger replayed: ${events.length} events, ${decisionsReplayed} decision(s) matched.`);
}

process.exit(ok ? 0 : 1);

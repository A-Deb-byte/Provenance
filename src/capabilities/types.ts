import type { RiskLevel } from '../kernel/types';

export type CapabilityRiskLevel = RiskLevel;
export type WorkerFamily = 'browser' | 'desktop' | 'connector';
export type WorkerAvailability = 'available' | 'configured' | 'unavailable';

export type BrowserAction =
  | { type: 'browser.inspect'; origin: string; url: string; selector?: string }
  | { type: 'browser.navigate'; origin: string; url: string }
  | { type: 'browser.click'; origin: string; url: string; selector: string }
  | { type: 'browser.type'; origin: string; url: string; selector: string; payloadArtifactId: string; payloadHash: string }
  | { type: 'browser.download'; origin: string; url: string; downloadRoot: string; fileName: string };

export type DesktopAction =
  | { type: 'desktop.discover'; appId: string }
  | { type: 'desktop.inspect'; appId: string; windowId: string; treeRevision: string }
  | { type: 'desktop.click'; appId: string; windowId: string; treeRevision: string; nodeId: string }
  | { type: 'desktop.type'; appId: string; windowId: string; treeRevision: string; nodeId: string; payloadArtifactId: string; payloadHash: string }
  | { type: 'desktop.shortcut'; appId: string; windowId: string; treeRevision: string; keys: string[] };

export type ConnectorAction =
  | { type: 'connector.read'; connectorId: string; resourceId: string }
  | { type: 'connector.draft'; connectorId: string; resourceId: string; payloadArtifactId: string; payloadHash: string }
  | { type: 'connector.send'; connectorId: string; resourceId: string; payloadArtifactId?: string; payloadHash: string }
  | { type: 'connector.delete'; connectorId: string; resourceId: string };

export type CapabilityAction = BrowserAction | DesktopAction | ConnectorAction;
export type CapabilityActionType = CapabilityAction['type'];

export interface BrowserCapabilityScope {
  family: 'browser';
  operations: BrowserAction['type'][];
  origins: string[];
  downloadRoots: string[];
}

export interface DesktopCapabilityScope {
  family: 'desktop';
  operations: DesktopAction['type'][];
  appId: string;
  /** Omitted only on the operator-configured app allowlist and discovery intents. */
  windowId?: string;
  /** Exact for inspection and mutation intents; omitted only with windowId. */
  treeRevision?: string;
}

export interface ConnectorCapabilityScope {
  family: 'connector';
  operations: ConnectorAction['type'][];
  connectorId: string;
  resourceRoots: string[];
}

export type CapabilityScope = BrowserCapabilityScope | DesktopCapabilityScope | ConnectorCapabilityScope;

export type TrustedAuthority =
  | { kind: 'user_request'; referenceId: string }
  | { kind: 'kernel_policy'; referenceId: string }
  | { kind: 'approval'; referenceId: string };

export interface ActionIntent {
  schemaVersion: 1;
  id: string;
  goalId: string;
  taskId: string;
  workerId: string;
  riskLevel: CapabilityRiskLevel;
  action: CapabilityAction;
  scope: CapabilityScope;
  authority: TrustedAuthority;
  untrustedObservationIds: string[];
  createdAt: string;
}

export interface CapabilityGrant {
  schemaVersion: 1;
  id: string;
  intentId: string;
  intentHash: string;
  workerId: string;
  scope: CapabilityScope;
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
  revocationReason?: string;
}

export interface ActionResult {
  schemaVersion: 1;
  intentId: string;
  grantId: string;
  workerId: string;
  status: 'succeeded' | 'failed' | 'denied';
  operationsUsed: number;
  startedAt: string;
  finishedAt: string;
  evidenceHashes: string[];
  observationIds: string[];
  errorCode?: string;
}

export type PromptInjectionSignalCode =
  | 'instruction_override'
  | 'secret_request'
  | 'authority_bypass'
  | 'exfiltration_request'
  | 'tool_execution_request';

export interface UntrustedObservation {
  id: string;
  source: 'web' | 'document' | 'screen' | 'tool_output';
  sourceRef: string;
  contentHash: string;
  capturedAt: string;
  canGrantAuthority: false;
  injectionSignalCodes: PromptInjectionSignalCode[];
}

export interface WorkerRegistration {
  id: string;
  family: WorkerFamily;
  availability: WorkerAvailability;
  supportedActions: CapabilityActionType[];
  configuredScopes: CapabilityScope[];
  registeredAt: string;
  lastSeenAt?: string;
  unavailableReason?: string;
}

export type AutomationTrigger =
  | { type: 'manual' }
  | { type: 'interval'; everyMinutes: number; startsAt?: string }
  | { type: 'schedule'; cron: string; timezone: string };

export interface AutomationContract {
  schemaVersion: 1;
  id: string;
  name: string;
  enabled: boolean;
  goalId: string;
  workerId: string;
  riskLevel: CapabilityRiskLevel;
  action: CapabilityAction;
  scope: CapabilityScope;
  trigger: AutomationTrigger;
  approvalMode: 'per_run' | 'preapproved_l2';
  budget: {
    maxRuns: number;
    maxConsecutiveFailures: number;
    maxRuntimeMsPerRun: number;
  };
  createdAt: string;
  updatedAt: string;
}

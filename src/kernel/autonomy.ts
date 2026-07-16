import crypto from 'node:crypto';
import { validateAutomationContract } from '../capabilities/automation';
import type {
  ActionIntent,
  AutomationContract,
  CapabilityAction,
  CapabilityScope,
  WorkerRegistration,
} from '../capabilities/types';
import { isCapabilityAction, isCapabilityScope } from '../capabilities/validators';
import type { WorkerAvailabilityReport } from '../capabilities/registry';
import { createKernelId } from './ids';
import type {
  ApprovalRecord,
  BenchmarkRun,
  GoalContract,
  KernelEvent,
  KernelTask,
  ReleaseProposal,
  RiskLevel,
} from './types';

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const isNonEmptyString = (value: unknown): value is string => (
  typeof value === 'string' && value.trim().length > 0
);

const isSha256 = (value: unknown): value is string => (
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
);

const riskLevels = new Set<RiskLevel>(['L0', 'L1', 'L2', 'L3', 'L4']);

/**
 * No browser, desktop, or connector worker runtime ships with this repository.
 * These registrations exist so availability is reported honestly instead of
 * the families being silently absent from the capability report.
 */
export const defaultWorkerRegistrations = (registeredAt = new Date().toISOString()): WorkerRegistration[] => [
  {
    id: 'worker.browser.placeholder',
    family: 'browser',
    availability: 'unavailable',
    supportedActions: ['browser.inspect'],
    configuredScopes: [{
      family: 'browser',
      operations: ['browser.inspect'],
      origins: ['https://localhost'],
      downloadRoots: [],
    }],
    registeredAt,
    unavailableReason: 'No browser worker runtime is installed in this deployment.',
  },
  {
    id: 'worker.desktop.placeholder',
    family: 'desktop',
    availability: 'unavailable',
    supportedActions: ['desktop.discover', 'desktop.inspect'],
    configuredScopes: [{
      family: 'desktop',
      operations: ['desktop.discover', 'desktop.inspect'],
      appId: 'app.placeholder',
    }],
    registeredAt,
    unavailableReason: 'No desktop worker runtime is installed in this deployment.',
  },
  {
    id: 'worker.connector.placeholder',
    family: 'connector',
    availability: 'unavailable',
    supportedActions: ['connector.read'],
    configuredScopes: [{
      family: 'connector',
      operations: ['connector.read'],
      connectorId: 'connector.placeholder',
      resourceRoots: [],
    }],
    registeredAt,
    unavailableReason: 'No connector worker runtime is installed in this deployment.',
  },
];

const isCanonicalHttpOrigin = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      !parsed.username && !parsed.password && parsed.origin === value;
  } catch {
    return false;
  }
};

export const WEB_INSPECT_WORKER_ID = 'worker.browser.web_inspect';
export const BROWSER_WRITE_WORKER_ID = 'worker.browser.playwright';
export const DESKTOP_WORKER_ID = 'worker.desktop.windows_uia';

export const DESKTOP_V1_ACTIONS = [
  'desktop.discover',
  'desktop.inspect',
  'desktop.click',
  'desktop.type',
] as const;

/** Static executable allowlist; every action intent still narrows to an exact live snapshot. */
export const buildDesktopWorkerRegistration = (
  appIds: readonly string[],
  options: { available: boolean; reason?: string; registeredAt?: string },
): WorkerRegistration => {
  const normalizedAppIds = appIds.map((appId) => appId.trim());
  if (normalizedAppIds.length === 0 || new Set(normalizedAppIds).size !== normalizedAppIds.length ||
    normalizedAppIds.some((appId) => !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(appId))) {
    throw new Error('Desktop worker registration requires unique canonical application ids.');
  }
  return {
    id: DESKTOP_WORKER_ID,
    family: 'desktop',
    availability: options.available ? 'available' : 'unavailable',
    supportedActions: [...DESKTOP_V1_ACTIONS],
    configuredScopes: normalizedAppIds.map((appId) => ({
      family: 'desktop',
      operations: [...DESKTOP_V1_ACTIONS],
      appId,
    })),
    registeredAt: options.registeredAt ?? new Date().toISOString(),
    ...(options.available ? {} : {
      unavailableReason: options.reason?.trim() || 'The native desktop bridge is not available.',
    }),
  };
};

/**
 * Registration for the write-capable Playwright browser worker. Returns
 * undefined unless origins are allowlisted; the caller only supplies origins
 * once it has confirmed a real browser engine is installed, so the worker is
 * never advertised as available without a runtime behind it.
 */
export const buildBrowserWriteWorkerRegistration = (
  originsCsv: string | undefined,
  registeredAt = new Date().toISOString(),
): WorkerRegistration | undefined => {
  const origins = (originsCsv ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(isCanonicalHttpOrigin);
  if (origins.length === 0) return undefined;
  return {
    id: BROWSER_WRITE_WORKER_ID,
    family: 'browser',
    availability: 'available',
    supportedActions: ['browser.navigate', 'browser.click', 'browser.type'],
    configuredScopes: [{
      family: 'browser',
      operations: ['browser.navigate', 'browser.click', 'browser.type'],
      origins,
      downloadRoots: [],
    }],
    registeredAt,
  };
};

/**
 * Builds the runtime worker registrations. The read-only web-inspect worker
 * becomes available only when the operator allowlists origins through
 * WEB_INSPECT_ORIGINS; desktop and connector runtimes do not ship here and
 * always register as unavailable.
 */
export const buildWorkerRegistrations = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  registeredAt = new Date().toISOString(),
): WorkerRegistration[] => {
  const registrations = defaultWorkerRegistrations(registeredAt);
  const origins = (env.WEB_INSPECT_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(isCanonicalHttpOrigin);
  if (origins.length === 0) return registrations;

  return registrations.map((registration) => registration.family !== 'browser' ? registration : {
    id: WEB_INSPECT_WORKER_ID,
    family: 'browser',
    availability: 'available',
    supportedActions: ['browser.inspect'],
    configuredScopes: [{
      family: 'browser',
      operations: ['browser.inspect'],
      origins,
      downloadRoots: [],
    }],
    registeredAt,
  });
};

export interface AutomationContractInput {
  name: string;
  goalId: string;
  workerId: string;
  riskLevel: RiskLevel;
  action: CapabilityAction;
  scope: CapabilityScope;
  trigger: AutomationContract['trigger'];
  approvalMode: AutomationContract['approvalMode'];
  budget: AutomationContract['budget'];
}

export const isAutomationContractInput = (value: unknown): value is AutomationContractInput => {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.name) &&
    isNonEmptyString(value.goalId) &&
    isNonEmptyString(value.workerId) &&
    typeof value.riskLevel === 'string' &&
    riskLevels.has(value.riskLevel as RiskLevel) &&
    isCapabilityAction(value.action) &&
    isCapabilityScope(value.scope) &&
    isRecord(value.trigger) &&
    (value.approvalMode === 'per_run' || value.approvalMode === 'preapproved_l2') &&
    isRecord(value.budget)
  );
};

/** Builds a disabled automation contract; enabling is a separate explicit step. */
export const buildAutomationContract = (
  input: AutomationContractInput,
  now = new Date().toISOString(),
): AutomationContract => {
  const contract: AutomationContract = {
    schemaVersion: 1,
    id: createKernelId('automation'),
    name: input.name.trim(),
    enabled: false,
    goalId: input.goalId,
    workerId: input.workerId,
    riskLevel: input.riskLevel,
    action: input.action,
    scope: input.scope,
    trigger: input.trigger,
    approvalMode: input.approvalMode,
    budget: input.budget,
    createdAt: now,
    updatedAt: now,
  };
  const validation = validateAutomationContract(contract);
  if (!validation.valid) {
    throw new Error(`Invalid automation contract: ${validation.errors.join(' ')}`);
  }
  return contract;
};

/** A deterministic dry-run intent for policy evaluation; never dispatched. */
export const buildAutomationIntent = (
  automation: AutomationContract,
  now = new Date().toISOString(),
  approvalId?: string,
): ActionIntent => ({
  schemaVersion: 1,
  id: createKernelId('intent'),
  goalId: automation.goalId,
  taskId: `automation:${automation.id}`,
  workerId: automation.workerId,
  riskLevel: automation.riskLevel,
  action: automation.action,
  scope: automation.scope,
  authority: approvalId
    ? { kind: 'approval', referenceId: approvalId }
    : { kind: 'kernel_policy', referenceId: automation.id },
  untrustedObservationIds: [],
  createdAt: now,
});

export interface ReleaseProposalInput {
  title: string;
  targetVersion: string;
  contentHash: string;
  evaluationEventIds: string[];
  rollbackInstructions: string;
  signature?: string;
}

export const RELEASE_AUTHORIZATION_SCHEMA_VERSION = 1 as const;

export interface ReleaseAuthorizationPayload {
  schemaVersion: typeof RELEASE_AUTHORIZATION_SCHEMA_VERSION;
  targetVersion: string;
  contentHash: string;
  evaluationEventIds: string[];
  rollbackInstructions: string;
}

export type ReleaseAuthorizationSource = Pick<
  ReleaseProposalInput,
  'targetVersion' | 'contentHash' | 'evaluationEventIds' | 'rollbackInstructions'
>;

const normalizeEvaluationEventIds = (value: readonly string[]): string[] => {
  if (value.length === 0) throw new Error('At least one release evaluation event id is required.');
  const normalized = value.map((eventId) => eventId.trim());
  if (normalized.some((eventId) => eventId.length === 0)) {
    throw new Error('Release evaluation event ids cannot be blank.');
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('Release evaluation event ids must be unique.');
  }
  return normalized.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
};

const isEvaluationEventIdSet = (value: unknown): value is string[] => {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isNonEmptyString)) return false;
  const normalized = value.map((eventId) => eventId.trim());
  return normalized.every((eventId, index) => eventId === value[index]) &&
    new Set(normalized).size === normalized.length;
};

export const isReleaseProposalInput = (value: unknown): value is ReleaseProposalInput => {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.title) &&
    isNonEmptyString(value.targetVersion) &&
    isSha256(value.contentHash) &&
    isEvaluationEventIdSet(value.evaluationEventIds) &&
    isNonEmptyString(value.rollbackInstructions) &&
    (value.signature === undefined || isNonEmptyString(value.signature))
  );
};

export const buildReleaseProposal = (
  input: ReleaseProposalInput,
  now = new Date().toISOString(),
): ReleaseProposal => ({
  id: createKernelId('release'),
  title: input.title.trim(),
  targetVersion: input.targetVersion.trim(),
  contentHash: input.contentHash,
  evaluationEventIds: normalizeEvaluationEventIds(input.evaluationEventIds),
  rollbackInstructions: input.rollbackInstructions.trim(),
  signature: input.signature,
  activationState: 'proposed',
  createdAt: now,
  updatedAt: now,
});

/**
 * Builds the complete authorization document covered by a release signature.
 * Fixed property order plus a sorted evaluation set makes the UTF-8 JSON
 * representation deterministic across callers and runtimes.
 */
export const buildReleaseAuthorizationPayload = (
  release: ReleaseAuthorizationSource,
): ReleaseAuthorizationPayload => {
  const targetVersion = release.targetVersion.trim();
  const rollbackInstructions = release.rollbackInstructions.trim();
  if (!targetVersion) throw new Error('Release target version is required.');
  if (!isSha256(release.contentHash)) throw new Error('Release content hash must be a SHA-256 digest.');
  if (!rollbackInstructions) throw new Error('Release rollback instructions are required.');
  return {
    schemaVersion: RELEASE_AUTHORIZATION_SCHEMA_VERSION,
    targetVersion,
    contentHash: release.contentHash,
    evaluationEventIds: normalizeEvaluationEventIds(release.evaluationEventIds),
    rollbackInstructions,
  };
};

export const serializeReleaseAuthorizationPayload = (
  release: ReleaseAuthorizationSource,
): string => JSON.stringify(buildReleaseAuthorizationPayload(release));

const parseReleasePublicKey = (configuredKey: string): crypto.KeyObject => {
  if (configuredKey.includes('BEGIN')) return crypto.createPublicKey(configuredKey);
  return crypto.createPublicKey({
    key: Buffer.from(configuredKey, 'base64'),
    format: 'der',
    type: 'spki',
  });
};

export const verifyReleaseSignature = (
  configuredKey: string,
  release: ReleaseAuthorizationSource,
  signatureBase64: string,
): boolean => {
  try {
    return crypto.verify(
      null,
      Buffer.from(serializeReleaseAuthorizationPayload(release), 'utf8'),
      parseReleasePublicKey(configuredKey),
      Buffer.from(signatureBase64, 'base64'),
    );
  } catch {
    return false;
  }
};

/**
 * Activation succeeds only when a user-controlled verification key is
 * configured and the proposal's Ed25519 signature covers the complete,
 * versioned release authorization payload. Every other case is blocked with a
 * recorded reason: unsigned proposals cannot activate core changes, and signed
 * ones stay blocked when no key is installed or verification fails.
 */
export const decideReleaseActivation = (
  proposal: ReleaseProposal,
  configuredPublicKey?: string,
  now = new Date().toISOString(),
): ReleaseProposal => {
  if (proposal.activationState === 'rejected') {
    throw new Error('Rejected release proposals cannot be activated.');
  }
  if (!proposal.signature) {
    return {
      ...proposal,
      activationState: 'blocked',
      activationReason: 'Unsigned release proposals cannot activate core changes.',
      updatedAt: now,
    };
  }
  if (!configuredPublicKey?.trim()) {
    return {
      ...proposal,
      activationState: 'blocked',
      activationReason: 'No release signing verification key is installed in this deployment.',
      updatedAt: now,
    };
  }
  if (!verifyReleaseSignature(configuredPublicKey.trim(), proposal, proposal.signature)) {
    return {
      ...proposal,
      activationState: 'blocked',
      activationReason: 'Release signature failed verification against the configured key.',
      updatedAt: now,
    };
  }
  return {
    ...proposal,
    activationState: 'activated',
    activationReason: 'Ed25519 signature verified for the canonical release authorization payload.',
    updatedAt: now,
  };
};

export const rejectReleaseProposal = (
  proposal: ReleaseProposal,
  reason: string,
  now = new Date().toISOString(),
): ReleaseProposal => {
  if (!reason.trim()) throw new Error('Release rejection reason is required.');
  if (proposal.activationState === 'rejected') throw new Error('Release proposal is already rejected.');
  return {
    ...proposal,
    activationState: 'rejected',
    activationReason: reason.trim(),
    updatedAt: now,
  };
};

/** Projects a finished goal's recorded state into a benchmark record. */
export const buildBenchmarkRun = (
  goal: GoalContract,
  tasks: readonly KernelTask[],
  approvals: readonly ApprovalRecord[],
  events: readonly KernelEvent[],
  now = new Date().toISOString(),
): BenchmarkRun => {
  if (goal.status !== 'completed' && goal.status !== 'failed') {
    throw new Error('Benchmark runs can only be recorded for completed or failed goals.');
  }
  const goalTasks = tasks.filter((task) => task.goalId === goal.id);
  const providerCallCount = events.filter((event) => (
    event.entityType === 'provider' &&
    event.type === 'provider.call.completed' &&
    event.payload.goalId === goal.id
  )).length;
  return {
    id: createKernelId('benchmark'),
    goalId: goal.id,
    objective: goal.objective,
    completion: goal.status,
    taskDefinitions: goalTasks.map((task) => ({
      taskId: task.id,
      title: task.title,
      expectedEvidence: task.expectedEvidence,
      status: task.status,
    })),
    interventionCount: approvals.filter((approval) => approval.goalId === goal.id).length,
    commandRuntimeMs: goal.usage.commandRuntimeMs,
    providerCallCount,
    evidenceEventIds: goalTasks.flatMap((task) => task.evidenceEventIds),
    createdAt: now,
  };
};

export type FeatureAvailability = 'available' | 'configured' | 'unavailable' | 'blocked';

export interface RuntimeFeatureStatus {
  status: FeatureAvailability;
  reason: string;
}

export interface RuntimeCapabilityReport {
  providers: { configured: string[]; unavailable: Array<{ id: string; reason: string }> };
  workers: WorkerAvailabilityReport;
  features: Record<string, RuntimeFeatureStatus>;
  generatedAt: string;
}

export interface RuntimeReportInput {
  providerStatuses: ReadonlyArray<{ id: string; configured: boolean; unavailableReason?: string }>;
  workerReport: WorkerAvailabilityReport;
  stopAll: boolean;
  coreModel?: { status: 'available' | 'unavailable'; reason: string };
  releaseSigningConfigured?: boolean;
  releaseDeployment?: RuntimeFeatureStatus;
  secretVault?: { status: 'available' | 'unavailable'; reason: string };
  accessControl?: { status: 'available' | 'unavailable'; reason: string };
  osSandbox?: { status: 'available' | 'unavailable'; reason: string };
  recurringResearchScheduler?: {
    available: boolean;
    enabled: boolean;
    running: boolean;
    tickInProgress: boolean;
    tickIntervalMs: number;
    reason: string;
    lastTickAt?: string;
    lastOutcome?: string;
    lastError?: string;
  };
  desktopIpc?: RuntimeFeatureStatus;
  now?: string;
}

export const buildRuntimeCapabilityReport = (input: RuntimeReportInput): RuntimeCapabilityReport => {
  const configuredProviders = input.providerStatuses.filter((status) => status.configured).map((status) => status.id);
  const unavailableProviders = input.providerStatuses
    .filter((status) => !status.configured)
    .map((status) => ({ id: status.id, reason: status.unavailableReason ?? 'Server-side credentials are not configured.' }));
  const hasAvailableWorker = input.workerReport.available.length > 0;
  const hasResearchWorker = input.workerReport.available.includes(WEB_INSPECT_WORKER_ID);
  const hasDesktopWorker = input.workerReport.available.includes(DESKTOP_WORKER_ID);
  const recurringScheduler = input.recurringResearchScheduler;
  const recurringSchedulerStatus: RuntimeFeatureStatus = !recurringScheduler
    ? {
      status: 'unavailable',
      reason: 'No durable recurring research scheduler is installed in this server process.',
    }
    : input.stopAll
      ? {
        status: 'blocked',
        reason: 'Stop All is active; recurring research dispatch and in-flight work are halted.',
      }
      : !recurringScheduler.enabled || !recurringScheduler.available
        ? { status: 'unavailable', reason: recurringScheduler.reason }
        : !recurringScheduler.running
          ? {
            status: 'configured',
            reason: `The durable scheduler is configured at ${recurringScheduler.tickIntervalMs} ms but its clock is stopped.`,
          }
          : recurringScheduler.lastError
            ? {
              status: 'blocked',
              reason: `The durable scheduler clock is running but its last tick failed: ${recurringScheduler.lastError}`,
            }
            : {
              status: 'available',
              reason: `Durable interval scheduling is running every ${recurringScheduler.tickIntervalMs} ms${
                recurringScheduler.tickInProgress ? ' with a tick in progress' : ''
              }${recurringScheduler.lastOutcome ? `; last outcome: ${recurringScheduler.lastOutcome}` : ''}.`,
            };

  const features: Record<string, RuntimeFeatureStatus> = {
    verificationCommands: {
      status: input.stopAll ? 'blocked' : 'available',
      reason: input.stopAll
        ? 'Stop All is active; command execution is halted until resumed.'
        : 'Allowlisted npm verification commands run inside the configured workspace.',
    },
    providerCalls: {
      status: input.stopAll ? 'blocked' : configuredProviders.length > 0 ? 'available' : 'unavailable',
      reason: input.stopAll
        ? 'Stop All is active; provider calls are halted until resumed.'
        : configuredProviders.length > 0
          ? `Configured providers: ${configuredProviders.join(', ')}.`
          : 'No provider has server-side credentials configured.',
    },
    backgroundAutomation: {
      status: hasAvailableWorker ? (input.stopAll ? 'blocked' : 'configured') : 'unavailable',
      reason: hasAvailableWorker
        ? input.stopAll
          ? 'Stop All is active; automations cannot be enabled until resumed.'
          : 'A registered worker is available; automations still require explicit enablement.'
        : 'No capability worker runtime is available, so automations cannot execute.',
    },
    recurringResearchScheduler: recurringSchedulerStatus,
    coreModel: input.coreModel
      ? { status: input.coreModel.status, reason: input.coreModel.reason }
      : { status: 'unavailable', reason: 'No core model runtime is configured.' },
    secretVault: input.secretVault
      ? { status: input.secretVault.status, reason: input.secretVault.reason }
      : {
        status: 'unavailable',
        reason: 'No operating-system vault adapter is installed; credentials come from server environment variables.',
      },
    accessControl: input.accessControl ?? {
      status: 'unavailable',
      reason: 'No operator API token is configured; mutating requests are open on loopback.',
    },
    osSandbox: input.osSandbox ?? {
      status: 'unavailable',
      reason: 'No operating-system sandbox confines project scripts; verification runs on the trusted host.',
    },
    releaseSigning: {
      status: input.releaseSigningConfigured ? 'configured' : 'unavailable',
      reason: input.releaseSigningConfigured
        ? 'A release signing verification key is installed; correctly signed proposals can activate.'
        : 'No release signing verification key is installed; release proposals cannot activate.',
    },
    verifiedResearchReports: {
      status: input.stopAll
        ? 'blocked'
        : configuredProviders.length > 0 && hasResearchWorker ? 'available' : 'unavailable',
      reason: input.stopAll
        ? 'Stop All is active; research missions cannot dispatch provider or source steps.'
        : configuredProviders.length === 0
          ? 'No configured provider can plan, synthesize, and critique a report.'
          : !hasResearchWorker
            ? 'No allowlisted read-only web inspection worker is available for source capture.'
            : 'Explicit allowlisted sources can be captured, citation-checked, critiqued, and published as authenticated reports.',
    },
    releaseDeployment: input.releaseDeployment ?? {
      status: 'unavailable',
      reason: 'No supervised core-release process runtime is installed.',
    },
    desktopIpc: input.desktopIpc ?? {
      status: 'unavailable',
      reason: 'No Rust/Tauri desktop shell or authenticated IPC channel is installed.',
    },
    desktopAutomation: {
      status: input.stopAll
        ? 'blocked'
        : hasDesktopWorker ? 'available' : input.desktopIpc?.status ?? 'unavailable',
      reason: input.stopAll
        ? 'Stop All is active; desktop inspection and actions are halted.'
        : hasDesktopWorker
          ? 'Windows UI Automation is available through exact-snapshot capability grants; desktop writes require explicit L2 approval.'
          : input.desktopIpc?.reason ?? 'No authenticated Windows UI Automation worker is available.',
    },
  };

  return {
    providers: { configured: configuredProviders, unavailable: unavailableProviders },
    workers: input.workerReport,
    features,
    generatedAt: input.now ?? new Date().toISOString(),
  };
};

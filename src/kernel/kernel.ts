import crypto from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { createCapabilityGrant } from '../capabilities/grants';
import {
  authorizeCapabilityDispatch,
  type CapabilityDispatchAuthorization,
} from '../capabilities/dispatch';
import {
  createMemoryCapabilityGrantStore,
  type CapabilityGrantStore,
} from '../capabilities/grantStore';
import { analyzePromptInjection, createUntrustedObservation } from '../capabilities/injection';
import { CapabilityPolicyDecision, decideActionPolicy } from '../capabilities/policy';
import { createWorkerRegistry } from '../capabilities/registry';
import type {
  ActionIntent,
  AutomationContract,
  PromptInjectionSignalCode,
  WorkerRegistration,
} from '../capabilities/types';
import { ProviderRouter } from '../providers/router';
import { ProviderExecution, ProviderRequest, ProviderRoutePlan, ProviderRoutingPolicy } from '../providers/types';
import { createApprovalRecord, decideApprovalRecord } from './approvals';
import {
  buildAutomationContract,
  buildAutomationIntent,
  buildBenchmarkRun,
  buildReleaseProposal,
  defaultWorkerRegistrations,
  isAutomationContractInput,
  isReleaseProposalInput,
  rejectReleaseProposal,
} from './autonomy';
import { createEmptyUsage, reserveBudget } from './budget';
import { createCapabilityToken, useCapabilityToken } from './capabilities';
import { isGoalContractInput } from './guards';
import { createKernelId } from './ids';
import { appendKernelEvent, KernelEventInput, readKernelEvents } from './ledger';
import {
  CreateMemoryCandidateInput,
  createMemoryCandidate as createMemoryCandidateRecord,
  createMemoryLedgerPayload,
  hashMemoryContent,
  listActiveMemories,
  promoteMemoryRecord,
  revokeMemoryRecord,
} from './memory';
import { decidePolicyForCommand } from './policy';
import { evaluateSkillPackage, getSkillEvaluationLedgerMetadata } from './skills/evaluation';
import {
  activateSkillCanary,
  applySkillEvaluation,
  createSkillCandidate,
  getKernelCanaryCase,
  getSkillActivationLedgerMetadata,
  getSkillPackageLedgerMetadata,
  promoteSkill,
  recordCanaryRun,
  rollbackSkill,
} from './skills/foundry';
import { runPureTransform, stableHash } from './skills/runtime';
import { synthesizePureTransform } from './skills/synthesizer';
import {
  buildResearchCritiqueRequest,
  buildResearchDraftRequest,
  buildResearchMissionGoal,
  buildResearchPlanRequest,
  buildResearchVerification,
  type CapturedResearchSource,
  chunkResearchSource,
  MAX_RESEARCH_SOURCES,
  MAX_RESEARCH_SYNTHESIS_ATTEMPTS,
  normalizeResearchMissionInput,
  parseResearchCritique,
  parseResearchDraft,
  parseResearchPlan,
  renderVerifiedResearchReport,
  RESEARCH_PROVIDER_TIMEOUT_MS,
  verifyResearchDraft,
} from './missions/research';
import {
  calculateNextResearchDue,
  claimResearchOccurrence,
  createRecurringResearchOccurrenceId,
  createDueResearchOccurrence,
  createRecurringResearchSchedule,
  finishResearchOccurrence,
  MAX_RESEARCH_INTERVAL_MS,
  MIN_RESEARCH_INTERVAL_MS,
  resumeResearchOccurrence,
  skipResearchOccurrence,
  startResearchOccurrence,
  updateRecurringResearchSchedule,
  validateRecurringResearchSchedule,
  type RecurringResearchBudget,
  type RecurringResearchOccurrenceStatus,
} from './scheduler';
import {
  clearPendingKernelSnapshot,
  hashKernelStateContent,
  PendingKernelSnapshot,
  readKernelRecoveryState,
  readKernelState,
  readPendingKernelSnapshot,
  writeKernelRecoveryState,
  writeKernelState,
  writePendingKernelSnapshot,
} from './store';
import { buildInitialTaskGraph, getNextReadyTask, markTaskStatus } from './taskGraph';
import {
  ApprovalStatus,
  BenchmarkRun,
  CapabilityToken,
  GoalContract,
  GoalContractInput,
  KernelCommandRequest,
  KernelControls,
  KernelEvidence,
  KernelEvent,
  KernelMemoryRecord,
  KernelState,
  KernelTask,
  MemoryEvidenceRef,
  ReleaseProposal,
  RecurringResearchKernelState,
  RecurringResearchOccurrenceRecord,
  RecurringResearchScheduleRecord,
  ResearchMission,
  ResearchMissionActiveStep,
  ResearchMissionProviderRun,
  ResearchMissionSource,
  ResearchMissionStage,
  SkillActivation,
  SkillCase,
  SkillEvaluation,
  SkillManifest,
  SkillPackage,
} from './types';
import type { ArtifactMetadata, ArtifactStore } from './artifacts/artifactStore';
import type { SandboxRunner } from './sandbox/sandbox';
import type { createReleaseLifecycle } from './releases/lifecycle';
import { runKernelCommand } from './workers/commandWorker';

export interface KernelActionWorkerResult {
  status: 'succeeded' | 'failed' | 'uncertain';
  summary: string;
  sourceRef: string;
  content?: string;
  errorCode?: string;
}

export interface KernelActionWorker {
  execute(intent: ActionIntent, options: {
    timeoutMs: number;
    authorization?: CapabilityDispatchAuthorization;
    signal?: AbortSignal;
  }): Promise<KernelActionWorkerResult>;
}

/** May only tighten: heuristic assessment stays the floor on any failure. */
export type KernelObservationAssessor = (content: string) => Promise<{
  risk: 'none' | 'medium' | 'high';
  signals: ReadonlyArray<{ code: PromptInjectionSignalCode }>;
}>;

export interface AutomationRunOutcome {
  decision: CapabilityPolicyDecision;
  approvalId?: string;
  dispatch?: {
    status: 'succeeded' | 'failed' | 'uncertain';
    summary: string;
    sourceRef: string;
    errorCode?: string;
  };
  observation?: {
    id: string;
    source: 'web' | 'screen';
    artifactId?: string;
    contentHash: string;
    risk: 'none' | 'medium' | 'high';
    injectionSignalCodes: PromptInjectionSignalCode[];
  };
  content?: string;
}

export interface KernelServiceOptions {
  runtimeDir: string;
  allowedWorkspaceRoot?: string;
  providerRouter?: ProviderRouter;
  workerRegistrations?: WorkerRegistration[];
  releaseSigningPublicKey?: string;
  actionWorkers?: Record<string, KernelActionWorker>;
  observationAssessor?: KernelObservationAssessor;
  sandbox?: SandboxRunner;
  artifactStore?: ArtifactStore;
  capabilityGrantStore?: CapabilityGrantStore;
  releaseLifecycle?: ReturnType<typeof createReleaseLifecycle>;
  researchRoutingPolicy?: ProviderRoutingPolicy;
  researchProviderConfigured?: boolean;
  researchWorkerId?: string;
  providerTimeoutMs?: number;
  recurringResearchSchedulerEnabled?: boolean;
  recurringResearchTickMs?: number;
  schedulerInstanceId?: string;
}

export interface KernelStepResult {
  status: 'passed' | 'failed' | 'blocked' | 'denied' | 'approval_required' | 'completed';
  reason?: string;
  evidence?: KernelEvidence;
  approvalId?: string;
}

export interface ResearchMissionStepResult {
  outcome: 'advanced' | 'in_progress' | 'blocked' | 'completed';
  mission: ResearchMission;
}

export interface ResearchMissionCapability {
  available: boolean;
  reason: string;
  allowedOrigins: string[];
  maxSources: number;
}

export interface RecurringResearchCapability {
  available: boolean;
  reason: string;
  schedulerEnabled: boolean;
  tickIntervalMs: number;
  minIntervalMinutes: number;
  maxIntervalMinutes: number;
  allowedOrigins: string[];
  maxSources: number;
}

interface InterruptedTaskRecoveryResult {
  recoveredTaskIds: string[];
  recoveredOccurrenceIds: string[];
  reconciledOccurrenceIds: string[];
}

export interface RecurringResearchScheduleInput {
  objective: string;
  sourceUrls: string[];
  intervalMinutes: number;
  startsAt?: string;
  maxRuns?: number;
  maxConsecutiveFailures?: number;
  maxRuntimeMinutes?: number;
}

export interface RecurringResearchTickResult {
  outcome: 'idle' | 'started' | 'completed' | 'blocked' | 'failed' | 'stopped';
  schedule?: RecurringResearchScheduleRecord;
  occurrence?: RecurringResearchOccurrenceRecord;
  mission?: ResearchMission;
  reason?: string;
}

export type KernelMemoryCandidateInput = Omit<CreateMemoryCandidateInput, 'evidenceRefs'> & {
  evidenceRefs?: MemoryEvidenceRef[];
};

export interface KernelSkillSynthesisInput {
  manifest: SkillManifest;
  trainingCases: SkillCase[];
  replayCases: SkillCase[];
  previousVersionId?: string;
}

const isWithinRoot = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const SNAPSHOT_COMMITTED_EVENT_TYPE = 'system.snapshot_committed';
const SNAPSHOT_PREPARED_EVENT_TYPE = 'system.snapshot_prepared';

const isSnapshotCommitEvent = (event: KernelEvent): boolean => (
  event.type === SNAPSHOT_COMMITTED_EVENT_TYPE &&
  event.entityType === 'system' &&
  event.entityId === 'kernel-state'
);

const isSnapshotPreparedEvent = (event: KernelEvent): boolean => (
  event.type === SNAPSHOT_PREPARED_EVENT_TYPE &&
  event.entityType === 'system' &&
  event.entityId === 'kernel-state'
);

const eventSnapshotHash = (event: KernelEvent): string | null => (
  (isSnapshotCommitEvent(event) || isSnapshotPreparedEvent(event)) && typeof event.payload.stateHash === 'string'
    ? event.payload.stateHash
    : null
);

const sourceBackedMemoryEventTypes = new Set([
  'memory.source_attested',
  'goal.created',
  'task.passed',
  'provider.call.completed',
  'automation.run_completed',
  'artifact.created',
  'benchmark.recorded',
]);

const isIndependentMemoryEvidence = (
  event: KernelEvent,
  record: KernelMemoryRecord,
  reference: MemoryEvidenceRef,
): boolean => {
  if (
    event.entityId === record.id ||
    event.type === 'memory.candidate_created' ||
    !sourceBackedMemoryEventTypes.has(event.type)
  ) {
    return false;
  }
  if (reference.artifactId) {
    return event.entityId === reference.artifactId || event.payload.artifactId === reference.artifactId;
  }
  if (record.provenance.sourceType === 'provider_candidate') {
    return event.type === 'provider.call.completed' && (
      event.id === record.provenance.sourceId || event.entityId === record.provenance.sourceId
    );
  }
  if (record.provenance.sourceType === 'kernel_event') {
    return event.id === record.provenance.sourceId;
  }
  if (event.type === 'memory.source_attested') {
    return event.payload.sourceType === record.provenance.sourceType &&
      event.payload.sourceId === record.provenance.sourceId &&
      event.payload.contentHash === record.contentHash;
  }
  return true;
};

const researchReportInputHash = (mission: ResearchMission): string => stableHash({
  missionId: mission.id,
  revision: mission.revision,
  objective: mission.objective,
  sources: mission.sources.map((source) => ({
    id: source.id,
    url: source.url,
    origin: source.origin,
    status: source.status,
    artifactId: source.artifactId,
    contentHash: source.contentHash,
    chunks: source.chunks,
    observationRisk: source.observationRisk,
    evidenceEventId: source.evidenceEventId,
  })),
  draft: mission.draft,
  verification: mission.verification,
  providerRuns: mission.providerRuns,
});

const exactStringArray = (value: unknown, expected: readonly string[]): boolean => (
  Array.isArray(value) &&
  value.length === expected.length &&
  value.every((item, index) => typeof item === 'string' && item === expected[index])
);

const RECURRING_RESEARCH_STATE_SCHEMA = 1 as const;
const RECURRING_RESEARCH_DEFAULT_TICK_MS = 15_000;
const RECURRING_RESEARCH_MIN_TICK_MS = 1_000;
const RECURRING_RESEARCH_MAX_TICK_MS = 60_000;
const RECURRING_RESEARCH_MAX_RUNS = 1_000;
const RECURRING_RESEARCH_MAX_FAILURES = 100;
const RECURRING_RESEARCH_LEASE_GRACE_MS = 60_000;
const OBSERVATION_ASSESSOR_TIMEOUT_MS = 30_000;

const awaitAbortable = <T>(
  operation: Promise<T>,
  signal: AbortSignal,
  message: string,
): Promise<T> => new Promise<T>((resolve, reject) => {
  const rejectAbort = () => {
    const error = new Error(message);
    error.name = 'AbortError';
    reject(error);
  };
  if (signal.aborted) {
    rejectAbort();
    return;
  }
  const onAbort = () => rejectAbort();
  signal.addEventListener('abort', onAbort, { once: true });
  operation.then(
    (value) => {
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    },
    (error) => {
      signal.removeEventListener('abort', onAbort);
      reject(error);
    },
  );
});

const emptyRecurringResearchState = (): RecurringResearchKernelState => ({
  schemaVersion: RECURRING_RESEARCH_STATE_SCHEMA,
  schedules: [],
  occurrences: [],
});

const recurringOccurrenceStatuses = new Set([
  'due', 'claimed', 'running', 'completed', 'failed', 'blocked', 'uncertain', 'skipped',
]);

const isCanonicalRecurringTimestamp = (value: unknown): value is string => {
  if (typeof value !== 'string' || !value.trim()) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
};

const recurringResearchState = (state: KernelState): RecurringResearchKernelState => {
  const recurring = state.recurringResearch ?? emptyRecurringResearchState();
  if (recurring.schemaVersion !== 1 || !Array.isArray(recurring.schedules) || !Array.isArray(recurring.occurrences)) {
    throw new Error('Recurring research state schema is invalid.');
  }
  const scheduleIds = new Set<string>();
  for (const record of recurring.schedules) {
    const contract = validateRecurringResearchSchedule(record.contract);
    if (scheduleIds.has(contract.id)) throw new Error('Recurring research schedule ids must be unique.');
    scheduleIds.add(contract.id);
    if (
      !Number.isSafeInteger(record.maxRuns) || record.maxRuns < 1 ||
      !Number.isSafeInteger(record.maxConsecutiveFailures) || record.maxConsecutiveFailures < 1 ||
      !Number.isSafeInteger(record.runsClaimed) || record.runsClaimed < 0 || record.runsClaimed > record.maxRuns ||
      !Number.isSafeInteger(record.consecutiveFailures) || record.consecutiveFailures < 0 ||
      !isCanonicalRecurringTimestamp(record.nextDueAt) ||
      (record.scheduledThrough !== undefined && !isCanonicalRecurringTimestamp(record.scheduledThrough))
    ) {
      throw new Error(`Recurring research schedule record is invalid: ${contract.id}.`);
    }
  }

  const occurrenceIds = new Set<string>();
  for (const occurrence of recurring.occurrences) {
    const schedule = recurring.schedules.find((candidate) => candidate.contract.id === occurrence.scheduleId);
    if (
      occurrenceIds.has(occurrence.id) ||
      !schedule ||
      !recurringOccurrenceStatuses.has(occurrence.status) ||
      occurrence.id !== createRecurringResearchOccurrenceId(
        occurrence.scheduleId,
        occurrence.scheduleVersion,
        occurrence.scheduledFor,
      ) ||
      !isCanonicalRecurringTimestamp(occurrence.createdAt) ||
      !isCanonicalRecurringTimestamp(occurrence.updatedAt) ||
      !isCanonicalRecurringTimestamp(occurrence.deadlineAt) ||
      !occurrence.lease ||
      !isCanonicalRecurringTimestamp(occurrence.lease.claimedAt) ||
      !isCanonicalRecurringTimestamp(occurrence.lease.expiresAt) ||
      typeof occurrence.lease.owner !== 'string' || !occurrence.lease.owner.trim() ||
      typeof occurrence.leaseId !== 'string' || !occurrence.leaseId.trim() ||
      !Number.isSafeInteger(occurrence.leaseFence) || occurrence.leaseFence < 1 ||
      typeof occurrence.goalId !== 'string' || !occurrence.goalId.trim() ||
      typeof occurrence.missionId !== 'string' || !occurrence.missionId.trim() ||
      !Number.isSafeInteger(occurrence.attempt) || occurrence.attempt < 1 ||
      !Array.isArray(occurrence.evidenceRefs) ||
      (occurrence.runtimeUsedMs !== undefined && (
        !Number.isSafeInteger(occurrence.runtimeUsedMs) ||
        occurrence.runtimeUsedMs < 0 ||
        occurrence.runtimeUsedMs > schedule.contract.budget.maxRuntimeMs
      )) ||
      (occurrence.attemptStartedAt !== undefined && !isCanonicalRecurringTimestamp(occurrence.attemptStartedAt)) ||
      (occurrence.sourceFetchesUsed !== undefined && (
        !Number.isSafeInteger(occurrence.sourceFetchesUsed) ||
        occurrence.sourceFetchesUsed < 0 ||
        occurrence.sourceFetchesUsed > schedule.contract.budget.maxSourceFetches
      ))
    ) {
      throw new Error(`Recurring research occurrence record is invalid: ${occurrence.id || 'unknown'}.`);
    }
    occurrenceIds.add(occurrence.id);
  }

  for (const schedule of recurring.schedules) {
    const occurrences = recurring.occurrences.filter((candidate) => candidate.scheduleId === schedule.contract.id);
    if (schedule.runsClaimed !== occurrences.length) {
      throw new Error(`Recurring research schedule run counter is inconsistent: ${schedule.contract.id}.`);
    }
    if (schedule.lastOccurrenceId && !occurrences.some((candidate) => candidate.id === schedule.lastOccurrenceId)) {
      throw new Error(`Recurring research schedule last occurrence is invalid: ${schedule.contract.id}.`);
    }
    if (schedule.activeOccurrenceId) {
      const active = occurrences.find((candidate) => candidate.id === schedule.activeOccurrenceId);
      if (!active || !['claimed', 'running', 'blocked', 'uncertain'].includes(active.status)) {
        throw new Error(`Recurring research schedule active occurrence is invalid: ${schedule.contract.id}.`);
      }
    }
  }
  return recurring;
};

const chargedRecurringRuntimeMs = (
  occurrence: RecurringResearchOccurrenceRecord,
  now: string,
  maximum: number,
): number => {
  const alreadyCharged = Math.max(0, occurrence.runtimeUsedMs ?? 0);
  const attemptStartedAt = occurrence.attemptStartedAt ?? occurrence.lease?.claimedAt;
  if (!attemptStartedAt) return Math.min(maximum, alreadyCharged);
  const elapsed = Math.max(0, Date.parse(now) - Date.parse(attemptStartedAt));
  return Math.min(maximum, alreadyCharged + elapsed);
};

const safeBoundedInteger = (
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  field: string,
): number => {
  const candidate = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(candidate) || (candidate as number) < minimum || (candidate as number) > maximum) {
    throw new Error(`${field} must be an integer from ${minimum} to ${maximum}.`);
  }
  return candidate as number;
};

const canonicalOptionalTimestamp = (value: unknown, fallback: string): string => {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !value.trim()) throw new Error('startsAt must be a canonical ISO timestamp.');
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error('startsAt must be a canonical ISO timestamp.');
  }
  return value;
};

const normalizeRecurringResearchScheduleInput = (
  value: unknown,
  now: string,
): {
  objective: string;
  sourceUrls: string[];
  intervalMs: number;
  startsAt: string;
  maxRuns: number;
  maxConsecutiveFailures: number;
  budget: RecurringResearchBudget;
} => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Recurring research schedule input must be an object.');
  }
  const input = value as Partial<RecurringResearchScheduleInput>;
  const intervalMinutes = safeBoundedInteger(
    input.intervalMinutes,
    60,
    MIN_RESEARCH_INTERVAL_MS / 60_000,
    MAX_RESEARCH_INTERVAL_MS / 60_000,
    'intervalMinutes',
  );
  const maxRuntimeMinutes = safeBoundedInteger(input.maxRuntimeMinutes, 10, 1, 15, 'maxRuntimeMinutes');
  const sourceUrls = Array.isArray(input.sourceUrls) ? input.sourceUrls : [];
  return {
    objective: typeof input.objective === 'string' ? input.objective : '',
    sourceUrls,
    intervalMs: intervalMinutes * 60_000,
    startsAt: canonicalOptionalTimestamp(input.startsAt, now),
    maxRuns: safeBoundedInteger(input.maxRuns, 100, 1, RECURRING_RESEARCH_MAX_RUNS, 'maxRuns'),
    maxConsecutiveFailures: safeBoundedInteger(
      input.maxConsecutiveFailures,
      3,
      1,
      RECURRING_RESEARCH_MAX_FAILURES,
      'maxConsecutiveFailures',
    ),
    budget: {
      maxRuntimeMs: maxRuntimeMinutes * 60_000,
      maxProviderCalls: 8,
      maxSourceFetches: sourceUrls.length * 3,
      maxAttempts: 3,
    },
  };
};

export const createKernelService = (options: KernelServiceOptions) => {
  const workerRegistry = createWorkerRegistry(options.workerRegistrations ?? defaultWorkerRegistrations());
  const capabilityGrantStore = options.capabilityGrantStore ?? createMemoryCapabilityGrantStore();
  const activeProviderControllers = new Map<string, AbortController>();
  const activeActionControllers = new Map<string, AbortController>();
  const activeRecurringResearchControllers = new Map<string, AbortController>();
  const schedulerInstanceId = options.schedulerInstanceId?.trim() || `scheduler_${crypto.randomUUID()}`;
  const configuredTickMs = options.recurringResearchTickMs ?? RECURRING_RESEARCH_DEFAULT_TICK_MS;
  const recurringResearchTickMs = Number.isSafeInteger(configuredTickMs)
    ? Math.max(RECURRING_RESEARCH_MIN_TICK_MS, Math.min(configuredTickMs, RECURRING_RESEARCH_MAX_TICK_MS))
    : RECURRING_RESEARCH_DEFAULT_TICK_MS;
  let mutationQueue: Promise<void> = Promise.resolve();
  let recoveryInProgress = false;
  let recoveryPromise: Promise<InterruptedTaskRecoveryResult> | undefined;

  const withMutation = <T>(work: () => Promise<T>): Promise<T> => {
    const result = mutationQueue.then(work, work);
    mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  };

  const assessObservation = async (content: string, parentSignal?: AbortSignal) => {
    if (!options.observationAssessor) return undefined;
    const controller = new AbortController();
    const abortFromParent = () => controller.abort();
    if (parentSignal?.aborted) controller.abort();
    else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
    const timeout = setTimeout(() => controller.abort(), OBSERVATION_ASSESSOR_TIMEOUT_MS);
    timeout.unref?.();
    try {
      if (controller.signal.aborted) throw new Error('Observation assessment was cancelled before dispatch.');
      return await awaitAbortable(
        options.observationAssessor(content),
        controller.signal,
        'Observation assessment was cancelled before completion.',
      );
    } finally {
      clearTimeout(timeout);
      parentSignal?.removeEventListener('abort', abortFromParent);
    }
  };

  const appendEvent = async (state: KernelState, input: KernelEventInput) => {
    const event = await appendKernelEvent(options.runtimeDir, state.lastEventHash, input);
    return { event, state: { ...state, lastEventHash: event.hash } };
  };

  const finishPendingSnapshot = async (
    pending: PendingKernelSnapshot,
    committedEvent?: KernelEvent,
  ): Promise<KernelState> => {
    const events = await readKernelEvents(options.runtimeDir);
    const prepared = events.find((candidate) => candidate.hash === pending.baseEventHash);
    if (
      !prepared ||
      !isSnapshotPreparedEvent(prepared) ||
      prepared.payload.baseEventHash !== prepared.previousHash ||
      eventSnapshotHash(prepared) !== pending.stateHash
    ) {
      throw new Error('Pending kernel snapshot is not authenticated by a preparation event.');
    }
    const event = committedEvent ?? await appendKernelEvent(
      options.runtimeDir,
      pending.baseEventHash,
      {
        actor: 'system',
        type: SNAPSHOT_COMMITTED_EVENT_TYPE,
        entityId: 'kernel-state',
        entityType: 'system',
        payload: {
          schemaVersion: 1,
          baseEventHash: pending.baseEventHash,
          preparedEventHash: prepared.hash,
          stateHash: pending.stateHash,
        },
      },
    );
    if (
      event.previousHash !== pending.baseEventHash ||
      event.payload.baseEventHash !== pending.baseEventHash ||
      event.payload.preparedEventHash !== prepared.hash ||
      eventSnapshotHash(event) !== pending.stateHash
    ) {
      throw new Error('Kernel snapshot commit does not match its pending content.');
    }
    const committedState = { ...pending.state, lastEventHash: event.hash };
    await writeKernelState(options.runtimeDir, committedState);
    await writeKernelRecoveryState(options.runtimeDir, committedState);
    await clearPendingKernelSnapshot(options.runtimeDir);
    return committedState;
  };

  const commitState = async (state: KernelState): Promise<KernelState> => {
    const events = await readKernelEvents(options.runtimeDir);
    const ledgerHead = events.at(-1)?.hash ?? null;
    if (state.lastEventHash !== ledgerHead) {
      throw new Error('Kernel snapshot commit base does not match the event ledger.');
    }
    const stateHash = hashKernelStateContent(state);
    const prepared = await appendKernelEvent(options.runtimeDir, state.lastEventHash, {
      actor: 'system',
      type: SNAPSHOT_PREPARED_EVENT_TYPE,
      entityId: 'kernel-state',
      entityType: 'system',
      payload: {
        schemaVersion: 1,
        baseEventHash: state.lastEventHash,
        stateHash,
      },
    });
    const preparedState = { ...state, lastEventHash: prepared.hash };
    const pending: PendingKernelSnapshot = {
      schemaVersion: 1,
      baseEventHash: prepared.hash,
      stateHash,
      state: preparedState,
    };
    await writePendingKernelSnapshot(options.runtimeDir, pending);
    return finishPendingSnapshot(pending);
  };

  const normalizeWorkspaceRoot = async (requestedRoot: string): Promise<string> => {
    const configuredRoot = await realpath(options.allowedWorkspaceRoot ?? process.cwd());
    const candidateRoot = await realpath(requestedRoot);
    if (!isWithinRoot(configuredRoot, candidateRoot)) {
      throw new Error('Goal workspace is outside the configured kernel workspace.');
    }
    return candidateRoot;
  };

  const readConsistentState = async (): Promise<KernelState> => {
    const [state, recoveryState, pending, events] = await Promise.all([
      readKernelState(options.runtimeDir),
      readKernelRecoveryState(options.runtimeDir),
      readPendingKernelSnapshot(options.runtimeDir),
      readKernelEvents(options.runtimeDir),
    ]);
    const ledgerHead = events.at(-1)?.hash ?? null;

    if (pending) {
      if (
        pending.state.lastEventHash !== pending.baseEventHash ||
        hashKernelStateContent(pending.state) !== pending.stateHash
      ) {
        throw new Error('Pending kernel snapshot integrity check failed.');
      }
      if (pending.baseEventHash === ledgerHead) {
        return finishPendingSnapshot(pending);
      }
      const committed = events.at(-1);
      if (
        committed &&
        isSnapshotCommitEvent(committed) &&
        committed.previousHash === pending.baseEventHash &&
        eventSnapshotHash(committed) === pending.stateHash
      ) {
        return finishPendingSnapshot(pending, committed);
      }
    }

    const snapshotEventIndexes = new Map(
      events
        .map((event, index) => ({ event, index }))
        .filter(({ event }) => isSnapshotCommitEvent(event))
        .map(({ event, index }) => [event.hash, { event, index }] as const),
    );
    const verifiedCandidates = [state, recoveryState]
      .filter((candidate): candidate is KernelState => candidate !== null)
      .map((candidate) => ({ candidate, commit: candidate.lastEventHash ? snapshotEventIndexes.get(candidate.lastEventHash) : undefined }))
      .filter(({ candidate, commit }) => (
        commit !== undefined &&
        commit.event.previousHash === commit.event.payload.baseEventHash &&
        eventSnapshotHash(commit.event) === hashKernelStateContent(candidate)
      ))
      .sort((left, right) => right.commit!.index - left.commit!.index);

    const verified = verifiedCandidates[0];
    if (verified?.candidate.lastEventHash === ledgerHead) {
      await writeKernelState(options.runtimeDir, verified.candidate);
      await writeKernelRecoveryState(options.runtimeDir, verified.candidate);
      await clearPendingKernelSnapshot(options.runtimeDir);
      return verified.candidate;
    }

    if (verified) {
      const tail = events.slice(verified.commit!.index + 1);
      if (tail.some((event) => isSnapshotCommitEvent(event))) {
        throw new Error('Kernel snapshot integrity check failed: a newer committed snapshot is unavailable.');
      }
      const recoveryEvent = await appendKernelEvent(options.runtimeDir, ledgerHead, {
        actor: 'system',
        type: 'system.snapshot_recovered',
        entityId: 'kernel-state',
        entityType: 'system',
        payload: {
          recoveredSnapshotCommitHash: verified.candidate.lastEventHash,
          abandonedTailHashes: tail.map((event) => event.hash),
        },
      });
      return commitState({ ...verified.candidate, lastEventHash: recoveryEvent.hash });
    }

    const hasSnapshotCommit = snapshotEventIndexes.size > 0;
    if (!hasSnapshotCommit && state.lastEventHash === ledgerHead) {
      if (events.length === 0) return state;
      return commitState(state);
    }

    throw new Error('Kernel snapshot integrity check failed against the event ledger.');
  };

  const ensureCurrentStateSchema = async (state: KernelState): Promise<KernelState> => {
    if (state.contentSchemaVersion === 2 && state.recurringResearch?.schemaVersion === 1) return state;
    const previousStateHash = hashKernelStateContent(state);
    const appended = await appendEvent(state, {
      actor: 'system',
      type: 'system.state_schema_migrated',
      entityId: 'kernel-state',
      entityType: 'system',
      payload: {
        fromVersion: 1,
        toVersion: 2,
        previousStateHash,
      },
    });
    return commitState({
      ...appended.state,
      contentSchemaVersion: 2,
      recurringResearch: emptyRecurringResearchState(),
    });
  };

  const initializeKernelState = (): Promise<KernelState> => withMutation(async () => (
    ensureCurrentStateSchema(await readConsistentState())
  ));

  const getState = (): Promise<KernelState> => withMutation(readConsistentState);

  const getEvents = () => withMutation(() => readKernelEvents(options.runtimeDir));

  const createGoal = (input: GoalContractInput): Promise<GoalContract> => withMutation(async () => {
    if (!isGoalContractInput(input)) {
      throw new Error('Invalid goal contract input.');
    }

    const workspaceRoot = await normalizeWorkspaceRoot(input.workspaceRoot);
    let state = await readConsistentState();
    const now = new Date().toISOString();
    const goal: GoalContract = {
      ...input,
      workspaceRoot,
      id: createKernelId('goal'),
      status: 'active',
      usage: createEmptyUsage(),
      createdAt: now,
      updatedAt: now,
    };
    const tasks = buildInitialTaskGraph(goal, now);

    let appended = await appendEvent(state, {
      actor: 'kernel',
      type: 'goal.created',
      entityId: goal.id,
      entityType: 'goal',
      payload: { objective: goal.objective, successCriteria: goal.successCriteria },
    });
    state = appended.state;

    for (const task of tasks) {
      appended = await appendEvent(state, {
        actor: 'kernel',
        type: 'task.created',
        entityId: task.id,
        entityType: 'task',
        payload: { goalId: goal.id, title: task.title, riskLevel: task.riskLevel },
      });
      state = appended.state;
    }

    await commitState({
      ...state,
      goals: [...state.goals, goal],
      tasks: [...state.tasks, ...tasks],
    });
    return goal;
  });

  interface PreparedGoalStep {
    kind: 'dispatch';
    task: KernelTask;
    token: CapabilityToken;
    request: KernelCommandRequest;
    remainingRuntimeMs: number;
  }
  type GoalStepPreparation = PreparedGoalStep | { kind: 'result'; result: KernelStepResult };

  // Phase 1 of a goal step: policy, budget, token, and the 'running' mark all
  // happen under the mutation lock. Command execution itself runs outside the
  // lock (phase 2) so steps for different goals can execute in parallel, and
  // the outcome is recorded under the lock again (phase 3).
  const prepareGoalStep = (goalId: string): Promise<GoalStepPreparation> => withMutation(async () => {
    let state = await readConsistentState();
    const goal = state.goals.find((candidate) => candidate.id === goalId);
    if (!goal) throw new Error('Goal not found.');
    if (goal.status === 'completed') {
      return { kind: 'result', result: { status: 'completed', reason: 'Goal is already complete.' } };
    }
    if (goal.status !== 'active') {
      return { kind: 'result', result: { status: 'blocked', reason: `Goal is ${goal.status}.` } };
    }
    if (state.controls.stopAll) {
      return { kind: 'result', result: { status: 'blocked', reason: 'Stop All is active. Resume the kernel before executing tasks.' } };
    }

    const task = getNextReadyTask(state.tasks.filter((candidate) => candidate.goalId === goalId));
    if (!task) return { kind: 'result', result: { status: 'blocked', reason: 'No ready task is available.' } };
    if (!task.commandRequest) {
      return { kind: 'result', result: { status: 'blocked', reason: 'Task has no executable command request.' } };
    }

    const policy = decidePolicyForCommand(task.commandRequest);
    if (policy.kind === 'approval_required') {
      const approvalBudget = reserveBudget(goal.budget, goal.usage, { approvals: 1 });
      if (!approvalBudget.allowed) return { kind: 'result', result: { status: 'blocked', reason: approvalBudget.reason } };
      const approval = createApprovalRecord({
        goalId,
        taskId: task.id,
        requestedAction: `${task.commandRequest.command} ${task.commandRequest.args.join(' ')}`,
        riskLevel: policy.riskLevel,
        reason: policy.reason,
      });
      const appended = await appendEvent(state, {
        actor: 'kernel',
        type: 'approval.requested',
        entityId: approval.id,
        entityType: 'approval',
        payload: { goalId, taskId: task.id, riskLevel: approval.riskLevel, reason: approval.reason },
      });
      state = appended.state;
      await commitState({
        ...state,
        approvals: [...state.approvals, approval],
        goals: state.goals.map((candidate) => candidate.id === goalId
          ? { ...candidate, usage: approvalBudget.usage, updatedAt: approval.updatedAt }
          : candidate),
        tasks: markTaskStatus(state.tasks, task.id, 'awaiting_approval', approval.updatedAt, { approvalId: approval.id }),
      });
      return { kind: 'result', result: { status: 'approval_required', reason: policy.reason, approvalId: approval.id } };
    }

    if (policy.kind === 'deny') {
      const now = new Date().toISOString();
      const appended = await appendEvent(state, {
        actor: 'kernel',
        type: 'task.denied',
        entityId: task.id,
        entityType: 'task',
        payload: { reason: policy.reason },
      });
      state = appended.state;
      await commitState({
        ...state,
        goals: state.goals.map((candidate) => candidate.id === goalId
          ? { ...candidate, status: 'blocked', updatedAt: now }
          : candidate),
        tasks: markTaskStatus(state.tasks, task.id, 'denied', now),
      });
      return { kind: 'result', result: { status: 'denied', reason: policy.reason } };
    }

    const reserved = reserveBudget(goal.budget, goal.usage, { operations: 1 });
    if (!reserved.allowed) return { kind: 'result', result: { status: 'blocked', reason: reserved.reason } };
    const remainingRuntimeMs = goal.budget.maxCommandRuntimeMs - reserved.usage.commandRuntimeMs;
    if (remainingRuntimeMs <= 0) {
      return { kind: 'result', result: { status: 'blocked', reason: 'Command runtime budget exceeded.' } };
    }

    const token = createCapabilityToken({
      family: 'command.run',
      goalId,
      taskId: task.id,
      workspaceRoot: await realpath(options.allowedWorkspaceRoot ?? process.cwd()),
      command: task.commandRequest.command,
      args: task.commandRequest.args,
      cwd: task.commandRequest.cwd,
      riskLevel: task.riskLevel,
      maxOperations: 1,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });
    const startedAt = new Date().toISOString();

    let appended = await appendEvent(state, {
      actor: 'kernel',
      type: 'task.started',
      entityId: task.id,
      entityType: 'task',
      payload: { goalId, command: task.commandRequest.command, args: task.commandRequest.args },
    });
    state = appended.state;
    appended = await appendEvent(state, {
      actor: 'kernel',
      type: 'capability.issued',
      entityId: token.id,
      entityType: 'capability',
      payload: { goalId, taskId: task.id, family: token.family, expiresAt: token.expiresAt },
    });
    state = appended.state;
    await commitState({
      ...state,
      goals: state.goals.map((candidate) => candidate.id === goalId
        ? { ...candidate, usage: reserved.usage, updatedAt: startedAt }
        : candidate),
      tasks: markTaskStatus(state.tasks, task.id, 'running', startedAt),
    });

    return { kind: 'dispatch', task, token, request: task.commandRequest, remainingRuntimeMs };
  });

  // Phase 3: record the outcome of a command that executed outside the lock.
  const recordGoalStepOutcome = (
    goalId: string,
    task: KernelTask,
    evidence: KernelEvidence,
  ): Promise<KernelStepResult> => withMutation(async () => {
    let state = await readConsistentState();
    const outcomeStatus = evidence.exitCode === 0 ? 'passed' : 'failed';
    const appended = await appendEvent(state, {
      actor: 'worker',
      type: `task.${outcomeStatus}`,
      entityId: task.id,
      entityType: 'task',
      payload: { evidence },
    });
    state = appended.state;

    const finishedAt = new Date().toISOString();
    const currentGoal = state.goals.find((candidate) => candidate.id === goalId);
    if (!currentGoal) throw new Error('Goal not found.');
    const currentTask = state.tasks.find((candidate) => candidate.id === task.id) ?? task;
    const tasks = markTaskStatus(state.tasks, task.id, outcomeStatus, finishedAt, {
      evidenceEventIds: [...currentTask.evidenceEventIds, appended.event.id],
    });
    const goalTasks = tasks.filter((candidate) => candidate.goalId === goalId);
    const goalStatus = outcomeStatus === 'failed'
      ? 'failed'
      : goalTasks.every((candidate) => candidate.status === 'passed') ? 'completed' : currentGoal.status;
    const updatedUsage = {
      ...currentGoal.usage,
      commandRuntimeMs: currentGoal.usage.commandRuntimeMs + (evidence.durationMs ?? 0),
    };

    if (goalStatus === 'completed' || goalStatus === 'failed') {
      const goalAppended = await appendEvent(state, {
        actor: 'kernel',
        type: `goal.${goalStatus}`,
        entityId: goalId,
        entityType: 'goal',
        payload: { taskId: task.id },
      });
      state = goalAppended.state;
    }

    await commitState({
      ...state,
      goals: state.goals.map((candidate) => candidate.id === goalId
        ? { ...candidate, status: goalStatus, usage: updatedUsage, updatedAt: finishedAt }
        : candidate),
      tasks,
    });
    return { status: outcomeStatus, evidence };
  });

  const stepGoal = async (goalId: string): Promise<KernelStepResult> => {
    const prepared = await prepareGoalStep(goalId);
    if (prepared.kind === 'result') return prepared.result;
    const evidence = await runKernelCommand(prepared.token, prepared.request, {
      timeoutMs: prepared.remainingRuntimeMs,
      sandbox: options.sandbox,
    });
    return recordGoalStepOutcome(goalId, prepared.task, evidence);
  };

  const MAX_PARALLEL_GOAL_STEPS = 8;

  /**
   * Steps several goals concurrently. State mutations stay serialized on the
   * kernel queue, but the worker commands themselves run in parallel OS
   * processes, one per goal.
   */
  const stepGoalsInParallel = async (
    goalIds: string[],
  ): Promise<Array<{ goalId: string; result?: KernelStepResult; error?: string }>> => {
    const unique = [...new Set(goalIds)];
    if (unique.length === 0) throw new Error('At least one goal id is required.');
    if (unique.length > MAX_PARALLEL_GOAL_STEPS) {
      throw new Error(`At most ${MAX_PARALLEL_GOAL_STEPS} goals can be stepped in parallel.`);
    }
    return Promise.all(unique.map(async (goalId) => {
      try {
        return { goalId, result: await stepGoal(goalId) };
      } catch (error) {
        return { goalId, error: error instanceof Error ? error.message : 'Goal step failed.' };
      }
    }));
  };

  const decideApproval = (
    approvalId: string,
    status: Extract<ApprovalStatus, 'approved' | 'denied'>,
    reason: string,
  ) => withMutation(async () => {
    let state = await readConsistentState();
    const approval = state.approvals.find((candidate) => candidate.id === approvalId);
    if (!approval) throw new Error('Approval not found.');
    if (approval.status !== 'pending') throw new Error('Approval has already been decided.');
    if (!reason.trim()) throw new Error('Approval decision reason is required.');

    const decided = decideApprovalRecord(approval, status, reason);
    const appended = await appendEvent(state, {
      actor: 'user',
      type: `approval.${status}`,
      entityId: approvalId,
      entityType: 'approval',
      payload: { goalId: approval.goalId, taskId: approval.taskId, reason },
    });
    state = appended.state;
    const automationApproval = approval.taskId.startsWith('automation:') && state.automations.some(
      (automation) => `automation:${automation.id}` === approval.taskId,
    );
    const taskStatus = status === 'denied' ? 'denied' : 'blocked';
    await commitState({
      ...state,
      approvals: state.approvals.map((candidate) => candidate.id === approvalId ? decided : candidate),
      tasks: automationApproval
        ? state.tasks
        : markTaskStatus(state.tasks, approval.taskId, taskStatus, decided.updatedAt),
      goals: automationApproval
        ? state.goals
        : state.goals.map((candidate) => candidate.id === approval.goalId
          ? { ...candidate, status: 'blocked', updatedAt: decided.updatedAt }
          : candidate),
    });
    return decided;
  });

  const createMemoryCandidate = (input: KernelMemoryCandidateInput): Promise<KernelMemoryRecord> => withMutation(async () => {
    let state = await readConsistentState();
    const events = await readKernelEvents(options.runtimeDir);
    const suppliedEvidence = input.evidenceRefs ?? [];
    const eventIds = new Set(events.map((event) => event.id));
    if (suppliedEvidence.some((reference) => !eventIds.has(reference.eventId))) {
      throw new Error('Memory candidate references evidence that is not in the kernel ledger.');
    }
    if (input.provenance.sourceType === 'kernel_event' && !eventIds.has(input.provenance.sourceId)) {
      throw new Error('Memory provenance event is not in the kernel ledger.');
    }

    const evidenceRefs = suppliedEvidence.map((reference) => ({ ...reference }));
    if (input.provenance.sourceType === 'kernel_event' && !evidenceRefs.some((reference) => (
      reference.eventId === input.provenance.sourceId
    ))) {
      evidenceRefs.push({ eventId: input.provenance.sourceId });
    }

    const contentHash = hashMemoryContent(input.content.trim());
    if (input.provenance.sourceType === 'user') {
      const source = await appendEvent(state, {
        actor: 'user',
        type: 'memory.source_attested',
        entityId: input.provenance.sourceId,
        entityType: 'memory',
        payload: {
          sourceType: input.provenance.sourceType,
          sourceId: input.provenance.sourceId,
          observedAt: input.provenance.observedAt,
          contentHash,
        },
      });
      state = source.state;
      evidenceRefs.push({ eventId: source.event.id });
    }

    const draft = createMemoryCandidateRecord({ ...input, evidenceRefs });
    const appended = await appendEvent(state, {
      actor: input.provenance.actor,
      type: 'memory.candidate_created',
      entityId: draft.id,
      entityType: 'memory',
      payload: createMemoryLedgerPayload(draft),
    });
    state = appended.state;
    const record: KernelMemoryRecord = draft;
    await commitState({
      ...state,
      memories: [...state.memories, record],
    });
    return record;
  });

  const promoteMemory = (memoryId: string, reason: string): Promise<KernelMemoryRecord> => withMutation(async () => {
    let state = await readConsistentState();
    const events = await readKernelEvents(options.runtimeDir);
    const record = state.memories.find((candidate) => candidate.id === memoryId);
    if (!record) throw new Error('Memory not found.');
    const eventsById = new Map(events.map((event) => [event.id, event]));
    if (record.evidenceRefs.some((reference) => !eventsById.has(reference.eventId))) {
      throw new Error('Memory evidence is missing from the kernel ledger.');
    }
    const validatedEvidenceEventIds = record.evidenceRefs
      .filter((reference) => isIndependentMemoryEvidence(eventsById.get(reference.eventId)!, record, reference))
      .map((reference) => reference.eventId);

    const promoted = promoteMemoryRecord(state.memories, memoryId, reason, validatedEvidenceEventIds);
    const appended = await appendEvent(state, {
      actor: 'user',
      type: 'memory.promoted',
      entityId: memoryId,
      entityType: 'memory',
      payload: {
        ...createMemoryLedgerPayload(promoted.record),
        reasonHash: hashMemoryContent(reason.trim()),
        supersedesIds: promoted.record.supersedesIds,
      },
    });
    state = appended.state;
    await commitState({ ...state, memories: promoted.records });
    return promoted.record;
  });

  const revokeMemory = (memoryId: string, reason: string): Promise<KernelMemoryRecord> => withMutation(async () => {
    let state = await readConsistentState();
    if (!state.memories.some((candidate) => candidate.id === memoryId)) throw new Error('Memory not found.');
    const revoked = revokeMemoryRecord(state.memories, memoryId, reason);
    const appended = await appendEvent(state, {
      actor: 'user',
      type: 'memory.revoked',
      entityId: memoryId,
      entityType: 'memory',
      payload: {
        ...createMemoryLedgerPayload(revoked.record),
        reasonHash: hashMemoryContent(reason.trim()),
      },
    });
    state = appended.state;
    await commitState({ ...state, memories: revoked.records });
    return revoked.record;
  });

  const getActiveMemories = async (): Promise<KernelMemoryRecord[]> => {
    const state = await getState();
    return listActiveMemories(state.memories).filter((record) => record.status === 'promoted');
  };

  const synthesizeSkill = (input: KernelSkillSynthesisInput): Promise<SkillPackage> => withMutation(async () => {
    let state = await readConsistentState();
    const synthesis = synthesizePureTransform(input.trainingCases, {
      maxSteps: input.manifest.maxSteps,
      maxInputChars: input.manifest.maxInputChars,
    });
    if (!synthesis.improvesBaseline) {
      throw new Error('No bounded skill candidate improved the training baseline.');
    }
    const now = new Date().toISOString();
    const skill = createSkillCandidate({
      id: createKernelId('skill'),
      manifest: input.manifest,
      program: synthesis.program,
      trainingCases: input.trainingCases,
      replayCases: input.replayCases,
      previousVersionId: input.previousVersionId,
      createdAt: now,
    });
    const appended = await appendEvent(state, {
      actor: input.manifest.provenance.actor,
      type: 'skill.candidate_created',
      entityId: skill.id,
      entityType: 'skill',
      payload: { ...getSkillPackageLedgerMetadata(skill) },
    });
    state = appended.state;
    await commitState({
      ...state,
      skillPackages: [...state.skillPackages, skill],
    });
    return skill;
  });

  const evaluateSkill = (skillId: string): Promise<SkillEvaluation> => withMutation(async () => {
    let state = await readConsistentState();
    const skill = state.skillPackages.find((candidate) => candidate.id === skillId);
    if (!skill) throw new Error('Skill not found.');
    const createdAt = new Date().toISOString();
    const evaluation = evaluateSkillPackage(skill, {
      evaluationId: createKernelId('eval'),
      createdAt,
    });
    const evaluatedSkill = applySkillEvaluation(skill, evaluation, createdAt);
    const appended = await appendEvent(state, {
      actor: 'kernel',
      type: evaluation.eligibleForCanary ? 'skill.evaluated' : 'skill.rejected',
      entityId: evaluation.id,
      entityType: 'skill_eval',
      payload: { ...getSkillEvaluationLedgerMetadata(evaluation) },
    });
    state = appended.state;
    await commitState({
      ...state,
      skillPackages: state.skillPackages.map((candidate) => candidate.id === skillId ? evaluatedSkill : candidate),
      skillEvaluations: [...state.skillEvaluations, evaluation],
    });
    return evaluation;
  });

  const startSkillCanary = (skillId: string, maxRuns: number): Promise<SkillActivation> => withMutation(async () => {
    let state = await readConsistentState();
    const skill = state.skillPackages.find((candidate) => candidate.id === skillId);
    if (!skill) throw new Error('Skill not found.');
    const evaluation = [...state.skillEvaluations].reverse().find((candidate) => candidate.skillId === skillId);
    if (!evaluation) throw new Error('Skill evaluation not found.');
    const now = new Date().toISOString();
    const canary = activateSkillCanary(skill, evaluation, {
      activationId: createKernelId('activation'),
      maxRuns,
      createdAt: now,
    });
    const appended = await appendEvent(state, {
      actor: 'user',
      type: 'skill.canary_started',
      entityId: canary.activation.id,
      entityType: 'skill_activation',
      payload: { ...getSkillActivationLedgerMetadata(canary.activation) },
    });
    state = appended.state;
    await commitState({
      ...state,
      skillPackages: state.skillPackages.map((candidate) => candidate.id === skillId ? canary.skill : candidate),
      skillActivations: [...state.skillActivations, canary.activation],
    });
    return canary.activation;
  });

  const runSkillCanary = (
    skillId: string,
  ): Promise<{ caseId: string; passed: boolean; activation: SkillActivation }> => withMutation(async () => {
    let state = await readConsistentState();
    const skill = state.skillPackages.find((candidate) => candidate.id === skillId);
    if (!skill) throw new Error('Skill not found.');
    const activation = [...state.skillActivations].reverse().find((candidate) => candidate.skillId === skillId);
    if (!activation) throw new Error('Skill activation not found.');
    if (
      typeof activation.evaluationId !== 'string' ||
      typeof activation.suiteHash !== 'string' ||
      !Array.isArray(activation.replayCaseIds)
    ) {
      throw new Error('Legacy skill canary must be restarted with kernel-owned replay evidence.');
    }
    const evaluation = state.skillEvaluations.find((candidate) => candidate.id === activation.evaluationId);
    if (
      !evaluation ||
      evaluation.skillId !== skill.id ||
      !evaluation.eligibleForCanary ||
      activation.suiteHash !== skill.contentHash
    ) {
      throw new Error('Skill canary evaluation evidence is missing or does not match its activation.');
    }
    const caseId = activation.replayCaseIds[activation.usedRuns];
    const canaryCase = getKernelCanaryCase(skill, activation.usedRuns);
    if (caseId !== canaryCase.id) throw new Error('Skill canary kernel-owned case sequence is invalid.');
    const output = runPureTransform(skill.program, canaryCase.input, {
      maxInputChars: skill.manifest.maxInputChars,
      maxSteps: skill.manifest.maxSteps,
    });
    const passed = output === canaryCase.expectedOutput;
    const updated = recordCanaryRun(skill, activation, { passed, updatedAt: new Date().toISOString() });
    const appended = await appendEvent(state, {
      actor: 'kernel',
      type: passed ? 'skill.canary_passed' : 'skill.canary_failed',
      entityId: activation.id,
      entityType: 'skill_activation',
      payload: {
        ...getSkillActivationLedgerMetadata(updated),
        caseId,
        inputHash: stableHash(canaryCase.input),
        outputHash: stableHash(output),
        expectedOutputHash: stableHash(canaryCase.expectedOutput),
        evaluationId: evaluation.id,
        suiteHash: evaluation.suiteHash,
      },
    });
    state = appended.state;
    await commitState({
      ...state,
      skillActivations: state.skillActivations.map((candidate) => candidate.id === activation.id ? updated : candidate),
    });
    return { caseId, passed, activation: updated };
  });

  const promoteSkillPackage = (skillId: string): Promise<SkillPackage> => withMutation(async () => {
    let state = await readConsistentState();
    const skill = state.skillPackages.find((candidate) => candidate.id === skillId);
    if (!skill) throw new Error('Skill not found.');
    const activation = [...state.skillActivations].reverse().find((candidate) => candidate.skillId === skillId);
    if (!activation) throw new Error('Skill activation not found.');
    const promoted = promoteSkill(skill, activation, new Date().toISOString());
    const appended = await appendEvent(state, {
      actor: 'user',
      type: 'skill.promoted',
      entityId: skillId,
      entityType: 'skill',
      payload: { ...getSkillPackageLedgerMetadata(promoted.skill) },
    });
    state = appended.state;
    await commitState({
      ...state,
      skillPackages: state.skillPackages.map((candidate) => candidate.id === skillId ? promoted.skill : candidate),
      skillActivations: state.skillActivations.map((candidate) => candidate.id === activation.id ? promoted.activation : candidate),
    });
    return promoted.skill;
  });

  const rollbackSkillPackage = (skillId: string, reason: string): Promise<SkillPackage> => withMutation(async () => {
    let state = await readConsistentState();
    const skill = state.skillPackages.find((candidate) => candidate.id === skillId);
    if (!skill) throw new Error('Skill not found.');
    const activation = [...state.skillActivations].reverse().find((candidate) => candidate.skillId === skillId);
    if (!activation) throw new Error('Skill activation not found.');
    const rolledBack = rollbackSkill(skill, activation, reason, new Date().toISOString());
    const appended = await appendEvent(state, {
      actor: 'user',
      type: 'skill.rolled_back',
      entityId: skillId,
      entityType: 'skill',
      payload: {
        ...getSkillPackageLedgerMetadata(rolledBack.skill),
        reasonHash: stableHash(reason.trim()),
      },
    });
    state = appended.state;
    await commitState({
      ...state,
      skillPackages: state.skillPackages.map((candidate) => candidate.id === skillId ? rolledBack.skill : candidate),
      skillActivations: state.skillActivations.map((candidate) => candidate.id === activation.id ? rolledBack.activation : candidate),
    });
    return rolledBack.skill;
  });

  const invokeSkill = (skillId: string, input: string): Promise<string> => withMutation(async () => {
    let state = await readConsistentState();
    const skill = state.skillPackages.find((candidate) => candidate.id === skillId);
    if (!skill) throw new Error('Skill not found.');
    const activation = [...state.skillActivations].reverse().find((candidate) => candidate.skillId === skillId);
    if (skill.status !== 'promoted' || activation?.status !== 'active') {
      throw new Error('Skill is not active.');
    }
    const output = runPureTransform(skill.program, input, {
      maxInputChars: skill.manifest.maxInputChars,
      maxSteps: skill.manifest.maxSteps,
    });
    const appended = await appendEvent(state, {
      actor: 'kernel',
      type: 'skill.invoked',
      entityId: skillId,
      entityType: 'skill',
      payload: { inputHash: stableHash(input), outputHash: stableHash(output), contentHash: skill.contentHash },
    });
    state = appended.state;
    await commitState(state);
    return output;
  });

  interface PreparedProviderExecution {
    plan: ProviderRoutePlan;
    requestHash: string;
  }

  const prepareProviderExecution = (
    goalId: string,
    request: ProviderRequest,
    policy: ProviderRoutingPolicy,
  ): Promise<PreparedProviderExecution> => withMutation(async () => {
    if (!options.providerRouter) throw new Error('Provider router is unavailable.');
    let state = await readConsistentState();
    const goal = state.goals.find((candidate) => candidate.id === goalId);
    if (!goal) throw new Error('Goal not found.');
    if (goal.status !== 'active') throw new Error(`Goal is ${goal.status}.`);
    if (state.controls.stopAll) throw new Error('Stop All is active. Resume the kernel before provider calls.');

    const plan = options.providerRouter.plan(request, policy);
    const reserved = reserveBudget(goal.budget, goal.usage, {
      operations: 1,
      providerCalls: plan.selections.length,
    });
    if (!reserved.allowed) throw new Error(reserved.reason);
    const requestHash = stableHash(request);
    const token = createCapabilityToken({
      family: 'provider.call',
      goalId,
      taskId: request.id,
      workspaceRoot: await realpath(options.allowedWorkspaceRoot ?? process.cwd()),
      providerIds: plan.selections.map((selection) => selection.provider),
      models: plan.selections.map((selection) => selection.model),
      requestHash,
      riskLevel: 'L1',
      maxOperations: 1,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });
    const tokenUse = useCapabilityToken(token);
    if (!tokenUse.allowed) throw new Error(tokenUse.reason);

    const appended = await appendEvent(state, {
      actor: 'kernel',
      type: 'provider.call.started',
      entityId: request.id,
      entityType: 'provider',
      payload: {
        goalId,
        requestHash,
        capabilityId: token.id,
        mode: plan.mode,
        selections: plan.selections,
      },
    });
    state = appended.state;
    await commitState({
      ...state,
      goals: state.goals.map((candidate) => candidate.id === goalId
        ? { ...candidate, usage: reserved.usage, updatedAt: new Date().toISOString() }
        : candidate),
    });
    return { plan, requestHash };
  });

  const recordProviderSuccess = (
    goalId: string,
    request: ProviderRequest,
    prepared: PreparedProviderExecution,
    execution: ProviderExecution,
  ): Promise<void> => withMutation(async () => {
    let state = await readConsistentState();
    const appended = await appendEvent(state, {
      actor: 'provider',
      type: 'provider.call.completed',
      entityId: request.id,
      entityType: 'provider',
      payload: {
        goalId,
        requestHash: prepared.requestHash,
        resultHashes: execution.results.map((result) => stableHash({
          provider: result.provider,
          model: result.model,
          text: result.text,
          structured: result.structured,
          toolCalls: result.toolCalls,
        })),
        usage: execution.results.map((result) => ({
          provider: result.provider,
          usage: result.usage,
          latencyMs: result.latencyMs,
        })),
        errorCodes: execution.errors.map((error) => ({
          provider: error.provider,
          code: error.code,
          retryable: error.retryable,
        })),
        disagreement: execution.disagreement,
      },
    });
    state = appended.state;
    await commitState(state);
  });

  const recordProviderFailure = (
    goalId: string,
    request: ProviderRequest,
    prepared: PreparedProviderExecution,
    error: unknown,
  ): Promise<void> => withMutation(async () => {
    let state = await readConsistentState();
    const appended = await appendEvent(state, {
      actor: 'provider',
      type: 'provider.call.failed',
      entityId: request.id,
      entityType: 'provider',
      payload: {
        goalId,
        requestHash: prepared.requestHash,
        errorHash: stableHash(error instanceof Error ? error.message : 'Provider call failed.'),
      },
    });
    state = appended.state;
    await commitState(state);
  });

  const executeProviderRequest = async (
    goalId: string,
    request: ProviderRequest,
    policy: ProviderRoutingPolicy,
    parentSignal?: AbortSignal,
  ): Promise<ProviderExecution> => {
    const prepared = await prepareProviderExecution(goalId, request, policy);
    if (!options.providerRouter) throw new Error('Provider router is unavailable.');
    if (recoveryInProgress) throw new Error('Provider dispatch is unavailable while recovery is in progress.');
    const controller = new AbortController();
    const configuredTimeout = options.providerTimeoutMs ?? RESEARCH_PROVIDER_TIMEOUT_MS;
    const timeoutMs = Number.isSafeInteger(configuredTimeout)
      ? Math.max(1_000, Math.min(configuredTimeout, 120_000))
      : RESEARCH_PROVIDER_TIMEOUT_MS;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const abortFromParent = () => controller.abort();
    if (parentSignal?.aborted) controller.abort();
    else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
    activeProviderControllers.set(request.id, controller);
    try {
      const current = await getState();
      if (current.controls.stopAll) throw new Error('Stop All became active before provider dispatch.');
      if (controller.signal.aborted) throw new Error('Provider request was cancelled before dispatch.');
      const execution = await awaitAbortable(
        options.providerRouter.execute(request, prepared.plan, controller.signal),
        controller.signal,
        'Provider request was cancelled before completion.',
      );
      if ((await getState()).controls.stopAll) {
        throw new Error('Stop All became active before the provider result was committed.');
      }
      await recordProviderSuccess(goalId, request, prepared, execution);
      return execution;
    } catch (error) {
      await recordProviderFailure(goalId, request, prepared, error);
      throw error;
    } finally {
      clearTimeout(timeout);
      parentSignal?.removeEventListener('abort', abortFromParent);
      activeProviderControllers.delete(request.id);
    }
  };

  const findResearchGoal = (state: KernelState, missionId: string): GoalContract | undefined => (
    state.goals.find((goal) => goal.research?.id === missionId || (
      goal.kind === 'research_report' && goal.id === missionId
    ))
  );

  const assertResearchExecutionOwnership = (
    mission: ResearchMission,
    ownership?: ResearchMission['schedulerOwnership'],
  ): void => {
    if (!mission.schedulerOwnership) {
      if (ownership) throw new Error('Manual research missions do not accept scheduler ownership.');
      return;
    }
    if (
      !ownership ||
      ownership.scheduleId !== mission.schedulerOwnership.scheduleId ||
      ownership.occurrenceId !== mission.schedulerOwnership.occurrenceId ||
      ownership.leaseId !== mission.schedulerOwnership.leaseId ||
      ownership.leaseFence !== mission.schedulerOwnership.leaseFence
    ) {
      throw new Error('Research mission is owned by a durable scheduler occurrence.');
    }
  };

  const assertResearchResultCommitAllowed = (
    state: KernelState,
    mission: ResearchMission,
    ownership?: ResearchMission['schedulerOwnership'],
    signal?: AbortSignal,
  ): void => {
    assertResearchExecutionOwnership(mission, ownership);
    if (state.controls.stopAll) {
      throw new Error('Stop All became active before the research result was committed.');
    }
    if (signal?.aborted) throw new Error('Research execution was cancelled before its result was committed.');
    if (!ownership) return;
    const occurrence = recurringResearchState(state).occurrences.find((candidate) => (
      candidate.id === ownership.occurrenceId && candidate.scheduleId === ownership.scheduleId
    ));
    const now = Date.now();
    if (
      !occurrence ||
      occurrence.status !== 'running' ||
      occurrence.missionId !== mission.id ||
      occurrence.leaseId !== ownership.leaseId ||
      occurrence.leaseFence !== ownership.leaseFence ||
      !occurrence.lease ||
      now >= Date.parse(occurrence.deadlineAt) ||
      now >= Date.parse(occurrence.lease.expiresAt)
    ) {
      throw new Error('The durable scheduler lease, fence, or deadline is no longer authoritative.');
    }
  };

  const taskIdForMissionStage = (mission: ResearchMission, stage: ResearchMissionStage | 'publish'): string => {
    if (stage === 'planning') return mission.taskIds.plan;
    if (stage === 'collecting') return mission.taskIds.collect;
    if (stage === 'synthesizing') return mission.taskIds.synthesize;
    if (stage === 'verifying') return mission.taskIds.verify;
    return mission.taskIds.publish;
  };

  const replaceResearchMission = (
    state: KernelState,
    mission: ResearchMission,
    goalPatch: Partial<GoalContract> = {},
  ): KernelState => ({
    ...state,
    goals: state.goals.map((goal) => goal.id === mission.goalId
      ? { ...goal, ...goalPatch, research: mission, updatedAt: mission.updatedAt }
      : goal),
  });

  const getResearchMissionCapability = (): ResearchMissionCapability => {
    const workerId = options.researchWorkerId?.trim();
    const registration = workerId ? workerRegistry.get(workerId) : undefined;
    const allowedOrigins = registration?.configuredScopes.flatMap((scope) => (
      scope.family === 'browser' && scope.operations.includes('browser.inspect') ? scope.origins : []
    )) ?? [];
    if (!options.providerRouter || options.researchProviderConfigured === false) {
      return { available: false, reason: 'Provider routing is unavailable.', allowedOrigins, maxSources: MAX_RESEARCH_SOURCES };
    }
    if (!options.artifactStore) {
      return { available: false, reason: 'The authenticated artifact store is unavailable.', allowedOrigins, maxSources: MAX_RESEARCH_SOURCES };
    }
    if (!workerId || registration?.availability !== 'available' || !options.actionWorkers?.[workerId]) {
      return { available: false, reason: 'The read-only web inspection worker is unavailable.', allowedOrigins, maxSources: MAX_RESEARCH_SOURCES };
    }
    if (allowedOrigins.length === 0) {
      return { available: false, reason: 'No read-only research origins are configured.', allowedOrigins, maxSources: MAX_RESEARCH_SOURCES };
    }
    return {
      available: true,
      reason: 'Provider routing, authenticated artifacts, and read-only source inspection are available.',
      allowedOrigins: [...new Set(allowedOrigins)].sort(),
      maxSources: MAX_RESEARCH_SOURCES,
    };
  };

  interface ResearchMissionCreationContext {
    actor: 'user' | 'kernel';
    schedulerOwnership?: ResearchMission['schedulerOwnership'];
  }

  const appendResearchMissionCreation = async (
    initialState: KernelState,
    input: ReturnType<typeof normalizeResearchMissionInput>,
    workspaceRoot: string,
    context: ResearchMissionCreationContext,
  ): Promise<{ state: KernelState; goal: GoalContract; tasks: KernelTask[]; mission: ResearchMission }> => {
    let state = initialState;
    const built = buildResearchMissionGoal(input, workspaceRoot);
    const mission: ResearchMission = context.schedulerOwnership
      ? { ...built.mission, schedulerOwnership: context.schedulerOwnership }
      : built.mission;
    const goal: GoalContract = { ...built.goal, research: mission };
    let appended = await appendEvent(state, {
      actor: context.actor,
      type: 'goal.created',
      entityId: goal.id,
      entityType: 'goal',
      payload: {
        objective: goal.objective,
        successCriteria: goal.successCriteria,
        kind: goal.kind,
        scheduleId: context.schedulerOwnership?.scheduleId,
        occurrenceId: context.schedulerOwnership?.occurrenceId,
      },
    });
    state = appended.state;
    for (const task of built.tasks) {
      appended = await appendEvent(state, {
        actor: 'kernel',
        type: 'task.created',
        entityId: task.id,
        entityType: 'task',
        payload: {
          goalId: goal.id,
          missionId: mission.id,
          title: task.title,
          riskLevel: task.riskLevel,
          missionStep: task.missionStep,
          scheduleId: context.schedulerOwnership?.scheduleId,
          occurrenceId: context.schedulerOwnership?.occurrenceId,
        },
      });
      state = appended.state;
    }
    appended = await appendEvent(state, {
      actor: context.actor,
      type: 'mission.created',
      entityId: mission.id,
      entityType: 'mission',
      payload: {
        goalId: goal.id,
        revision: mission.revision,
        sourceCount: mission.sources.length,
        sourceUrlHashes: mission.sources.map((source) => stableHash(source.url)),
        scheduleId: context.schedulerOwnership?.scheduleId,
        occurrenceId: context.schedulerOwnership?.occurrenceId,
        leaseId: context.schedulerOwnership?.leaseId,
        leaseFence: context.schedulerOwnership?.leaseFence,
      },
    });
    return { state: appended.state, goal, tasks: built.tasks, mission };
  };

  const createResearchMission = async (value: unknown): Promise<ResearchMission> => {
    const input = normalizeResearchMissionInput(value);
    const capability = getResearchMissionCapability();
    if (!capability.available) throw new Error(capability.reason);
    const allowed = new Set(capability.allowedOrigins);
    const deniedOrigin = input.sourceUrls.map((url) => new URL(url).origin).find((origin) => !allowed.has(origin));
    if (deniedOrigin) {
      throw new Error(`Source origin is outside WEB_INSPECT_ORIGINS: ${deniedOrigin}.`);
    }
    const workspaceRoot = await realpath(options.allowedWorkspaceRoot ?? process.cwd());
    return withMutation(async () => {
      let state = await readConsistentState();
      if (state.controls.stopAll) throw new Error('Stop All is active. Resume the kernel before creating a mission.');
      const created = await appendResearchMissionCreation(state, input, workspaceRoot, { actor: 'user' });
      await commitState({
        ...created.state,
        goals: [...created.state.goals, created.goal],
        tasks: [...created.state.tasks, ...created.tasks],
      });
      return created.mission;
    });
  };

  const listResearchMissions = async (): Promise<ResearchMission[]> => {
    const state = await getState();
    return state.goals.flatMap((goal) => goal.research ? [goal.research] : []);
  };

  const loadCapturedResearchSources = async (mission: ResearchMission): Promise<CapturedResearchSource[]> => {
    if (!options.artifactStore) throw new Error('The authenticated artifact store is unavailable.');
    const captured: CapturedResearchSource[] = [];
    for (const source of mission.sources.filter((candidate) => candidate.status === 'captured')) {
      if (!source.artifactId || !source.contentHash) throw new Error(`Source ${source.id} is missing artifact evidence.`);
      const resolved = await options.artifactStore.resolve(source.artifactId);
      if (!resolved || resolved.contentHash !== source.contentHash) {
        throw new Error(`Source ${source.id} failed authenticated artifact resolution.`);
      }
      captured.push({ source, content: resolved.content });
    }
    if (captured.length === 0) throw new Error('No eligible captured sources are available.');
    return captured;
  };

  const beginResearchStep = (
    missionId: string,
    stage: ResearchMissionStage,
    kind: ResearchMissionActiveStep['kind'],
    detail: { requestId?: string; sourceId?: string; intentId?: string; requestHash?: string },
    ownership?: ResearchMission['schedulerOwnership'],
    parentSignal?: AbortSignal,
  ): Promise<ResearchMissionActiveStep> => withMutation(async () => {
    let state = await readConsistentState();
    const goal = findResearchGoal(state, missionId);
    const mission = goal?.research;
    if (!goal || !mission) throw new Error('Research mission not found.');
    assertResearchResultCommitAllowed(state, mission, ownership, parentSignal);
    if (mission.status !== stage) throw new Error(`Research mission is ${mission.status}, not ${stage}.`);
    if (mission.activeStep) throw new Error('Research mission already has an in-flight step.');
    if (goal.status !== 'active') throw new Error(`Goal is ${goal.status}.`);
    if (state.controls.stopAll) throw new Error('Stop All is active. Resume the kernel before running a mission.');
    const activeStep: ResearchMissionActiveStep = {
      id: createKernelId('mission_step'),
      stage,
      kind,
      attempt: stage === 'synthesizing' ? mission.synthesisAttempts + 1 : mission.checkpoint + 1,
      startedAt: new Date().toISOString(),
      ...detail,
    };
    const taskId = taskIdForMissionStage(mission, stage);
    const updated: ResearchMission = { ...mission, activeStep, updatedAt: activeStep.startedAt };
    const appended = await appendEvent(state, {
      actor: 'kernel',
      type: 'mission.step_started',
      entityId: mission.id,
      entityType: 'mission',
      payload: {
        goalId: goal.id,
        stepId: activeStep.id,
        stage,
        kind,
        requestId: detail.requestId,
        requestHash: detail.requestHash,
        sourceId: detail.sourceId,
        intentId: detail.intentId,
      },
    });
    state = replaceResearchMission(appended.state, updated);
    await commitState({
      ...state,
      tasks: markTaskStatus(state.tasks, taskId, 'running', activeStep.startedAt),
    });
    return activeStep;
  });

  const providerRunEvidence = async (
    purpose: ResearchMissionProviderRun['purpose'],
    requestId: string,
    execution: ProviderExecution,
  ): Promise<ResearchMissionProviderRun> => {
    const events = await getEvents();
    const evidence = [...events].reverse().find((event) => (
      event.type === 'provider.call.completed' && event.entityId === requestId
    ));
    if (!evidence) throw new Error('Mission provider call completed without ledger evidence.');
    const first = execution.results[0];
    if (!first) throw new Error('Mission provider call returned no result.');
    const usage = execution.results.reduce((total, result) => ({
      inputTokens: total.inputTokens + result.usage.inputTokens,
      outputTokens: total.outputTokens + result.usage.outputTokens,
      totalTokens: total.totalTokens + result.usage.totalTokens,
      latencyMs: Math.max(total.latencyMs, result.latencyMs),
    }), { inputTokens: 0, outputTokens: 0, totalTokens: 0, latencyMs: 0 });
    return {
      purpose,
      requestId,
      evidenceEventId: evidence.id,
      provider: first.provider,
      model: first.model,
      ...usage,
      completedAt: evidence.timestamp,
    };
  };

  interface PreparedResearchSourceDispatch {
    missionId: string;
    sourceId: string;
    activeStep: ResearchMissionActiveStep;
    intent: ActionIntent;
    authorization: CapabilityDispatchAuthorization;
    worker: KernelActionWorker;
  }

  const prepareResearchSourceDispatch = (
    missionId: string,
    ownership?: ResearchMission['schedulerOwnership'],
    parentSignal?: AbortSignal,
  ): Promise<PreparedResearchSourceDispatch | ResearchMissionStepResult> => withMutation(async () => {
    let state = await readConsistentState();
    const goal = findResearchGoal(state, missionId);
    const mission = goal?.research;
    if (!goal || !mission) throw new Error('Research mission not found.');
    assertResearchResultCommitAllowed(state, mission, ownership, parentSignal);
    if (mission.status !== 'collecting') {
      return {
        outcome: mission.status === 'completed' ? 'completed' : mission.status === 'blocked' ? 'blocked' : 'in_progress',
        mission,
      };
    }
    if (mission.activeStep) return { outcome: 'in_progress', mission };
    if (goal.status !== 'active') throw new Error(`Goal is ${goal.status}.`);
    if (state.controls.stopAll) throw new Error('Stop All is active. Resume the kernel before source inspection.');

    const source = mission.sources.find((candidate) => candidate.status === 'pending');
    if (!source) {
      const capturedCount = mission.sources.filter((candidate) => candidate.status === 'captured').length;
      const now = new Date().toISOString();
      const blocked = capturedCount === 0;
      const updated: ResearchMission = {
        ...mission,
        status: blocked ? 'blocked' : 'synthesizing',
        resumeStage: blocked ? 'collecting' : undefined,
        retryable: blocked ? true : undefined,
        lastError: blocked ? 'No eligible source was captured. Explicit retry is required.' : undefined,
        updatedAt: now,
      };
      const appended = await appendEvent(state, {
        actor: 'kernel',
        type: blocked ? 'mission.blocked' : 'mission.collection_completed',
        entityId: mission.id,
        entityType: 'mission',
        payload: { goalId: goal.id, capturedCount, sourceCount: mission.sources.length },
      });
      state = replaceResearchMission(appended.state, updated, { status: blocked ? 'blocked' : 'active' });
      await commitState({
        ...state,
        tasks: markTaskStatus(
          state.tasks,
          mission.taskIds.collect,
          blocked ? 'blocked' : 'passed',
          now,
          { evidenceEventIds: [appended.event.id] },
        ),
      });
      return { outcome: blocked ? 'blocked' : 'advanced', mission: updated };
    }

    let recurringAfterSourceCharge: RecurringResearchKernelState | undefined;
    let sourceFetchNumber: number | undefined;
    if (ownership) {
      const recurring = recurringResearchState(state);
      const occurrence = recurring.occurrences.find((candidate) => candidate.id === ownership.occurrenceId);
      const schedule = recurring.schedules.find((candidate) => candidate.contract.id === ownership.scheduleId);
      if (!occurrence || !schedule) throw new Error('Scheduled source-fetch budget state is unavailable.');
      const sourceFetchesUsed = occurrence.sourceFetchesUsed ?? 0;
      if (sourceFetchesUsed >= schedule.contract.budget.maxSourceFetches) {
        throw new Error('Occurrence source-fetch budget is exhausted.');
      }
      sourceFetchNumber = sourceFetchesUsed + 1;
      recurringAfterSourceCharge = {
        ...recurring,
        occurrences: recurring.occurrences.map((candidate) => candidate.id === occurrence.id
          ? { ...candidate, sourceFetchesUsed: sourceFetchNumber }
          : candidate),
      };
    }

    const workerId = options.researchWorkerId?.trim();
    const registration = workerId ? workerRegistry.get(workerId) : undefined;
    const worker = workerId ? options.actionWorkers?.[workerId] : undefined;
    if (!workerId || !registration || registration.availability !== 'available' || !worker) {
      throw new Error('The read-only web inspection worker is unavailable.');
    }
    const intent: ActionIntent = {
      schemaVersion: 1,
      id: createKernelId('intent'),
      goalId: goal.id,
      taskId: mission.taskIds.collect,
      workerId,
      riskLevel: 'L0',
      action: { type: 'browser.inspect', origin: source.origin, url: source.url },
      scope: { family: 'browser', operations: ['browser.inspect'], origins: [source.origin], downloadRoots: [] },
      authority: { kind: 'user_request', referenceId: `${mission.id}:r${mission.revision}` },
      untrustedObservationIds: [],
      createdAt: new Date().toISOString(),
    };
    const decision = decideActionPolicy(intent, workerRegistry);
    if (decision.kind !== 'allow') throw new Error(`Research source policy denied dispatch: ${decision.reason}`);
    const reserved = reserveBudget(goal.budget, goal.usage, { operations: 1 });
    if (!reserved.allowed) throw new Error(reserved.reason);
    const issuedAt = new Date().toISOString();
    const grant = createCapabilityGrant(intent, {
      id: createKernelId('cap'),
      issuedAt,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      maxOps: 1,
    });
    await capabilityGrantStore.create(grant);
    const authorized = await authorizeCapabilityDispatch(
      capabilityGrantStore,
      grant.id,
      intent,
      registration,
      { now: new Date().toISOString(), operationsUsed: 1 },
    );
    if (!authorized.allowed || !authorized.authorization || !authorized.grant) {
      throw new Error(`Capability authorization failed before research dispatch: ${authorized.reason}`);
    }
    const activeStep: ResearchMissionActiveStep = {
      id: createKernelId('mission_step'),
      stage: 'collecting',
      kind: 'source',
      attempt: mission.checkpoint + 1,
      startedAt: issuedAt,
      sourceId: source.id,
      intentId: intent.id,
    };
    let appended = await appendEvent(state, {
      actor: 'kernel',
      type: 'capability.grant_consumed',
      entityId: grant.id,
      entityType: 'capability',
      payload: {
        missionId: mission.id,
        sourceId: source.id,
        intentId: intent.id,
        grantId: grant.id,
        grantStatus: authorized.grant.status,
      },
    });
    state = appended.state;
    appended = await appendEvent(state, {
      actor: 'kernel',
      type: 'mission.source_started',
      entityId: mission.id,
      entityType: 'mission',
      payload: {
        goalId: goal.id,
        stepId: activeStep.id,
        sourceId: source.id,
        sourceUrlHash: stableHash(source.url),
        intentId: intent.id,
        grantId: grant.id,
        sourceFetchNumber,
      },
    });
    state = appended.state;
    const updated: ResearchMission = {
      ...mission,
      activeStep,
      sources: mission.sources.map((candidate) => candidate.id === source.id
        ? { ...candidate, status: 'running', failureReason: undefined }
        : candidate),
      updatedAt: issuedAt,
    };
    state = replaceResearchMission(state, updated, { usage: reserved.usage });
    await commitState({
      ...state,
      tasks: markTaskStatus(state.tasks, mission.taskIds.collect, 'running', issuedAt),
      ...(recurringAfterSourceCharge ? { recurringResearch: recurringAfterSourceCharge } : {}),
    });
    return {
      missionId: mission.id,
      sourceId: source.id,
      activeStep,
      intent,
      authorization: authorized.authorization,
      worker,
    };
  });

  const recordResearchSourceDispatch = (
    prepared: PreparedResearchSourceDispatch,
    dispatch: KernelActionWorkerResult,
    assessment: { risk: 'none' | 'medium' | 'high'; codes: PromptInjectionSignalCode[] },
    ownership?: ResearchMission['schedulerOwnership'],
    parentSignal?: AbortSignal,
  ): Promise<ResearchMissionStepResult> => withMutation(async () => {
    let state = await readConsistentState();
    const goal = findResearchGoal(state, prepared.missionId);
    const mission = goal?.research;
    if (!goal || !mission) throw new Error('Research mission not found.');
    assertResearchResultCommitAllowed(state, mission, ownership, parentSignal);
    if (mission.activeStep?.id !== prepared.activeStep.id) {
      throw new Error('Research source result does not match the active checkpoint.');
    }
    const currentSource = mission.sources.find((candidate) => candidate.id === prepared.sourceId);
    if (!currentSource) throw new Error('Research source not found.');

    const content = dispatch.content ?? '';
    const observation = createUntrustedObservation({
      id: createKernelId('obs'),
      source: 'web',
      sourceRef: dispatch.sourceRef,
      content,
      capturedAt: new Date().toISOString(),
    });
    const chunked = chunkResearchSource(currentSource.id, content);
    const canPersist = dispatch.status === 'succeeded' && chunked.content.length > 0;
    const artifact = canPersist && options.artifactStore
      ? await options.artifactStore.create(chunked.content)
      : undefined;
    // Artifact I/O is outside the durable state commit. Recheck the scheduler
    // gate before any ledger event can make the result authoritative.
    assertResearchResultCommitAllowed(state, mission, ownership, parentSignal);
    if (artifact) {
      const artifactEvent = await appendEvent(state, {
        actor: 'worker',
        type: 'artifact.created',
        entityId: artifact.id,
        entityType: 'artifact',
        payload: {
          artifactId: artifact.id,
          contentHash: artifact.contentHash,
          byteLength: artifact.byteLength,
          missionId: mission.id,
          sourceId: currentSource.id,
          kind: 'research_source',
          observationId: observation.id,
        },
      });
      state = artifactEvent.state;
    }
    const status: ResearchMissionSource['status'] = !canPersist
      ? 'failed'
      : assessment.risk === 'high' ? 'quarantined' : 'captured';
    const eventType = status === 'captured'
      ? 'mission.source_captured'
      : status === 'quarantined' ? 'mission.source_quarantined' : 'mission.source_failed';
    const sourceEvent = await appendEvent(state, {
      actor: 'worker',
      type: eventType,
      entityId: mission.id,
      entityType: 'mission',
      payload: {
        goalId: goal.id,
        stepId: prepared.activeStep.id,
        sourceId: currentSource.id,
        sourceUrlHash: stableHash(currentSource.url),
        status,
        summary: dispatch.summary,
        errorCode: dispatch.errorCode,
        observationId: observation.id,
        observationContentHash: observation.contentHash,
        risk: assessment.risk,
        injectionSignalCodes: assessment.codes,
        artifactId: artifact?.id,
        artifactContentHash: artifact?.contentHash,
      },
    });
    state = sourceEvent.state;
    const updatedSource: ResearchMissionSource = {
      ...currentSource,
      status,
      artifactId: artifact?.id,
      contentHash: artifact?.contentHash,
      byteLength: artifact?.byteLength,
      chunks: artifact ? chunked.chunks : [],
      observationId: observation.id,
      observationRisk: assessment.risk,
      injectionSignalCodes: assessment.codes,
      evidenceEventId: sourceEvent.event.id,
      failureReason: status === 'captured' ? undefined : dispatch.status === 'failed'
        ? dispatch.summary
        : 'High-risk prompt-injection signals quarantined this source.',
      capturedAt: observation.capturedAt,
    };
    const sources = mission.sources.map((candidate) => candidate.id === updatedSource.id ? updatedSource : candidate);
    const remaining = sources.some((candidate) => candidate.status === 'pending');
    const capturedCount = sources.filter((candidate) => candidate.status === 'captured').length;
    const blocked = !remaining && capturedCount === 0;
    const nextStatus: ResearchMission['status'] = remaining ? 'collecting' : blocked ? 'blocked' : 'synthesizing';
    const now = new Date().toISOString();
    const updated: ResearchMission = {
      ...mission,
      sources,
      status: nextStatus,
      checkpoint: mission.checkpoint + 1,
      activeStep: undefined,
      resumeStage: blocked ? 'collecting' : undefined,
      retryable: blocked ? true : undefined,
      lastError: blocked ? 'No eligible source was captured. Explicit retry is required.' : undefined,
      updatedAt: now,
    };
    state = replaceResearchMission(state, updated, { status: blocked ? 'blocked' : 'active' });
    const currentTask = state.tasks.find((task) => task.id === mission.taskIds.collect);
    const taskStatus = remaining ? 'ready' : blocked ? 'blocked' : 'passed';
    await commitState({
      ...state,
      tasks: markTaskStatus(state.tasks, mission.taskIds.collect, taskStatus, now, {
        evidenceEventIds: [...(currentTask?.evidenceEventIds ?? []), sourceEvent.event.id],
        outputArtifactIds: artifact
          ? [...(currentTask?.outputArtifactIds ?? []), artifact.id]
          : currentTask?.outputArtifactIds ?? [],
      }),
    });
    return { outcome: blocked ? 'blocked' : 'advanced', mission: updated };
  });

  const runResearchSourceStep = async (
    missionId: string,
    ownership?: ResearchMission['schedulerOwnership'],
    parentSignal?: AbortSignal,
  ): Promise<ResearchMissionStepResult> => {
    const prepared = await prepareResearchSourceDispatch(missionId, ownership, parentSignal);
    if ('outcome' in prepared) return prepared;
    if (recoveryInProgress) throw new Error('Research source dispatch is unavailable while recovery is in progress.');
    const controller = new AbortController();
    const abortFromParent = () => controller.abort();
    if (parentSignal?.aborted) controller.abort();
    else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
    activeActionControllers.set(prepared.activeStep.id, controller);
    let dispatch: KernelActionWorkerResult;
    try {
      const current = await getState();
      if (current.controls.stopAll) throw new Error('Stop All became active before source dispatch.');
      if (controller.signal.aborted) throw new Error('Research source dispatch was cancelled before I/O.');
      dispatch = await awaitAbortable(
        prepared.worker.execute(prepared.intent, {
          timeoutMs: 30_000,
          authorization: prepared.authorization,
          signal: controller.signal,
        }),
        controller.signal,
        'Research source dispatch was cancelled before completion.',
      );
    } catch (error) {
      dispatch = {
        status: 'failed',
        summary: error instanceof Error ? error.message : 'Research source worker failed.',
        sourceRef: (prepared.intent.action as { url?: string }).url ?? 'about:invalid',
        errorCode: controller.signal.aborted ? 'cancelled' : 'worker_exception',
      };
    } finally {
      parentSignal?.removeEventListener('abort', abortFromParent);
      activeActionControllers.delete(prepared.activeStep.id);
    }
    if ((await getState()).controls.stopAll && dispatch.status === 'succeeded') {
      dispatch = {
        status: 'failed',
        summary: 'Stop All became active before the source result was committed.',
        sourceRef: dispatch.sourceRef,
        errorCode: 'cancelled',
      };
    }
    const content = dispatch.content ?? '';
    const heuristic = analyzePromptInjection(content);
    let risk = heuristic.risk;
    const codes = new Set<PromptInjectionSignalCode>(heuristic.signals.map((signal) => signal.code));
    if (options.observationAssessor) {
      try {
        const assessed = await assessObservation(content, parentSignal);
        if (!assessed) throw new Error('Observation assessor is unavailable.');
        const rank = { none: 0, medium: 1, high: 2 } as const;
        if (rank[assessed.risk] > rank[risk]) risk = assessed.risk;
        for (const signal of assessed.signals) codes.add(signal.code);
      } catch {
        // The deterministic heuristic remains the minimum assessment.
      }
    }
    return recordResearchSourceDispatch(prepared, dispatch, { risk, codes: [...codes] }, ownership, parentSignal);
  };

  const blockResearchMissionStep = (
    missionId: string,
    stage: ResearchMissionStage,
    error: unknown,
    retryable = true,
  ): Promise<ResearchMissionStepResult> => withMutation(async () => {
    let state = await readConsistentState();
    const goal = findResearchGoal(state, missionId);
    const mission = goal?.research;
    if (!goal || !mission) throw new Error('Research mission not found.');
    if (mission.status === 'completed') return { outcome: 'completed', mission };
    const message = (error instanceof Error ? error.message : 'Research mission step failed.').slice(0, 500);
    const now = new Date().toISOString();
    const sourceId = mission.activeStep?.sourceId;
    const sources = sourceId
      ? mission.sources.map((source) => source.id === sourceId && source.status === 'running'
        ? { ...source, status: 'failed' as const, failureReason: 'The in-flight source outcome was not committed.' }
        : source)
      : mission.sources;
    const updated: ResearchMission = {
      ...mission,
      sources,
      status: 'blocked',
      activeStep: undefined,
      resumeStage: stage,
      retryable,
      lastError: message,
      updatedAt: now,
    };
    const appended = await appendEvent(state, {
      actor: 'kernel',
      type: 'mission.step_failed',
      entityId: mission.id,
      entityType: 'mission',
      payload: {
        goalId: goal.id,
        stage,
        stepId: mission.activeStep?.id,
        retryable,
        errorHash: stableHash(message),
      },
    });
    state = replaceResearchMission(appended.state, updated, { status: 'blocked' });
    const taskId = taskIdForMissionStage(mission, stage);
    const currentTask = state.tasks.find((task) => task.id === taskId);
    await commitState({
      ...state,
      tasks: markTaskStatus(state.tasks, taskId, 'blocked', now, {
        evidenceEventIds: [...(currentTask?.evidenceEventIds ?? []), appended.event.id],
      }),
    });
    return { outcome: 'blocked', mission: updated };
  });

  const recordResearchPlan = (
    missionId: string,
    activeStep: ResearchMissionActiveStep,
    plan: ResearchMission['plan'] & {},
    providerRun: ResearchMissionProviderRun,
    ownership?: ResearchMission['schedulerOwnership'],
    parentSignal?: AbortSignal,
  ): Promise<ResearchMissionStepResult> => withMutation(async () => {
    let state = await readConsistentState();
    const goal = findResearchGoal(state, missionId);
    const mission = goal?.research;
    if (!goal || !mission) throw new Error('Research mission not found.');
    assertResearchResultCommitAllowed(state, mission, ownership, parentSignal);
    if (mission.activeStep?.id !== activeStep.id) throw new Error('Research plan does not match the active checkpoint.');
    const now = new Date().toISOString();
    const appended = await appendEvent(state, {
      actor: 'provider',
      type: 'mission.plan_completed',
      entityId: mission.id,
      entityType: 'mission',
      payload: {
        goalId: goal.id,
        stepId: activeStep.id,
        providerEvidenceEventId: providerRun.evidenceEventId,
        planHash: stableHash(plan),
        questionCount: plan.researchQuestions.length,
      },
    });
    const updated: ResearchMission = {
      ...mission,
      plan,
      status: 'collecting',
      checkpoint: mission.checkpoint + 1,
      activeStep: undefined,
      providerRuns: [...mission.providerRuns, providerRun],
      lastError: undefined,
      retryable: undefined,
      resumeStage: undefined,
      updatedAt: now,
    };
    state = replaceResearchMission(appended.state, updated);
    const taskRecord = state.tasks.find((task) => task.id === mission.taskIds.plan);
    await commitState({
      ...state,
      tasks: markTaskStatus(state.tasks, mission.taskIds.plan, 'passed', now, {
        evidenceEventIds: [...(taskRecord?.evidenceEventIds ?? []), providerRun.evidenceEventId, appended.event.id],
      }),
    });
    return { outcome: 'advanced', mission: updated };
  });

  const recordResearchDraft = (
    missionId: string,
    activeStep: ResearchMissionActiveStep,
    draft: NonNullable<ResearchMission['draft']>,
    deterministicIssues: string[],
    providerRun: ResearchMissionProviderRun,
    ownership?: ResearchMission['schedulerOwnership'],
    parentSignal?: AbortSignal,
  ): Promise<ResearchMissionStepResult> => withMutation(async () => {
    let state = await readConsistentState();
    const goal = findResearchGoal(state, missionId);
    const mission = goal?.research;
    if (!goal || !mission) throw new Error('Research mission not found.');
    assertResearchResultCommitAllowed(state, mission, ownership, parentSignal);
    if (mission.activeStep?.id !== activeStep.id) throw new Error('Research draft does not match the active checkpoint.');
    const attempts = mission.synthesisAttempts + 1;
    const grounded = deterministicIssues.length === 0;
    const retrying = !grounded && attempts < MAX_RESEARCH_SYNTHESIS_ATTEMPTS;
    const blocked = !grounded && !retrying;
    const now = new Date().toISOString();
    const appended = await appendEvent(state, {
      actor: grounded ? 'kernel' : 'provider',
      type: grounded ? 'mission.draft_grounded' : 'mission.grounding_failed',
      entityId: mission.id,
      entityType: 'mission',
      payload: {
        goalId: goal.id,
        stepId: activeStep.id,
        providerEvidenceEventId: providerRun.evidenceEventId,
        draftHash: stableHash(draft),
        claimCount: draft.claims.length,
        deterministicIssueHashes: deterministicIssues.map((issue) => stableHash(issue)),
        synthesisAttempt: attempts,
      },
    });
    const updated: ResearchMission = {
      ...mission,
      draft,
      status: grounded ? 'verifying' : blocked ? 'blocked' : 'synthesizing',
      checkpoint: mission.checkpoint + 1,
      activeStep: undefined,
      providerRuns: [...mission.providerRuns, providerRun],
      synthesisAttempts: attempts,
      lastVerificationIssues: deterministicIssues,
      resumeStage: blocked ? 'synthesizing' : undefined,
      retryable: blocked ? false : undefined,
      lastError: blocked ? 'Citation grounding failed after the bounded synthesis attempts.' : undefined,
      updatedAt: now,
    };
    state = replaceResearchMission(appended.state, updated, { status: blocked ? 'blocked' : 'active' });
    const taskRecord = state.tasks.find((task) => task.id === mission.taskIds.synthesize);
    await commitState({
      ...state,
      tasks: markTaskStatus(
        state.tasks,
        mission.taskIds.synthesize,
        grounded ? 'passed' : blocked ? 'blocked' : 'ready',
        now,
        { evidenceEventIds: [...(taskRecord?.evidenceEventIds ?? []), providerRun.evidenceEventId, appended.event.id] },
      ),
    });
    return { outcome: blocked ? 'blocked' : 'advanced', mission: updated };
  });

  const recordResearchCritique = async (
    missionId: string,
    activeStep: ResearchMissionActiveStep,
    critique: ReturnType<typeof parseResearchCritique>,
    deterministicIssues: string[],
    providerRun: ResearchMissionProviderRun,
    ownership?: ResearchMission['schedulerOwnership'],
    parentSignal?: AbortSignal,
  ): Promise<ResearchMissionStepResult> => {
    if (!options.artifactStore) throw new Error('The authenticated artifact store is unavailable.');
    return withMutation(async () => {
      let state = await readConsistentState();
      const goal = findResearchGoal(state, missionId);
      const mission = goal?.research;
      if (!goal || !mission) throw new Error('Research mission not found.');
      assertResearchResultCommitAllowed(state, mission, ownership, parentSignal);
      if (!mission.draft) throw new Error('Research mission has no grounded draft.');
      if (mission.activeStep?.id !== activeStep.id) throw new Error('Research critique does not match the active checkpoint.');
      const verification = buildResearchVerification(deterministicIssues, critique);
      const now = new Date().toISOString();
      const providerRuns = [...mission.providerRuns, providerRun];
      if (verification.status !== 'passed') {
        const issues = [
          ...verification.deterministicIssues,
          ...verification.criticIssues.map((issue) => `${issue.claimId}: ${issue.reason}`),
          ...(verification.criticVerdict === 'fail' ? [verification.criticSummary] : []),
        ];
        const retrying = mission.synthesisAttempts < MAX_RESEARCH_SYNTHESIS_ATTEMPTS;
        const appended = await appendEvent(state, {
          actor: 'provider',
          type: 'mission.critique_failed',
          entityId: mission.id,
          entityType: 'mission',
          payload: {
            goalId: goal.id,
            stepId: activeStep.id,
            providerEvidenceEventId: providerRun.evidenceEventId,
            issueHashes: issues.map((issue) => stableHash(issue)),
            retrying,
          },
        });
        const updated: ResearchMission = {
          ...mission,
          verification,
          providerRuns,
          status: retrying ? 'synthesizing' : 'blocked',
          checkpoint: mission.checkpoint + 1,
          activeStep: undefined,
          lastVerificationIssues: issues,
          resumeStage: retrying ? undefined : 'verifying',
          retryable: retrying ? undefined : false,
          lastError: retrying ? undefined : 'The separate critique pass failed after the bounded synthesis attempts.',
          updatedAt: now,
        };
        state = replaceResearchMission(appended.state, updated, { status: retrying ? 'active' : 'blocked' });
        const synthTask = state.tasks.find((task) => task.id === mission.taskIds.synthesize);
        const verifyTask = state.tasks.find((task) => task.id === mission.taskIds.verify);
        const tasks = state.tasks.map((task) => {
          if (task.id === mission.taskIds.synthesize) {
            return { ...task, status: retrying ? 'ready' as const : task.status, updatedAt: now };
          }
          if (task.id === mission.taskIds.verify) {
            return {
              ...task,
              status: retrying ? 'pending' as const : 'blocked' as const,
              evidenceEventIds: [...(verifyTask?.evidenceEventIds ?? []), providerRun.evidenceEventId, appended.event.id],
              updatedAt: now,
            };
          }
          if (task.id === mission.taskIds.publish && retrying) return { ...task, status: 'pending' as const, updatedAt: now };
          return task;
        });
        void synthTask;
        await commitState({ ...state, tasks });
        return { outcome: retrying ? 'advanced' : 'blocked', mission: updated };
      }

      const verifiedMission: ResearchMission = {
        ...mission,
        verification,
        providerRuns,
        activeStep: undefined,
        lastVerificationIssues: [],
        updatedAt: now,
      };
      const reportContent = renderVerifiedResearchReport(verifiedMission);
      const artifact = await options.artifactStore.create(reportContent);
      // A deadline can fire while the artifact file is being written. Do not
      // append publication evidence unless the final commit gate still holds.
      assertResearchResultCommitAllowed(state, mission, ownership, parentSignal);
      const publicationAcceptedAt = new Date().toISOString();
      let appended = await appendEvent(state, {
        actor: 'kernel',
        type: 'mission.verification_passed',
        entityId: mission.id,
        entityType: 'mission',
        payload: {
          goalId: goal.id,
          stepId: activeStep.id,
          providerEvidenceEventId: providerRun.evidenceEventId,
          claimCount: mission.draft.claims.length,
          verificationHash: stableHash(verification),
        },
      });
      state = appended.state;
      const verificationEventId = appended.event.id;
      appended = await appendEvent(state, {
        actor: 'kernel',
        type: 'artifact.created',
        entityId: artifact.id,
        entityType: 'artifact',
        payload: {
          artifactId: artifact.id,
          contentHash: artifact.contentHash,
          byteLength: artifact.byteLength,
          missionId: mission.id,
          kind: 'verified_research_report',
        },
      });
      state = appended.state;
      appended = await appendEvent(state, {
        actor: 'kernel',
        type: 'mission.report_published',
        entityId: mission.id,
        entityType: 'mission',
        payload: {
          goalId: goal.id,
          artifactId: artifact.id,
          contentHash: artifact.contentHash,
          reportInputHash: researchReportInputHash(verifiedMission),
          sourceEvidenceEventIds: mission.sources.flatMap((source) => (
            source.status === 'captured' && source.evidenceEventId ? [source.evidenceEventId] : []
          )),
          providerEvidenceEventIds: providerRuns.map((run) => run.evidenceEventId),
          verificationEventId,
          publicationAcceptedAt,
        },
      });
      state = appended.state;
      const publishedEventId = appended.event.id;
      const completedAt = publicationAcceptedAt;
      const completed: ResearchMission = {
        ...verifiedMission,
        status: 'completed',
        checkpoint: mission.checkpoint + 1,
        reportArtifactId: artifact.id,
        reportContentHash: artifact.contentHash,
        completedAt,
        updatedAt: completedAt,
      };
      appended = await appendEvent(state, {
        actor: 'kernel',
        type: 'goal.completed',
        entityId: goal.id,
        entityType: 'goal',
        payload: { missionId: mission.id, reportArtifactId: artifact.id, reportContentHash: artifact.contentHash },
      });
      state = replaceResearchMission(appended.state, completed, { status: 'completed' });
      const verifyTask = state.tasks.find((task) => task.id === mission.taskIds.verify);
      const publishTask = state.tasks.find((task) => task.id === mission.taskIds.publish);
      let tasks = markTaskStatus(state.tasks, mission.taskIds.verify, 'passed', completedAt, {
        evidenceEventIds: [...(verifyTask?.evidenceEventIds ?? []), providerRun.evidenceEventId, verificationEventId],
      });
      tasks = markTaskStatus(tasks, mission.taskIds.publish, 'passed', completedAt, {
        evidenceEventIds: [...(publishTask?.evidenceEventIds ?? []), publishedEventId],
        outputArtifactIds: [artifact.id],
      });
      await commitState({ ...state, tasks });
      return { outcome: 'completed', mission: completed };
    });
  };

  const runResearchProviderStep = async (
    missionId: string,
    stage: Exclude<ResearchMissionStage, 'collecting'>,
    ownership?: ResearchMission['schedulerOwnership'],
    parentSignal?: AbortSignal,
  ): Promise<ResearchMissionStepResult> => {
    let activeStep: ResearchMissionActiveStep | undefined;
    try {
      const initialState = await getState();
      const mission = findResearchGoal(initialState, missionId)?.research;
      if (!mission) throw new Error('Research mission not found.');
      assertResearchExecutionOwnership(mission, ownership);
      const requestId = createKernelId('mission_step');
      let sources: CapturedResearchSource[] = [];
      const request = stage === 'planning'
        ? buildResearchPlanRequest(mission, requestId)
        : stage === 'synthesizing'
          ? buildResearchDraftRequest(mission, sources = await loadCapturedResearchSources(mission), requestId)
          : buildResearchCritiqueRequest(mission, sources = await loadCapturedResearchSources(mission), requestId);
      activeStep = await beginResearchStep(mission.id, stage, 'provider', {
        requestId,
        requestHash: stableHash(request),
      }, ownership, parentSignal);
      const execution = await executeProviderRequest(
        mission.goalId,
        request,
        options.researchRoutingPolicy ?? { mode: 'automatic' },
        parentSignal,
      );
      if (execution.disagreement) throw new Error('Provider ensemble disagreed on the mission stage output.');
      if (execution.results.some((result) => result.toolCalls.length > 0)) {
        throw new Error('Mission provider returned forbidden tool calls.');
      }
      const purpose = stage === 'planning' ? 'plan' : stage === 'synthesizing' ? 'synthesis' : 'critique';
      const providerRun = await providerRunEvidence(purpose, requestId, execution);
      if (stage === 'planning') {
        return recordResearchPlan(mission.id, activeStep, parseResearchPlan(execution), providerRun, ownership, parentSignal);
      }
      if (stage === 'synthesizing') {
        const draft = parseResearchDraft(execution);
        return recordResearchDraft(
          mission.id,
          activeStep,
          draft,
          verifyResearchDraft(draft, sources),
          providerRun,
          ownership,
          parentSignal,
        );
      }
      const latestState = await getState();
      const latest = findResearchGoal(latestState, mission.id)?.research;
      if (!latest?.draft) throw new Error('Research mission has no grounded draft.');
      const deterministicIssues = verifyResearchDraft(latest.draft, sources);
      return recordResearchCritique(
        mission.id,
        activeStep,
        parseResearchCritique(execution),
        deterministicIssues,
        providerRun,
        ownership,
        parentSignal,
      );
    } catch (error) {
      if (!activeStep) {
        const latest = findResearchGoal(await getState(), missionId)?.research;
        if (latest?.activeStep) return { outcome: 'in_progress', mission: latest };
        if (latest && latest.status !== stage) {
          return {
            outcome: latest.status === 'completed' ? 'completed' : latest.status === 'blocked' ? 'blocked' : 'advanced',
            mission: latest,
          };
        }
      }
      return blockResearchMissionStep(missionId, stage, error, true);
    }
  };

  const stepResearchMissionWithOwnership = async (
    missionId: string,
    ownership?: ResearchMission['schedulerOwnership'],
    parentSignal?: AbortSignal,
  ): Promise<ResearchMissionStepResult> => {
    const state = await getState();
    const mission = findResearchGoal(state, missionId)?.research;
    if (!mission) throw new Error('Research mission not found.');
    assertResearchExecutionOwnership(mission, ownership);
    if (mission.status === 'completed') return { outcome: 'completed', mission };
    if (mission.status === 'blocked' || mission.status === 'cancelled') return { outcome: 'blocked', mission };
    if (mission.activeStep) return { outcome: 'in_progress', mission };
    if (mission.status === 'collecting') {
      try {
        return await runResearchSourceStep(mission.id, ownership, parentSignal);
      } catch (error) {
        return blockResearchMissionStep(mission.id, 'collecting', error, true);
      }
    }
    return runResearchProviderStep(mission.id, mission.status, ownership, parentSignal);
  };

  const stepResearchMission = async (missionId: string): Promise<ResearchMissionStepResult> => (
    stepResearchMissionWithOwnership(missionId)
  );

  const runResearchMission = async (
    missionId: string,
    maxSteps = 20,
  ): Promise<ResearchMissionStepResult> => {
    if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 25) {
      throw new Error('Research mission maxSteps must be an integer from 1 to 25.');
    }
    let result = await stepResearchMissionWithOwnership(missionId);
    for (let index = 1; index < maxSteps && result.outcome === 'advanced'; index += 1) {
      result = await stepResearchMissionWithOwnership(missionId);
    }
    return result;
  };

  const resumeResearchMissionWithOwnership = (
    missionId: string,
    reason: string,
    ownership?: ResearchMission['schedulerOwnership'],
  ): Promise<ResearchMission> => withMutation(async () => {
    if (!reason.trim()) throw new Error('Research mission resume reason is required.');
    let state = await readConsistentState();
    const goal = findResearchGoal(state, missionId);
    const mission = goal?.research;
    if (!goal || !mission) throw new Error('Research mission not found.');
    assertResearchExecutionOwnership(mission, ownership);
    if (mission.status !== 'blocked' || !mission.resumeStage) throw new Error('Research mission is not resumable.');
    if (mission.retryable !== true) throw new Error('Research mission requires revision rather than retry.');
    if (state.controls.stopAll) throw new Error('Stop All is active. Resume the kernel before the mission.');
    const now = new Date().toISOString();
    const sources = mission.resumeStage === 'collecting'
      ? mission.sources.map((source) => source.status === 'failed' || source.status === 'quarantined'
        ? {
          ...source,
          status: 'pending' as const,
          artifactId: undefined,
          contentHash: undefined,
          byteLength: undefined,
          chunks: [],
          observationId: undefined,
          observationRisk: undefined,
          injectionSignalCodes: [],
          evidenceEventId: undefined,
          failureReason: undefined,
          capturedAt: undefined,
        }
        : source)
      : mission.sources;
    const updated: ResearchMission = {
      ...mission,
      sources,
      status: mission.resumeStage,
      activeStep: undefined,
      resumeStage: undefined,
      retryable: undefined,
      lastError: undefined,
      updatedAt: now,
    };
    let appended = await appendEvent(state, {
      actor: 'user',
      type: 'mission.resume_authorized',
      entityId: mission.id,
      entityType: 'mission',
      payload: {
        goalId: goal.id,
        stage: mission.resumeStage,
        revision: mission.revision,
        reasonHash: stableHash(reason.trim()),
      },
    });
    state = appended.state;
    appended = await appendEvent(state, {
      actor: 'user',
      type: 'task.resume_authorized',
      entityId: taskIdForMissionStage(mission, mission.resumeStage),
      entityType: 'task',
      payload: { goalId: goal.id, missionId: mission.id, reasonHash: stableHash(reason.trim()) },
    });
    state = replaceResearchMission(appended.state, updated, { status: 'active' });
    const resumedTask = state.tasks.find((task) => task.id === taskIdForMissionStage(mission, mission.resumeStage!));
    await commitState({
      ...state,
      tasks: markTaskStatus(state.tasks, taskIdForMissionStage(mission, mission.resumeStage), 'ready', now, {
        evidenceEventIds: [...(resumedTask?.evidenceEventIds ?? []), appended.event.id],
      }),
    });
    return updated;
  });

  const resumeResearchMission = (missionId: string, reason: string): Promise<ResearchMission> => (
    resumeResearchMissionWithOwnership(missionId, reason)
  );

  const getResearchMissionReport = async (
    missionId: string,
  ): Promise<{ content: string; contentHash: string }> => {
    if (!options.artifactStore) throw new Error('The authenticated artifact store is unavailable.');
    const state = await getState();
    const mission = findResearchGoal(state, missionId)?.research;
    if (!mission) throw new Error('Research mission not found.');
    if (mission.status !== 'completed' || !mission.reportArtifactId || !mission.reportContentHash) {
      throw new Error('Research mission has no published report.');
    }
    const events = await getEvents();
    const published = events.find((event) => (
      event.type === 'mission.report_published' &&
      event.entityId === mission.id &&
      event.payload.artifactId === mission.reportArtifactId &&
      event.payload.contentHash === mission.reportContentHash
    ));
    if (!published) throw new Error('Published report is not bound to the mission ledger.');
    if (published.payload.reportInputHash !== researchReportInputHash(mission)) {
      throw new Error('Published report inputs are not authenticated by the mission ledger.');
    }

    const capturedSources = mission.sources.filter((source) => source.status === 'captured');
    if (capturedSources.length === 0) {
      throw new Error('Published report source evidence is unavailable or invalid.');
    }
    const expectedSourceEvidenceEventIds = capturedSources.flatMap((source) => (
      source.evidenceEventId ? [source.evidenceEventId] : []
    ));
    if (
      expectedSourceEvidenceEventIds.length !== capturedSources.length ||
      !exactStringArray(published.payload.sourceEvidenceEventIds, expectedSourceEvidenceEventIds)
    ) {
      throw new Error('Published report source evidence is unavailable or invalid.');
    }
    for (const source of capturedSources) {
      if (!source.artifactId || !source.contentHash || !source.evidenceEventId) {
        throw new Error('Published report source evidence is unavailable or invalid.');
      }
      const sourceArtifact = await options.artifactStore.resolve(source.artifactId);
      const reconstructed = sourceArtifact
        ? chunkResearchSource(source.id, sourceArtifact.content)
        : undefined;
      if (
        !sourceArtifact ||
        sourceArtifact.contentHash !== source.contentHash ||
        reconstructed?.content !== sourceArtifact.content ||
        stableHash(reconstructed.chunks) !== stableHash(source.chunks)
      ) {
        throw new Error('Published report source evidence is unavailable or invalid.');
      }
      const sourceEvent = events.find((event) => event.id === source.evidenceEventId);
      const artifactEvent = events.find((event) => (
        event.type === 'artifact.created' &&
        event.entityId === source.artifactId &&
        event.payload.missionId === mission.id &&
        event.payload.sourceId === source.id &&
        event.payload.kind === 'research_source' &&
        event.payload.contentHash === source.contentHash
      ));
      if (
        !sourceEvent ||
        sourceEvent.type !== 'mission.source_captured' ||
        sourceEvent.entityId !== mission.id ||
        sourceEvent.payload.goalId !== mission.goalId ||
        sourceEvent.payload.sourceId !== source.id ||
        sourceEvent.payload.sourceUrlHash !== stableHash(source.url) ||
        sourceEvent.payload.status !== 'captured' ||
        sourceEvent.payload.artifactId !== source.artifactId ||
        sourceEvent.payload.artifactContentHash !== source.contentHash ||
        !artifactEvent ||
        new URL(source.url).origin !== source.origin
      ) {
        throw new Error('Published report source evidence is unavailable or invalid.');
      }
    }

    const expectedProviderEvidenceEventIds = mission.providerRuns.map((run) => run.evidenceEventId);
    if (!exactStringArray(published.payload.providerEvidenceEventIds, expectedProviderEvidenceEventIds)) {
      throw new Error('Published report provider evidence is unavailable or invalid.');
    }
    for (const run of mission.providerRuns) {
      const providerEvent = events.find((event) => event.id === run.evidenceEventId);
      if (
        !providerEvent ||
        providerEvent.type !== 'provider.call.completed' ||
        providerEvent.entityId !== run.requestId ||
        providerEvent.payload.goalId !== mission.goalId
      ) {
        throw new Error('Published report provider evidence is unavailable or invalid.');
      }
    }
    const verificationEvent = events.find((event) => event.id === published.payload.verificationEventId);
    if (
      !verificationEvent ||
      verificationEvent.type !== 'mission.verification_passed' ||
      verificationEvent.entityId !== mission.id ||
      verificationEvent.payload.goalId !== mission.goalId ||
      mission.verification?.status !== 'passed'
    ) {
      throw new Error('Published report verification evidence is unavailable or invalid.');
    }

    const reportArtifactEvent = events.find((event) => (
      event.type === 'artifact.created' &&
      event.entityId === mission.reportArtifactId &&
      event.payload.missionId === mission.id &&
      event.payload.kind === 'verified_research_report' &&
      event.payload.contentHash === mission.reportContentHash
    ));
    if (!reportArtifactEvent) throw new Error('Published report is not bound to its artifact ledger event.');
    const resolved = await options.artifactStore.resolve(mission.reportArtifactId);
    if (!resolved || resolved.contentHash !== mission.reportContentHash) {
      throw new Error('Published report failed authenticated artifact resolution.');
    }
    return resolved;
  };

  const getRecurringResearchCapability = (): RecurringResearchCapability => {
    const research = getResearchMissionCapability();
    const schedulerEnabled = options.recurringResearchSchedulerEnabled === true;
    return {
      available: schedulerEnabled && research.available,
      reason: !schedulerEnabled
        ? 'The durable recurring research scheduler is disabled in this deployment.'
        : !research.available
          ? research.reason
          : 'Durable interval scheduling is available for fixed, read-only research missions.',
      schedulerEnabled,
      tickIntervalMs: recurringResearchTickMs,
      minIntervalMinutes: MIN_RESEARCH_INTERVAL_MS / 60_000,
      maxIntervalMinutes: MAX_RESEARCH_INTERVAL_MS / 60_000,
      allowedOrigins: research.allowedOrigins,
      maxSources: research.maxSources,
    };
  };

  const listRecurringResearchSchedules = async (): Promise<RecurringResearchScheduleRecord[]> => {
    const state = await getState();
    return [...recurringResearchState(state).schedules]
      .sort((left, right) => left.contract.createdAt.localeCompare(right.contract.createdAt));
  };

  const getRecurringResearchSchedule = async (
    scheduleId: string,
  ): Promise<{ schedule: RecurringResearchScheduleRecord; occurrences: RecurringResearchOccurrenceRecord[] }> => {
    const state = await getState();
    const recurring = recurringResearchState(state);
    const schedule = recurring.schedules.find((candidate) => candidate.contract.id === scheduleId);
    if (!schedule) throw new Error('Recurring research schedule not found.');
    return {
      schedule,
      occurrences: recurring.occurrences
        .filter((occurrence) => occurrence.scheduleId === scheduleId)
        .sort((left, right) => right.scheduledFor.localeCompare(left.scheduledFor)),
    };
  };

  const createRecurringResearchScheduleContract = async (
    value: unknown,
  ): Promise<RecurringResearchScheduleRecord> => {
    const now = new Date().toISOString();
    const normalized = normalizeRecurringResearchScheduleInput(value, now);
    const capability = getRecurringResearchCapability();
    if (!capability.available) throw new Error(capability.reason);
    const allowedOrigins = new Set(capability.allowedOrigins);
    const deniedOrigin = normalized.sourceUrls
      .map((url) => { try { return new URL(url).origin; } catch { return 'invalid'; } })
      .find((origin) => !allowedOrigins.has(origin));
    if (deniedOrigin) throw new Error(`Schedule source origin is outside WEB_INSPECT_ORIGINS: ${deniedOrigin}.`);

    const contract = createRecurringResearchSchedule({
      id: createKernelId('research_schedule'),
      enabled: false,
      objective: normalized.objective,
      sourceUrls: normalized.sourceUrls,
      trigger: {
        type: 'interval',
        everyMs: normalized.intervalMs,
        startsAt: normalized.startsAt,
        catchUp: 'latest_once',
      },
      budget: normalized.budget,
    }, now);
    const record: RecurringResearchScheduleRecord = {
      contract,
      maxRuns: normalized.maxRuns,
      maxConsecutiveFailures: normalized.maxConsecutiveFailures,
      runsClaimed: 0,
      consecutiveFailures: 0,
      nextDueAt: contract.trigger.startsAt,
    };

    return withMutation(async () => {
      let state = await ensureCurrentStateSchema(await readConsistentState());
      const recurring = recurringResearchState(state);
      const appended = await appendEvent(state, {
        actor: 'user',
        type: 'schedule.created',
        entityId: contract.id,
        entityType: 'schedule',
        payload: {
          scheduleId: contract.id,
          version: contract.version,
          objectiveHash: stableHash(contract.objective),
          sourceUrlHashes: contract.sourceUrls.map((url) => stableHash(url)),
          intervalMs: contract.trigger.everyMs,
          startsAt: contract.trigger.startsAt,
          maxRuns: record.maxRuns,
          maxConsecutiveFailures: record.maxConsecutiveFailures,
          budget: contract.budget,
        },
      });
      state = appended.state;
      await commitState({
        ...state,
        recurringResearch: {
          ...recurring,
          schedules: [...recurring.schedules, record],
        },
      });
      return record;
    });
  };

  const setRecurringResearchScheduleEnabled = (
    scheduleId: string,
    enabled: boolean,
    reason: string,
  ): Promise<RecurringResearchScheduleRecord> => withMutation(async () => {
    if (!reason.trim()) throw new Error('Schedule state change reason is required.');
    let state = await ensureCurrentStateSchema(await readConsistentState());
    const recurring = recurringResearchState(state);
    const current = recurring.schedules.find((candidate) => candidate.contract.id === scheduleId);
    if (!current) throw new Error('Recurring research schedule not found.');
    if (current.contract.enabled === enabled) throw new Error(`Schedule is already ${enabled ? 'enabled' : 'disabled'}.`);
    if (enabled) {
      const capability = getRecurringResearchCapability();
      if (!capability.available) throw new Error(capability.reason);
      if (state.controls.stopAll) throw new Error('Stop All is active. Resume the kernel before enabling schedules.');
      if (current.activeOccurrenceId) throw new Error('Resolve the active occurrence before enabling this schedule.');
      if (current.runsClaimed >= current.maxRuns) throw new Error('Schedule run budget is exhausted.');
    }
    const now = new Date().toISOString();
    const contract = updateRecurringResearchSchedule(current.contract, { enabled }, now);
    const due = calculateNextResearchDue(contract, now, current.scheduledThrough);
    const updated: RecurringResearchScheduleRecord = {
      ...current,
      contract,
      nextDueAt: due.nextDueAt,
      consecutiveFailures: enabled ? 0 : current.consecutiveFailures,
      haltedReason: enabled ? undefined : reason.trim(),
    };
    const appended = await appendEvent(state, {
      actor: 'user',
      type: enabled ? 'schedule.enabled' : 'schedule.disabled',
      entityId: scheduleId,
      entityType: 'schedule',
      payload: {
        scheduleId,
        version: contract.version,
        reasonHash: stableHash(reason.trim()),
        nextDueAt: updated.nextDueAt,
      },
    });
    state = appended.state;
    await commitState({
      ...state,
      recurringResearch: {
        ...recurring,
        schedules: recurring.schedules.map((candidate) => candidate.contract.id === scheduleId ? updated : candidate),
      },
    });
    return updated;
  });

  interface PreparedRecurringResearchOccurrence {
    schedule: RecurringResearchScheduleRecord;
    occurrence: RecurringResearchOccurrenceRecord;
    ownership: NonNullable<ResearchMission['schedulerOwnership']>;
    mission: ResearchMission;
  }

  type RecurringResearchPreparation =
    | { kind: 'result'; result: RecurringResearchTickResult }
    | { kind: 'dispatch'; prepared: PreparedRecurringResearchOccurrence };

  const disableRecurringSchedule = (
    record: RecurringResearchScheduleRecord,
    reason: string,
    now: string,
  ): RecurringResearchScheduleRecord => ({
    ...record,
    contract: record.contract.enabled
      ? updateRecurringResearchSchedule(record.contract, { enabled: false }, now)
      : record.contract,
    haltedReason: reason,
  });

  const failClosedRecurringResearchOccurrence = (
    identity: {
      scheduleId: string;
      occurrenceId: string;
      missionId: string;
      leaseId: string;
      leaseFence: number;
    },
    error: unknown,
  ): Promise<RecurringResearchTickResult> => withMutation(async () => {
    let state = await readConsistentState();
    const recurring = recurringResearchState(state);
    const current = recurring.occurrences.find((candidate) => candidate.id === identity.occurrenceId);
    const schedule = recurring.schedules.find((candidate) => candidate.contract.id === identity.scheduleId);
    const message = (error instanceof Error
      ? error.message
      : 'Recurring research could not durably record its outcome.').slice(0, 1_000);
    if (!current || !schedule) return { outcome: 'blocked', reason: message };
    if (
      current.leaseId !== identity.leaseId ||
      current.leaseFence !== identity.leaseFence ||
      current.missionId !== identity.missionId
    ) {
      return { outcome: 'blocked', schedule, occurrence: current, reason: 'A newer occurrence owner already resolved this run.' };
    }
    if (current.status !== 'claimed' && current.status !== 'running') {
      const mission = findResearchGoal(state, current.missionId)?.research;
      return { outcome: 'blocked', schedule, occurrence: current, mission, reason: current.statusReason ?? message };
    }

    const now = new Date().toISOString();
    let appended = await appendEvent(state, {
      actor: 'kernel',
      type: 'schedule.occurrence_uncertain',
      entityId: current.id,
      entityType: 'occurrence',
      payload: {
        scheduleId: schedule.contract.id,
        occurrenceId: current.id,
        missionId: current.missionId,
        leaseId: current.leaseId,
        leaseFence: current.leaseFence,
        reasonHash: stableHash(message),
        failClosed: true,
      },
    });
    state = appended.state;
    const uncertainEventId = appended.event.id;
    const uncertain: RecurringResearchOccurrenceRecord = {
      ...current,
      status: 'uncertain',
      statusReason: message,
      runtimeUsedMs: chargedRecurringRuntimeMs(current, now, schedule.contract.budget.maxRuntimeMs),
      attemptStartedAt: undefined,
      evidenceRefs: [...current.evidenceRefs, { eventId: uncertainEventId }],
      updatedAt: now,
    };

    let mission = findResearchGoal(state, current.missionId)?.research;
    let tasks = state.tasks;
    if (mission && ['planning', 'collecting', 'synthesizing', 'verifying'].includes(mission.status)) {
      const stage = mission.activeStep?.stage ?? mission.status as ResearchMissionStage;
      appended = await appendEvent(state, {
        actor: 'kernel',
        type: 'mission.interrupted',
        entityId: mission.id,
        entityType: 'mission',
        payload: {
          goalId: mission.goalId,
          stepId: mission.activeStep?.id,
          stage,
          reasonHash: stableHash(message),
          occurrenceId: current.id,
        },
      });
      state = appended.state;
      const blockedMission: ResearchMission = {
        ...mission,
        status: 'blocked',
        activeStep: undefined,
        resumeStage: stage,
        retryable: true,
        lastError: message,
        sources: mission.sources.map((source) => source.status === 'running'
          ? { ...source, status: 'failed', failureReason: 'The in-flight source outcome was not durably committed.' }
          : source),
        updatedAt: now,
      };
      state = replaceResearchMission(state, blockedMission, { status: 'blocked' });
      const taskId = taskIdForMissionStage(mission, stage);
      const task = tasks.find((candidate) => candidate.id === taskId);
      tasks = markTaskStatus(tasks, taskId, 'blocked', now, {
        evidenceEventIds: [...(task?.evidenceEventIds ?? []), appended.event.id],
      });
      mission = blockedMission;
    }

    const halted = disableRecurringSchedule(
      { ...schedule, activeOccurrenceId: current.id, lastOccurrenceId: current.id },
      message,
      now,
    );
    await commitState({
      ...state,
      tasks,
      recurringResearch: {
        ...recurring,
        schedules: recurring.schedules.map((candidate) => candidate.contract.id === halted.contract.id ? halted : candidate),
        occurrences: recurring.occurrences.map((candidate) => candidate.id === uncertain.id ? uncertain : candidate),
      },
    });
    return { outcome: 'blocked', schedule: halted, occurrence: uncertain, mission, reason: message };
  });

  const prepareRecurringResearchOccurrence = (
    now: string,
    workspaceRoot: string,
  ): Promise<RecurringResearchPreparation> => withMutation(async () => {
    let state = await ensureCurrentStateSchema(await readConsistentState());
    if (state.controls.stopAll) {
      return { kind: 'result', result: { outcome: 'stopped', reason: 'Stop All is active.' } };
    }
    const capability = getRecurringResearchCapability();
    if (!capability.available) {
      return { kind: 'result', result: { outcome: 'blocked', reason: capability.reason } };
    }
    const recurring = recurringResearchState(state);
    const dueCandidates = recurring.schedules.flatMap((schedule) => {
      if (
        !schedule.contract.enabled ||
        schedule.activeOccurrenceId ||
        schedule.runsClaimed >= schedule.maxRuns
      ) return [];
      const decision = calculateNextResearchDue(schedule.contract, now, schedule.scheduledThrough);
      return decision.due ? [{ schedule, decision }] : [];
    }).sort((left, right) => (
      left.decision.scheduledFor.localeCompare(right.decision.scheduledFor) ||
      left.schedule.contract.id.localeCompare(right.schedule.contract.id)
    ));
    const selected = dueCandidates[0];
    if (!selected) return { kind: 'result', result: { outcome: 'idle', reason: 'No schedule is due.' } };

    const allowedOrigins = new Set(capability.allowedOrigins);
    const deniedOrigin = selected.schedule.contract.sourceUrls
      .map((url) => new URL(url).origin)
      .find((origin) => !allowedOrigins.has(origin));
    if (deniedOrigin) {
      const blocked = disableRecurringSchedule(
        selected.schedule,
        `Configured source origin is no longer authorized: ${deniedOrigin}.`,
        now,
      );
      const appended = await appendEvent(state, {
        actor: 'kernel',
        type: 'schedule.blocked',
        entityId: blocked.contract.id,
        entityType: 'schedule',
        payload: { scheduleId: blocked.contract.id, reasonCode: 'origin_removed', originHash: stableHash(deniedOrigin) },
      });
      await commitState({
        ...appended.state,
        recurringResearch: {
          ...recurring,
          schedules: recurring.schedules.map((candidate) => (
            candidate.contract.id === blocked.contract.id ? blocked : candidate
          )),
        },
      });
      return { kind: 'result', result: { outcome: 'blocked', schedule: blocked, reason: blocked.haltedReason } };
    }

    const due = createDueResearchOccurrence(selected.schedule.contract, selected.decision, now);
    if (recurring.occurrences.some((candidate) => candidate.id === due.id)) {
      throw new Error('Recurring research occurrence already exists for this schedule boundary.');
    }
    const leaseId = createKernelId('schedule_lease');
    const leaseFence = 1;
    const deadlineAt = new Date(Date.parse(now) + selected.schedule.contract.budget.maxRuntimeMs).toISOString();
    const leaseExpiresAt = new Date(
      Date.parse(deadlineAt) + RECURRING_RESEARCH_LEASE_GRACE_MS,
    ).toISOString();
    const claimed = claimResearchOccurrence(due, {
      owner: schedulerInstanceId,
      claimedAt: now,
      expiresAt: leaseExpiresAt,
    });
    const running = startResearchOccurrence(claimed, schedulerInstanceId, now);
    const ownership: NonNullable<ResearchMission['schedulerOwnership']> = {
      scheduleId: selected.schedule.contract.id,
      occurrenceId: due.id,
      leaseId,
      leaseFence,
    };
    const created = await appendResearchMissionCreation(
      state,
      normalizeResearchMissionInput({
        objective: selected.schedule.contract.objective,
        sourceUrls: [...selected.schedule.contract.sourceUrls],
      }),
      workspaceRoot,
      { actor: 'kernel', schedulerOwnership: ownership },
    );
    const occurrence: RecurringResearchOccurrenceRecord = {
      ...running,
      leaseId,
      leaseFence,
      deadlineAt,
      goalId: created.goal.id,
      missionId: created.mission.id,
      attempt: 1,
      runtimeUsedMs: 0,
      attemptStartedAt: now,
      sourceFetchesUsed: 0,
    };
    const runsClaimed = selected.schedule.runsClaimed + 1;
    let updatedSchedule: RecurringResearchScheduleRecord = {
      ...selected.schedule,
      runsClaimed,
      scheduledThrough: selected.decision.scheduledFor,
      nextDueAt: selected.decision.nextDueAt,
      activeOccurrenceId: occurrence.id,
      lastOccurrenceId: occurrence.id,
      haltedReason: undefined,
    };
    if (runsClaimed >= selected.schedule.maxRuns) {
      updatedSchedule = disableRecurringSchedule(updatedSchedule, 'Schedule run budget is exhausted.', now);
    }
    let appended = await appendEvent(created.state, {
      actor: 'kernel',
      type: 'schedule.occurrence_claimed',
      entityId: occurrence.id,
      entityType: 'occurrence',
      payload: {
        scheduleId: updatedSchedule.contract.id,
        scheduleVersion: due.scheduleVersion,
        occurrenceId: occurrence.id,
        scheduledFor: occurrence.scheduledFor,
        catchUpApplied: occurrence.catchUpApplied,
        skippedIntervals: occurrence.skippedIntervals,
        leaseId,
        leaseFence,
        leaseOwnerHash: stableHash(schedulerInstanceId),
        leaseExpiresAt,
        deadlineAt,
        goalId: occurrence.goalId,
        missionId: occurrence.missionId,
        runNumber: runsClaimed,
      },
    });
    state = appended.state;
    await commitState({
      ...state,
      goals: [...state.goals, created.goal],
      tasks: [...state.tasks, ...created.tasks],
      recurringResearch: {
        ...recurring,
        schedules: recurring.schedules.map((candidate) => (
          candidate.contract.id === updatedSchedule.contract.id ? updatedSchedule : candidate
        )),
        occurrences: [...recurring.occurrences, occurrence],
      },
    });
    return {
      kind: 'dispatch',
      prepared: { schedule: updatedSchedule, occurrence, ownership, mission: created.mission },
    };
  });

  const recordRecurringResearchOutcome = (
    prepared: PreparedRecurringResearchOccurrence,
    requestedStatus: Extract<RecurringResearchOccurrenceStatus, 'completed' | 'failed' | 'blocked' | 'uncertain'>,
    reason: string | undefined,
    report?: { artifactId: string; contentHash: string; eventId: string },
  ): Promise<RecurringResearchOccurrenceRecord> => withMutation(async () => {
    let state = await readConsistentState();
    const recurring = recurringResearchState(state);
    const current = recurring.occurrences.find((candidate) => candidate.id === prepared.occurrence.id);
    const schedule = recurring.schedules.find((candidate) => candidate.contract.id === prepared.schedule.contract.id);
    if (!current || !schedule) throw new Error('Recurring research occurrence state is unavailable.');
    if (
      current.leaseId !== prepared.occurrence.leaseId ||
      current.leaseFence !== prepared.occurrence.leaseFence ||
      current.lease?.owner !== schedulerInstanceId ||
      current.missionId !== prepared.mission.id ||
      current.status !== 'running'
    ) {
      throw new Error('Recurring research completion was rejected as stale.');
    }
    const now = new Date().toISOString();
    const runtimeUsedMs = chargedRecurringRuntimeMs(
      current,
      now,
      schedule.contract.budget.maxRuntimeMs,
    );
    let status = requestedStatus;
    let statusReason = reason;
    const completedMission = status === 'completed'
      ? findResearchGoal(state, current.missionId)?.research
      : undefined;
    if (Date.parse(now) >= Date.parse(current.lease!.expiresAt)) {
      status = 'uncertain';
      statusReason = 'The scheduler lease expired before the result could be committed.';
    } else if (
      status === 'completed' &&
      (
        !completedMission?.completedAt ||
        Date.parse(completedMission.completedAt) >= Date.parse(current.deadlineAt)
      )
    ) {
      status = 'failed';
      statusReason = 'The mission did not commit completion before its durable runtime deadline.';
      report = undefined;
    }
    let appended = await appendEvent(state, {
      actor: 'kernel',
      type: `schedule.occurrence_${status}`,
      entityId: current.id,
      entityType: 'occurrence',
      payload: {
        scheduleId: schedule.contract.id,
        occurrenceId: current.id,
        status,
        reasonHash: statusReason ? stableHash(statusReason) : undefined,
        leaseId: current.leaseId,
        leaseFence: current.leaseFence,
        missionId: current.missionId,
        missionCompletedAt: completedMission?.completedAt,
        reportArtifactId: report?.artifactId,
        reportContentHash: report?.contentHash,
      },
    });
    state = appended.state;
    const evidenceRefs = [
      { eventId: appended.event.id },
      ...(report ? [{ eventId: report.eventId, artifactId: report.artifactId, contentHash: report.contentHash }] : []),
    ];
    const finishedBase = status === 'uncertain' && Date.parse(now) >= Date.parse(current.lease!.expiresAt)
      ? {
        ...current,
        status: 'uncertain' as const,
        statusReason: statusReason!,
        evidenceRefs: [...current.evidenceRefs, ...evidenceRefs],
        updatedAt: now,
      }
      : finishResearchOccurrence(current, {
        status,
        now,
        reason: status === 'completed' ? undefined : statusReason ?? 'Recurring research did not complete.',
        evidenceRefs,
      });
    const finished: RecurringResearchOccurrenceRecord = {
      ...current,
      ...finishedBase,
      runtimeUsedMs,
      attemptStartedAt: undefined,
      reportArtifactId: report?.artifactId,
      reportContentHash: report?.contentHash,
    };
    let consecutiveFailures = schedule.consecutiveFailures;
    if (status === 'completed') consecutiveFailures = 0;
    else if (status === 'failed') consecutiveFailures += 1;
    const remainsActive = status === 'blocked' || status === 'uncertain';
    let updatedSchedule: RecurringResearchScheduleRecord = {
      ...schedule,
      consecutiveFailures,
      activeOccurrenceId: remainsActive ? current.id : undefined,
      lastOccurrenceId: current.id,
    };
    if (remainsActive) {
      updatedSchedule = disableRecurringSchedule(
        updatedSchedule,
        statusReason ?? 'The active occurrence requires explicit operator resolution.',
        now,
      );
    } else if (consecutiveFailures >= schedule.maxConsecutiveFailures) {
      updatedSchedule = disableRecurringSchedule(
        updatedSchedule,
        'Schedule halted after reaching its consecutive failure bound.',
        now,
      );
    }
    await commitState({
      ...state,
      recurringResearch: {
        ...recurring,
        schedules: recurring.schedules.map((candidate) => (
          candidate.contract.id === updatedSchedule.contract.id ? updatedSchedule : candidate
        )),
        occurrences: recurring.occurrences.map((candidate) => candidate.id === finished.id ? finished : candidate),
      },
    });
    return finished;
  });

  const executeRecurringResearchOccurrence = async (
    prepared: PreparedRecurringResearchOccurrence,
  ): Promise<RecurringResearchTickResult> => {
    if (recoveryInProgress) {
      return failClosedRecurringResearchOccurrence({
        scheduleId: prepared.schedule.contract.id,
        occurrenceId: prepared.occurrence.id,
        missionId: prepared.mission.id,
        leaseId: prepared.occurrence.leaseId,
        leaseFence: prepared.occurrence.leaseFence,
      }, new Error('Recurring research dispatch was blocked because recovery is in progress.'));
    }
    if (activeRecurringResearchControllers.has(prepared.occurrence.id)) {
      return { outcome: 'started', ...prepared, reason: 'Occurrence is already running.' };
    }
    const controller = new AbortController();
    activeRecurringResearchControllers.set(prepared.occurrence.id, controller);
    let deadlineExceeded = false;
    const timeoutMs = Math.max(1, Date.parse(prepared.occurrence.deadlineAt) - Date.now());
    const deadlineTimer = setTimeout(() => {
      deadlineExceeded = true;
      controller.abort();
    }, timeoutMs);
    let result: ResearchMissionStepResult | undefined;
    let executionError: unknown;
    try {
      const state = await getState();
      if (state.controls.stopAll) controller.abort();
      for (let step = 0; step < 25 && !controller.signal.aborted; step += 1) {
        result = await stepResearchMissionWithOwnership(
          prepared.mission.id,
          prepared.ownership,
          controller.signal,
        );
        if (result.outcome !== 'advanced') break;
      }
    } catch (error) {
      executionError = error;
    } finally {
      clearTimeout(deadlineTimer);
      activeRecurringResearchControllers.delete(prepared.occurrence.id);
    }

    try {
      let status: Extract<RecurringResearchOccurrenceStatus, 'completed' | 'failed' | 'blocked' | 'uncertain'>;
      let reason: string | undefined;
      let report: { artifactId: string; contentHash: string; eventId: string } | undefined;
      let latestState = await getState();
      let mission = findResearchGoal(latestState, prepared.mission.id)?.research;
      const missionCompleted = result?.outcome === 'completed' && mission?.status === 'completed';
      if (missionCompleted) {
      try {
        const resolved = await getResearchMissionReport(mission.id);
        const events = await getEvents();
        const published = [...events].reverse().find((event) => (
          event.type === 'mission.report_published' &&
          event.entityId === mission!.id &&
          event.payload.artifactId === mission!.reportArtifactId
        ));
        if (!published || !mission.reportArtifactId) throw new Error('Published report event is unavailable.');
        report = {
          artifactId: mission.reportArtifactId,
          contentHash: resolved.contentHash,
          eventId: published.id,
        };
        status = 'completed';
      } catch (error) {
        status = 'failed';
        reason = error instanceof Error ? error.message : 'Published report authentication failed.';
      }
      } else if (deadlineExceeded || latestState.controls.stopAll || controller.signal.aborted) {
      if (mission && ['planning', 'collecting', 'synthesizing', 'verifying'].includes(mission.status)) {
        await blockResearchMissionStep(
          mission.id,
          mission.status as ResearchMissionStage,
          new Error(deadlineExceeded
            ? 'The occurrence exceeded its durable runtime deadline.'
            : 'Stop All or scheduler shutdown cancelled the occurrence before completion.'),
          true,
        );
        latestState = await getState();
        mission = findResearchGoal(latestState, prepared.mission.id)?.research;
      }
      status = deadlineExceeded ? 'failed' : 'blocked';
      reason = deadlineExceeded
        ? 'The occurrence exceeded its durable runtime deadline.'
        : 'Stop All or scheduler shutdown cancelled the occurrence before completion.';
      } else if (executionError) {
        status = mission?.retryable ? 'blocked' : 'failed';
        reason = executionError instanceof Error ? executionError.message : 'Recurring research execution failed.';
      } else if (mission?.status === 'blocked' && mission.retryable) {
        status = 'blocked';
        reason = mission.lastError ?? 'Research mission requires explicit resume.';
      } else {
        status = 'failed';
        reason = mission?.lastError ?? 'Research mission did not complete within its bounded step count.';
      }
      const occurrence = await recordRecurringResearchOutcome(prepared, status, reason, report);
      const detail = await getRecurringResearchSchedule(prepared.schedule.contract.id);
      return {
        outcome: occurrence.status === 'completed' ? 'completed'
          : occurrence.status === 'blocked' || occurrence.status === 'uncertain' ? 'blocked' : 'failed',
        schedule: detail.schedule,
        occurrence,
        mission,
        reason: occurrence.statusReason,
      };
    } catch (error) {
      return failClosedRecurringResearchOccurrence({
        scheduleId: prepared.schedule.contract.id,
        occurrenceId: prepared.occurrence.id,
        missionId: prepared.mission.id,
        leaseId: prepared.occurrence.leaseId,
        leaseFence: prepared.occurrence.leaseFence,
      }, error);
    }
  };

  const runRecurringResearchTick = async (now = new Date().toISOString()): Promise<RecurringResearchTickResult> => {
    if (options.recurringResearchSchedulerEnabled !== true) {
      return { outcome: 'stopped', reason: 'The durable recurring research scheduler is disabled.' };
    }
    if (recoveryInProgress) {
      return { outcome: 'stopped', reason: 'The durable recurring research scheduler is recovering.' };
    }
    const canonicalNow = new Date(now).toISOString();
    if (canonicalNow !== now) throw new Error('Scheduler tick time must be a canonical ISO timestamp.');
    const workspaceRoot = await realpath(options.allowedWorkspaceRoot ?? process.cwd());
    const preparation = await prepareRecurringResearchOccurrence(canonicalNow, workspaceRoot);
    return preparation.kind === 'result'
      ? preparation.result
      : executeRecurringResearchOccurrence(preparation.prepared);
  };

  const skipRecurringResearchOccurrence = (
    scheduleId: string,
    occurrenceId: string,
    reason: string,
  ): Promise<RecurringResearchOccurrenceRecord> => withMutation(async () => {
    if (!reason.trim()) throw new Error('Occurrence skip reason is required.');
    let state = await readConsistentState();
    const recurring = recurringResearchState(state);
    const schedule = recurring.schedules.find((candidate) => candidate.contract.id === scheduleId);
    const current = recurring.occurrences.find((candidate) => candidate.id === occurrenceId);
    if (!schedule || !current || current.scheduleId !== scheduleId) {
      throw new Error('Recurring research occurrence not found.');
    }
    if (schedule.activeOccurrenceId !== occurrenceId) throw new Error('Occurrence is not active for this schedule.');
    if (activeRecurringResearchControllers.has(occurrenceId)) {
      throw new Error('A running occurrence must be cancelled with Stop All before it can be skipped.');
    }
    const now = new Date().toISOString();
    const skippedBase = skipResearchOccurrence(current, reason.trim(), now);
    let appended = await appendEvent(state, {
      actor: 'user',
      type: 'schedule.occurrence_skipped',
      entityId: occurrenceId,
      entityType: 'occurrence',
      payload: { scheduleId, occurrenceId, reasonHash: stableHash(reason.trim()), missionId: current.missionId },
    });
    state = appended.state;
    const skipped: RecurringResearchOccurrenceRecord = {
      ...current,
      ...skippedBase,
      evidenceRefs: [...skippedBase.evidenceRefs, { eventId: appended.event.id }],
    };
    const updatedSchedule: RecurringResearchScheduleRecord = {
      ...schedule,
      activeOccurrenceId: undefined,
      lastOccurrenceId: occurrenceId,
      haltedReason: reason.trim(),
    };
    await commitState({
      ...state,
      recurringResearch: {
        ...recurring,
        schedules: recurring.schedules.map((candidate) => candidate.contract.id === scheduleId ? updatedSchedule : candidate),
        occurrences: recurring.occurrences.map((candidate) => candidate.id === occurrenceId ? skipped : candidate),
      },
    });
    return skipped;
  });

  const prepareRecurringResearchResume = (
    scheduleId: string,
    occurrenceId: string,
    reason: string,
  ): Promise<{
    schedule: RecurringResearchScheduleRecord;
    occurrence: RecurringResearchOccurrenceRecord;
    ownership: NonNullable<ResearchMission['schedulerOwnership']>;
  }> => withMutation(async () => {
    if (!reason.trim()) throw new Error('Occurrence resume reason is required.');
    let state = await readConsistentState();
    if (state.controls.stopAll) throw new Error('Stop All is active. Resume the kernel before this occurrence.');
    const capability = getRecurringResearchCapability();
    if (!capability.available) throw new Error(capability.reason);
    const recurring = recurringResearchState(state);
    const schedule = recurring.schedules.find((candidate) => candidate.contract.id === scheduleId);
    const current = recurring.occurrences.find((candidate) => candidate.id === occurrenceId);
    if (!schedule || !current || current.scheduleId !== scheduleId) {
      throw new Error('Recurring research occurrence not found.');
    }
    if (schedule.activeOccurrenceId !== occurrenceId) throw new Error('Occurrence is not active for this schedule.');
    if (current.attempt >= schedule.contract.budget.maxAttempts) {
      throw new Error('Occurrence retry budget is exhausted.');
    }
    const goal = findResearchGoal(state, current.missionId);
    if (!goal?.research || goal.research.status !== 'blocked' || goal.research.retryable !== true) {
      throw new Error('The scheduled research mission is not resumable.');
    }
    const now = new Date().toISOString();
    const runtimeUsedMs = Math.max(0, current.runtimeUsedMs ?? 0);
    const remainingRuntimeMs = schedule.contract.budget.maxRuntimeMs - runtimeUsedMs;
    if (remainingRuntimeMs <= 0) throw new Error('Occurrence runtime budget is exhausted.');
    const leaseId = createKernelId('schedule_lease');
    const leaseFence = current.leaseFence + 1;
    const deadlineAt = new Date(Date.parse(now) + remainingRuntimeMs).toISOString();
    const expiresAt = new Date(Date.parse(deadlineAt) + RECURRING_RESEARCH_LEASE_GRACE_MS).toISOString();
    const resumedBase = resumeResearchOccurrence(current, {
      owner: schedulerInstanceId,
      claimedAt: now,
      expiresAt,
    });
    const ownership: NonNullable<ResearchMission['schedulerOwnership']> = {
      scheduleId,
      occurrenceId,
      leaseId,
      leaseFence,
    };
    const occurrence: RecurringResearchOccurrenceRecord = {
      ...current,
      ...resumedBase,
      leaseId,
      leaseFence,
      deadlineAt,
      attempt: current.attempt + 1,
      runtimeUsedMs,
      attemptStartedAt: now,
    };
    const mission: ResearchMission = { ...goal.research, schedulerOwnership: ownership };
    let appended = await appendEvent(state, {
      actor: 'user',
      type: 'schedule.occurrence_resume_authorized',
      entityId: occurrenceId,
      entityType: 'occurrence',
      payload: {
        scheduleId,
        occurrenceId,
        missionId: current.missionId,
        attempt: occurrence.attempt,
        leaseId,
        leaseFence,
        remainingRuntimeMs,
        reasonHash: stableHash(reason.trim()),
      },
    });
    state = appended.state;
    await commitState({
      ...replaceResearchMission(state, mission),
      recurringResearch: {
        ...recurring,
        occurrences: recurring.occurrences.map((candidate) => candidate.id === occurrenceId ? occurrence : candidate),
      },
    });
    return { schedule, occurrence, ownership };
  });

  const startResumedRecurringResearchOccurrence = (
    prepared: {
      schedule: RecurringResearchScheduleRecord;
      occurrence: RecurringResearchOccurrenceRecord;
      ownership: NonNullable<ResearchMission['schedulerOwnership']>;
    },
    mission: ResearchMission,
  ): Promise<PreparedRecurringResearchOccurrence> => withMutation(async () => {
    let state = await readConsistentState();
    const recurring = recurringResearchState(state);
    const current = recurring.occurrences.find((candidate) => candidate.id === prepared.occurrence.id);
    if (
      !current ||
      current.status !== 'claimed' ||
      current.leaseId !== prepared.occurrence.leaseId ||
      current.leaseFence !== prepared.occurrence.leaseFence
    ) throw new Error('Resumed occurrence lease is stale.');
    const now = new Date().toISOString();
    const runningBase = startResearchOccurrence(current, schedulerInstanceId, now);
    const running: RecurringResearchOccurrenceRecord = { ...current, ...runningBase };
    const appended = await appendEvent(state, {
      actor: 'kernel',
      type: 'schedule.occurrence_resumed',
      entityId: current.id,
      entityType: 'occurrence',
      payload: {
        scheduleId: current.scheduleId,
        occurrenceId: current.id,
        missionId: current.missionId,
        attempt: current.attempt,
        leaseId: current.leaseId,
        leaseFence: current.leaseFence,
      },
    });
    state = appended.state;
    await commitState({
      ...state,
      recurringResearch: {
        ...recurring,
        occurrences: recurring.occurrences.map((candidate) => candidate.id === current.id ? running : candidate),
      },
    });
    return { schedule: prepared.schedule, occurrence: running, ownership: prepared.ownership, mission };
  });

  const resumeRecurringResearchOccurrenceRun = async (
    scheduleId: string,
    occurrenceId: string,
    reason: string,
  ): Promise<RecurringResearchTickResult> => {
    const prepared = await prepareRecurringResearchResume(scheduleId, occurrenceId, reason);
    try {
      const mission = await resumeResearchMissionWithOwnership(
        prepared.occurrence.missionId,
        reason,
        prepared.ownership,
      );
      return executeRecurringResearchOccurrence(
        await startResumedRecurringResearchOccurrence(prepared, mission),
      );
    } catch (error) {
      return failClosedRecurringResearchOccurrence({
        scheduleId,
        occurrenceId,
        missionId: prepared.occurrence.missionId,
        leaseId: prepared.occurrence.leaseId,
        leaseFence: prepared.occurrence.leaseFence,
      }, error);
    }
  };

  const abortRecurringResearchRuns = async (): Promise<void> => {
    for (const controller of activeRecurringResearchControllers.values()) controller.abort();
    const deadline = Date.now() + 5_000;
    while (activeRecurringResearchControllers.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  const getWorkers = () => ({
    workers: workerRegistry.list(),
    report: workerRegistry.report(),
  });

  const createAutomation = (value: unknown): Promise<AutomationContract> => withMutation(async () => {
    if (!isAutomationContractInput(value)) throw new Error('Invalid automation input.');
    let state = await readConsistentState();
    if (!state.goals.some((goal) => goal.id === value.goalId)) throw new Error('Goal not found.');
    if (!workerRegistry.get(value.workerId)) throw new Error('Automation worker is not registered.');

    const automation = buildAutomationContract(value);
    const appended = await appendEvent(state, {
      actor: 'user',
      type: 'automation.created',
      entityId: automation.id,
      entityType: 'automation',
      payload: {
        automationId: automation.id,
        name: automation.name,
        goalId: automation.goalId,
        workerId: automation.workerId,
        riskLevel: automation.riskLevel,
        actionType: automation.action.type,
        triggerType: automation.trigger.type,
        approvalMode: automation.approvalMode,
        contentHash: stableHash(automation),
      },
    });
    state = appended.state;
    await commitState({
      ...state,
      automations: [...state.automations, automation],
    });
    return automation;
  });

  const setAutomationEnabled = (
    automationId: string,
    enabled: boolean,
    reason: string,
  ): Promise<AutomationContract> => withMutation(async () => {
    if (!reason.trim()) throw new Error('Automation state change reason is required.');
    let state = await readConsistentState();
    const automation = state.automations.find((candidate) => candidate.id === automationId);
    if (!automation) throw new Error('Automation not found.');
    if (automation.enabled === enabled) {
      throw new Error(`Automation is already ${enabled ? 'enabled' : 'disabled'}.`);
    }
    if (enabled) {
      if (state.controls.stopAll) throw new Error('Stop All is active. Automations cannot be enabled.');
      const worker = workerRegistry.get(automation.workerId);
      if (worker?.availability !== 'available') {
        throw new Error('Automation worker is not available in this deployment.');
      }
    }

    const now = new Date().toISOString();
    const updated: AutomationContract = { ...automation, enabled, updatedAt: now };
    const appended = await appendEvent(state, {
      actor: 'user',
      type: enabled ? 'automation.enabled' : 'automation.disabled',
      entityId: automationId,
      entityType: 'automation',
      payload: { automationId, reason: reason.trim() },
    });
    state = appended.state;
    await commitState({
      ...state,
      automations: state.automations.map((candidate) => candidate.id === automationId ? updated : candidate),
    });
    return updated;
  });

  const evaluateAutomation = (automationId: string): Promise<CapabilityPolicyDecision> => withMutation(async () => {
    let state = await readConsistentState();
    const automation = state.automations.find((candidate) => candidate.id === automationId);
    if (!automation) throw new Error('Automation not found.');

    const intent = buildAutomationIntent(automation);
    const decision = decideActionPolicy(intent, workerRegistry);
    const appended = await appendEvent(state, {
      actor: 'kernel',
      type: 'automation.evaluated',
      entityId: automationId,
      entityType: 'automation',
      payload: {
        automationId,
        intentId: intent.id,
        kind: decision.kind,
        reasonCode: decision.reasonCode,
        riskLevel: decision.riskLevel,
        reason: decision.reason,
      },
    });
    state = appended.state;
    await commitState(state);
    return decision;
  });

  interface PreparedAutomationRun {
    kind: 'dispatch';
    automationId: string;
    automationUpdatedAt: string;
    intent: ActionIntent;
    decision: CapabilityPolicyDecision;
    approvalId?: string;
    grantId: string;
    grantStatus: 'active' | 'revoked' | 'consumed';
    authorization: CapabilityDispatchAuthorization;
    worker: KernelActionWorker;
    controller: AbortController;
    timeoutMs: number;
    runStartedEventId: string;
  }

  type AutomationRunPreparation = PreparedAutomationRun | {
    kind: 'result';
    result: AutomationRunOutcome;
  };

  interface AutomationObservationAssessment {
    risk: 'none' | 'medium' | 'high';
    codes: PromptInjectionSignalCode[];
  }

  const prepareAutomationRun = (automationId: string): Promise<AutomationRunPreparation> => withMutation(async () => {
    let state = await readConsistentState();
    const automation = state.automations.find((candidate) => candidate.id === automationId);
    if (!automation) throw new Error('Automation not found.');
    if (!automation.enabled) throw new Error('Automation is disabled.');
    if (state.controls.stopAll) throw new Error('Stop All is active. Resume the kernel before running automations.');
    const goal = state.goals.find((candidate) => candidate.id === automation.goalId);
    if (!goal) throw new Error('Goal not found.');

    const events = await readKernelEvents(options.runtimeDir);
    const terminalRunTypes = new Set([
      'automation.run_completed', 'automation.run_failed', 'automation.run_uncertain',
    ]);
    const finishedIntentIds = new Set(events
      .filter((event) => (
        terminalRunTypes.has(event.type) &&
        event.payload.automationId === automationId && typeof event.payload.intentId === 'string'
      ))
      .map((event) => event.payload.intentId as string));
    const hasInFlightRun = events.some((event) => (
      event.type === 'automation.run_started' && event.payload.automationId === automationId &&
      typeof event.payload.intentId === 'string' && !finishedIntentIds.has(event.payload.intentId)
    ));
    if (hasInFlightRun) throw new Error('Automation already has an in-flight or uncertain run.');
    if (events.some((event) => (
      event.type === 'automation.run_uncertain' && event.payload.automationId === automationId
    ))) {
      throw new Error('Automation has an unresolved uncertain desktop outcome and cannot be retried.');
    }
    const runEvents = events.filter((event) => (
      terminalRunTypes.has(event.type) &&
      event.payload.automationId === automationId
    ));
    if (runEvents.length >= automation.budget.maxRuns) {
      throw new Error('Automation run budget is exhausted.');
    }
    let trailingFailures = 0;
    for (let index = runEvents.length - 1; index >= 0; index -= 1) {
      if (runEvents[index].type !== 'automation.run_failed') break;
      trailingFailures += 1;
    }
    if (trailingFailures >= automation.budget.maxConsecutiveFailures) {
      throw new Error('Automation is halted after consecutive run failures.');
    }

    const approvalTaskId = `automation:${automation.id}`;
    const approvalRequest = `automation-run:${automation.id}:${stableHash({
      workerId: automation.workerId,
      riskLevel: automation.riskLevel,
      action: automation.action,
      scope: automation.scope,
    })}`;
    let approval = [...state.approvals].reverse().find((candidate) => (
      candidate.goalId === automation.goalId &&
      candidate.taskId === approvalTaskId &&
      candidate.requestedAction === approvalRequest &&
      (candidate.status === 'pending' || candidate.status === 'approved')
    ));
    let intent = buildAutomationIntent(automation);
    let decision = decideActionPolicy(intent, workerRegistry);

    if (decision.kind === 'approval_required' && approval?.status !== 'approved') {
      if (!approval) {
        const approvalBudget = reserveBudget(goal.budget, goal.usage, { approvals: 1 });
        if (!approvalBudget.allowed) throw new Error(approvalBudget.reason);
        approval = createApprovalRecord({
          goalId: automation.goalId,
          taskId: approvalTaskId,
          requestedAction: approvalRequest,
          riskLevel: automation.riskLevel,
          reason: decision.reason,
        });
        let appended = await appendEvent(state, {
          actor: 'kernel',
          type: 'approval.requested',
          entityId: approval.id,
          entityType: 'approval',
          payload: {
            goalId: automation.goalId,
            taskId: approvalTaskId,
            automationId,
            riskLevel: automation.riskLevel,
            reason: decision.reason,
          },
        });
        state = appended.state;
        appended = await appendEvent(state, {
          actor: 'kernel',
          type: 'automation.run_blocked',
          entityId: automationId,
          entityType: 'automation',
          payload: { automationId, intentId: intent.id, approvalId: approval.id, reasonCode: decision.reasonCode, reason: decision.reason },
        });
        state = appended.state;
        await commitState({
          ...state,
          approvals: [...state.approvals, approval],
          goals: state.goals.map((candidate) => candidate.id === goal.id
            ? { ...candidate, usage: approvalBudget.usage, updatedAt: approval!.updatedAt }
            : candidate),
        });
      }
      return { kind: 'result', result: { decision, approvalId: approval.id } };
    }

    const approvalId = approval?.status === 'approved' ? approval.id : undefined;
    if (approvalId) {
      intent = buildAutomationIntent(automation, new Date().toISOString(), approvalId);
      decision = decideActionPolicy(intent, workerRegistry);
    }
    if (decision.kind !== 'allow') {
      const appended = await appendEvent(state, {
        actor: 'kernel',
        type: 'automation.run_denied',
        entityId: automationId,
        entityType: 'automation',
        payload: { automationId, intentId: intent.id, reasonCode: decision.reasonCode, reason: decision.reason },
      });
      await commitState(appended.state);
      return { kind: 'result', result: { decision, approvalId } };
    }

    const worker = options.actionWorkers?.[automation.workerId];
    const registration = workerRegistry.get(automation.workerId);
    if (!worker || !registration) {
      throw new Error('No executable worker runtime is registered for this automation.');
    }
    const reserved = reserveBudget(goal.budget, goal.usage, { operations: 1 });
    if (!reserved.allowed) throw new Error(reserved.reason);

    const startedAt = new Date().toISOString();
    const grant = createCapabilityGrant(intent, {
      id: createKernelId('cap'),
      issuedAt: startedAt,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      maxOps: 1,
      approvalId,
    });
    await capabilityGrantStore.create(grant);
    const authorized = await authorizeCapabilityDispatch(
      capabilityGrantStore,
      grant.id,
      intent,
      registration,
      { now: new Date().toISOString(), operationsUsed: 1 },
    );
    if (!authorized.allowed || !authorized.authorization || !authorized.grant) {
      throw new Error(`Capability authorization failed before dispatch: ${authorized.reason}`);
    }

    let appended = await appendEvent(state, {
      actor: 'kernel',
      type: 'capability.grant_consumed',
      entityId: grant.id,
      entityType: 'capability',
      payload: {
        automationId,
        intentId: intent.id,
        grantId: grant.id,
        approvalId,
        grantStatus: authorized.grant.status,
      },
    });
    state = appended.state;
    appended = await appendEvent(state, {
      actor: 'kernel',
      type: 'automation.run_started',
      entityId: automationId,
      entityType: 'automation',
      payload: { automationId, intentId: intent.id, grantId: grant.id, approvalId, actionType: automation.action.type },
    });
    state = appended.state;
    const runStartedEventId = appended.event.id;
    const consumedAt = new Date().toISOString();
    await commitState({
      ...state,
      approvals: approvalId
        ? state.approvals.map((candidate) => candidate.id === approvalId
          ? { ...candidate, status: 'consumed', updatedAt: consumedAt }
          : candidate)
        : state.approvals,
      goals: state.goals.map((candidate) => candidate.id === goal.id
        ? { ...candidate, usage: reserved.usage, updatedAt: consumedAt }
        : candidate),
    });

    const controller = new AbortController();
    activeActionControllers.set(intent.id, controller);
    return {
      kind: 'dispatch',
      automationId,
      automationUpdatedAt: automation.updatedAt,
      intent,
      decision,
      approvalId,
      grantId: grant.id,
      grantStatus: authorized.grant.status,
      authorization: authorized.authorization,
      worker,
      controller,
      timeoutMs: Math.max(1, Math.min(automation.budget.maxRuntimeMsPerRun, 30_000)),
      runStartedEventId,
    };
  });

  const recordAutomationRunOutcome = (
    prepared: PreparedAutomationRun,
    dispatched: KernelActionWorkerResult,
    assessed: AutomationObservationAssessment,
    timedOut: boolean,
    persistedObservation?: ArtifactMetadata,
  ): Promise<AutomationRunOutcome> => withMutation(async () => {
    let state = await readConsistentState();
    const events = await readKernelEvents(options.runtimeDir);
    const currentAutomation = state.automations.find((candidate) => candidate.id === prepared.automationId);
    const runStarted = events.find((event) => (
      event.id === prepared.runStartedEventId &&
      event.type === 'automation.run_started' &&
      event.payload.automationId === prepared.automationId &&
      event.payload.intentId === prepared.intent.id &&
      event.payload.grantId === prepared.grantId
    ));
    const alreadyFinished = events.some((event) => (
      (event.type === 'automation.run_completed' || event.type === 'automation.run_failed' ||
        event.type === 'automation.run_uncertain') &&
      event.payload.automationId === prepared.automationId &&
      event.payload.intentId === prepared.intent.id
    ));
    if (alreadyFinished) throw new Error('Automation run outcome has already been recorded.');

    let fenceReason: string | undefined;
    let fenceErrorCode: string | undefined;
    if (activeActionControllers.get(prepared.intent.id) !== prepared.controller || !runStarted) {
      fenceReason = 'Automation dispatch ownership changed before result commit.';
      fenceErrorCode = 'stale_dispatch';
    } else if (prepared.controller.signal.aborted) {
      fenceReason = timedOut
        ? 'Automation dispatch exceeded its bounded runtime before result commit.'
        : 'Automation dispatch was cancelled before result commit.';
      fenceErrorCode = timedOut ? 'timeout' : 'cancelled';
    } else if (state.controls.stopAll) {
      fenceReason = 'Stop All became active before automation result commit.';
      fenceErrorCode = 'cancelled';
    } else if (!currentAutomation?.enabled || currentAutomation.updatedAt !== prepared.automationUpdatedAt) {
      fenceReason = 'Automation authority changed before result commit.';
      fenceErrorCode = 'stale_dispatch';
    }

    const desktopMutation = prepared.intent.action.type === 'desktop.click' ||
      prepared.intent.action.type === 'desktop.type' || prepared.intent.action.type === 'desktop.shortcut';
    let dispatch: KernelActionWorkerResult = fenceReason
      ? {
        status: desktopMutation ? 'uncertain' : 'failed',
        summary: desktopMutation
          ? `${fenceReason} The desktop mutation may have completed and must not be retried automatically.`
          : fenceReason,
        sourceRef: `automation:${prepared.automationId}`,
        errorCode: desktopMutation ? 'desktop_outcome_uncertain' : fenceErrorCode,
      }
      : dispatched;
    let content = dispatch.content ?? '';
    let assessment = fenceReason
      ? { risk: 'none' as const, codes: [] as PromptInjectionSignalCode[] }
      : assessed;
    const observationSource = prepared.intent.action.type.startsWith('desktop.') ? 'screen' as const : 'web' as const;
    let observationArtifact = fenceReason ? undefined : persistedObservation;
    if (observationSource === 'screen' && content.length > 0) {
      const contentHash = analyzePromptInjection(content).contentHash;
      const artifactMatches = observationArtifact?.contentHash === contentHash &&
        observationArtifact.byteLength === Buffer.byteLength(content, 'utf8');
      if (!artifactMatches) {
        dispatch = {
          status: 'failed',
          summary: 'Desktop observation content was not authenticated in the artifact store.',
          sourceRef: dispatch.sourceRef,
          errorCode: 'artifact_authentication_failed',
        };
        content = '';
        assessment = { risk: 'none', codes: [] };
        observationArtifact = undefined;
      }
    }
    const observation = {
      ...createUntrustedObservation({
        id: createKernelId('obs'),
        source: observationSource,
        sourceRef: dispatch.sourceRef,
        content,
        capturedAt: new Date().toISOString(),
      }),
      injectionSignalCodes: assessment.codes,
    };

    const succeeded = dispatch.status === 'succeeded';
    if (observationArtifact) {
      const artifactAppended = await appendEvent(state, {
        actor: 'worker',
        type: 'artifact.created',
        entityId: observationArtifact.id,
        entityType: 'artifact',
        payload: {
          artifactId: observationArtifact.id,
          contentHash: observationArtifact.contentHash,
          byteLength: observationArtifact.byteLength,
          automationId: prepared.automationId,
          intentId: prepared.intent.id,
          observationId: observation.id,
          role: 'desktop_observation',
        },
      });
      state = artifactAppended.state;
    }
    const terminalEventType = dispatch.status === 'succeeded'
      ? 'automation.run_completed'
      : dispatch.status === 'uncertain'
        ? 'automation.run_uncertain'
        : 'automation.run_failed';
    const appended = await appendEvent(state, {
      actor: 'worker',
      type: terminalEventType,
      entityId: prepared.automationId,
      entityType: 'automation',
      payload: {
        automationId: prepared.automationId,
        intentId: prepared.intent.id,
        grantId: prepared.grantId,
        approvalId: prepared.approvalId,
        grantStatus: prepared.grantStatus,
        summary: dispatch.summary,
        errorCode: dispatch.errorCode,
        observationId: observation.id,
        observationSource,
        artifactId: observationArtifact?.id,
        contentHash: observation.contentHash,
        injectionSignalCodes: observation.injectionSignalCodes,
        risk: assessment.risk,
        fenceReason,
      },
    });
    await commitState(appended.state);

    return {
      decision: prepared.decision,
      approvalId: prepared.approvalId,
      dispatch: {
        status: dispatch.status,
        summary: dispatch.summary,
        sourceRef: dispatch.sourceRef,
        errorCode: dispatch.errorCode,
      },
      observation: {
        id: observation.id,
        source: observationSource,
        artifactId: observationArtifact?.id,
        contentHash: observation.contentHash,
        risk: assessment.risk,
        injectionSignalCodes: observation.injectionSignalCodes,
      },
      content,
    };
  });

  const executePreparedAutomationRun = async (
    prepared: PreparedAutomationRun,
  ): Promise<AutomationRunOutcome> => {
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      prepared.controller.abort();
    }, prepared.timeoutMs);
    timeout.unref?.();

    try {
      let dispatch: KernelActionWorkerResult;
      try {
        const operation = prepared.worker.execute(prepared.intent, {
          timeoutMs: prepared.timeoutMs,
          authorization: prepared.authorization,
          signal: prepared.controller.signal,
        });
        dispatch = await awaitAbortable(
          operation,
          prepared.controller.signal,
          'Automation dispatch was cancelled before completion.',
        );
      } catch {
        const desktopMutation = prepared.intent.action.type === 'desktop.click' ||
          prepared.intent.action.type === 'desktop.type' || prepared.intent.action.type === 'desktop.shortcut';
        const uncertain = desktopMutation && (timedOut || prepared.controller.signal.aborted);
        dispatch = {
          status: uncertain ? 'uncertain' : 'failed',
          summary: uncertain
            ? 'Desktop dispatch was interrupted after authorization; its native side effect may have completed and must not be retried automatically.'
            : timedOut
            ? 'Worker execution timed out after capability authorization.'
            : prepared.controller.signal.aborted
              ? 'Worker execution was cancelled after capability authorization.'
              : 'Worker execution failed after capability authorization.',
          sourceRef: `automation:${prepared.automationId}`,
          errorCode: uncertain
            ? 'desktop_outcome_uncertain'
            : timedOut ? 'timeout' : prepared.controller.signal.aborted ? 'cancelled' : 'worker_exception',
        };
      }

      let observationArtifact: ArtifactMetadata | undefined;
      if (
        prepared.intent.action.type.startsWith('desktop.') &&
        (dispatch.content?.length ?? 0) > 0 &&
        !prepared.controller.signal.aborted
      ) {
        try {
          if (!options.artifactStore) throw new Error('Artifact store is unavailable.');
          observationArtifact = await options.artifactStore.create(dispatch.content!);
          const expectedHash = analyzePromptInjection(dispatch.content!).contentHash;
          if (
            observationArtifact.contentHash !== expectedHash ||
            observationArtifact.byteLength !== Buffer.byteLength(dispatch.content!, 'utf8')
          ) {
            throw new Error('Artifact metadata did not authenticate the desktop observation.');
          }
        } catch {
          const mutation = prepared.intent.action.type === 'desktop.click' ||
            prepared.intent.action.type === 'desktop.type' || prepared.intent.action.type === 'desktop.shortcut';
          dispatch = {
            status: mutation ? 'uncertain' : 'failed',
            summary: mutation
              ? 'The desktop mutation completed, but its observation could not be persisted; do not retry it automatically.'
              : 'Desktop observation could not be persisted before result commit.',
            sourceRef: dispatch.sourceRef,
            errorCode: mutation ? 'desktop_outcome_uncertain' : 'artifact_persistence_failed',
          };
          observationArtifact = undefined;
        }
      }

      const content = dispatch.content ?? '';
      const heuristic = analyzePromptInjection(content);
      let assessment: AutomationObservationAssessment = {
        risk: heuristic.risk,
        codes: heuristic.signals.map((signal) => signal.code),
      };
      if (options.observationAssessor && !prepared.controller.signal.aborted) {
        try {
          const result = await assessObservation(content, prepared.controller.signal);
          if (!result) throw new Error('Observation assessor is unavailable.');
          assessment = { risk: result.risk, codes: result.signals.map((signal) => signal.code) };
        } catch {
          // The heuristic floor stands when the advisory model fails.
        }
      }

      clearTimeout(timeout);
      return await recordAutomationRunOutcome(
        prepared,
        dispatch,
        assessment,
        timedOut,
        observationArtifact,
      );
    } finally {
      clearTimeout(timeout);
      if (activeActionControllers.get(prepared.intent.id) === prepared.controller) {
        activeActionControllers.delete(prepared.intent.id);
      }
    }
  };

  const runAutomation = async (automationId: string): Promise<AutomationRunOutcome> => {
    const prepared = await prepareAutomationRun(automationId);
    return prepared.kind === 'result' ? prepared.result : executePreparedAutomationRun(prepared);
  };

  const setStopAll = (stopAll: boolean, reason: string): Promise<KernelControls> => withMutation(async () => {
    if (!reason.trim()) throw new Error('Stop All state change reason is required.');
    let state = await readConsistentState();
    if (state.controls.stopAll === stopAll) {
      throw new Error(`Kernel execution is already ${stopAll ? 'stopped' : 'running'}.`);
    }
    if (stopAll) {
      for (const controller of activeProviderControllers.values()) controller.abort();
      for (const controller of activeActionControllers.values()) controller.abort();
      for (const controller of activeRecurringResearchControllers.values()) controller.abort();
    }

    const now = new Date().toISOString();
    const controls: KernelControls = stopAll
      ? { stopAll: true, stopAllReason: reason.trim(), updatedAt: now }
      : { stopAll: false, updatedAt: now };
    const appended = await appendEvent(state, {
      actor: 'user',
      type: stopAll ? 'control.stop_all' : 'control.resumed',
      entityId: 'kernel',
      entityType: 'control',
      payload: { reason: reason.trim() },
    });
    state = appended.state;
    await commitState({ ...state, controls });
    return controls;
  });

  const performInterruptedTaskRecovery = async (): Promise<InterruptedTaskRecoveryResult> => {
    await initializeKernelState();
    const before = await getState();
    const beforeRecurring = recurringResearchState(before);
    const activeBefore = beforeRecurring.occurrences.filter((occurrence) => (
      occurrence.status === 'claimed' || occurrence.status === 'running'
    ));
    const reconciledReports = new Map<string, { artifactId: string; contentHash: string; eventId: string }>();
    if (activeBefore.length > 0) {
      const events = await getEvents();
      for (const occurrence of activeBefore) {
        const mission = findResearchGoal(before, occurrence.missionId)?.research;
        if (mission?.status !== 'completed' || !mission.reportArtifactId) continue;
        try {
          const resolved = await getResearchMissionReport(mission.id);
          const published = [...events].reverse().find((event) => (
            event.type === 'mission.report_published' &&
            event.entityId === mission.id &&
            event.payload.artifactId === mission.reportArtifactId
          ));
          const publicationAcceptedAt = typeof published?.payload.publicationAcceptedAt === 'string'
            ? published.payload.publicationAcceptedAt
            : published?.timestamp;
          if (
            published &&
            mission.completedAt &&
            publicationAcceptedAt &&
            Date.parse(mission.completedAt) < Date.parse(occurrence.deadlineAt) &&
            Date.parse(publicationAcceptedAt) < Date.parse(occurrence.deadlineAt)
          ) {
            reconciledReports.set(occurrence.id, {
              artifactId: mission.reportArtifactId,
              contentHash: resolved.contentHash,
              eventId: published.id,
            });
          }
        } catch {
          // Invalid or incomplete publication remains uncertain and is never replayed.
        }
      }
    }

    return withMutation(async () => {
      let state = await readConsistentState();
      const recurring = recurringResearchState(state);
      const interrupted = state.tasks.filter((task) => task.status === 'running');
      const activeOccurrences = recurring.occurrences.filter((occurrence) => (
        occurrence.status === 'claimed' || occurrence.status === 'running'
      ));
      if (interrupted.length === 0 && activeOccurrences.length === 0) {
        return { recoveredTaskIds: [], recoveredOccurrenceIds: [], reconciledOccurrenceIds: [] };
      }

      const now = new Date().toISOString();
      for (const task of interrupted) {
        const appended = await appendEvent(state, {
          actor: 'kernel',
          type: 'task.recovered',
          entityId: task.id,
          entityType: 'task',
          payload: {
            goalId: task.goalId,
            reason: 'Interrupted running task was recovered into a blocked state instead of silently resuming.',
          },
        });
        state = appended.state;
      }

      const interruptedTaskIds = new Set(interrupted.map((task) => task.id));
      const interruptedGoalIds = new Set(interrupted.map((task) => task.goalId));
      const interruptedResearchGoals = state.goals.filter((goal) => (
        interruptedGoalIds.has(goal.id) && goal.research?.activeStep
      ));
      for (const goal of interruptedResearchGoals) {
        const appended = await appendEvent(state, {
          actor: 'kernel',
          type: 'mission.interrupted',
          entityId: goal.research!.id,
          entityType: 'mission',
          payload: {
            goalId: goal.id,
            stepId: goal.research!.activeStep!.id,
            stage: goal.research!.activeStep!.stage,
            reason: 'The external outcome is uncertain after restart; explicit resume is required.',
          },
        });
        state = appended.state;
      }

      const occurrenceUpdates = new Map<string, RecurringResearchOccurrenceRecord>();
      const uncertainMissionIds = new Set<string>();
      const reconciledOccurrenceIds: string[] = [];
      for (const occurrence of activeOccurrences) {
        const report = reconciledReports.get(occurrence.id);
        const schedule = recurring.schedules.find((candidate) => candidate.contract.id === occurrence.scheduleId);
        if (!schedule) throw new Error('Interrupted occurrence schedule is unavailable during recovery.');
        const status = report ? 'completed' as const : 'uncertain' as const;
        const reason = report
          ? undefined
          : 'The scheduler process restarted before the occurrence outcome was committed; explicit resolution is required.';
        const appended = await appendEvent(state, {
          actor: 'kernel',
          type: report ? 'schedule.occurrence_reconciled' : 'schedule.occurrence_uncertain',
          entityId: occurrence.id,
          entityType: 'occurrence',
          payload: {
            scheduleId: occurrence.scheduleId,
            occurrenceId: occurrence.id,
            missionId: occurrence.missionId,
            status,
            reportArtifactId: report?.artifactId,
            reportContentHash: report?.contentHash,
            reasonHash: reason ? stableHash(reason) : undefined,
          },
        });
        state = appended.state;
        occurrenceUpdates.set(occurrence.id, {
          ...occurrence,
          status,
          statusReason: reason,
          reportArtifactId: report?.artifactId,
          reportContentHash: report?.contentHash,
          evidenceRefs: [
            ...occurrence.evidenceRefs,
            { eventId: appended.event.id },
            ...(report ? [{ eventId: report.eventId, artifactId: report.artifactId, contentHash: report.contentHash }] : []),
          ],
          runtimeUsedMs: chargedRecurringRuntimeMs(
            occurrence,
            now,
            schedule.contract.budget.maxRuntimeMs,
          ),
          attemptStartedAt: undefined,
          updatedAt: now,
        });
        if (report) reconciledOccurrenceIds.push(occurrence.id);
        else uncertainMissionIds.add(occurrence.missionId);
      }

      const scheduledBlockedTaskIds = new Set<string>();
      const goals = state.goals.map((goal) => {
        const scheduledInterrupted = goal.research && uncertainMissionIds.has(goal.research.id);
        if (!scheduledInterrupted && (!interruptedGoalIds.has(goal.id) || goal.status !== 'active')) return goal;
        if (!goal.research) return { ...goal, status: 'blocked' as const, updatedAt: now };
        if (goal.research.status === 'completed') return goal;
        const stage = goal.research.activeStep?.stage ?? (
          ['planning', 'collecting', 'synthesizing', 'verifying'].includes(goal.research.status)
            ? goal.research.status as ResearchMissionStage
            : goal.research.resumeStage
        );
        if (stage) scheduledBlockedTaskIds.add(taskIdForMissionStage(goal.research, stage));
        const research: ResearchMission = {
          ...goal.research,
          status: 'blocked',
          activeStep: undefined,
          resumeStage: stage,
          retryable: Boolean(stage),
          lastError: 'The external outcome is uncertain after restart; explicit resume is required.',
          sources: goal.research.sources.map((source) => source.status === 'running'
            ? { ...source, status: 'failed', failureReason: 'Source capture was interrupted before its outcome was committed.' }
            : source),
          updatedAt: now,
        };
        return { ...goal, status: 'blocked' as const, research, updatedAt: now };
      });

      const occurrences = recurring.occurrences.map((occurrence) => occurrenceUpdates.get(occurrence.id) ?? occurrence);
      const schedules = recurring.schedules.map((schedule) => {
        const active = schedule.activeOccurrenceId
          ? occurrenceUpdates.get(schedule.activeOccurrenceId)
          : undefined;
        if (!active) return schedule;
        if (active.status === 'completed') {
          return { ...schedule, activeOccurrenceId: undefined, consecutiveFailures: 0, lastOccurrenceId: active.id };
        }
        return disableRecurringSchedule(
          { ...schedule, activeOccurrenceId: active.id, lastOccurrenceId: active.id },
          active.statusReason ?? 'The occurrence outcome is uncertain after restart.',
          now,
        );
      });

      await commitState({
        ...state,
        tasks: state.tasks.map((task) => (
          interruptedTaskIds.has(task.id) || scheduledBlockedTaskIds.has(task.id)
            ? { ...task, status: 'blocked' as const, updatedAt: now }
            : task
        )),
        goals,
        recurringResearch: { ...recurring, schedules, occurrences },
      });
      return {
        recoveredTaskIds: [...interruptedTaskIds],
        recoveredOccurrenceIds: activeOccurrences.filter((occurrence) => !reconciledReports.has(occurrence.id)).map((occurrence) => occurrence.id),
        reconciledOccurrenceIds,
      };
    });
  };

  const recoverInterruptedTasks = (): Promise<InterruptedTaskRecoveryResult> => {
    if (recoveryPromise) return recoveryPromise;
    if (
      activeProviderControllers.size > 0 ||
      activeActionControllers.size > 0 ||
      activeRecurringResearchControllers.size > 0
    ) {
      return Promise.reject(new Error('Recovery requires a quiescent kernel with no active external dispatch.'));
    }
    recoveryInProgress = true;
    const pending = (async () => {
      await Promise.resolve();
      if (
        activeProviderControllers.size > 0 ||
        activeActionControllers.size > 0 ||
        activeRecurringResearchControllers.size > 0
      ) {
        throw new Error('Recovery requires a quiescent kernel with no active external dispatch.');
      }
      return await performInterruptedTaskRecovery();
    })();
    let tracked!: Promise<InterruptedTaskRecoveryResult>;
    tracked = pending.finally(() => {
      if (recoveryPromise === tracked) {
        recoveryPromise = undefined;
        recoveryInProgress = false;
      }
    });
    recoveryPromise = tracked;
    return tracked;
  };

  const createReleaseProposal = (value: unknown): Promise<ReleaseProposal> => withMutation(async () => {
    if (!isReleaseProposalInput(value)) throw new Error('Invalid release proposal input.');
    let state = await readConsistentState();
    const events = await readKernelEvents(options.runtimeDir);
    const eventIds = new Set(events.map((event) => event.id));
    if (value.evaluationEventIds.some((eventId) => !eventIds.has(eventId))) {
      throw new Error('Release proposal references evaluation events that are not in the kernel ledger.');
    }

    const proposal = buildReleaseProposal(value);
    const appended = await appendEvent(state, {
      actor: 'user',
      type: 'release.proposed',
      entityId: proposal.id,
      entityType: 'release',
      payload: {
        releaseId: proposal.id,
        title: proposal.title,
        targetVersion: proposal.targetVersion,
        contentHash: proposal.contentHash,
        evaluationEventIds: proposal.evaluationEventIds,
        signed: Boolean(proposal.signature),
      },
    });
    state = appended.state;
    await commitState({
      ...state,
      releaseProposals: [...state.releaseProposals, proposal],
    });
    return proposal;
  });

  const activateReleaseProposal = (
    releaseId: string,
    artifactId: string,
  ): Promise<ReleaseProposal> => withMutation(async () => {
    if (!artifactId.trim()) throw new Error('Release artifact id is required.');
    let state = await readConsistentState();
    const proposal = state.releaseProposals.find((candidate) => candidate.id === releaseId);
    if (!proposal) throw new Error('Release proposal not found.');
    if (proposal.activationState === 'rejected') throw new Error('Rejected release proposals cannot be activated.');
    if (proposal.activationState === 'activated') throw new Error('Release proposal is already activated.');

    const result = options.releaseLifecycle
      ? await options.releaseLifecycle.activate(proposal, artifactId.trim())
      : {
        status: 'blocked' as const,
        reasonCode: 'install_failed' as const,
        reason: 'Staged release lifecycle is unavailable.',
      };
    const now = new Date().toISOString();
    const decided: ReleaseProposal = {
      ...proposal,
      activationState: result.status === 'activated' ? 'activated' : 'blocked',
      activationReason: `${result.reasonCode}: ${result.reason}`,
      updatedAt: now,
    };
    const appended = await appendEvent(state, {
      actor: 'kernel',
      type: decided.activationState === 'activated' ? 'release.activated' : 'release.activation_blocked',
      entityId: releaseId,
      entityType: 'release',
      payload: {
        releaseId,
        artifactId: artifactId.trim(),
        reasonCode: result.reasonCode,
        reason: result.reason,
        releaseDirectory: result.manifest?.releaseDirectory,
        previousReleaseId: result.previousManifest?.releaseId,
      },
    });
    state = appended.state;
    await commitState({
      ...state,
      releaseProposals: state.releaseProposals.map((candidate) => candidate.id === releaseId ? decided : candidate),
    });
    return decided;
  });

  const rejectRelease = (releaseId: string, reason: string): Promise<ReleaseProposal> => withMutation(async () => {
    let state = await readConsistentState();
    const proposal = state.releaseProposals.find((candidate) => candidate.id === releaseId);
    if (!proposal) throw new Error('Release proposal not found.');

    const rejected = rejectReleaseProposal(proposal, reason);
    const appended = await appendEvent(state, {
      actor: 'user',
      type: 'release.rejected',
      entityId: releaseId,
      entityType: 'release',
      payload: { releaseId, reason: rejected.activationReason },
    });
    state = appended.state;
    await commitState({
      ...state,
      releaseProposals: state.releaseProposals.map((candidate) => candidate.id === releaseId ? rejected : candidate),
    });
    return rejected;
  });

  const createArtifact = (content: string): Promise<ArtifactMetadata> => withMutation(async () => {
    if (!options.artifactStore) throw new Error('Artifact store is unavailable.');
    let state = await readConsistentState();
    const artifact = await options.artifactStore.create(content);
    const appended = await appendEvent(state, {
      actor: 'user',
      type: 'artifact.created',
      entityId: artifact.id,
      entityType: 'artifact',
      payload: { artifactId: artifact.id, contentHash: artifact.contentHash, byteLength: artifact.byteLength },
    });
    state = appended.state;
    await commitState(state);
    return artifact;
  });

  const listArtifacts = (): Promise<ArtifactMetadata[]> => {
    if (!options.artifactStore) return Promise.resolve([]);
    return options.artifactStore.list();
  };

  const recordBenchmarkRun = (goalId: string): Promise<BenchmarkRun> => withMutation(async () => {
    let state = await readConsistentState();
    const events = await readKernelEvents(options.runtimeDir);
    const goal = state.goals.find((candidate) => candidate.id === goalId);
    if (!goal) throw new Error('Goal not found.');

    const run = buildBenchmarkRun(goal, state.tasks, state.approvals, events);
    const appended = await appendEvent(state, {
      actor: 'kernel',
      type: 'benchmark.recorded',
      entityId: run.id,
      entityType: 'benchmark',
      payload: {
        benchmarkId: run.id,
        goalId,
        completion: run.completion,
        interventionCount: run.interventionCount,
        commandRuntimeMs: run.commandRuntimeMs,
        providerCallCount: run.providerCallCount,
        taskCount: run.taskDefinitions.length,
      },
    });
    state = appended.state;
    await commitState({
      ...state,
      benchmarkRuns: [...state.benchmarkRuns, run],
    });
    return run;
  });

  return {
    getState,
    getEvents,
    createGoal,
    stepGoal,
    stepGoalsInParallel,
    decideApproval,
    createMemoryCandidate,
    promoteMemory,
    revokeMemory,
    getActiveMemories,
    synthesizeSkill,
    evaluateSkill,
    startSkillCanary,
    runSkillCanary,
    promoteSkillPackage,
    rollbackSkillPackage,
    invokeSkill,
    executeProviderRequest,
    getResearchMissionCapability,
    createResearchMission,
    listResearchMissions,
    stepResearchMission,
    runResearchMission,
    resumeResearchMission,
    getResearchMissionReport,
    getRecurringResearchCapability,
    listRecurringResearchSchedules,
    getRecurringResearchSchedule,
    createRecurringResearchSchedule: createRecurringResearchScheduleContract,
    setRecurringResearchScheduleEnabled,
    runRecurringResearchTick,
    resumeRecurringResearchOccurrence: resumeRecurringResearchOccurrenceRun,
    skipRecurringResearchOccurrence,
    abortRecurringResearchRuns,
    getWorkers,
    createAutomation,
    setAutomationEnabled,
    evaluateAutomation,
    runAutomation,
    setStopAll,
    recoverInterruptedTasks,
    createReleaseProposal,
    activateReleaseProposal,
    rejectRelease,
    recordBenchmarkRun,
    createArtifact,
    listArtifacts,
  };
};

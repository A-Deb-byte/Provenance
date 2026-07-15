import type {
  RecurringResearchOccurrence,
  RecurringResearchSchedule,
} from './scheduler/types';

export type AutonomyLevel = 'manual' | 'supervised' | 'bounded';
export type RiskLevel = 'L0' | 'L1' | 'L2' | 'L3' | 'L4';
export type KernelActor = 'user' | 'kernel' | 'worker' | 'provider' | 'system';

export type GoalStatus = 'drafted' | 'active' | 'blocked' | 'completed' | 'failed' | 'cancelled';
export type TaskStatus = 'pending' | 'ready' | 'running' | 'awaiting_approval' | 'passed' | 'failed' | 'blocked' | 'denied' | 'cancelled';
export type ApprovalStatus = 'pending' | 'approved' | 'consumed' | 'denied' | 'expired' | 'cancelled';
export type PolicyDecisionKind = 'allow' | 'deny' | 'approval_required';
export type CapabilityFamily = 'state.read' | 'state.write' | 'command.run' | 'provider.call' | 'approval.decide';

export type MemoryKind = 'working' | 'episodic' | 'semantic' | 'procedural' | 'intent';
export type MemoryStatus = 'candidate' | 'promoted' | 'superseded' | 'revoked';
export type MemorySensitivity = 'public' | 'internal' | 'confidential' | 'secret';

export interface MemoryScope {
  kind: 'global' | 'workspace' | 'goal';
  id?: string;
}

export interface MemoryRetention {
  kind: 'session' | 'until' | 'durable';
  expiresAt?: string;
}

export interface MemoryProvenance {
  sourceType: 'user' | 'kernel_event' | 'provider_candidate' | 'import';
  sourceId: string;
  actor: KernelActor;
  observedAt: string;
  excerptHash?: string;
}

export interface MemoryEvidenceRef {
  eventId: string;
  artifactId?: string;
}

export interface KernelMemoryRecord {
  id: string;
  kind: MemoryKind;
  status: MemoryStatus;
  content: string;
  contentHash: string;
  confidence: number;
  scope: MemoryScope;
  sensitivity: MemorySensitivity;
  retention: MemoryRetention;
  provenance: MemoryProvenance;
  evidenceRefs: MemoryEvidenceRef[];
  contradictionIds: string[];
  supersedesIds: string[];
  createdAt: string;
  updatedAt: string;
  promotedAt?: string;
  revokedAt?: string;
  lifecycleReason?: string;
}

export type PureTransformOperation = 'trim' | 'collapse_whitespace' | 'lowercase' | 'uppercase' | 'sort_lines';

export interface PureTransformStep {
  operation: PureTransformOperation;
}

export interface PureTransformProgram {
  runtime: 'pure-transform-v1';
  steps: PureTransformStep[];
}

export interface SkillCase {
  id: string;
  input: string;
  expectedOutput: string;
  kind: 'train' | 'replay';
  sourceEventId?: string;
}

export interface SkillManifest {
  schemaVersion: 1;
  name: string;
  version: string;
  description: string;
  runtime: 'pure-transform-v1';
  inputType: 'text';
  outputType: 'text';
  permissionScopes: string[];
  dependencyLock: 'builtin:pure-transform-v1';
  supportedPlatforms: Array<'any' | 'windows' | 'linux' | 'macos'>;
  rateLimitPerMinute: number;
  maxInputChars: number;
  maxSteps: number;
  sideEffects: 'none';
  expectedArtifacts: string[];
  rollbackInstructions: string;
  provenance: MemoryProvenance;
}

export type SkillPackageStatus = 'candidate' | 'evaluated' | 'canary' | 'promoted' | 'rejected' | 'rolled_back' | 'superseded';

export interface SkillPackage {
  id: string;
  manifest: SkillManifest;
  program: PureTransformProgram;
  trainingCases: SkillCase[];
  replayCases: SkillCase[];
  status: SkillPackageStatus;
  contentHash: string;
  previousVersionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SkillCaseResult {
  caseId: string;
  actualOutput: string;
  passed: boolean;
}

export interface SkillEvaluation {
  id: string;
  skillId: string;
  suiteHash: string;
  candidateScore: number;
  baselineScore: number;
  permissionDelta: string[];
  eligibleForCanary: boolean;
  caseResults: SkillCaseResult[];
  createdAt: string;
}

export interface SkillActivation {
  id: string;
  skillId: string;
  evaluationId: string;
  suiteHash: string;
  replayCaseIds: string[];
  status: 'canary' | 'active' | 'rolled_back' | 'failed';
  maxRuns: number;
  usedRuns: number;
  passedRuns: number;
  failedRuns: number;
  createdAt: string;
  updatedAt: string;
  rollbackReason?: string;
}

export interface KernelBudget {
  maxOperations: number;
  maxCommandRuntimeMs: number;
  maxApprovals: number;
  maxProviderCalls: number;
}

export interface BudgetUsage {
  operations: number;
  commandRuntimeMs: number;
  approvals: number;
  providerCalls: number;
}

export interface GoalContractInput {
  objective: string;
  successCriteria: string[];
  constraints: string[];
  autonomyLevel: AutonomyLevel;
  workspaceRoot: string;
  verificationCommands: string[];
  budget: KernelBudget;
}

export interface GoalContract extends GoalContractInput {
  id: string;
  status: GoalStatus;
  kind?: 'research_report';
  research?: ResearchMission;
  createdAt: string;
  updatedAt: string;
  usage: BudgetUsage;
}

export interface KernelTask {
  id: string;
  goalId: string;
  title: string;
  description: string;
  status: TaskStatus;
  riskLevel: RiskLevel;
  capabilityFamily: CapabilityFamily;
  dependsOn: string[];
  expectedEvidence: string;
  commandRequest?: KernelCommandRequest;
  missionStep?: ResearchMissionStage | 'publish';
  outputArtifactIds?: string[];
  approvalId?: string;
  evidenceEventIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface KernelCommandRequest {
  command: string;
  args: string[];
  cwd: string;
  expectedEvidence: string;
}

export interface KernelEvidence {
  kind: 'command_output' | 'state_change' | 'approval_decision' | 'policy_decision';
  summary: string;
  command?: string;
  exitCode?: number;
  durationMs?: number;
  stdout?: string;
  stderr?: string;
}

export interface KernelEvent {
  id: string;
  timestamp: string;
  actor: KernelActor;
  type: string;
  entityId: string;
  entityType: 'goal' | 'task' | 'approval' | 'capability' | 'budget' | 'worker' | 'system' | 'memory' | 'skill' | 'skill_eval' | 'skill_activation' | 'provider' | 'automation' | 'control' | 'release' | 'benchmark' | 'artifact' | 'mission' | 'schedule' | 'occurrence';
  payload: Record<string, unknown>;
  previousHash: string | null;
  hash: string;
}

export interface ApprovalRecord {
  id: string;
  goalId: string;
  taskId: string;
  status: ApprovalStatus;
  requestedAction: string;
  riskLevel: RiskLevel;
  reason: string;
  createdAt: string;
  updatedAt: string;
  decidedAt?: string;
  decisionReason?: string;
}

export interface PolicyDecision {
  kind: PolicyDecisionKind;
  riskLevel: RiskLevel;
  reason: string;
}

export interface CapabilityToken {
  id: string;
  family: CapabilityFamily;
  goalId: string;
  taskId: string;
  scope: {
    workspaceRoot: string;
    command?: string;
    args?: string[];
    cwd?: string;
    providerIds?: string[];
    models?: string[];
    requestHash?: string;
  };
  riskLevel: RiskLevel;
  expiresAt: string;
  maxOperations: number;
  usedOperations: number;
}

export interface KernelControls {
  stopAll: boolean;
  stopAllReason?: string;
  updatedAt?: string;
}

export type ReleaseActivationState = 'proposed' | 'blocked' | 'rejected' | 'activated';

export interface ReleaseProposal {
  id: string;
  title: string;
  targetVersion: string;
  contentHash: string;
  evaluationEventIds: string[];
  rollbackInstructions: string;
  signature?: string;
  activationState: ReleaseActivationState;
  activationReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface BenchmarkRun {
  id: string;
  goalId: string;
  objective: string;
  completion: 'completed' | 'failed';
  taskDefinitions: Array<{ taskId: string; title: string; expectedEvidence: string; status: TaskStatus }>;
  interventionCount: number;
  commandRuntimeMs: number;
  providerCallCount: number;
  evidenceEventIds: string[];
  createdAt: string;
}

export type ResearchMissionStage = 'planning' | 'collecting' | 'synthesizing' | 'verifying';
export type ResearchMissionStatus = ResearchMissionStage | 'blocked' | 'completed' | 'cancelled';
export type ResearchSourceStatus = 'pending' | 'running' | 'captured' | 'quarantined' | 'failed';

export interface ResearchSourceChunk {
  id: string;
  charStart: number;
  charEnd: number;
  contentHash: string;
}

export interface ResearchMissionSource {
  id: string;
  url: string;
  origin: string;
  status: ResearchSourceStatus;
  artifactId?: string;
  contentHash?: string;
  byteLength?: number;
  chunks: ResearchSourceChunk[];
  observationId?: string;
  observationRisk?: 'none' | 'medium' | 'high';
  injectionSignalCodes: string[];
  evidenceEventId?: string;
  failureReason?: string;
  capturedAt?: string;
}

export interface ResearchMissionPlan {
  title: string;
  researchQuestions: string[];
  reportOutline: string[];
}

export interface ResearchClaimEvidence {
  sourceId: string;
  chunkId: string;
  quote: string;
}

export interface ResearchMissionClaim {
  id: string;
  statement: string;
  confidence: 'high' | 'medium' | 'low';
  evidence: ResearchClaimEvidence[];
}

export interface ResearchMissionDraft {
  title: string;
  executiveSummary: string;
  claims: ResearchMissionClaim[];
  limitations: string[];
}

export interface ResearchMissionProviderRun {
  purpose: 'plan' | 'synthesis' | 'critique';
  requestId: string;
  evidenceEventId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  latencyMs: number;
  completedAt: string;
}

export interface ResearchMissionVerification {
  status: 'passed' | 'failed';
  deterministicIssues: string[];
  criticVerdict: 'pass' | 'fail';
  criticSummary: string;
  criticIssues: Array<{
    claimId: string;
    severity: 'error' | 'warning';
    reason: string;
  }>;
  verifiedAt: string;
}

export interface ResearchMissionActiveStep {
  id: string;
  stage: ResearchMissionStage;
  kind: 'provider' | 'source';
  attempt: number;
  startedAt: string;
  requestId?: string;
  sourceId?: string;
  intentId?: string;
}

export interface ResearchMissionTaskIds {
  plan: string;
  collect: string;
  synthesize: string;
  verify: string;
  publish: string;
}

export interface ResearchMission {
  id: string;
  goalId: string;
  objective: string;
  status: ResearchMissionStatus;
  revision: number;
  checkpoint: number;
  taskIds: ResearchMissionTaskIds;
  sources: ResearchMissionSource[];
  plan?: ResearchMissionPlan;
  draft?: ResearchMissionDraft;
  verification?: ResearchMissionVerification;
  providerRuns: ResearchMissionProviderRun[];
  synthesisAttempts: number;
  lastVerificationIssues: string[];
  activeStep?: ResearchMissionActiveStep;
  resumeStage?: ResearchMissionStage;
  retryable?: boolean;
  lastError?: string;
  reportArtifactId?: string;
  reportContentHash?: string;
  schedulerOwnership?: {
    scheduleId: string;
    occurrenceId: string;
    leaseId: string;
    leaseFence: number;
  };
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface RecurringResearchScheduleRecord {
  contract: RecurringResearchSchedule;
  maxRuns: number;
  maxConsecutiveFailures: number;
  runsClaimed: number;
  consecutiveFailures: number;
  nextDueAt: string;
  scheduledThrough?: string;
  activeOccurrenceId?: string;
  lastOccurrenceId?: string;
  haltedReason?: string;
}

export interface RecurringResearchOccurrenceRecord extends RecurringResearchOccurrence {
  leaseId: string;
  leaseFence: number;
  deadlineAt: string;
  goalId: string;
  missionId: string;
  attempt: number;
  /** Cumulative wall-clock runtime charged across every attempt. */
  runtimeUsedMs?: number;
  /** Start of the current attempt, used to charge runtime on every exit path. */
  attemptStartedAt?: string;
  /** Persisted pre-dispatch source-fetch charges across every attempt. */
  sourceFetchesUsed?: number;
  reportArtifactId?: string;
  reportContentHash?: string;
}

export interface RecurringResearchKernelState {
  schemaVersion: 1;
  schedules: RecurringResearchScheduleRecord[];
  occurrences: RecurringResearchOccurrenceRecord[];
}

export interface KernelState {
  goals: GoalContract[];
  tasks: KernelTask[];
  approvals: ApprovalRecord[];
  memories: KernelMemoryRecord[];
  skillPackages: SkillPackage[];
  skillEvaluations: SkillEvaluation[];
  skillActivations: SkillActivation[];
  automations: import('../capabilities/types').AutomationContract[];
  releaseProposals: ReleaseProposal[];
  benchmarkRuns: BenchmarkRun[];
  contentSchemaVersion?: 2;
  recurringResearch?: RecurringResearchKernelState;
  controls: KernelControls;
  lastEventHash: string | null;
}

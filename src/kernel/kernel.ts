import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { consumeCapabilityGrant, createCapabilityGrant } from '../capabilities/grants';
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
import { ProviderExecution, ProviderRequest, ProviderRoutingPolicy } from '../providers/types';
import { createApprovalRecord, decideApprovalRecord } from './approvals';
import {
  buildAutomationContract,
  buildAutomationIntent,
  buildBenchmarkRun,
  buildReleaseProposal,
  decideReleaseActivation,
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
  getSkillActivationLedgerMetadata,
  getSkillPackageLedgerMetadata,
  promoteSkill,
  recordCanaryRun,
  rollbackSkill,
} from './skills/foundry';
import { runPureTransform, stableHash } from './skills/runtime';
import { synthesizePureTransform } from './skills/synthesizer';
import { readKernelState, writeKernelState } from './store';
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
  KernelMemoryRecord,
  KernelState,
  KernelTask,
  MemoryEvidenceRef,
  ReleaseProposal,
  SkillActivation,
  SkillCase,
  SkillEvaluation,
  SkillManifest,
  SkillPackage,
} from './types';
import type { SandboxRunner } from './sandbox/sandbox';
import { runKernelCommand } from './workers/commandWorker';

export interface KernelActionWorkerResult {
  status: 'succeeded' | 'failed';
  summary: string;
  sourceRef: string;
  content?: string;
  errorCode?: string;
}

export interface KernelActionWorker {
  execute(intent: ActionIntent, options: { timeoutMs: number }): Promise<KernelActionWorkerResult>;
}

/** May only tighten: heuristic assessment stays the floor on any failure. */
export type KernelObservationAssessor = (content: string) => Promise<{
  risk: 'none' | 'medium' | 'high';
  signals: ReadonlyArray<{ code: PromptInjectionSignalCode }>;
}>;

export interface AutomationRunOutcome {
  decision: CapabilityPolicyDecision;
  dispatch?: {
    status: 'succeeded' | 'failed';
    summary: string;
    sourceRef: string;
    errorCode?: string;
  };
  observation?: {
    id: string;
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
}

export interface KernelStepResult {
  status: 'passed' | 'failed' | 'blocked' | 'denied' | 'approval_required' | 'completed';
  reason?: string;
  evidence?: KernelEvidence;
  approvalId?: string;
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

export const createKernelService = (options: KernelServiceOptions) => {
  const workerRegistry = createWorkerRegistry(options.workerRegistrations ?? defaultWorkerRegistrations());
  let mutationQueue: Promise<void> = Promise.resolve();

  const withMutation = <T>(work: () => Promise<T>): Promise<T> => {
    const result = mutationQueue.then(work, work);
    mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  };

  const appendEvent = async (state: KernelState, input: KernelEventInput) => {
    const event = await appendKernelEvent(options.runtimeDir, state.lastEventHash, input);
    return { event, state: { ...state, lastEventHash: event.hash } };
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
    const [state, events] = await Promise.all([
      readKernelState(options.runtimeDir),
      readKernelEvents(options.runtimeDir),
    ]);
    const ledgerHead = events.at(-1)?.hash ?? null;
    if (state.lastEventHash !== ledgerHead) {
      throw new Error('Kernel snapshot head does not match the event ledger.');
    }
    return state;
  };

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

    await writeKernelState(options.runtimeDir, {
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
      await writeKernelState(options.runtimeDir, {
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
      await writeKernelState(options.runtimeDir, {
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
    await writeKernelState(options.runtimeDir, {
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

    await writeKernelState(options.runtimeDir, {
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
    const taskStatus = status === 'denied' ? 'denied' : 'blocked';
    await writeKernelState(options.runtimeDir, {
      ...state,
      approvals: state.approvals.map((candidate) => candidate.id === approvalId ? decided : candidate),
      tasks: markTaskStatus(state.tasks, approval.taskId, taskStatus, decided.updatedAt),
      goals: state.goals.map((candidate) => candidate.id === approval.goalId
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

    const draft = createMemoryCandidateRecord({ ...input, evidenceRefs: suppliedEvidence });
    const appended = await appendEvent(state, {
      actor: input.provenance.actor,
      type: 'memory.candidate_created',
      entityId: draft.id,
      entityType: 'memory',
      payload: createMemoryLedgerPayload(draft),
    });
    state = appended.state;
    const record: KernelMemoryRecord = {
      ...draft,
      evidenceRefs: [...draft.evidenceRefs, { eventId: appended.event.id }],
    };
    await writeKernelState(options.runtimeDir, {
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
    const eventIds = new Set(events.map((event) => event.id));
    if (record.evidenceRefs.some((reference) => !eventIds.has(reference.eventId))) {
      throw new Error('Memory evidence is missing from the kernel ledger.');
    }

    const promoted = promoteMemoryRecord(state.memories, memoryId, reason);
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
    await writeKernelState(options.runtimeDir, { ...state, memories: promoted.records });
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
    await writeKernelState(options.runtimeDir, { ...state, memories: revoked.records });
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
    await writeKernelState(options.runtimeDir, {
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
    await writeKernelState(options.runtimeDir, {
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
    await writeKernelState(options.runtimeDir, {
      ...state,
      skillPackages: state.skillPackages.map((candidate) => candidate.id === skillId ? canary.skill : candidate),
      skillActivations: [...state.skillActivations, canary.activation],
    });
    return canary.activation;
  });

  const runSkillCanary = (
    skillId: string,
    input: string,
    expectedOutput: string,
  ): Promise<{ output: string; passed: boolean; activation: SkillActivation }> => withMutation(async () => {
    let state = await readConsistentState();
    const skill = state.skillPackages.find((candidate) => candidate.id === skillId);
    if (!skill) throw new Error('Skill not found.');
    const activation = [...state.skillActivations].reverse().find((candidate) => candidate.skillId === skillId);
    if (!activation) throw new Error('Skill activation not found.');
    const output = runPureTransform(skill.program, input, {
      maxInputChars: skill.manifest.maxInputChars,
      maxSteps: skill.manifest.maxSteps,
    });
    const passed = output === expectedOutput;
    const updated = recordCanaryRun(skill, activation, { passed, updatedAt: new Date().toISOString() });
    const appended = await appendEvent(state, {
      actor: 'kernel',
      type: passed ? 'skill.canary_passed' : 'skill.canary_failed',
      entityId: activation.id,
      entityType: 'skill_activation',
      payload: {
        ...getSkillActivationLedgerMetadata(updated),
        inputHash: stableHash(input),
        outputHash: stableHash(output),
        expectedOutputHash: stableHash(expectedOutput),
      },
    });
    state = appended.state;
    await writeKernelState(options.runtimeDir, {
      ...state,
      skillActivations: state.skillActivations.map((candidate) => candidate.id === activation.id ? updated : candidate),
    });
    return { output, passed, activation: updated };
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
    await writeKernelState(options.runtimeDir, {
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
    await writeKernelState(options.runtimeDir, {
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
    await writeKernelState(options.runtimeDir, state);
    return output;
  });

  const executeProviderRequest = (
    goalId: string,
    request: ProviderRequest,
    policy: ProviderRoutingPolicy,
  ): Promise<ProviderExecution> => withMutation(async () => {
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

    let appended = await appendEvent(state, {
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
    await writeKernelState(options.runtimeDir, {
      ...state,
      goals: state.goals.map((candidate) => candidate.id === goalId
        ? { ...candidate, usage: reserved.usage, updatedAt: new Date().toISOString() }
        : candidate),
    });

    try {
      const execution = await options.providerRouter.execute(request, plan, new AbortController().signal);
      state = await readConsistentState();
      appended = await appendEvent(state, {
        actor: 'provider',
        type: 'provider.call.completed',
        entityId: request.id,
        entityType: 'provider',
        payload: {
          goalId,
          requestHash,
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
      await writeKernelState(options.runtimeDir, state);
      return execution;
    } catch (error) {
      state = await readConsistentState();
      appended = await appendEvent(state, {
        actor: 'provider',
        type: 'provider.call.failed',
        entityId: request.id,
        entityType: 'provider',
        payload: {
          goalId,
          requestHash,
          errorHash: stableHash(error instanceof Error ? error.message : 'Provider call failed.'),
        },
      });
      state = appended.state;
      await writeKernelState(options.runtimeDir, state);
      throw error;
    }
  });

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
    await writeKernelState(options.runtimeDir, {
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
    await writeKernelState(options.runtimeDir, {
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
    await writeKernelState(options.runtimeDir, state);
    return decision;
  });

  const runAutomation = (automationId: string): Promise<AutomationRunOutcome> => withMutation(async () => {
    let state = await readConsistentState();
    const automation = state.automations.find((candidate) => candidate.id === automationId);
    if (!automation) throw new Error('Automation not found.');
    if (!automation.enabled) throw new Error('Automation is disabled.');
    if (state.controls.stopAll) throw new Error('Stop All is active. Resume the kernel before running automations.');
    const goal = state.goals.find((candidate) => candidate.id === automation.goalId);
    if (!goal) throw new Error('Goal not found.');

    const events = await readKernelEvents(options.runtimeDir);
    const runEvents = events.filter((event) => (
      (event.type === 'automation.run_completed' || event.type === 'automation.run_failed') &&
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

    const reserved = reserveBudget(goal.budget, goal.usage, { operations: 1 });
    if (!reserved.allowed) throw new Error(reserved.reason);

    const intent = buildAutomationIntent(automation);
    const decision = decideActionPolicy(intent, workerRegistry);
    if (decision.kind !== 'allow') {
      const appended = await appendEvent(state, {
        actor: 'kernel',
        type: decision.kind === 'approval_required' ? 'automation.run_blocked' : 'automation.run_denied',
        entityId: automationId,
        entityType: 'automation',
        payload: { automationId, intentId: intent.id, reasonCode: decision.reasonCode, reason: decision.reason },
      });
      state = appended.state;
      await writeKernelState(options.runtimeDir, state);
      return { decision };
    }

    const worker = options.actionWorkers?.[automation.workerId];
    const registration = workerRegistry.get(automation.workerId);
    if (!worker || !registration) {
      throw new Error('No executable worker runtime is registered for this automation.');
    }

    const startedAt = new Date().toISOString();
    const grant = createCapabilityGrant(intent, {
      id: createKernelId('cap'),
      issuedAt: startedAt,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      maxOps: 1,
    });
    let appended = await appendEvent(state, {
      actor: 'kernel',
      type: 'automation.run_started',
      entityId: automationId,
      entityType: 'automation',
      payload: { automationId, intentId: intent.id, grantId: grant.id, actionType: automation.action.type },
    });
    state = appended.state;

    const timeoutMs = Math.min(automation.budget.maxRuntimeMsPerRun, 30_000);
    const dispatch = await worker.execute(intent, { timeoutMs });

    const content = dispatch.content ?? '';
    const heuristic = analyzePromptInjection(content);
    let assessment: { risk: 'none' | 'medium' | 'high'; codes: PromptInjectionSignalCode[] } = {
      risk: heuristic.risk,
      codes: heuristic.signals.map((signal) => signal.code),
    };
    if (options.observationAssessor) {
      try {
        const assessed = await options.observationAssessor(content);
        assessment = { risk: assessed.risk, codes: assessed.signals.map((signal) => signal.code) };
      } catch {
        // The heuristic floor stands when the advisory model fails.
      }
    }
    const observation = {
      ...createUntrustedObservation({
        id: createKernelId('obs'),
        source: 'web' as const,
        sourceRef: dispatch.sourceRef,
        content,
        capturedAt: new Date().toISOString(),
      }),
      injectionSignalCodes: assessment.codes,
    };

    const consumed = consumeCapabilityGrant(grant, intent, registration, {
      now: new Date().toISOString(),
      operationsUsed: 1,
    });
    const succeeded = dispatch.status === 'succeeded' && consumed.allowed;
    appended = await appendEvent(state, {
      actor: 'worker',
      type: succeeded ? 'automation.run_completed' : 'automation.run_failed',
      entityId: automationId,
      entityType: 'automation',
      payload: {
        automationId,
        intentId: intent.id,
        grantId: grant.id,
        grantStatus: consumed.grant.status,
        summary: dispatch.summary,
        errorCode: dispatch.errorCode ?? (consumed.allowed ? undefined : consumed.reasonCode),
        observationId: observation.id,
        contentHash: observation.contentHash,
        injectionSignalCodes: observation.injectionSignalCodes,
        risk: assessment.risk,
      },
    });
    state = appended.state;
    await writeKernelState(options.runtimeDir, {
      ...state,
      goals: state.goals.map((candidate) => candidate.id === goal.id
        ? { ...candidate, usage: reserved.usage, updatedAt: new Date().toISOString() }
        : candidate),
    });

    return {
      decision,
      dispatch: {
        status: dispatch.status,
        summary: dispatch.summary,
        sourceRef: dispatch.sourceRef,
        errorCode: dispatch.errorCode,
      },
      observation: {
        id: observation.id,
        contentHash: observation.contentHash,
        risk: assessment.risk,
        injectionSignalCodes: observation.injectionSignalCodes,
      },
      content,
    };
  });

  const setStopAll = (stopAll: boolean, reason: string): Promise<KernelControls> => withMutation(async () => {
    if (!reason.trim()) throw new Error('Stop All state change reason is required.');
    let state = await readConsistentState();
    if (state.controls.stopAll === stopAll) {
      throw new Error(`Kernel execution is already ${stopAll ? 'stopped' : 'running'}.`);
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
    await writeKernelState(options.runtimeDir, { ...state, controls });
    return controls;
  });

  const recoverInterruptedTasks = (): Promise<{ recoveredTaskIds: string[] }> => withMutation(async () => {
    let state = await readConsistentState();
    const interrupted = state.tasks.filter((task) => task.status === 'running');
    if (interrupted.length === 0) return { recoveredTaskIds: [] };

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
    await writeKernelState(options.runtimeDir, {
      ...state,
      tasks: state.tasks.map((task) => interruptedTaskIds.has(task.id)
        ? { ...task, status: 'blocked', updatedAt: now }
        : task),
      goals: state.goals.map((goal) => interruptedGoalIds.has(goal.id) && goal.status === 'active'
        ? { ...goal, status: 'blocked', updatedAt: now }
        : goal),
    });
    return { recoveredTaskIds: [...interruptedTaskIds] };
  });

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
    await writeKernelState(options.runtimeDir, {
      ...state,
      releaseProposals: [...state.releaseProposals, proposal],
    });
    return proposal;
  });

  const activateReleaseProposal = (releaseId: string): Promise<ReleaseProposal> => withMutation(async () => {
    let state = await readConsistentState();
    const proposal = state.releaseProposals.find((candidate) => candidate.id === releaseId);
    if (!proposal) throw new Error('Release proposal not found.');

    const decided = decideReleaseActivation(proposal, options.releaseSigningPublicKey);
    const appended = await appendEvent(state, {
      actor: 'kernel',
      type: decided.activationState === 'activated' ? 'release.activated' : 'release.activation_blocked',
      entityId: releaseId,
      entityType: 'release',
      payload: { releaseId, reason: decided.activationReason },
    });
    state = appended.state;
    await writeKernelState(options.runtimeDir, {
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
    await writeKernelState(options.runtimeDir, {
      ...state,
      releaseProposals: state.releaseProposals.map((candidate) => candidate.id === releaseId ? rejected : candidate),
    });
    return rejected;
  });

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
    await writeKernelState(options.runtimeDir, {
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
  };
};

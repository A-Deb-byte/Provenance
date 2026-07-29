import express from 'express';
import type { WorkerRegistration } from '../capabilities/types';
import {
  createDiagnosticSnapshot,
  createDiagnosticSupportBundle,
  type DiagnosticHealthInput,
  type DiagnosticLogInput,
  type DiagnosticSnapshot,
  type DiagnosticSnapshotInput,
} from '../diagnostics';
import type { ProviderRouter } from '../providers/router';
import type { ProviderPublicStatus, ProviderRoutingPolicy } from '../providers/types';
import { buildRuntimeCapabilityReport } from './autonomy';
import { buildObservatorySnapshot } from './observatory';
import { sandboxStatus, SandboxRunner } from './sandbox/sandbox';
import { getSkillEvaluationLedgerMetadata } from './skills/evaluation';
import {
  getSkillEvaluationSuiteLedgerMetadata,
  type SkillEvaluationSourceResolver,
} from './skills/evaluationSuite';
import type { RecurringResearchSchedulerStatus } from './scheduler/service';
import {
  createKernelService,
  KernelActionWorker,
  KernelObservationAssessor,
  MAX_KERNEL_AUDIT_REASON_CHARS,
  MAX_PROVIDER_REQUEST_ID_CHARS,
} from './kernel';

export interface KernelRouterOptions {
  readonly runtimeDir: string;
  readonly allowedWorkspaceRoot: string;
  readonly providerRouter?: ProviderRouter;
  readonly providerStatuses?: readonly ProviderPublicStatus[];
  readonly workerRegistrations?: WorkerRegistration[];
  readonly coreModelStatus?: () => Promise<{ status: 'available' | 'unavailable'; reason: string }>;
  readonly releaseSigningPublicKey?: string;
  readonly actionWorkers?: Record<string, KernelActionWorker>;
  readonly observationAssessor?: KernelObservationAssessor;
  readonly secretVaultStatus?: () => Promise<{ status: 'available' | 'unavailable'; reason: string }>;
  readonly accessControlStatus?: () => { status: 'available' | 'unavailable'; reason: string };
  readonly sandbox?: SandboxRunner;
  readonly artifactStore?: import('./artifacts/artifactStore').ArtifactStore;
  readonly capabilityGrantStore?: import('../capabilities/grantStore').CapabilityGrantStore;
  readonly releaseLifecycle?: ReturnType<typeof import('./releases/lifecycle').createReleaseLifecycle>;
  readonly researchRoutingPolicy?: ProviderRoutingPolicy;
  readonly researchProviderConfigured?: boolean;
  readonly researchWorkerId?: string;
  readonly providerTimeoutMs?: number;
  readonly recurringResearchSchedulerEnabled?: boolean;
  readonly recurringResearchTickMs?: number;
  readonly skillEvaluationSourceResolver?: SkillEvaluationSourceResolver;
  readonly skillEvaluatorAllowlist?: readonly string[];
  readonly skillAuthorPrincipal?: (request: express.Request) => string | undefined;
  readonly recurringResearchSchedulerStatus?: () => RecurringResearchSchedulerStatus;
  readonly desktopIpcStatus?: () => import('./autonomy').RuntimeFeatureStatus;
  readonly desktopPayloadStore?: import('../desktop/payloadStore').DesktopPayloadStore;
  readonly diagnostics?: {
    readonly build: DiagnosticSnapshotInput['build'];
    readonly runtime: DiagnosticSnapshotInput['runtime'];
    readonly health?: () => readonly DiagnosticHealthInput[] | Promise<readonly DiagnosticHealthInput[]>;
    readonly logs?: () => readonly DiagnosticLogInput[] | Promise<readonly DiagnosticLogInput[]>;
  };
  readonly recoverOnStart?: boolean;
  readonly kernelService?: ReturnType<typeof createKernelService>;
}

type ApprovalDecisionStatus = 'approved' | 'denied';

const errorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : 'Unknown kernel error.';
};

const isApprovalDecisionStatus = (value: unknown): value is ApprovalDecisionStatus => {
  return value === 'approved' || value === 'denied';
};

const requiredAuditReason = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`);
  const reason = value.trim();
  if (reason.length > MAX_KERNEL_AUDIT_REASON_CHARS) {
    throw new Error(`${label} must be at most ${MAX_KERNEL_AUDIT_REASON_CHARS} characters.`);
  }
  return reason;
};

export const createKernelRouter = (options: KernelRouterOptions) => {
  const config = Object.freeze({
    runtimeDir: options.runtimeDir,
    allowedWorkspaceRoot: options.allowedWorkspaceRoot,
    providerRouter: options.providerRouter,
    workerRegistrations: options.workerRegistrations,
    releaseSigningPublicKey: options.releaseSigningPublicKey,
    actionWorkers: options.actionWorkers,
    observationAssessor: options.observationAssessor,
    sandbox: options.sandbox,
    artifactStore: options.artifactStore,
    capabilityGrantStore: options.capabilityGrantStore,
    releaseLifecycle: options.releaseLifecycle,
    researchRoutingPolicy: options.researchRoutingPolicy,
    researchProviderConfigured: options.researchProviderConfigured,
    researchWorkerId: options.researchWorkerId,
    providerTimeoutMs: options.providerTimeoutMs,
    recurringResearchSchedulerEnabled: options.recurringResearchSchedulerEnabled,
    recurringResearchTickMs: options.recurringResearchTickMs,
    skillEvaluationSourceResolver: options.skillEvaluationSourceResolver,
    skillEvaluatorAllowlist: options.skillEvaluatorAllowlist,
  });
  const kernel = options.kernelService ?? createKernelService(config);
  const router = express.Router();

  const diagnosticSnapshot = async (): Promise<DiagnosticSnapshot> => {
    if (!options.diagnostics) throw new Error('Diagnostics are unavailable.');
    const [state, events, configuredHealth] = await Promise.all([
      kernel.getState(),
      kernel.getEvents(),
      options.diagnostics.health?.() ?? [],
    ]);
    const workers = kernel.getWorkers().report;
    return createDiagnosticSnapshot({
      build: options.diagnostics.build,
      runtime: options.diagnostics.runtime,
      health: [
        {
          component: 'kernel.snapshot',
          status: 'ok',
          reasonCode: 'authenticated',
          metrics: {
            goals: state.goals.length,
            tasks: state.tasks.length,
            automations: state.automations.length,
            stop_all: state.controls.stopAll,
          },
        },
        {
          component: 'kernel.ledger',
          status: 'ok',
          reasonCode: 'verified',
          metrics: { events: events.length },
        },
        {
          component: 'kernel.workers',
          status: workers.available.length > 0 ? 'ok' : 'degraded',
          reasonCode: workers.available.length > 0 ? 'available' : 'none_available',
          metrics: {
            available: workers.available.length,
            configured: workers.configured.length,
            unavailable: workers.unavailable.length,
          },
        },
        ...configuredHealth,
      ],
    });
  };

  // Interrupted running tasks are recovered into an inspectable blocked
  // state at startup rather than silently resuming.
  if (options.recoverOnStart !== false) {
    void kernel.recoverInterruptedTasks().catch((error) => {
      console.warn('[Kernel] Startup recovery skipped:', error instanceof Error ? error.message : error);
    });
  }

  router.get('/research-missions/config', (_req, res) => {
    res.json(kernel.getResearchMissionCapability());
  });

  router.get('/recurring-research/config', (_req, res) => {
    res.json(kernel.getRecurringResearchCapability());
  });

  router.get('/recurring-research', async (_req, res) => {
    try {
      res.json({ schedules: await kernel.listRecurringResearchSchedules() });
    } catch {
      res.status(500).json({ error: 'Recurring research schedules are unavailable.' });
    }
  });

  router.post('/recurring-research', async (req, res) => {
    try {
      res.status(201).json(await kernel.createRecurringResearchSchedule(req.body));
    } catch (error) {
      const message = errorMessage(error);
      const status = message.includes('unavailable') || message.includes('disabled in this deployment') ? 503 : 400;
      res.status(status).json({ error: message });
    }
  });

  router.get('/recurring-research/:scheduleId', async (req, res) => {
    try {
      res.json(await kernel.getRecurringResearchSchedule(req.params.scheduleId));
    } catch (error) {
      const message = errorMessage(error);
      res.status(message === 'Recurring research schedule not found.' ? 404 : 500).json({ error: message });
    }
  });

  router.post('/recurring-research/:scheduleId/enabled', async (req, res) => {
    if (typeof req.body?.enabled !== 'boolean') {
      res.status(400).json({ error: 'Schedule enabled must be a boolean.' });
      return;
    }
    try {
      res.json(await kernel.setRecurringResearchScheduleEnabled(
        req.params.scheduleId,
        req.body.enabled,
        requiredAuditReason(req.body?.reason, 'Schedule change reason'),
      ));
    } catch (error) {
      const message = errorMessage(error);
      const status = message === 'Recurring research schedule not found.' ? 404
        : message.includes('unavailable') || message.includes('disabled in this deployment') ? 503
          : message.includes('already') || message.includes('exhausted') || message.includes('active occurrence') ||
              message.includes('Stop All') ? 409 : 400;
      res.status(status).json({ error: message });
    }
  });

  router.post('/recurring-research/tick', async (_req, res) => {
    try {
      // Wall-clock authority stays server-side. The optional kernel timestamp
      // exists only for deterministic clocks and tests, never HTTP callers.
      res.json(await kernel.runRecurringResearchTick());
    } catch (error) {
      res.status(400).json({ error: errorMessage(error) });
    }
  });

  router.post('/recurring-research/:scheduleId/occurrences/:occurrenceId/resume', async (req, res) => {
    try {
      res.json(await kernel.resumeRecurringResearchOccurrence(
        req.params.scheduleId,
        req.params.occurrenceId,
        requiredAuditReason(req.body?.reason, 'Occurrence resume reason'),
      ));
    } catch (error) {
      const message = errorMessage(error);
      const status = message.includes('not found') ? 404
        : message.includes('unavailable') || message.includes('disabled') ? 503
          : message.includes('not active') || message.includes('not resumable') || message.includes('exhausted') ||
              message.includes('Stop All') ? 409 : 400;
      res.status(status).json({ error: message });
    }
  });

  router.post('/recurring-research/:scheduleId/occurrences/:occurrenceId/skip', async (req, res) => {
    try {
      res.json(await kernel.skipRecurringResearchOccurrence(
        req.params.scheduleId,
        req.params.occurrenceId,
        requiredAuditReason(req.body?.reason, 'Occurrence skip reason'),
      ));
    } catch (error) {
      const message = errorMessage(error);
      const status = message.includes('not found') ? 404
        : message.includes('not active') || message.includes('must be cancelled') ? 409 : 400;
      res.status(status).json({ error: message });
    }
  });

  router.get('/research-missions', async (_req, res) => {
    try {
      res.json({ missions: await kernel.listResearchMissions() });
    } catch {
      res.status(500).json({ error: 'Research missions are unavailable.' });
    }
  });

  router.post('/research-missions', async (req, res) => {
    try {
      res.status(201).json(await kernel.createResearchMission(req.body));
    } catch (error) {
      const message = errorMessage(error);
      const status = message.includes('unavailable') ? 503 : 400;
      res.status(status).json({ error: message });
    }
  });

  router.get('/research-missions/:missionId', async (req, res) => {
    try {
      const [state, events] = await Promise.all([kernel.getState(), kernel.getEvents()]);
      const goal = state.goals.find((candidate) => (
        candidate.research?.id === req.params.missionId ||
        (candidate.kind === 'research_report' && candidate.id === req.params.missionId)
      ));
      if (!goal?.research) {
        res.status(404).json({ error: 'Research mission not found.' });
        return;
      }
      const mission = goal.research;
      res.json({
        mission,
        goal,
        tasks: state.tasks.filter((task) => task.goalId === goal.id),
        approvals: state.approvals.filter((approval) => approval.goalId === goal.id),
        events: events.filter((event) => (
          event.entityId === mission.id ||
          event.entityId === goal.id ||
          event.payload.missionId === mission.id ||
          event.payload.goalId === goal.id
        )),
        controls: state.controls,
      });
    } catch {
      res.status(500).json({ error: 'Research mission state is unavailable.' });
    }
  });

  router.post('/research-missions/:missionId/step', async (req, res) => {
    try {
      res.json(await kernel.stepResearchMission(req.params.missionId));
    } catch (error) {
      const message = errorMessage(error);
      res.status(message === 'Research mission not found.' ? 404 : 400).json({ error: message });
    }
  });

  router.post('/research-missions/:missionId/run', async (req, res) => {
    try {
      const maxSteps = req.body?.maxSteps === undefined ? 20 : req.body.maxSteps;
      res.json(await kernel.runResearchMission(req.params.missionId, maxSteps));
    } catch (error) {
      const message = errorMessage(error);
      res.status(message === 'Research mission not found.' ? 404 : 400).json({ error: message });
    }
  });

  router.post('/research-missions/:missionId/resume', async (req, res) => {
    try {
      res.json(await kernel.resumeResearchMission(req.params.missionId, String(req.body?.reason ?? '')));
    } catch (error) {
      const message = errorMessage(error);
      const status = message === 'Research mission not found.' ? 404
        : message.includes('not resumable') || message.includes('requires revision') ? 409 : 400;
      res.status(status).json({ error: message });
    }
  });

  router.get('/research-missions/:missionId/report', async (req, res) => {
    try {
      res.json(await kernel.getResearchMissionReport(req.params.missionId));
    } catch (error) {
      const message = errorMessage(error);
      const status = message === 'Research mission not found.' ? 404
        : message.includes('no published report') ? 409
          : message.startsWith('Published report') || message.includes('failed authenticated') ? 422 : 500;
      res.status(status).json({ error: message });
    }
  });

  router.post('/goals', async (req, res) => {
    try {
      const goal = await kernel.createGoal(req.body);
      res.status(201).json(goal);
    } catch (error) {
      res.status(400).json({ error: errorMessage(error) });
    }
  });

  router.get('/goals', async (_req, res) => {
    try {
      const state = await kernel.getState();
      res.json({ goals: state.goals });
    } catch {
      res.status(500).json({ error: 'Kernel state is unavailable.' });
    }
  });

  router.get('/goals/:goalId', async (req, res) => {
    try {
      const [state, events] = await Promise.all([kernel.getState(), kernel.getEvents()]);
      const goal = state.goals.find((candidate) => candidate.id === req.params.goalId);
      if (!goal) {
        res.status(404).json({ error: 'Goal not found.' });
        return;
      }

      res.json({
        goal,
        tasks: state.tasks.filter((task) => task.goalId === goal.id),
        approvals: state.approvals.filter((approval) => approval.goalId === goal.id),
        events: events.filter((event) => event.entityId === goal.id || event.payload.goalId === goal.id),
      });
    } catch {
      res.status(500).json({ error: 'Kernel state is unavailable.' });
    }
  });

  router.post('/goals/:goalId/step', async (req, res) => {
    try {
      res.json(await kernel.stepGoal(req.params.goalId));
    } catch (error) {
      const message = errorMessage(error);
      const status = message === 'Goal not found.' ? 404 : 500;
      res.status(status).json({ error: message });
    }
  });

  router.post('/goals/step-parallel', async (req, res) => {
    const goalIds = req.body?.goalIds as unknown;
    if (!Array.isArray(goalIds) || goalIds.length === 0 || !goalIds.every((id) => typeof id === 'string' && id.trim())) {
      res.status(400).json({ error: 'goalIds must be a non-empty array of goal id strings.' });
      return;
    }
    try {
      res.json({ results: await kernel.stepGoalsInParallel(goalIds as string[]) });
    } catch (error) {
      res.status(400).json({ error: errorMessage(error) });
    }
  });

  router.post('/goals/:goalId/provider-calls', async (req, res) => {
    try {
      const request = req.body?.request;
      const policy = req.body?.policy;
      if (!request || typeof request !== 'object' || !policy || typeof policy !== 'object') {
        res.status(400).json({ error: 'Provider request and routing policy are required.' });
        return;
      }
      const requestId = (request as { id?: unknown }).id;
      if (
        typeof requestId !== 'string' ||
        !requestId.trim() ||
        requestId !== requestId.trim() ||
        requestId.length > MAX_PROVIDER_REQUEST_ID_CHARS
      ) {
        res.status(400).json({
          error: `Provider request id must be a trimmed non-empty string of at most ${MAX_PROVIDER_REQUEST_ID_CHARS} characters.`,
        });
        return;
      }
      res.json(await kernel.executeProviderRequest(req.params.goalId, request, policy));
    } catch (error) {
      const message = errorMessage(error);
      const status = message === 'Goal not found.' ? 404
        : message === 'Provider router is unavailable.' ? 503
          : message.includes('budget exceeded') ? 409 : 400;
      res.status(status).json({ error: message });
    }
  });

  router.get('/events', async (_req, res) => {
    try {
      res.json({ events: await kernel.getEvents() });
    } catch {
      res.status(500).json({ error: 'Kernel events are unavailable.' });
    }
  });

  router.get('/observatory', async (_req, res) => {
    try {
      const observatory = await kernel.getObservatoryData(200);
      res.setHeader('cache-control', 'no-store');
      res.json(buildObservatorySnapshot({
        state: observatory.state,
        events: observatory.events,
        eventsTruncated: observatory.eventsTruncated,
        activeRuntime: observatory.activeRuntime,
        workers: kernel.getWorkers().workers,
        providers: options.providerStatuses ?? [],
      }));
    } catch {
      res.status(500).json({ error: 'Kernel observatory projection is unavailable.' });
    }
  });

  router.get('/approvals', async (_req, res) => {
    try {
      const state = await kernel.getState();
      res.json({ approvals: state.approvals });
    } catch {
      res.status(500).json({ error: 'Kernel approvals are unavailable.' });
    }
  });

  router.post('/approvals/:approvalId/decision', async (req, res) => {
    const status = req.body?.status as unknown;
    if (!isApprovalDecisionStatus(status)) {
      res.status(400).json({ error: 'Approval status must be approved or denied.' });
      return;
    }
    let reason: string;
    try {
      reason = requiredAuditReason(req.body?.reason, 'Approval decision reason');
    } catch (error) {
      res.status(400).json({ error: errorMessage(error) });
      return;
    }

    try {
      res.json(await kernel.decideApproval(req.params.approvalId, status, reason));
    } catch (error) {
      const message = errorMessage(error);
      const responseStatus = message === 'Approval not found.'
        ? 404
        : message === 'Approval has already been decided.' ? 409 : 400;
      res.status(responseStatus).json({ error: message });
    }
  });

  router.get('/memories', async (req, res) => {
    try {
      const state = await kernel.getState();
      const requestedStatus = typeof req.query.status === 'string' ? req.query.status : undefined;
      const memories = requestedStatus
        ? state.memories.filter((memory) => memory.status === requestedStatus)
        : state.memories;
      res.json({ memories });
    } catch {
      res.status(500).json({ error: 'Kernel memories are unavailable.' });
    }
  });

  router.post('/memories/candidates', async (req, res) => {
    try {
      res.status(201).json(await kernel.createMemoryCandidate(req.body));
    } catch (error) {
      res.status(400).json({ error: errorMessage(error) });
    }
  });

  router.post('/memories/:memoryId/promote', async (req, res) => {
    const reason = req.body?.reason as unknown;
    if (typeof reason !== 'string' || !reason.trim()) {
      res.status(400).json({ error: 'Memory promotion reason is required.' });
      return;
    }
    try {
      res.json(await kernel.promoteMemory(req.params.memoryId, reason.trim()));
    } catch (error) {
      const message = errorMessage(error);
      res.status(message === 'Memory not found.' ? 404 : 409).json({ error: message });
    }
  });

  router.post('/memories/:memoryId/revoke', async (req, res) => {
    const reason = req.body?.reason as unknown;
    if (typeof reason !== 'string' || !reason.trim()) {
      res.status(400).json({ error: 'Memory revocation reason is required.' });
      return;
    }
    try {
      res.json(await kernel.revokeMemory(req.params.memoryId, reason.trim()));
    } catch (error) {
      const message = errorMessage(error);
      res.status(message === 'Memory not found.' ? 404 : 409).json({ error: message });
    }
  });

  router.get('/skills', async (_req, res) => {
    try {
      const state = await kernel.getState();
      res.json({ skills: state.skillPackages, activations: state.skillActivations });
    } catch {
      res.status(500).json({ error: 'Kernel skills are unavailable.' });
    }
  });

  router.get('/skill-evaluations', async (_req, res) => {
    try {
      const state = await kernel.getState();
      res.json({ evaluations: state.skillEvaluations.map(getSkillEvaluationLedgerMetadata) });
    } catch {
      res.status(500).json({ error: 'Skill evaluations are unavailable.' });
    }
  });

  router.get('/skill-evaluation-suites', async (_req, res) => {
    try {
      const state = await kernel.getState();
      res.json({
        suites: (state.skillEvaluationSuites ?? []).map(getSkillEvaluationSuiteLedgerMetadata),
      });
    } catch {
      res.status(500).json({ error: 'Skill evaluation suites are unavailable.' });
    }
  });

  router.post('/skill-evaluation-suites', async (req, res) => {
    if (
      !req.body ||
      typeof req.body !== 'object' ||
      Object.keys(req.body).some((key) => key !== 'sourceId')
    ) {
      res.status(400).json({
        error: 'Raw oracle expectations and authority claims are not accepted; reference one evaluator source id.',
      });
      return;
    }
    try {
      const suite = await kernel.createSkillEvaluationSuite({ sourceId: req.body?.sourceId });
      res.status(201).json(getSkillEvaluationSuiteLedgerMetadata(suite));
    } catch (error) {
      const message = errorMessage(error);
      res.status(message.includes('unavailable') ? 503 : 400).json({ error: message });
    }
  });

  router.post('/skills/synthesize', async (req, res) => {
    if (
      Object.prototype.hasOwnProperty.call(req.body ?? {}, 'author') ||
      Object.prototype.hasOwnProperty.call(req.body ?? {}, 'authorPrincipalId') ||
      Object.prototype.hasOwnProperty.call(req.body ?? {}, 'evaluatorId')
    ) {
      res.status(400).json({ error: 'Caller-supplied skill author or evaluator authority is not accepted.' });
      return;
    }
    const principalId = options.skillAuthorPrincipal?.(req);
    if (!principalId?.trim()) {
      res.status(503).json({ error: 'Authenticated skill author authority is unavailable.' });
      return;
    }
    try {
      res.status(201).json(await kernel.synthesizeSkill({
        ...req.body,
        author: {
          authorityType: 'authenticated-principal-v1',
          principalId: principalId.trim(),
        },
      }));
    } catch (error) {
      res.status(400).json({ error: errorMessage(error) });
    }
  });

  router.post('/skills/:skillId/evaluate', async (req, res) => {
    try {
      const evaluation = await kernel.evaluateSkill(req.params.skillId);
      res.json(getSkillEvaluationLedgerMetadata(evaluation));
    } catch (error) {
      const message = errorMessage(error);
      res.status(message === 'Skill not found.' ? 404 : 409).json({ error: message });
    }
  });

  router.post('/skills/:skillId/canary', async (req, res) => {
    const maxRuns = req.body?.maxRuns as unknown;
    if (!Number.isInteger(maxRuns)) {
      res.status(400).json({ error: 'Canary maxRuns must be an integer.' });
      return;
    }
    try {
      res.json(await kernel.startSkillCanary(req.params.skillId, maxRuns as number));
    } catch (error) {
      const message = errorMessage(error);
      res.status(message.endsWith('not found.') ? 404 : 409).json({ error: message });
    }
  });

  router.post('/skills/:skillId/canary-runs', async (req, res) => {
    if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
      res.status(400).json({ error: 'Canary runs use a kernel-owned independent oracle and accept no caller oracle.' });
      return;
    }
    try {
      res.json(await kernel.runSkillCanary(req.params.skillId));
    } catch (error) {
      const message = errorMessage(error);
      res.status(message.endsWith('not found.') ? 404 : 409).json({ error: message });
    }
  });

  router.post('/skills/:skillId/promote', async (req, res) => {
    try {
      res.json(await kernel.promoteSkillPackage(req.params.skillId));
    } catch (error) {
      const message = errorMessage(error);
      res.status(message.endsWith('not found.') ? 404 : 409).json({ error: message });
    }
  });

  router.post('/skills/:skillId/rollback', async (req, res) => {
    const reason = req.body?.reason as unknown;
    if (typeof reason !== 'string' || !reason.trim()) {
      res.status(400).json({ error: 'Skill rollback reason is required.' });
      return;
    }
    try {
      res.json(await kernel.rollbackSkillPackage(req.params.skillId, reason.trim()));
    } catch (error) {
      const message = errorMessage(error);
      res.status(message.endsWith('not found.') ? 404 : 409).json({ error: message });
    }
  });

  router.post('/skills/:skillId/invoke', async (req, res) => {
    const input = req.body?.input as unknown;
    if (typeof input !== 'string') {
      res.status(400).json({ error: 'Skill input must be a string.' });
      return;
    }
    try {
      res.json({ output: await kernel.invokeSkill(req.params.skillId, input) });
    } catch (error) {
      const message = errorMessage(error);
      res.status(message === 'Skill not found.' ? 404 : 409).json({ error: message });
    }
  });

  router.get('/workers', (_req, res) => {
    res.json(kernel.getWorkers());
  });

  router.get('/diagnostics', async (_req, res) => {
    if (!options.diagnostics) {
      res.status(503).json({ error: 'Diagnostics are unavailable.' });
      return;
    }
    try {
      res.setHeader('cache-control', 'no-store');
      res.json(await diagnosticSnapshot());
    } catch {
      res.status(500).json({ error: 'The diagnostic snapshot could not be created.' });
    }
  });

  router.post('/diagnostics/support-bundle', async (_req, res) => {
    if (!options.diagnostics || !options.artifactStore) {
      res.status(503).json({ error: 'Diagnostic support-bundle export is unavailable.' });
      return;
    }
    try {
      const [snapshot, logs] = await Promise.all([
        diagnosticSnapshot(),
        options.diagnostics.logs?.() ?? [],
      ]);
      const bundle = createDiagnosticSupportBundle({ snapshot, logs, generatedAt: snapshot.generatedAt });
      const artifact = await kernel.createArtifact(bundle.content);
      res.status(201).set({
        'cache-control': 'no-store',
        'content-disposition': `attachment; filename="${bundle.fileName}"`,
        'content-type': `${bundle.contentType}; charset=utf-8`,
        'x-provenance-artifact-id': artifact.id,
        'x-provenance-artifact-sha256': artifact.contentHash,
      }).send(bundle.content);
    } catch {
      res.status(500).json({ error: 'The diagnostic support bundle could not be created.' });
    }
  });

  router.get('/artifacts', async (_req, res) => {
    try {
      res.json({ artifacts: await kernel.listArtifacts() });
    } catch {
      res.status(500).json({ error: 'Artifacts are unavailable.' });
    }
  });

  router.post('/desktop/typed-payloads', async (req, res) => {
    const content = req.body?.content as unknown;
    if (typeof content !== 'string' || content.length === 0) {
      res.status(400).json({ error: 'Desktop typing payload must be a non-empty string.' });
      return;
    }
    if (!options.desktopPayloadStore) {
      res.status(503).json({ error: 'Desktop typed-payload staging is unavailable.' });
      return;
    }
    try {
      // Only metadata crosses back to the cockpit. The content remains in the
      // process-local, consume-once store until the authorized worker resolves it.
      res.status(201).json(await options.desktopPayloadStore.stage(content));
    } catch (error) {
      const message = errorMessage(error);
      res.status(message.includes('typed-payload staging is unavailable') ? 503 : 400).json({ error: message });
    }
  });

  router.post('/artifacts', async (req, res) => {
    const content = req.body?.content as unknown;
    if (typeof content !== 'string' || content.length === 0) {
      res.status(400).json({ error: 'Artifact content must be a non-empty string.' });
      return;
    }
    try {
      res.status(201).json(await kernel.createArtifact(content));
    } catch (error) {
      const message = errorMessage(error);
      res.status(message.includes('unavailable') ? 503 : 400).json({ error: message });
    }
  });

  router.get('/automations', async (_req, res) => {
    try {
      const state = await kernel.getState();
      res.json({ automations: state.automations });
    } catch {
      res.status(500).json({ error: 'Kernel automations are unavailable.' });
    }
  });

  router.post('/automations', async (req, res) => {
    try {
      res.status(201).json(await kernel.createAutomation(req.body));
    } catch (error) {
      const message = errorMessage(error);
      res.status(message.endsWith('not found.') ? 404 : 400).json({ error: message });
    }
  });

  router.post('/automations/:automationId/enabled', async (req, res) => {
    const enabled = req.body?.enabled as unknown;
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'Automation enabled must be a boolean.' });
      return;
    }
    let reason: string;
    try {
      reason = requiredAuditReason(req.body?.reason, 'Automation state change reason');
    } catch (error) {
      res.status(400).json({ error: errorMessage(error) });
      return;
    }
    try {
      res.json(await kernel.setAutomationEnabled(req.params.automationId, enabled, reason));
    } catch (error) {
      const message = errorMessage(error);
      res.status(message === 'Automation not found.' ? 404 : 409).json({ error: message });
    }
  });

  router.post('/automations/:automationId/evaluate', async (req, res) => {
    try {
      res.json({ decision: await kernel.evaluateAutomation(req.params.automationId) });
    } catch (error) {
      const message = errorMessage(error);
      res.status(message === 'Automation not found.' ? 404 : 400).json({ error: message });
    }
  });

  router.post('/automations/:automationId/run', async (req, res) => {
    try {
      res.json(await kernel.runAutomation(req.params.automationId));
    } catch (error) {
      const message = errorMessage(error);
      const status = message.endsWith('not found.')
        ? 404
        : message.includes('disabled') || message.includes('Stop All') || message.includes('budget') ||
          message.includes('halted') || message.includes('in-flight') || message.includes('uncertain')
          ? 409 : 400;
      res.status(status).json({ error: message });
    }
  });

  router.get('/controls', async (_req, res) => {
    try {
      const state = await kernel.getState();
      res.json({ controls: state.controls });
    } catch {
      res.status(500).json({ error: 'Kernel controls are unavailable.' });
    }
  });

  router.post('/controls/stop-all', async (req, res) => {
    let reason: string;
    try {
      reason = requiredAuditReason(req.body?.reason, 'Stop All reason');
    } catch (error) {
      res.status(400).json({ error: errorMessage(error) });
      return;
    }
    try {
      res.json({ controls: await kernel.setStopAll(true, reason) });
    } catch (error) {
      res.status(409).json({ error: errorMessage(error) });
    }
  });

  router.post('/controls/resume', async (req, res) => {
    let reason: string;
    try {
      reason = requiredAuditReason(req.body?.reason, 'Resume reason');
    } catch (error) {
      res.status(400).json({ error: errorMessage(error) });
      return;
    }
    try {
      res.json({ controls: await kernel.setStopAll(false, reason) });
    } catch (error) {
      res.status(409).json({ error: errorMessage(error) });
    }
  });

  router.post('/recovery', async (_req, res) => {
    try {
      res.json(await kernel.recoverInterruptedTasks());
    } catch (error) {
      const message = errorMessage(error);
      res.status(message.includes('quiescent kernel') ? 409 : 500).json({ error: message });
    }
  });

  router.get('/release-proposals', async (_req, res) => {
    try {
      const state = await kernel.getState();
      res.json({ releaseProposals: state.releaseProposals });
    } catch {
      res.status(500).json({ error: 'Release proposals are unavailable.' });
    }
  });

  router.post('/release-proposals', async (req, res) => {
    try {
      res.status(201).json(await kernel.createReleaseProposal(req.body));
    } catch (error) {
      res.status(400).json({ error: errorMessage(error) });
    }
  });

  router.post('/release-proposals/:releaseId/activate', async (req, res) => {
    const artifactId = req.body?.artifactId as unknown;
    if (typeof artifactId !== 'string' || !artifactId.trim()) {
      res.status(400).json({ error: 'Release artifact id is required.' });
      return;
    }
    try {
      res.json(await kernel.activateReleaseProposal(req.params.releaseId, artifactId.trim()));
    } catch (error) {
      const message = errorMessage(error);
      res.status(message === 'Release proposal not found.' ? 404 : 409).json({ error: message });
    }
  });

  router.post('/release-proposals/:releaseId/reject', async (req, res) => {
    const reason = req.body?.reason as unknown;
    if (typeof reason !== 'string' || !reason.trim()) {
      res.status(400).json({ error: 'Release rejection reason is required.' });
      return;
    }
    try {
      res.json(await kernel.rejectRelease(req.params.releaseId, reason.trim()));
    } catch (error) {
      const message = errorMessage(error);
      res.status(message === 'Release proposal not found.' ? 404 : 409).json({ error: message });
    }
  });

  router.get('/benchmarks', async (_req, res) => {
    try {
      const state = await kernel.getState();
      res.json({ benchmarkRuns: state.benchmarkRuns });
    } catch {
      res.status(500).json({ error: 'Benchmark runs are unavailable.' });
    }
  });

  router.post('/benchmarks', async (req, res) => {
    const goalId = req.body?.goalId as unknown;
    if (typeof goalId !== 'string' || !goalId.trim()) {
      res.status(400).json({ error: 'Benchmark goalId is required.' });
      return;
    }
    try {
      res.status(201).json(await kernel.recordBenchmarkRun(goalId.trim()));
    } catch (error) {
      const message = errorMessage(error);
      res.status(message === 'Goal not found.' ? 404 : 409).json({ error: message });
    }
  });

  router.get('/runtime-report', async (_req, res) => {
    try {
      const state = await kernel.getState();
      const coreModel = options.coreModelStatus ? await options.coreModelStatus() : undefined;
      const secretVault = options.secretVaultStatus ? await options.secretVaultStatus() : undefined;
      const accessControl = options.accessControlStatus ? options.accessControlStatus() : undefined;
      const sandboxReport = options.sandbox ? sandboxStatus(options.sandbox) : undefined;
      const osSandbox = sandboxReport
        ? { status: sandboxReport.status, reason: sandboxReport.reason }
        : undefined;
      const releaseDeployment = options.releaseLifecycle
        ? (() => {
          const status = options.releaseLifecycle!.getProcessStatus();
          return status.activeReleaseId
            ? {
              status: 'available' as const,
              reason: `Supervised core release ${status.activeReleaseId} is active in process ${String(status.activePid)}.`,
            }
            : {
              status: 'configured' as const,
              reason: 'The signed core-release supervisor is installed; no release child is active.',
            };
        })()
        : undefined;
      const recurringResearchCapability = kernel.getRecurringResearchCapability();
      const recurringResearchSchedulerStatus = options.recurringResearchSchedulerStatus?.();
      res.json(buildRuntimeCapabilityReport({
        providerStatuses: options.providerStatuses ?? [],
        workerReport: kernel.getWorkers().report,
        stopAll: state.controls.stopAll,
        coreModel,
        releaseSigningConfigured: Boolean(options.releaseSigningPublicKey?.trim()),
        releaseDeployment,
        secretVault,
        accessControl,
        osSandbox,
        commandExecution: sandboxReport?.commandExecution,
        recurringResearchScheduler: {
          available: recurringResearchCapability.available,
          enabled: recurringResearchCapability.schedulerEnabled,
          running: recurringResearchSchedulerStatus?.running ?? false,
          tickInProgress: recurringResearchSchedulerStatus?.tickInProgress ?? false,
          tickIntervalMs: recurringResearchSchedulerStatus?.tickIntervalMs ?? recurringResearchCapability.tickIntervalMs,
          reason: recurringResearchCapability.reason,
          lastTickAt: recurringResearchSchedulerStatus?.lastTickAt,
          lastOutcome: recurringResearchSchedulerStatus?.lastOutcome,
          lastError: recurringResearchSchedulerStatus?.lastError,
        },
        desktopIpc: options.desktopIpcStatus?.(),
      }));
    } catch {
      res.status(500).json({ error: 'Runtime capability report is unavailable.' });
    }
  });

  return router;
};

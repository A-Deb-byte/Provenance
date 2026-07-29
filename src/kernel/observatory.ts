import type { AutomationContract, CapabilityAction, WorkerRegistration } from '../capabilities/types';
import type { ProviderPublicStatus } from '../providers/types';
import type {
  ApprovalRecord,
  BudgetUsage,
  GoalContract,
  KernelBudget,
  KernelControls,
  KernelEvent,
  KernelState,
  KernelTask,
  TaskStatus,
} from './types';

const MAX_GOALS = 24;
const MAX_TASKS = 60;
const MAX_ACTIVITIES = 100;
const MAX_APPROVALS = 100;
const MAX_CURRENT_WORK = 100;
const MAX_RUNTIME_ENTRIES = 64;
const MAX_DISPLAY_TEXT = 1_000;
const MAX_TARGET_TEXT = 2_048;
const MAX_IDENTIFIER_TEXT = 256;
const MAX_TYPE_TEXT = 128;
const SENSITIVE_ASSIGNMENT =
  /((?:authorization|auth|credential|api[_-]?key|password|secret|token)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/giu;
const BEARER_CREDENTIAL = /\bbearer\s+[a-z0-9._~+/=-]{8,}/giu;
const PREFIXED_CREDENTIAL =
  /\b(?:sk-(?:or-v1-)?[a-z0-9_-]{12,}|xox[baprs]-[a-z0-9-]{12,}|AKIA[A-Z0-9]{12,}|AIza[a-z0-9_-]{20,})\b/giu;
const JWT_CREDENTIAL = /\beyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\b/giu;

export type ObservatoryActivityStatus = 'running' | 'blocked' | 'succeeded' | 'failed' | 'uncertain' | 'info';

export interface ObservatorySurface {
  kind: 'browser' | 'desktop' | 'connector';
  action: string;
  primary: string;
  secondary?: string;
  url?: string;
}

export interface ObservatoryActivity {
  id: string;
  timestamp: string;
  type: string;
  actor: KernelEvent['actor'];
  entityId: string;
  entityType: KernelEvent['entityType'];
  status: ObservatoryActivityStatus;
  summary: string;
  goalId?: string;
  taskId?: string;
  approvalId?: string;
  automationId?: string;
  provider?: string;
  model?: string;
  routes?: Array<{ provider: string; model?: string }>;
  riskLevel?: string;
  surface?: ObservatorySurface;
}

export interface ObservatoryGoal {
  id: string;
  objective: string;
  status: GoalContract['status'];
  kind?: GoalContract['kind'];
  autonomyLevel: GoalContract['autonomyLevel'];
  updatedAt: string;
  budget: KernelBudget;
  usage: BudgetUsage;
  taskCounts: Partial<Record<TaskStatus, number>>;
  mission?: {
    id: string;
    status: string;
    stage?: string;
    sourceCount: number;
    capturedSourceCount: number;
    lastError?: string;
  };
}

export interface ObservatoryTask {
  id: string;
  goalId: string;
  title: string;
  description: string;
  status: KernelTask['status'];
  riskLevel: KernelTask['riskLevel'];
  capabilityFamily: KernelTask['capabilityFamily'];
  expectedEvidence: string;
  approvalId?: string;
  evidenceCount: number;
  updatedAt: string;
}

export interface ObservatoryWorkItem {
  id: string;
  kind: 'task' | 'mission' | 'automation' | 'provider' | 'recurring' | 'recovery';
  status: 'queued' | 'running' | 'awaiting_approval' | 'approved_waiting_execution' | 'blocked';
  title: string;
  detail: string;
  goalId?: string;
  taskId?: string;
  startedAt?: string;
  surface?: ObservatorySurface;
}

export interface ObservatoryApproval extends ApprovalRecord {
  actionSummary: string;
  surface?: ObservatorySurface;
}

export interface ObservatorySnapshot {
  schemaVersion: 1;
  generatedAt: string;
  ledgerHead: string | null;
  controls: KernelControls;
  counts: {
    goals: number;
    activeGoals: number;
    tasks: number;
    runningTasks: number;
    pendingApprovals: number;
    automations: number;
    enabledAutomations: number;
    recentEvents: number;
  };
  truncated: {
    goals: boolean;
    tasks: boolean;
    approvals: boolean;
    currentWork: boolean;
    activities: boolean;
    workers: boolean;
    providers: boolean;
  };
  goals: ObservatoryGoal[];
  tasks: ObservatoryTask[];
  approvals: ObservatoryApproval[];
  currentWork: ObservatoryWorkItem[];
  activities: ObservatoryActivity[];
  workers: Array<{
    id: string;
    family: WorkerRegistration['family'];
    availability: WorkerRegistration['availability'];
    supportedActions: WorkerRegistration['supportedActions'];
    lastSeenAt?: string;
    unavailableReason?: string;
  }>;
  providers: Array<{
    id: ProviderPublicStatus['id'];
    configured: boolean;
    defaultModel: string;
    capabilities: ProviderPublicStatus['capabilities'];
    unavailableReason?: string;
  }>;
}

export interface ObservatoryInput {
  state: KernelState;
  events: readonly KernelEvent[];
  workers: readonly WorkerRegistration[];
  providers?: readonly ProviderPublicStatus[];
  eventsTruncated?: boolean;
  activeRuntime?: ObservatoryActiveRuntime;
  now?: string;
}

export interface ObservatoryActiveProvider {
  id: string;
  goalId?: string;
  startedAt: string;
  routes: ReadonlyArray<{ provider: string; model?: string }>;
}

export interface ObservatoryActiveAction {
  id: string;
  kind: 'automation' | 'mission';
  goalId?: string;
  taskId?: string;
  automationId?: string;
  missionId?: string;
  startedAt: string;
  action: CapabilityAction;
}

export interface ObservatoryActiveRecurring {
  occurrenceId: string;
  scheduleId: string;
  goalId: string;
  missionId: string;
  startedAt: string;
}

export interface ObservatoryActiveRuntime {
  providers: readonly ObservatoryActiveProvider[];
  actions: readonly ObservatoryActiveAction[];
  recurring: readonly ObservatoryActiveRecurring[];
  recovery: {
    inProgress: boolean;
    startedAt?: string;
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const optionalText = (value: unknown): string | undefined => (
  typeof value === 'string' && value.trim() ? value.trim() : undefined
);

const redactSensitiveText = (value: string): string => value
  .replace(BEARER_CREDENTIAL, 'Bearer [REDACTED]')
  .replace(SENSITIVE_ASSIGNMENT, '$1[REDACTED]')
  .replace(PREFIXED_CREDENTIAL, '[REDACTED]')
  .replace(JWT_CREDENTIAL, '[REDACTED]');

const boundedText = (value: string, maxLength = MAX_DISPLAY_TEXT): string => {
  const redacted = redactSensitiveText(value);
  return redacted.length <= maxLength
    ? redacted
    : `${redacted.slice(0, Math.max(0, maxLength - 15))}... [truncated]`;
};

const boundedIdentifier = (value: string): string => boundedText(value, MAX_IDENTIFIER_TEXT);

const timestampValue = (value: string): number => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const newestFirst = <T extends { timestamp?: string; updatedAt?: string; createdAt?: string }>(
  left: T,
  right: T,
): number => timestampValue(right.timestamp ?? right.updatedAt ?? right.createdAt ?? '') -
  timestampValue(left.timestamp ?? left.updatedAt ?? left.createdAt ?? '');

const humanize = (value: string): string => value
  .replaceAll('.', ' ')
  .replaceAll('_', ' ')
  .replace(/\b\w/gu, (letter) => letter.toUpperCase());

const activityStatus = (type: string): ObservatoryActivityStatus => {
  if (type.endsWith('.started') || type.endsWith('_started')) return 'running';
  if (type.includes('uncertain')) return 'uncertain';
  if (
    type.includes('failed') ||
    type.includes('denied') ||
    type.includes('quarantined')
  ) return 'failed';
  if (
    type.includes('blocked') ||
    type.includes('interrupted') ||
    type === 'approval.requested' ||
    type === 'control.stop_all'
  ) return 'blocked';
  if (
    type.includes('completed') ||
    type.includes('passed') ||
    type.includes('published') ||
    type.includes('captured') ||
    type.includes('approved') ||
    type.includes('consumed') ||
    type.includes('resumed')
  ) return 'succeeded';
  return 'info';
};

const surfaceForAction = (action: CapabilityAction): ObservatorySurface => {
  if ('url' in action) {
    return {
      kind: 'browser',
      action: boundedText(action.type, MAX_TYPE_TEXT),
      primary: boundedText(action.url, MAX_TARGET_TEXT),
      secondary: boundedText('selector' in action ? action.selector : action.origin, MAX_TARGET_TEXT),
      url: boundedText(action.url, MAX_TARGET_TEXT),
    };
  }
  if ('appId' in action) {
    return {
      kind: 'desktop',
      action: boundedText(action.type, MAX_TYPE_TEXT),
      primary: boundedText(action.appId, MAX_TARGET_TEXT),
      secondary: 'windowId' in action
        ? boundedText(
          [action.windowId, 'nodeId' in action ? action.nodeId : undefined].filter(Boolean).join(' / '),
          MAX_TARGET_TEXT,
        )
        : undefined,
    };
  }
  return {
    kind: 'connector',
    action: boundedText(action.type, MAX_TYPE_TEXT),
    primary: boundedText(action.connectorId, MAX_TARGET_TEXT),
    secondary: boundedText(action.resourceId, MAX_TARGET_TEXT),
  };
};

const eventAutomation = (
  event: KernelEvent,
  automations: ReadonlyMap<string, AutomationContract>,
): AutomationContract | undefined => {
  const automationId = optionalText(event.payload.automationId) ??
    (event.entityType === 'automation' ? event.entityId : undefined);
  return automationId ? automations.get(automationId) : undefined;
};

const eventSurface = (
  event: KernelEvent,
  automations: ReadonlyMap<string, AutomationContract>,
  state: KernelState,
): ObservatorySurface | undefined => {
  const automation = eventAutomation(event, automations);
  if (automation) {
    const executionTypes = new Set([
      'automation.run_started',
      'automation.run_completed',
      'automation.run_failed',
      'automation.run_uncertain',
    ]);
    return executionTypes.has(event.type) ? surfaceForAction(automation.action) : undefined;
  }
  if (event.entityType !== 'mission' || !event.type.startsWith('mission.source_')) return undefined;
  const sourceId = optionalText(event.payload.sourceId);
  if (!sourceId) return undefined;
  const mission = state.goals.find((goal) => goal.research?.id === event.entityId)?.research;
  const source = mission?.sources.find((candidate) => candidate.id === sourceId);
  if (!source) return undefined;
  return {
    kind: 'browser',
    action: 'browser.inspect',
    primary: boundedText(source.url, MAX_TARGET_TEXT),
    secondary: boundedText(
      optionalText(event.payload.status) ?? humanize(event.type.replace('mission.source_', '')),
      MAX_TYPE_TEXT,
    ),
    url: boundedText(source.url, MAX_TARGET_TEXT),
  };
};

const providerSelections = (event: KernelEvent): Array<{ provider: string; model?: string }> => {
  if (!Array.isArray(event.payload.selections)) return [];
  return event.payload.selections.slice(0, 8).flatMap((selection) => {
    if (!isRecord(selection)) return [];
    const provider = optionalText(selection.provider);
    if (!provider) return [];
    return [{
      provider: boundedIdentifier(provider),
      model: optionalText(selection.model) ? boundedText(String(selection.model), 200) : undefined,
    }];
  });
};

const eventSummary = (
  event: KernelEvent,
  automations: ReadonlyMap<string, AutomationContract>,
): string => {
  const automation = eventAutomation(event, automations);
  const evidence = isRecord(event.payload.evidence) ? event.payload.evidence : undefined;
  const summary = optionalText(event.payload.summary) ??
    optionalText(evidence?.summary) ??
    optionalText(event.payload.reason);
  if (summary) return boundedText(summary);
  if (automation && event.type.startsWith('automation.')) {
    return boundedText(`${automation.name}: ${humanize(event.type)}`);
  }
  const selections = providerSelections(event);
  if (event.type === 'provider.call.started' && selections.length > 0) {
    const routes = selections.map((selection) => (
      `${selection.provider}${selection.model ? ` / ${selection.model}` : ''}`
    )).join(', ');
    return boundedText(`Provider call started with ${routes}.`);
  }
  return boundedText(humanize(event.type));
};

const projectActivities = (
  state: KernelState,
  events: readonly KernelEvent[],
  automations: ReadonlyMap<string, AutomationContract>,
): ObservatoryActivity[] => [...events]
  .slice(-MAX_ACTIVITIES)
  .reverse()
  .map((event) => {
    const automation = eventAutomation(event, automations);
    const selections = providerSelections(event);
    const selection = selections[0];
    return {
      id: boundedIdentifier(event.id),
      timestamp: event.timestamp,
      type: boundedText(event.type, MAX_TYPE_TEXT),
      actor: event.actor,
      entityId: boundedIdentifier(event.entityId),
      entityType: event.entityType,
      status: activityStatus(event.type),
      summary: eventSummary(event, automations),
      goalId: optionalText(event.payload.goalId)
        ? boundedIdentifier(String(event.payload.goalId))
        : undefined,
      taskId: optionalText(event.payload.taskId)
        ? boundedIdentifier(String(event.payload.taskId))
        : undefined,
      approvalId: optionalText(event.payload.approvalId)
        ? boundedIdentifier(String(event.payload.approvalId))
        : event.entityType === 'approval' ? boundedIdentifier(event.entityId) : undefined,
      automationId: automation ? boundedIdentifier(automation.id) : undefined,
      provider: selection?.provider,
      model: selection?.model,
      routes: selections.length > 0 ? selections : undefined,
      riskLevel: optionalText(event.payload.riskLevel)
        ? boundedText(String(event.payload.riskLevel), MAX_TYPE_TEXT)
        : optionalText(event.payload.risk)
          ? boundedText(String(event.payload.risk), MAX_TYPE_TEXT)
          : undefined,
      surface: eventSurface(event, automations, state),
    };
  });

const taskCounts = (goalId: string, tasks: readonly KernelTask[]): Partial<Record<TaskStatus, number>> => {
  const counts: Partial<Record<TaskStatus, number>> = {};
  for (const task of tasks) {
    if (task.goalId !== goalId) continue;
    counts[task.status] = (counts[task.status] ?? 0) + 1;
  }
  return counts;
};

const projectGoals = (state: KernelState): ObservatoryGoal[] => [...state.goals]
  .sort(newestFirst)
  .slice(0, MAX_GOALS)
  .map((goal) => ({
    id: boundedIdentifier(goal.id),
    objective: boundedText(goal.objective),
    status: goal.status,
    kind: goal.kind,
    autonomyLevel: goal.autonomyLevel,
    updatedAt: goal.updatedAt,
    budget: goal.budget,
    usage: goal.usage,
    taskCounts: taskCounts(goal.id, state.tasks),
    mission: goal.research
      ? {
        id: boundedIdentifier(goal.research.id),
        status: goal.research.status,
        stage: goal.research.activeStep?.stage,
        sourceCount: goal.research.sources.length,
        capturedSourceCount: goal.research.sources.filter((source) => source.status === 'captured').length,
        lastError: goal.research.lastError ? boundedText(goal.research.lastError) : undefined,
      }
      : undefined,
  }));

const projectTasks = (tasks: readonly KernelTask[]): ObservatoryTask[] => {
  const priority: Record<KernelTask['status'], number> = {
    running: 0,
    awaiting_approval: 1,
    blocked: 2,
    ready: 3,
    pending: 4,
    failed: 5,
    denied: 6,
    passed: 7,
    cancelled: 8,
  };
  return [...tasks]
    .sort((left, right) => priority[left.status] - priority[right.status] || newestFirst(left, right))
    .slice(0, MAX_TASKS)
    .map((task) => ({
      id: boundedIdentifier(task.id),
      goalId: boundedIdentifier(task.goalId),
      title: boundedText(task.title, 500),
      description: boundedText(task.description),
      status: task.status,
      riskLevel: task.riskLevel,
      capabilityFamily: task.capabilityFamily,
      expectedEvidence: boundedText(task.expectedEvidence),
      approvalId: task.approvalId ? boundedIdentifier(task.approvalId) : undefined,
      evidenceCount: task.evidenceEventIds.length,
      updatedAt: task.updatedAt,
    }));
};

interface CurrentWorkProjection {
  items: ObservatoryWorkItem[];
  truncated: boolean;
}

const approvalPriority = (approval: ApprovalRecord): number => approval.status === 'pending' ? 0 : 1;

const currentWork = (
  state: KernelState,
  automations: ReadonlyMap<string, AutomationContract>,
  activeRuntime: ObservatoryActiveRuntime,
): CurrentWorkProjection => {
  const work: ObservatoryWorkItem[] = [];
  const queuedApprovals = state.approvals
    .filter((candidate) => candidate.status === 'pending' || candidate.status === 'approved')
    .sort((left, right) => approvalPriority(left) - approvalPriority(right) || newestFirst(left, right));

  for (const approval of queuedApprovals.slice(0, MAX_APPROVALS)) {
    const automationId = approval.taskId.startsWith('automation:')
      ? approval.taskId.slice('automation:'.length)
      : undefined;
    const automation = automationId ? automations.get(automationId) : undefined;
    work.push({
      id: boundedIdentifier(approval.id),
      kind: automation ? 'automation' : 'task',
      status: approval.status === 'approved' ? 'approved_waiting_execution' : 'awaiting_approval',
      title: boundedText(automation?.name ?? approval.requestedAction, 500),
      detail: boundedText(automation ? humanize(automation.action.type) : approval.reason),
      goalId: boundedIdentifier(approval.goalId),
      taskId: boundedIdentifier(approval.taskId),
      startedAt: approval.createdAt,
      surface: automation ? surfaceForAction(automation.action) : undefined,
    });
  }

  const activeTasks = state.tasks
    .filter((task) => ['ready', 'running', 'awaiting_approval', 'blocked'].includes(task.status))
    .sort(newestFirst);
  for (const task of activeTasks.slice(0, MAX_CURRENT_WORK)) {
    if (work.some((item) => item.taskId === boundedIdentifier(task.id))) continue;
    work.push({
      id: boundedIdentifier(task.id),
      kind: 'task',
      status: task.status === 'ready'
        ? 'queued'
        : task.status === 'awaiting_approval'
          ? 'awaiting_approval'
          : task.status as 'running' | 'blocked',
      title: boundedText(task.title, 500),
      detail: boundedText(task.expectedEvidence),
      goalId: boundedIdentifier(task.goalId),
      taskId: boundedIdentifier(task.id),
      startedAt: task.status === 'running' ? task.updatedAt : undefined,
    });
  }

  for (const active of activeRuntime.actions.slice(0, MAX_RUNTIME_ENTRIES)) {
    const automation = active.automationId ? automations.get(active.automationId) : undefined;
    const task = active.taskId ? state.tasks.find((candidate) => candidate.id === active.taskId) : undefined;
    const goal = active.goalId ? state.goals.find((candidate) => candidate.id === active.goalId) : undefined;
    const existing = active.taskId
      ? work.find((item) => item.taskId === boundedIdentifier(active.taskId!))
      : undefined;
    const title = automation?.name ?? task?.title ?? goal?.research?.objective ?? goal?.objective ??
      humanize(active.action.type);
    const detail = active.kind === 'mission' && 'url' in active.action
      ? `Inspecting ${active.action.url}`
      : humanize(active.action.type);
    const projected = {
      id: boundedIdentifier(active.id),
      kind: active.kind,
      status: 'running' as const,
      title: boundedText(title, 500),
      detail: boundedText(detail),
      goalId: active.goalId ? boundedIdentifier(active.goalId) : undefined,
      taskId: active.taskId ? boundedIdentifier(active.taskId) : undefined,
      startedAt: active.startedAt,
      surface: surfaceForAction(active.action),
    };
    if (existing) Object.assign(existing, projected);
    else work.push(projected);
  }

  for (const active of activeRuntime.providers.slice(0, MAX_RUNTIME_ENTRIES)) {
    const routes = active.routes.slice(0, 8).map((route) => ({
      provider: boundedIdentifier(route.provider),
      model: route.model ? boundedText(route.model, 200) : undefined,
    }));
    work.push({
      id: boundedIdentifier(active.id),
      kind: 'provider',
      status: 'running',
      title: routes.length > 0
        ? boundedText(
          `Provider${routes.length > 1 ? ' ensemble' : ''}: ${routes.map((route) => route.provider).join(', ')}`,
          500,
        )
        : 'Provider call',
      detail: boundedText(
        routes.map((route) => route.model ?? route.provider).join(', ') ||
          'Model route selected by the kernel',
      ),
      goalId: active.goalId ? boundedIdentifier(active.goalId) : undefined,
      startedAt: active.startedAt,
    });
  }

  for (const active of activeRuntime.recurring.slice(0, MAX_RUNTIME_ENTRIES)) {
    const schedule = state.recurringResearch?.schedules.find((candidate) => (
      candidate.contract.id === active.scheduleId
    ));
    work.push({
      id: boundedIdentifier(active.occurrenceId),
      kind: 'recurring',
      status: 'running',
      title: boundedText(schedule?.contract.objective ?? 'Recurring research occurrence', 500),
      detail: boundedText(`Schedule ${active.scheduleId}; mission ${active.missionId}`),
      goalId: boundedIdentifier(active.goalId),
      startedAt: active.startedAt,
    });
  }

  if (activeRuntime.recovery.inProgress) {
    work.push({
      id: 'kernel-recovery',
      kind: 'recovery',
      status: 'running',
      title: 'Kernel recovery',
      detail: 'Reconciling interrupted work before new external dispatch.',
      startedAt: activeRuntime.recovery.startedAt,
    });
  }

  const workPriority: Record<ObservatoryWorkItem['status'], number> = {
    awaiting_approval: 0,
    approved_waiting_execution: 1,
    running: 2,
    blocked: 3,
    queued: 4,
  };
  const items = work.sort((left, right) => (
    workPriority[left.status] - workPriority[right.status] ||
    timestampValue(right.startedAt ?? '') - timestampValue(left.startedAt ?? '')
  ));
  return {
    items: items.slice(0, MAX_CURRENT_WORK),
    truncated: queuedApprovals.length > MAX_APPROVALS ||
      activeTasks.length > MAX_CURRENT_WORK ||
      activeRuntime.actions.length > MAX_RUNTIME_ENTRIES ||
      activeRuntime.providers.length > MAX_RUNTIME_ENTRIES ||
      activeRuntime.recurring.length > MAX_RUNTIME_ENTRIES ||
      items.length > MAX_CURRENT_WORK,
  };
};

export const buildObservatorySnapshot = ({
  state,
  events,
  workers,
  providers = [],
  eventsTruncated = false,
  activeRuntime = {
    providers: [],
    actions: [],
    recurring: [],
    recovery: { inProgress: false },
  },
  now = new Date().toISOString(),
}: ObservatoryInput): ObservatorySnapshot => {
  if ((events.at(-1)?.hash ?? null) !== state.lastEventHash) {
    throw new Error('Observatory state does not match the authenticated ledger head.');
  }
  const automations = new Map(state.automations.map((automation) => [automation.id, automation]));
  const approvalQueue = state.approvals
    .filter((approval) => approval.status === 'pending' || approval.status === 'approved')
    .sort((left, right) => approvalPriority(left) - approvalPriority(right) || newestFirst(left, right))
    .slice(0, MAX_APPROVALS)
    .map((approval): ObservatoryApproval => {
      const automationId = approval.taskId.startsWith('automation:')
        ? approval.taskId.slice('automation:'.length)
        : undefined;
      const automation = automationId ? automations.get(automationId) : undefined;
      const surface = automation ? surfaceForAction(automation.action) : undefined;
      return {
        id: boundedIdentifier(approval.id),
        goalId: boundedIdentifier(approval.goalId),
        taskId: boundedIdentifier(approval.taskId),
        status: approval.status,
        requestedAction: boundedText(approval.requestedAction, MAX_TARGET_TEXT),
        authorityBindingHash: approval.authorityBindingHash,
        riskLevel: approval.riskLevel,
        reason: boundedText(approval.reason),
        createdAt: approval.createdAt,
        updatedAt: approval.updatedAt,
        decidedAt: approval.decidedAt,
        decisionReason: approval.decisionReason ? boundedText(approval.decisionReason) : undefined,
        actionSummary: automation
          ? boundedText(`${humanize(automation.action.type)} on ${surface?.primary ?? automation.name}`)
          : boundedText(approval.requestedAction),
        surface,
      };
    });
  const activities = projectActivities(state, events, automations);
  const work = currentWork(state, automations, activeRuntime);
  return {
    schemaVersion: 1,
    generatedAt: now,
    ledgerHead: state.lastEventHash,
    controls: {
      stopAll: state.controls.stopAll,
      stopAllReason: state.controls.stopAllReason
        ? boundedText(state.controls.stopAllReason)
        : undefined,
      updatedAt: state.controls.updatedAt,
    },
    counts: {
      goals: state.goals.length,
      activeGoals: state.goals.filter((goal) => ['drafted', 'active', 'blocked'].includes(goal.status)).length,
      tasks: state.tasks.length,
      runningTasks: state.tasks.filter((task) => task.status === 'running').length,
      pendingApprovals: state.approvals.filter((approval) => approval.status === 'pending').length,
      automations: state.automations.length,
      enabledAutomations: state.automations.filter((automation) => automation.enabled).length,
      recentEvents: activities.length,
    },
    truncated: {
      goals: state.goals.length > MAX_GOALS,
      tasks: state.tasks.length > MAX_TASKS,
      approvals: state.approvals.filter((approval) => (
        approval.status === 'pending' || approval.status === 'approved'
      )).length > MAX_APPROVALS,
      currentWork: work.truncated,
      activities: eventsTruncated || events.length > MAX_ACTIVITIES,
      workers: workers.length > MAX_RUNTIME_ENTRIES,
      providers: providers.length > MAX_RUNTIME_ENTRIES,
    },
    goals: projectGoals(state),
    tasks: projectTasks(state.tasks),
    approvals: approvalQueue,
    currentWork: work.items,
    activities,
    workers: workers.slice(0, MAX_RUNTIME_ENTRIES).map((worker) => ({
      id: boundedIdentifier(worker.id),
      family: worker.family,
      availability: worker.availability,
      supportedActions: worker.supportedActions.slice(0, MAX_RUNTIME_ENTRIES),
      lastSeenAt: worker.lastSeenAt,
      unavailableReason: worker.unavailableReason ? boundedText(worker.unavailableReason) : undefined,
    })),
    providers: providers.slice(0, MAX_RUNTIME_ENTRIES).map((provider) => ({
      id: provider.id,
      configured: provider.configured,
      defaultModel: boundedText(provider.defaultModel, 200),
      capabilities: provider.capabilities.slice(0, MAX_RUNTIME_ENTRIES),
      unavailableReason: provider.unavailableReason ? boundedText(provider.unavailableReason) : undefined,
    })),
  };
};

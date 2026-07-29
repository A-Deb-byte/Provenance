import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppWindow,
  Eye,
  MonitorCog,
  MousePointer2,
  Play,
  RefreshCw,
  ShieldCheck,
  Type as TypeIcon,
} from 'lucide-react';
import { authenticatedFetch, getAuthSession, subscribeAuth } from '../lib/auth';

type DesktopActionType = 'desktop.discover' | 'desktop.inspect' | 'desktop.click' | 'desktop.type';
type ActiveAction = 'discover' | 'inspect' | 'click' | 'type' | 'approve' | 'deny' | 'execute' | null;

interface DesktopScopeProjection {
  family: 'desktop';
  operations: DesktopActionType[];
  appId: string;
  windowId?: string;
  treeRevision?: string;
}

interface DesktopWorkerProjection {
  id: string;
  availability: 'available' | 'configured' | 'unavailable';
  supportedActions: DesktopActionType[];
  configuredScopes: DesktopScopeProjection[];
  unavailableReason?: string;
}

interface GoalProjection {
  id: string;
  objective: string;
  status: string;
  budget: { maxOperations: number; maxApprovals: number };
  usage: { operations: number; approvals: number };
}

interface AutomationProjection {
  id: string;
  name: string;
  enabled: boolean;
  goalId: string;
  workerId: string;
  riskLevel: string;
  action: Record<string, unknown> & { type: string };
  scope: Record<string, unknown>;
  createdAt: string;
}

interface ApprovalProjection {
  id: string;
  goalId: string;
  taskId: string;
  status: 'pending' | 'approved' | 'consumed' | 'denied' | 'expired' | 'cancelled';
  requestedAction: string;
  riskLevel: string;
  reason: string;
  createdAt: string;
  decisionReason?: string;
}

interface EventProjection {
  id: string;
  timestamp: string;
  type: string;
  entityId: string;
  payload: Record<string, unknown>;
}

interface RuntimeFeatureProjection {
  status: 'available' | 'configured' | 'unavailable' | 'blocked';
  reason: string;
}

interface RuntimeProjection {
  features: Record<string, RuntimeFeatureProjection>;
}

interface DesktopWindowProjection {
  windowId: string;
  title: string;
  treeRevision: string;
}

interface DesktopNodeProjection {
  nodeId: string;
  role: string;
  name: string;
  enabled: boolean;
  focusable: boolean;
  focused: boolean;
  bounds?: { x: number; y: number; width: number; height: number };
}

interface DesktopTreeProjection {
  schemaVersion: 1;
  kind: 'desktop.tree';
  appId: string;
  windowId: string;
  treeRevision: string;
  nodes: DesktopNodeProjection[];
}

interface AutomationRunProjection {
  decision: { kind: 'allow' | 'approval_required' | 'deny'; reason?: string };
  approvalId?: string;
  dispatch?: { status: 'succeeded' | 'failed' | 'uncertain'; summary: string; errorCode?: string };
  content?: string;
}

interface DesktopPayloadProjection {
  id: string;
  contentHash: string;
}

interface AppOption {
  key: string;
  workerId: string;
  appId: string;
  operations: DesktopActionType[];
}

const desktopActionTypes = new Set<DesktopActionType>([
  'desktop.discover',
  'desktop.inspect',
  'desktop.click',
  'desktop.type',
]);
const approvalStatuses = new Set<ApprovalProjection['status']>([
  'pending', 'approved', 'consumed', 'denied', 'expired', 'cancelled',
]);

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);
const isText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const isNonNegativeInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

const responsePayload = async (response: Response): Promise<unknown> => {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
};

class ApiRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

const isUnauthorized = (error: unknown): error is ApiRequestError => (
  error instanceof ApiRequestError && error.status === 401
);

const requestJson = async (url: string, init?: RequestInit): Promise<unknown> => {
  const response = await authenticatedFetch(url, init);
  const payload = await responsePayload(response);
  if (!response.ok) {
    const message = isRecord(payload) && typeof payload.error === 'string'
      ? payload.error
      : `Request failed with status ${response.status}.`;
    throw new ApiRequestError(message, response.status);
  }
  return payload;
};

const parseDesktopScope = (value: unknown): DesktopScopeProjection => {
  if (!isRecord(value) || value.family !== 'desktop' || !isText(value.appId) || !Array.isArray(value.operations)) {
    throw new Error('Desktop worker scope is invalid.');
  }
  const operations = value.operations.filter((operation): operation is DesktopActionType => (
    typeof operation === 'string' && desktopActionTypes.has(operation as DesktopActionType)
  ));
  if (operations.length === 0 || operations.length !== value.operations.length) {
    throw new Error('Desktop worker scope operations are invalid.');
  }
  if (value.windowId !== undefined && !isText(value.windowId)) throw new Error('Desktop window scope is invalid.');
  if (value.treeRevision !== undefined && !isText(value.treeRevision)) throw new Error('Desktop tree scope is invalid.');
  return {
    family: 'desktop',
    operations,
    appId: value.appId,
    ...(typeof value.windowId === 'string' ? { windowId: value.windowId } : {}),
    ...(typeof value.treeRevision === 'string' ? { treeRevision: value.treeRevision } : {}),
  };
};

const parseWorkers = (payload: unknown): DesktopWorkerProjection[] => {
  if (!isRecord(payload) || !Array.isArray(payload.workers)) throw new Error('Desktop worker response is invalid.');
  return payload.workers.flatMap((value): DesktopWorkerProjection[] => {
    if (!isRecord(value) || value.family !== 'desktop') return [];
    if (!isText(value.id) || !['available', 'configured', 'unavailable'].includes(String(value.availability)) ||
        !Array.isArray(value.supportedActions) || !Array.isArray(value.configuredScopes)) {
      throw new Error('Desktop worker registration is invalid.');
    }
    const supportedActions = value.supportedActions.filter((action): action is DesktopActionType => (
      typeof action === 'string' && desktopActionTypes.has(action as DesktopActionType)
    ));
    if (supportedActions.length === 0) return [];
    return [{
      id: value.id,
      availability: value.availability as DesktopWorkerProjection['availability'],
      supportedActions,
      configuredScopes: value.configuredScopes.map(parseDesktopScope),
      ...(typeof value.unavailableReason === 'string' ? { unavailableReason: value.unavailableReason } : {}),
    }];
  });
};

const parseGoals = (payload: unknown): GoalProjection[] => {
  if (!isRecord(payload) || !Array.isArray(payload.goals)) throw new Error('Desktop goal response is invalid.');
  return payload.goals.map((value) => {
    if (!isRecord(value) || !isText(value.id) || !isText(value.objective) || !isText(value.status) ||
        !isRecord(value.budget) || !isRecord(value.usage) ||
        !isNonNegativeInteger(value.budget.maxOperations) || !isNonNegativeInteger(value.budget.maxApprovals) ||
        !isNonNegativeInteger(value.usage.operations) || !isNonNegativeInteger(value.usage.approvals)) {
      throw new Error('Desktop goal record is invalid.');
    }
    return {
      id: value.id,
      objective: value.objective,
      status: value.status,
      budget: { maxOperations: value.budget.maxOperations, maxApprovals: value.budget.maxApprovals },
      usage: { operations: value.usage.operations, approvals: value.usage.approvals },
    };
  });
};

const parseAutomation = (value: unknown): AutomationProjection => {
  if (!isRecord(value) || !isText(value.id) || !isText(value.name) || typeof value.enabled !== 'boolean' ||
      !isText(value.goalId) || !isText(value.workerId) || !isText(value.riskLevel) ||
      !isRecord(value.action) || !isText(value.action.type) || !isRecord(value.scope) || !isText(value.createdAt)) {
    throw new Error('Desktop automation record is invalid.');
  }
  return {
    id: value.id,
    name: value.name,
    enabled: value.enabled,
    goalId: value.goalId,
    workerId: value.workerId,
    riskLevel: value.riskLevel,
    action: value.action as AutomationProjection['action'],
    scope: value.scope,
    createdAt: value.createdAt,
  };
};

const parseAutomations = (payload: unknown): AutomationProjection[] => {
  if (!isRecord(payload) || !Array.isArray(payload.automations)) throw new Error('Desktop automation response is invalid.');
  return payload.automations.map(parseAutomation);
};

const parseApproval = (value: unknown): ApprovalProjection => {
  if (!isRecord(value) || !isText(value.id) || !isText(value.goalId) || !isText(value.taskId) ||
      typeof value.status !== 'string' || !approvalStatuses.has(value.status as ApprovalProjection['status']) ||
      !isText(value.requestedAction) || !isText(value.riskLevel) || !isText(value.reason) || !isText(value.createdAt)) {
    throw new Error('Desktop approval record is invalid.');
  }
  return {
    id: value.id,
    goalId: value.goalId,
    taskId: value.taskId,
    status: value.status as ApprovalProjection['status'],
    requestedAction: value.requestedAction,
    riskLevel: value.riskLevel,
    reason: value.reason,
    createdAt: value.createdAt,
    ...(typeof value.decisionReason === 'string' ? { decisionReason: value.decisionReason } : {}),
  };
};

const parseApprovals = (payload: unknown): ApprovalProjection[] => {
  if (!isRecord(payload) || !Array.isArray(payload.approvals)) throw new Error('Desktop approval response is invalid.');
  return payload.approvals.map(parseApproval);
};

const parseEvents = (payload: unknown): EventProjection[] => {
  if (!isRecord(payload) || !Array.isArray(payload.events)) throw new Error('Desktop event response is invalid.');
  return payload.events.map((value) => {
    if (!isRecord(value) || !isText(value.id) || !isText(value.timestamp) || !isText(value.type) ||
        !isText(value.entityId) || !isRecord(value.payload)) {
      throw new Error('Desktop event record is invalid.');
    }
    return { id: value.id, timestamp: value.timestamp, type: value.type, entityId: value.entityId, payload: value.payload };
  });
};

const parseRuntime = (payload: unknown): RuntimeProjection => {
  if (!isRecord(payload) || !isRecord(payload.features)) throw new Error('Desktop runtime report is invalid.');
  const features: Record<string, RuntimeFeatureProjection> = {};
  for (const [key, value] of Object.entries(payload.features)) {
    if (!isRecord(value) || !['available', 'configured', 'unavailable', 'blocked'].includes(String(value.status)) ||
        typeof value.reason !== 'string') {
      throw new Error('Desktop runtime feature is invalid.');
    }
    features[key] = { status: value.status as RuntimeFeatureProjection['status'], reason: value.reason };
  }
  return { features };
};

const parseRunOutcome = (value: unknown): AutomationRunProjection => {
  if (!isRecord(value) || !isRecord(value.decision) ||
      !['allow', 'approval_required', 'deny'].includes(String(value.decision.kind))) {
    throw new Error('Desktop automation run response is invalid.');
  }
  let dispatch: AutomationRunProjection['dispatch'];
  if (value.dispatch !== undefined) {
    if (!isRecord(value.dispatch) || !['succeeded', 'failed', 'uncertain'].includes(String(value.dispatch.status)) ||
        typeof value.dispatch.summary !== 'string') {
      throw new Error('Desktop worker dispatch response is invalid.');
    }
    dispatch = {
      status: value.dispatch.status as 'succeeded' | 'failed' | 'uncertain',
      summary: value.dispatch.summary,
      ...(typeof value.dispatch.errorCode === 'string' ? { errorCode: value.dispatch.errorCode } : {}),
    };
  }
  return {
    decision: {
      kind: value.decision.kind as AutomationRunProjection['decision']['kind'],
      ...(typeof value.decision.reason === 'string' ? { reason: value.decision.reason } : {}),
    },
    ...(typeof value.approvalId === 'string' ? { approvalId: value.approvalId } : {}),
    ...(dispatch ? { dispatch } : {}),
    ...(typeof value.content === 'string' ? { content: value.content } : {}),
  };
};

const parseDesktopPayload = (value: unknown): DesktopPayloadProjection => {
  if (!isRecord(value) || !/^artifact_[A-Za-z0-9-]+$/u.test(String(value.id)) || typeof value.contentHash !== 'string' || !/^[a-f0-9]{64}$/u.test(value.contentHash)) {
    throw new Error('Desktop typed-payload staging response is invalid.');
  }
  return { id: String(value.id), contentHash: value.contentHash };
};

const parseWindows = (content: string, expectedAppId: string): DesktopWindowProjection[] => {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error('Desktop discovery returned invalid JSON.');
  }
  if (!isRecord(value) || value.schemaVersion !== 1 || value.kind !== 'desktop.windows' ||
      value.appId !== expectedAppId || !Array.isArray(value.windows)) {
    throw new Error('Desktop discovery response schema is invalid.');
  }
  const windows = value.windows.map((window) => {
    if (!isRecord(window) || !isText(window.windowId) || typeof window.title !== 'string' || !isText(window.treeRevision)) {
      throw new Error('Desktop discovery window record is invalid.');
    }
    return { windowId: window.windowId, title: window.title, treeRevision: window.treeRevision };
  });
  if (new Set(windows.map((window) => window.windowId)).size !== windows.length) {
    throw new Error('Desktop discovery returned duplicate window identifiers.');
  }
  return windows;
};

const parseBounds = (value: unknown): DesktopNodeProjection['bounds'] => {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !['x', 'y', 'width', 'height'].every((key) => Number.isFinite(value[key]))) {
    throw new Error('Desktop control bounds are invalid.');
  }
  return {
    x: value.x as number,
    y: value.y as number,
    width: value.width as number,
    height: value.height as number,
  };
};

const parseTree = (content: string, expectedAppId: string, expectedWindowId: string): DesktopTreeProjection => {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error('Desktop inspection returned invalid JSON.');
  }
  if (!isRecord(value) || value.schemaVersion !== 1 || value.kind !== 'desktop.tree' ||
      value.appId !== expectedAppId || value.windowId !== expectedWindowId ||
      !isText(value.treeRevision) || !Array.isArray(value.nodes)) {
    throw new Error('Desktop inspection response schema is invalid.');
  }
  const nodes = value.nodes.map((node) => {
    if (!isRecord(node) || !isText(node.nodeId) || !isText(node.role) || typeof node.name !== 'string' ||
        typeof node.enabled !== 'boolean' || typeof node.focusable !== 'boolean' || typeof node.focused !== 'boolean') {
      throw new Error('Desktop control record is invalid.');
    }
    const bounds = parseBounds(node.bounds);
    return {
      nodeId: node.nodeId,
      role: node.role,
      name: node.name,
      enabled: node.enabled,
      focusable: node.focusable,
      focused: node.focused,
      ...(bounds ? { bounds } : {}),
    };
  });
  if (new Set(nodes.map((node) => node.nodeId)).size !== nodes.length) {
    throw new Error('Desktop inspection returned duplicate control identifiers.');
  }
  return {
    schemaVersion: 1,
    kind: 'desktop.tree',
    appId: value.appId,
    windowId: value.windowId,
    treeRevision: value.treeRevision,
    nodes,
  };
};

const eventSummary = (event: EventProjection): string => {
  if (typeof event.payload.summary === 'string') return event.payload.summary;
  if (typeof event.payload.reason === 'string') return event.payload.reason;
  return event.type.replaceAll('.', ' ');
};

const shortId = (value: string): string => value.length > 20 ? `${value.slice(0, 17)}...` : value;

export const DesktopPanel: React.FC = () => {
  const [workers, setWorkers] = useState<DesktopWorkerProjection[]>([]);
  const [goals, setGoals] = useState<GoalProjection[]>([]);
  const [automations, setAutomations] = useState<AutomationProjection[]>([]);
  const [approvals, setApprovals] = useState<ApprovalProjection[]>([]);
  const [events, setEvents] = useState<EventProjection[]>([]);
  const [runtime, setRuntime] = useState<RuntimeProjection | null>(null);
  const [selectedAppKey, setSelectedAppKey] = useState('');
  const [selectedGoalId, setSelectedGoalId] = useState('');
  const [windows, setWindows] = useState<DesktopWindowProjection[]>([]);
  const [selectedWindowId, setSelectedWindowId] = useState('');
  const [tree, setTree] = useState<DesktopTreeProjection | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState('');
  const [selectedActionAutomationId, setSelectedActionAutomationId] = useState('');
  const [auditReason, setAuditReason] = useState('');
  const [approvalReason, setApprovalReason] = useState('');
  const [typePayload, setTypePayload] = useState('');
  const [lastPayload, setLastPayload] = useState<DesktopPayloadProjection | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionWarning, setActionWarning] = useState<string | null>(null);
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const [activeAction, setActiveAction] = useState<ActiveAction>(null);
  const [authRevision, setAuthRevision] = useState(0);
  const [session, setSession] = useState(() => getAuthSession());
  const authEpoch = useRef(0);
  const observationAuthority = useRef('');

  const clearObservedState = useCallback(() => {
    setWindows([]);
    setSelectedWindowId('');
    setTree(null);
    setSelectedNodeId('');
  }, []);

  const clearProtectedState = useCallback(() => {
    setWorkers([]);
    setGoals([]);
    setAutomations([]);
    setApprovals([]);
    setEvents([]);
    setRuntime(null);
    setSelectedAppKey('');
    setSelectedGoalId('');
    clearObservedState();
    setSelectedActionAutomationId('');
    setAuditReason('');
    setApprovalReason('');
    setTypePayload('');
    setLastPayload(null);
    setIsLoading(false);
    setLoadError(null);
    setActionError(null);
    setActionWarning(null);
    setActionStatus(null);
    setActiveAction(null);
  }, [clearObservedState]);

  const clearForUnauthorized = useCallback((error: unknown): boolean => {
    if (!isUnauthorized(error)) return false;
    authEpoch.current += 1;
    clearProtectedState();
    return true;
  }, [clearProtectedState]);

  useEffect(() => subscribeAuth(() => {
    authEpoch.current += 1;
    clearProtectedState();
    setSession(getAuthSession());
    setAuthRevision((revision) => revision + 1);
  }), [clearProtectedState]);

  const loadProjection = useCallback(async (epoch: number, signal?: AbortSignal): Promise<void> => {
    const requestOptions = signal ? { signal } : undefined;
    const [workerPayload, goalPayload, automationPayload, approvalPayload, eventPayload, runtimePayload] = await Promise.all([
      requestJson('/api/kernel/workers', requestOptions),
      requestJson('/api/kernel/goals', requestOptions),
      requestJson('/api/kernel/automations', requestOptions),
      requestJson('/api/kernel/approvals', requestOptions),
      requestJson('/api/kernel/events', requestOptions),
      requestJson('/api/kernel/runtime-report', requestOptions),
    ]);
    const nextWorkers = parseWorkers(workerPayload);
    const nextGoals = parseGoals(goalPayload);
    const nextAutomations = parseAutomations(automationPayload);
    const nextApprovals = parseApprovals(approvalPayload);
    const nextEvents = parseEvents(eventPayload);
    const nextRuntime = parseRuntime(runtimePayload);
    if (epoch !== authEpoch.current) return;
    setWorkers(nextWorkers);
    setGoals(nextGoals);
    setAutomations(nextAutomations);
    setApprovals(nextApprovals);
    setEvents(nextEvents);
    setRuntime(nextRuntime);
    setLoadError(null);
  }, []);

  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let activeController: AbortController | null = null;
    const epoch = authEpoch.current;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      if (!disposed && epoch === authEpoch.current) setIsLoading(true);
      const controller = new AbortController();
      activeController = controller;
      const timeout = window.setTimeout(() => controller.abort(), 10_000);
      try {
        await loadProjection(epoch, controller.signal);
      } catch (error) {
        const unauthorized = clearForUnauthorized(error);
        if (!disposed && !unauthorized && epoch === authEpoch.current) {
          clearObservedState();
          setLoadError(error instanceof Error ? error.message : 'Desktop cockpit state is unavailable.');
        }
      } finally {
        window.clearTimeout(timeout);
        if (activeController === controller) activeController = null;
        inFlight = false;
        if (!disposed && epoch === authEpoch.current) setIsLoading(false);
      }
    };
    setIsLoading(true);
    void load();
    const interval = window.setInterval(() => void load(), 5_000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
      activeController?.abort();
    };
  }, [authRevision, clearForUnauthorized, clearObservedState, loadProjection]);

  const appOptions = useMemo(() => {
    const merged = new Map<string, AppOption>();
    for (const worker of workers) {
      if (worker.availability !== 'available') continue;
      for (const scope of worker.configuredScopes) {
        const key = `${worker.id}\u0000${scope.appId}`;
        const current = merged.get(key);
        const operations = scope.operations.filter((operation) => worker.supportedActions.includes(operation));
        merged.set(key, {
          key,
          workerId: worker.id,
          appId: scope.appId,
          operations: [...new Set([...(current?.operations ?? []), ...operations])],
        });
      }
    }
    return [...merged.values()].sort((left, right) => left.appId.localeCompare(right.appId));
  }, [workers]);

  const eligibleGoals = useMemo(() => goals.filter((goal) => (
    !['completed', 'failed', 'cancelled'].includes(goal.status) &&
    goal.usage.operations < goal.budget.maxOperations
  )), [goals]);

  useEffect(() => {
    setSelectedAppKey((current) => appOptions.some((option) => option.key === current) ? current : appOptions[0]?.key ?? '');
  }, [appOptions]);

  useEffect(() => {
    setSelectedGoalId((current) => eligibleGoals.some((goal) => goal.id === current) ? current : eligibleGoals[0]?.id ?? '');
  }, [eligibleGoals]);

  const desktopAutomations = useMemo(() => automations.filter((automation) => (
    desktopActionTypes.has(automation.action.type as DesktopActionType)
  )), [automations]);

  const mutationAutomations = useMemo(() => desktopAutomations
    .filter((automation) => automation.action.type === 'desktop.click' || automation.action.type === 'desktop.type')
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)), [desktopAutomations]);

  useEffect(() => {
    setSelectedActionAutomationId((current) => {
      if (mutationAutomations.some((automation) => automation.id === current)) return current;
      const actionable = mutationAutomations.find((automation) => {
        const approval = approvals.find((candidate) => candidate.taskId === `automation:${automation.id}`);
        return approval?.status === 'pending' || approval?.status === 'approved';
      });
      return actionable?.id ?? mutationAutomations[0]?.id ?? '';
    });
  }, [approvals, mutationAutomations]);

  const selectedApp = appOptions.find((option) => option.key === selectedAppKey) ?? null;
  const selectedGoal = eligibleGoals.find((goal) => goal.id === selectedGoalId) ?? null;
  const selectedWindow = windows.find((window) => window.windowId === selectedWindowId) ?? null;
  const selectedNode = tree?.nodes.find((node) => node.nodeId === selectedNodeId) ?? null;
  const selectedActionAutomation = mutationAutomations.find((automation) => automation.id === selectedActionAutomationId) ?? null;
  const selectedApproval = selectedActionAutomation
    ? approvals.find((approval) => approval.taskId === `automation:${selectedActionAutomation.id}`) ?? null
    : null;
  const isViewer = session?.role === 'viewer';
  const desktopRuntime = runtime?.features.desktopAutomation ?? runtime?.features.desktopIpc;
  const runtimeBlocked = desktopRuntime?.status === 'blocked';
  const desktopAvailable = appOptions.length > 0 && desktopRuntime?.status === 'available';
  const canMutate = desktopAvailable && !runtimeBlocked && !isViewer && !isLoading &&
    loadError === null && activeAction === null;
  const observationAuthorityKey = selectedApp && desktopRuntime?.status === 'available'
    ? `${selectedApp.key}\u0000${[...selectedApp.operations].sort().join(',')}`
    : '';

  useEffect(() => {
    const previous = observationAuthority.current;
    observationAuthority.current = observationAuthorityKey;
    if (!previous || previous === observationAuthorityKey) return;
    clearObservedState();
    if (session) {
      setActionWarning('Desktop authority changed. Previous windows and controls were discarded; discover them again.');
    }
  }, [clearObservedState, observationAuthorityKey, session]);

  const refreshProjection = async (epoch: number): Promise<void> => {
    if (epoch === authEpoch.current) setIsLoading(true);
    try {
      await loadProjection(epoch);
    } catch (error) {
      const unauthorized = clearForUnauthorized(error);
      if (!unauthorized && epoch === authEpoch.current) {
        clearObservedState();
        setLoadError(error instanceof Error ? error.message : 'Desktop cockpit refresh failed.');
      }
    } finally {
      if (epoch === authEpoch.current) setIsLoading(false);
    }
  };

  const createEnableRun = async (
    name: string,
    riskLevel: 'L0' | 'L2',
    action: Record<string, unknown> & { type: DesktopActionType },
    scope: DesktopScopeProjection,
    reason: string,
  ): Promise<{ automation: AutomationProjection; outcome: AutomationRunProjection }> => {
    const created = parseAutomation(await requestJson('/api/kernel/automations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name,
        goalId: selectedGoal!.id,
        workerId: selectedApp!.workerId,
        riskLevel,
        action,
        scope,
        trigger: { type: 'manual' },
        approvalMode: 'per_run',
        budget: { maxRuns: 1, maxConsecutiveFailures: 1, maxRuntimeMsPerRun: 30_000 },
      }),
    }));
    parseAutomation(await requestJson(`/api/kernel/automations/${encodeURIComponent(created.id)}/enabled`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, reason }),
    }));
    const outcome = parseRunOutcome(await requestJson(`/api/kernel/automations/${encodeURIComponent(created.id)}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }));
    return { automation: created, outcome };
  };

  const requireActionContext = (operation: DesktopActionType): { reason: string; epoch: number } | undefined => {
    setActionError(null);
    setActionWarning(null);
    setActionStatus(null);
    const reason = auditReason.trim();
    if (!selectedApp || !selectedGoal) {
      setActionError('Select an available desktop application and a bounded kernel goal.');
      return undefined;
    }
    if (!selectedApp.operations.includes(operation)) {
      setActionError(`${operation} is outside the selected worker scope.`);
      return undefined;
    }
    if (!reason) {
      setActionError('Desktop action reason is required.');
      return undefined;
    }
    return { reason, epoch: authEpoch.current };
  };

  const discoverWindows = async () => {
    if (!canMutate) return;
    const context = requireActionContext('desktop.discover');
    if (!context || !selectedApp) return;
    setActiveAction('discover');
    try {
      const { outcome } = await createEnableRun(
        `Discover windows for ${selectedApp.appId}`,
        'L0',
        { type: 'desktop.discover', appId: selectedApp.appId },
        { family: 'desktop', operations: ['desktop.discover'], appId: selectedApp.appId },
        context.reason,
      );
      if (outcome.decision.kind !== 'allow' || outcome.dispatch?.status !== 'succeeded' || outcome.content === undefined) {
        throw new Error(outcome.dispatch?.summary ?? outcome.decision.reason ?? 'Desktop discovery was not executed.');
      }
      const nextWindows = parseWindows(outcome.content, selectedApp.appId);
      if (context.epoch !== authEpoch.current) return;
      setWindows(nextWindows);
      setSelectedWindowId(nextWindows[0]?.windowId ?? '');
      setTree(null);
      setSelectedNodeId('');
      setActionStatus(`Recorded ${nextWindows.length} window${nextWindows.length === 1 ? '' : 's'} from the desktop worker.`);
      await refreshProjection(context.epoch);
    } catch (error) {
      clearForUnauthorized(error);
      if (context.epoch === authEpoch.current) setActionError(error instanceof Error ? error.message : 'Desktop discovery failed.');
    } finally {
      if (context.epoch === authEpoch.current) setActiveAction(null);
    }
  };

  const inspectWindow = async () => {
    if (!canMutate) return;
    const context = requireActionContext('desktop.inspect');
    if (!context || !selectedApp || !selectedWindow) {
      if (!selectedWindow) setActionError('Select a discovered window before inspecting controls.');
      return;
    }
    setActiveAction('inspect');
    try {
      const action = {
        type: 'desktop.inspect' as const,
        appId: selectedApp.appId,
        windowId: selectedWindow.windowId,
        treeRevision: selectedWindow.treeRevision,
      };
      const scope: DesktopScopeProjection = {
        family: 'desktop',
        operations: ['desktop.inspect'],
        appId: selectedApp.appId,
        windowId: selectedWindow.windowId,
        treeRevision: selectedWindow.treeRevision,
      };
      const { outcome } = await createEnableRun(
        `Inspect controls in ${selectedWindow.title || selectedWindow.windowId}`,
        'L0',
        action,
        scope,
        context.reason,
      );
      if (outcome.decision.kind !== 'allow' || outcome.dispatch?.status !== 'succeeded' || outcome.content === undefined) {
        throw new Error(outcome.dispatch?.summary ?? outcome.decision.reason ?? 'Desktop inspection was not executed.');
      }
      const nextTree = parseTree(outcome.content, selectedApp.appId, selectedWindow.windowId);
      if (context.epoch !== authEpoch.current) return;
      setTree(nextTree);
      setSelectedNodeId(nextTree.nodes[0]?.nodeId ?? '');
      setWindows((current) => current.map((window) => window.windowId === nextTree.windowId
        ? { ...window, treeRevision: nextTree.treeRevision }
        : window));
      setActionStatus(`Recorded ${nextTree.nodes.length} controls at tree revision ${nextTree.treeRevision}.`);
      await refreshProjection(context.epoch);
    } catch (error) {
      clearForUnauthorized(error);
      if (context.epoch === authEpoch.current) setActionError(error instanceof Error ? error.message : 'Desktop inspection failed.');
    } finally {
      if (context.epoch === authEpoch.current) setActiveAction(null);
    }
  };

  const requestMutation = async (kind: 'click' | 'type') => {
    if (!canMutate) return;
    const operation: DesktopActionType = kind === 'click' ? 'desktop.click' : 'desktop.type';
    const context = requireActionContext(operation);
    if (!context || !selectedApp || !selectedGoal || !tree || !selectedNode) {
      if (!tree || !selectedNode) setActionError('Inspect and select a control before requesting an action.');
      return;
    }
    if (!selectedNode.enabled) {
      setActionError('The selected control is disabled. Refresh the control tree before acting.');
      return;
    }
    if (selectedGoal.usage.approvals >= selectedGoal.budget.maxApprovals) {
      setActionError('The selected goal has no remaining approval budget.');
      return;
    }
    if (kind === 'type' && (!typePayload || typePayload.length > 4_096)) {
      setActionError('Desktop typing payload must contain 1-4096 characters.');
      return;
    }
    setActiveAction(kind);
    try {
      let payload: DesktopPayloadProjection | undefined;
      if (kind === 'type') {
        payload = parseDesktopPayload(await requestJson('/api/kernel/desktop/typed-payloads', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: typePayload }),
        }));
        if (context.epoch !== authEpoch.current) return;
        setLastPayload(payload);
      }
      const action = {
        type: operation,
        appId: tree.appId,
        windowId: tree.windowId,
        treeRevision: tree.treeRevision,
        nodeId: selectedNode.nodeId,
        ...(payload ? { payloadArtifactId: payload.id, payloadHash: payload.contentHash } : {}),
      };
      const scope: DesktopScopeProjection = {
        family: 'desktop',
        operations: [operation],
        appId: tree.appId,
        windowId: tree.windowId,
        treeRevision: tree.treeRevision,
      };
      const { automation, outcome } = await createEnableRun(
        `${kind === 'click' ? 'Click' : 'Type into'} ${selectedNode.role} ${selectedNode.name || selectedNode.nodeId}`,
        'L2',
        action,
        scope,
        context.reason,
      );
      if (outcome.decision.kind !== 'approval_required' || !outcome.approvalId || outcome.dispatch) {
        throw new Error('Desktop mutation did not stop at the required L2 approval gate.');
      }
      if (context.epoch !== authEpoch.current) return;
      setSelectedActionAutomationId(automation.id);
      setTypePayload('');
      setActionStatus(`${kind === 'click' ? 'Click' : 'Type'} request is awaiting explicit approval.`);
      await refreshProjection(context.epoch);
    } catch (error) {
      clearForUnauthorized(error);
      if (context.epoch === authEpoch.current) setActionError(error instanceof Error ? error.message : 'Desktop action request failed.');
    } finally {
      if (context.epoch === authEpoch.current) setActiveAction(null);
    }
  };

  const decideSelectedApproval = async (status: 'approved' | 'denied') => {
    if (!canMutate || !selectedApproval || selectedApproval.status !== 'pending') return;
    const reason = approvalReason.trim();
    if (!reason) {
      setActionError('Approval decision reason is required.');
      return;
    }
    const epoch = authEpoch.current;
    setActiveAction(status === 'approved' ? 'approve' : 'deny');
    setActionError(null);
    setActionWarning(null);
    setActionStatus(null);
    try {
      const decided = parseApproval(await requestJson(`/api/kernel/approvals/${encodeURIComponent(selectedApproval.id)}/decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status, reason }),
      }));
      if (epoch !== authEpoch.current) return;
      setApprovals((current) => current.map((approval) => approval.id === decided.id ? decided : approval));
      setApprovalReason('');
      setActionStatus(status === 'approved'
        ? 'Approval recorded. Execution remains blocked until Execute approved action is selected.'
        : 'Desktop action denied and will not execute.');
      await refreshProjection(epoch);
    } catch (error) {
      clearForUnauthorized(error);
      if (epoch === authEpoch.current) setActionError(error instanceof Error ? error.message : 'Approval decision failed.');
    } finally {
      if (epoch === authEpoch.current) setActiveAction(null);
    }
  };

  const executeApprovedAction = async () => {
    if (!canMutate || !selectedActionAutomation || selectedApproval?.status !== 'approved') return;
    const epoch = authEpoch.current;
    setActiveAction('execute');
    setActionError(null);
    setActionWarning(null);
    setActionStatus(null);
    try {
      const outcome = parseRunOutcome(await requestJson(`/api/kernel/automations/${encodeURIComponent(selectedActionAutomation.id)}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }));
      if (outcome.decision.kind === 'allow' && outcome.dispatch?.status === 'uncertain') {
        if (epoch !== authEpoch.current) return;
        setActionWarning(
          `Outcome uncertain: ${outcome.dispatch.summary} The action may have executed. Do not retry it; discover the window and inspect a fresh control tree.`,
        );
        clearObservedState();
        await refreshProjection(epoch);
        return;
      }
      if (outcome.decision.kind !== 'allow' || outcome.dispatch?.status !== 'succeeded') {
        throw new Error(outcome.dispatch?.summary ?? outcome.decision.reason ?? 'Approved desktop action did not execute.');
      }
      if (epoch !== authEpoch.current) return;
      setActionStatus(`Desktop action completed: ${outcome.dispatch.summary}`);
      clearObservedState();
      await refreshProjection(epoch);
    } catch (error) {
      clearForUnauthorized(error);
      if (epoch === authEpoch.current) setActionError(error instanceof Error ? error.message : 'Approved desktop action failed.');
    } finally {
      if (epoch === authEpoch.current) setActiveAction(null);
    }
  };

  const desktopAutomationIds = new Set(desktopAutomations.map((automation) => automation.id));
  const desktopEvents = [...events]
    .filter((event) => desktopAutomationIds.has(String(event.payload.automationId ?? event.entityId)))
    .sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp))
    .slice(0, 8);

  const availabilityReason = runtimeBlocked
    ? desktopRuntime?.reason
    : appOptions.length === 0
      ? workers.find((worker) => worker.unavailableReason)?.unavailableReason ?? 'No available desktop worker exposes an allowlisted application.'
      : desktopRuntime?.reason ?? 'A desktop worker and allowlisted application scope are available.';

  return (
    <section aria-labelledby="desktop-panel-title" className="rounded-3xl border border-slate-800 bg-[#101114]/90 p-5 shadow-2xl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-mono font-bold uppercase tracking-[0.35em] text-sky-400">Native Desktop Worker</p>
          <h2 id="desktop-panel-title" className="mt-1 text-xl font-black tracking-tight text-white">Windows UI Automation Cockpit</h2>
          <p className="mt-2 max-w-3xl text-xs leading-relaxed text-slate-400">
            Discover and inspect allowlisted windows through recorded L0 worker runs. Clicks and typing are L2 requests that cannot execute until their exact approval is recorded and explicitly consumed.
          </p>
        </div>
        <span className={`rounded-full border px-3 py-1 text-[10px] font-mono ${
          runtimeBlocked
            ? 'border-rose-900 bg-rose-950/20 text-rose-300'
            : desktopAvailable
              ? 'border-emerald-800 bg-emerald-950/20 text-emerald-300'
              : 'border-amber-800 bg-amber-950/20 text-amber-300'
        }`}>
          {runtimeBlocked ? 'Desktop blocked' : desktopAvailable ? 'Desktop available' : 'Desktop unavailable'}
        </span>
      </div>

      {isLoading && <p role="status" className="mt-4 rounded-lg border border-sky-900/50 bg-sky-950/20 px-3 py-2 text-xs text-sky-300">Loading desktop authority...</p>}
      {loadError && <p role="alert" className="mt-4 rounded-lg border border-rose-900/60 bg-rose-950/20 px-3 py-2 text-xs text-rose-300">Desktop cockpit unavailable: {loadError}</p>}
      {actionError && <p role="alert" className="mt-4 rounded-lg border border-rose-900/60 bg-rose-950/20 px-3 py-2 text-xs text-rose-300">{actionError}</p>}
      {actionWarning && <p role="alert" className="mt-4 rounded-lg border border-amber-800/70 bg-amber-950/25 px-3 py-2 text-xs text-amber-200">{actionWarning}</p>}
      {actionStatus && <p role="status" className="mt-4 rounded-lg border border-emerald-900/60 bg-emerald-950/20 px-3 py-2 text-xs text-emerald-300">{actionStatus}</p>}
      {!isLoading && availabilityReason && <p className="mt-4 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2 text-xs text-slate-400">{availabilityReason}</p>}
      {isViewer && <p className="mt-4 rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2 text-xs text-slate-300">Viewer sessions can inspect recorded desktop state but cannot discover, inspect live controls, approve, or execute actions.</p>}

      <div className="mt-5 grid grid-cols-1 gap-4 xl:grid-cols-[0.8fr_1.2fr]">
        <div className="space-y-4">
          <div className="rounded-2xl border border-slate-800 bg-black/20 p-4">
            <div className="flex items-center gap-2 text-sm font-bold text-slate-100"><MonitorCog size={14} className="text-sky-400" /> Scoped Runtime</div>
            <div className="mt-3 space-y-3">
              <label className="block text-[9px] uppercase tracking-wider text-slate-500">Allowed desktop application
                <select aria-label="Allowed desktop application" value={selectedAppKey} onChange={(event) => {
                  setSelectedAppKey(event.target.value);
                  setWindows([]);
                  setSelectedWindowId('');
                  setTree(null);
                  setSelectedNodeId('');
                }} disabled={appOptions.length === 0 || activeAction !== null} className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-950 p-2 text-xs normal-case text-slate-200 disabled:opacity-50">
                  {appOptions.length === 0 && <option value="">No allowlisted applications</option>}
                  {appOptions.map((option) => <option key={option.key} value={option.key}>{option.appId}</option>)}
                </select>
              </label>
              <label className="block text-[9px] uppercase tracking-wider text-slate-500">Bounded kernel goal
                <select aria-label="Desktop goal" value={selectedGoalId} onChange={(event) => setSelectedGoalId(event.target.value)} disabled={eligibleGoals.length === 0 || activeAction !== null} className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-950 p-2 text-xs normal-case text-slate-200 disabled:opacity-50">
                  {eligibleGoals.length === 0 && <option value="">No eligible goals</option>}
                  {eligibleGoals.map((goal) => <option key={goal.id} value={goal.id}>{goal.objective}</option>)}
                </select>
              </label>
              <label className="block text-[9px] uppercase tracking-wider text-slate-500">Desktop action reason
                <input aria-label="Desktop action reason" value={auditReason} onChange={(event) => setAuditReason(event.target.value)} disabled={!canMutate} className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-950 p-2 text-xs normal-case text-slate-200 disabled:opacity-50" />
              </label>
              <button type="button" onClick={() => void discoverWindows()} disabled={!canMutate || !selectedApp?.operations.includes('desktop.discover') || !selectedGoal || !auditReason.trim()} className="inline-flex items-center gap-1.5 rounded-lg border border-sky-800 bg-sky-950/20 px-3 py-2 text-xs font-bold text-sky-200 disabled:opacity-40">
                <RefreshCw size={12} className={activeAction === 'discover' ? 'animate-spin' : ''} /> {activeAction === 'discover' ? 'Discovering...' : 'Discover windows'}
              </button>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-black/20 p-4">
            <div className="flex items-center justify-between gap-2"><div className="flex items-center gap-2 text-sm font-bold text-slate-100"><AppWindow size={14} className="text-cyan-400" /> Recorded Windows</div><span className="text-[9px] font-mono text-slate-500">{windows.length}</span></div>
            <div className="mt-3 space-y-2">
              {windows.length === 0 && <p className="rounded-xl border border-dashed border-slate-800 p-4 text-center text-xs text-slate-500">No window discovery result in this authenticated view.</p>}
              {windows.map((window) => <button key={window.windowId} type="button" data-testid={`desktop-window-${window.windowId}`} onClick={() => {
                setSelectedWindowId(window.windowId);
                setTree(null);
                setSelectedNodeId('');
              }} className={`w-full rounded-xl border p-3 text-left ${selectedWindowId === window.windowId ? 'border-cyan-700 bg-cyan-950/20' : 'border-slate-800 bg-slate-950/30'}`}>
                <div className="text-xs font-bold text-slate-200">{window.title || 'Untitled window'}</div>
                <div className="mt-1 break-all font-mono text-[9px] text-slate-500">{window.windowId} / {window.treeRevision}</div>
              </button>)}
            </div>
            <button type="button" onClick={() => void inspectWindow()} disabled={!canMutate || !selectedWindow || !selectedGoal || !auditReason.trim() || !selectedApp?.operations.includes('desktop.inspect')} className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-cyan-800 px-3 py-2 text-xs font-bold text-cyan-200 disabled:opacity-40">
              <Eye size={12} /> {activeAction === 'inspect' ? 'Inspecting...' : 'Inspect controls'}
            </button>
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-2xl border border-slate-800 bg-black/20 p-4">
            <div className="flex items-center justify-between gap-2"><div className="text-sm font-bold text-slate-100">Recorded Control Tree</div><span className="text-[9px] font-mono text-slate-500">{tree ? `${tree.nodes.length} / ${tree.treeRevision}` : 'Not inspected'}</span></div>
            <div className="mt-3 max-h-72 space-y-2 overflow-y-auto">
              {!tree && <p className="rounded-xl border border-dashed border-slate-800 p-5 text-center text-xs text-slate-500">Inspect a discovered window to obtain a revision-bound control tree.</p>}
              {tree?.nodes.map((node) => <button key={node.nodeId} type="button" data-testid={`desktop-node-${node.nodeId}`} onClick={() => setSelectedNodeId(node.nodeId)} className={`w-full rounded-xl border p-3 text-left ${selectedNodeId === node.nodeId ? 'border-sky-700 bg-sky-950/20' : 'border-slate-800 bg-slate-950/30'}`}>
                <div className="flex items-start justify-between gap-2"><div><div className="text-xs font-bold text-slate-200">{node.name || 'Unnamed control'}</div><div className="mt-1 font-mono text-[9px] text-slate-500">{node.role} / {shortId(node.nodeId)}</div></div><span className={`rounded-full border px-2 py-0.5 text-[8px] uppercase ${node.enabled ? 'border-emerald-900 text-emerald-300' : 'border-slate-700 text-slate-500'}`}>{node.enabled ? 'enabled' : 'disabled'}</span></div>
                <div className="mt-2 text-[9px] text-slate-600">{node.focused ? 'Focused' : node.focusable ? 'Focusable' : 'Not focusable'}{node.bounds ? ` / ${node.bounds.width}x${node.bounds.height}` : ''}</div>
              </button>)}
            </div>

            {selectedNode && <div className="mt-4 rounded-xl border border-sky-900/50 bg-sky-950/10 p-3">
              <div className="text-xs font-bold text-sky-200">Selected: {selectedNode.name || selectedNode.nodeId}</div>
              <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                <button type="button" onClick={() => void requestMutation('click')} disabled={!canMutate || !selectedGoal || !auditReason.trim() || !selectedApp?.operations.includes('desktop.click') || !selectedNode.enabled} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-amber-800 px-3 py-2 text-xs font-bold text-amber-200 disabled:opacity-40"><MousePointer2 size={12} /> Request click approval</button>
                <div className="space-y-2">
                  <textarea aria-label="Desktop typing payload" value={typePayload} onChange={(event) => setTypePayload(event.target.value)} maxLength={4_096} rows={3} disabled={!canMutate || !selectedApp?.operations.includes('desktop.type')} className="w-full rounded-lg border border-slate-800 bg-slate-950 p-2 text-xs text-slate-200 disabled:opacity-50" />
                  <button type="button" onClick={() => void requestMutation('type')} disabled={!canMutate || !selectedGoal || !auditReason.trim() || !selectedApp?.operations.includes('desktop.type') || !selectedNode.enabled || typePayload.length === 0} className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-amber-800 px-3 py-2 text-xs font-bold text-amber-200 disabled:opacity-40"><TypeIcon size={12} /> Request type approval</button>
                </div>
              </div>
              {lastPayload && <div className="mt-2 break-all font-mono text-[9px] text-slate-600">Last staged payload: {lastPayload.id} / {lastPayload.contentHash}</div>}
            </div>}
          </div>

          <div className="rounded-2xl border border-slate-800 bg-black/20 p-4">
            <div className="flex items-center gap-2 text-sm font-bold text-slate-100"><ShieldCheck size={14} className="text-amber-400" /> Approval And Execution</div>
            {mutationAutomations.length === 0 && <p className="mt-3 text-xs text-slate-500">No desktop mutation requests recorded.</p>}
            {mutationAutomations.length > 0 && <>
              <label className="mt-3 block text-[9px] uppercase tracking-wider text-slate-500">Desktop action request
                <select aria-label="Desktop action request" value={selectedActionAutomationId} onChange={(event) => setSelectedActionAutomationId(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-950 p-2 text-xs normal-case text-slate-200">
                  {mutationAutomations.map((automation) => <option key={automation.id} value={automation.id}>{automation.name}</option>)}
                </select>
              </label>
              {selectedActionAutomation && <div className="mt-3 rounded-xl border border-amber-900/40 bg-amber-950/10 p-3">
                <div className="flex items-start justify-between gap-2"><div><div className="text-xs font-bold text-slate-200">{selectedActionAutomation.name}</div><div className="mt-1 font-mono text-[9px] text-slate-500">{selectedActionAutomation.action.type} / {selectedActionAutomation.id}</div></div><span className="rounded-full border border-amber-800 px-2 py-0.5 text-[9px] uppercase text-amber-300">{selectedApproval?.status ?? 'loading'}</span></div>
                {selectedApproval?.status === 'pending' && <>
                  <p className="mt-2 text-[10px] text-slate-400">{selectedApproval.reason}</p>
                  <label className="mt-3 block text-[9px] uppercase tracking-wider text-slate-500">Approval decision reason
                    <input aria-label="Approval decision reason" value={approvalReason} onChange={(event) => setApprovalReason(event.target.value)} disabled={!canMutate} className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-950 p-2 text-xs normal-case text-slate-200 disabled:opacity-50" />
                  </label>
                  <div className="mt-2 flex flex-wrap gap-2"><button type="button" onClick={() => void decideSelectedApproval('approved')} disabled={!canMutate} className="rounded-lg border border-emerald-800 px-3 py-2 text-xs font-bold text-emerald-200 disabled:opacity-40">Approve action</button><button type="button" onClick={() => void decideSelectedApproval('denied')} disabled={!canMutate} className="rounded-lg border border-rose-900 px-3 py-2 text-xs font-bold text-rose-300 disabled:opacity-40">Deny action</button></div>
                </>}
                {selectedApproval?.status === 'approved' && <div className="mt-3"><p className="text-[10px] text-amber-200">Approval is recorded, but no I/O occurs until the action is explicitly executed.</p><button type="button" onClick={() => void executeApprovedAction()} disabled={!canMutate} className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-amber-700 bg-amber-950/20 px-3 py-2 text-xs font-bold text-amber-200 disabled:opacity-40"><Play size={12} /> Execute approved action</button></div>}
                {selectedApproval && !['pending', 'approved'].includes(selectedApproval.status) && <p className="mt-3 text-[10px] text-slate-400">This request is terminal: {selectedApproval.status}. It cannot execute again.</p>}
              </div>}
            </>}
          </div>

          <div className="rounded-2xl border border-slate-800 bg-black/20 p-4">
            <div className="text-sm font-bold text-slate-100">Desktop Evidence</div>
            <div className="mt-3 space-y-2">
              {desktopEvents.length === 0 && <p className="text-xs text-slate-500">No desktop automation evidence recorded.</p>}
              {desktopEvents.map((event) => <div key={event.id} className="rounded-lg border border-slate-800 bg-slate-950/40 p-2.5"><div className="text-xs text-slate-300">{eventSummary(event)}</div><div className="mt-1 text-[9px] uppercase tracking-wider text-slate-600">{event.type} / {new Date(event.timestamp).toLocaleString()}</div></div>)}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleStop,
  Clock3,
  Database,
  Globe2,
  Monitor,
  Play,
  Plug,
  RefreshCw,
  Server,
  ShieldCheck,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import type {
  ObservatoryActivity,
  ObservatoryApproval,
  ObservatoryGoal,
  ObservatorySnapshot,
  ObservatorySurface,
  ObservatoryWorkItem,
} from '../kernel/observatory';
import {
  authenticatedFetch,
  getAuthSession,
  subscribeAuth,
} from '../lib/auth';

const POLL_INTERVAL_MS = 5_000;
const REQUEST_TIMEOUT_MS = 8_000;
const MUTATION_TIMEOUT_MS = 15_000;
const GOAL_PREVIEW_LIMIT = 4;
const WORK_PREVIEW_LIMIT = 8;
const APPROVAL_PREVIEW_LIMIT = 6;
const ACTIVITY_PREVIEW_LIMIT = 16;

interface AgentObservatoryProps {
  className?: string;
  closeButtonRef?: React.Ref<HTMLButtonElement>;
  drawerOpen?: boolean;
  enabled?: boolean;
  onClose?: () => void;
}

type MutationKind = 'control' | `approval:${string}`;
type ControlAction = 'stop' | 'resume';

interface ControlDraft {
  action: ControlAction;
  reason: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const trapDrawerFocus = (event: React.KeyboardEvent<HTMLElement>): void => {
  if (event.key !== 'Tab') return;
  const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )) as HTMLElement[];
  const visibleFocusable = focusable.filter(
    (element) => !element.hasAttribute('hidden') && element.getAttribute('aria-hidden') !== 'true',
  );
  if (visibleFocusable.length === 0) {
    event.preventDefault();
    return;
  }
  const first = visibleFocusable[0];
  const last = visibleFocusable[visibleFocusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
};

const isText = (value: unknown): value is string => (
  typeof value === 'string' && value.trim().length > 0
);

const hasFiniteNumbers = (value: unknown, keys: readonly string[]): boolean => (
  isRecord(value) && keys.every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]))
);

const isObservatorySnapshot = (value: unknown): value is ObservatorySnapshot => {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isText(value.generatedAt) ||
      !isRecord(value.controls) || typeof value.controls.stopAll !== 'boolean' ||
      !isRecord(value.counts) || !Array.isArray(value.goals) || !Array.isArray(value.tasks) ||
      !isRecord(value.truncated) ||
      !Array.isArray(value.approvals) || !Array.isArray(value.currentWork) ||
      !Array.isArray(value.activities) || !Array.isArray(value.workers) ||
      !Array.isArray(value.providers)) {
    return false;
  }
  return value.goals.every((goal) => (
    isRecord(goal) && isText(goal.id) && isText(goal.objective) && isText(goal.status) &&
    isText(goal.autonomyLevel) && isText(goal.updatedAt) &&
    hasFiniteNumbers(goal.budget, ['maxOperations', 'maxCommandRuntimeMs', 'maxApprovals', 'maxProviderCalls']) &&
    hasFiniteNumbers(goal.usage, ['operations', 'commandRuntimeMs', 'approvals', 'providerCalls']) &&
    isRecord(goal.taskCounts)
  )) && value.approvals.every((approval) => (
    isRecord(approval) && isText(approval.id) && isText(approval.actionSummary) &&
    (approval.status === 'pending' || approval.status === 'approved')
  )) && value.activities.every((activity) => (
    isRecord(activity) && isText(activity.id) && isText(activity.timestamp) &&
    isText(activity.type) && isText(activity.summary)
  )) && value.currentWork.every((work) => (
    isRecord(work) && isText(work.id) && isText(work.title) && isText(work.detail)
  ));
};

const readResponseError = async (response: Response, fallback: string): Promise<string> => {
  try {
    const value: unknown = await response.json();
    return isRecord(value) && typeof value.error === 'string' ? value.error : fallback;
  } catch {
    return fallback;
  }
};

const timeLabel = (timestamp: string): string => {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return 'Unknown time';
  const elapsedSeconds = Math.max(0, Math.round((Date.now() - parsed) / 1_000));
  if (elapsedSeconds < 10) return 'just now';
  if (elapsedSeconds < 60) return `${elapsedSeconds}s ago`;
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(parsed).toLocaleDateString();
};

const absoluteTimeLabel = (timestamp: string): string => {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : 'Unknown time';
};

const humanize = (value: string): string => value
  .replaceAll('.', ' ')
  .replaceAll('_', ' ')
  .replace(/\b\w/gu, (letter) => letter.toUpperCase());

const formatDuration = (milliseconds: number): string => {
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  const seconds = milliseconds / 1_000;
  if (seconds < 60) return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
  const minutes = seconds / 60;
  return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)}m`;
};

const surfaceIcon = (surface: ObservatorySurface) => {
  if (surface.kind === 'browser') return Globe2;
  if (surface.kind === 'desktop') return Monitor;
  return Plug;
};

const statusClasses: Record<ObservatoryActivity['status'], string> = {
  running: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300',
  blocked: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  succeeded: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
  failed: 'border-rose-500/40 bg-rose-500/10 text-rose-300',
  uncertain: 'border-orange-500/40 bg-orange-500/10 text-orange-300',
  info: 'border-slate-700 bg-slate-800/50 text-slate-300',
};

const workClasses: Record<ObservatoryWorkItem['status'], string> = {
  queued: 'text-slate-400 bg-slate-800/60',
  running: 'text-cyan-300 bg-cyan-500/10',
  awaiting_approval: 'text-amber-300 bg-amber-500/10',
  approved_waiting_execution: 'text-emerald-300 bg-emerald-500/10',
  blocked: 'text-rose-300 bg-rose-500/10',
};

const Section: React.FC<{
  title: string;
  count?: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}> = ({ title, count, defaultOpen = true, children }) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-b border-slate-800/80">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-white/[0.025]"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-300">
          {title}
          {count !== undefined && (
            <span className="rounded-full border border-slate-700 bg-slate-900 px-2 py-0.5 text-[10px] text-slate-400">
              {count}
            </span>
          )}
        </span>
        {open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
      </button>
      {open && <div className="px-4 pb-4">{children}</div>}
    </section>
  );
};

const ShowAllToggle: React.FC<{
  expanded: boolean;
  noun: string;
  previewLimit: number;
  total: number;
  onToggle: () => void;
}> = ({ expanded, noun, previewLimit, total, onToggle }) => {
  if (total <= previewLimit) return null;
  return (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={onToggle}
      className="mt-3 w-full rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-xs font-semibold text-slate-300 hover:border-cyan-500/40 hover:text-cyan-200"
    >
      {expanded ? `Show first ${previewLimit} ${noun}` : `Show all ${total} loaded ${noun}`}
    </button>
  );
};

const BudgetMetric: React.FC<{
  label: string;
  used: number;
  limit: number;
  format?: (value: number) => string;
}> = ({ label, used, limit, format = (value) => String(value) }) => {
  const ratio = limit > 0 ? Math.min(1, Math.max(0, used / limit)) : used > 0 ? 1 : 0;
  return (
    <div
      className="rounded-lg border border-slate-800 bg-slate-950/60 p-2.5"
      aria-label={`${label} budget: ${format(used)} of ${format(limit)}`}
    >
      <div className="flex items-center justify-between gap-2 text-[10px]">
        <span className="font-medium text-slate-400">{label}</span>
        <span className="font-mono text-slate-300">{format(used)} / {format(limit)}</span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-800" aria-hidden="true">
        <div
          className={`h-full rounded-full ${ratio >= 0.9 ? 'bg-rose-400' : ratio >= 0.7 ? 'bg-amber-400' : 'bg-cyan-400'}`}
          style={{ width: `${Math.round(ratio * 100)}%` }}
        />
      </div>
    </div>
  );
};

const GoalCard: React.FC<{ goal: ObservatoryGoal }> = ({ goal }) => {
  const taskSummary = Object.entries(goal.taskCounts)
    .filter(([, count]) => typeof count === 'number' && count > 0)
    .map(([status, count]) => `${count} ${humanize(status).toLowerCase()}`)
    .join(', ');
  return (
    <article className="rounded-xl border border-slate-800 bg-black/20 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold leading-relaxed text-slate-100">{goal.objective}</p>
          <p className="mt-1 text-[10px] uppercase tracking-wider text-slate-500">
            {humanize(goal.autonomyLevel)} autonomy{goal.kind ? ` / ${humanize(goal.kind)}` : ''}
          </p>
        </div>
        <span className="shrink-0 rounded-full border border-slate-700 bg-slate-900 px-2 py-1 text-[9px] font-bold uppercase text-slate-300">
          {goal.status}
        </span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <BudgetMetric label="Operations" used={goal.usage.operations} limit={goal.budget.maxOperations} />
        <BudgetMetric label="Provider calls" used={goal.usage.providerCalls} limit={goal.budget.maxProviderCalls} />
        <BudgetMetric label="Approvals" used={goal.usage.approvals} limit={goal.budget.maxApprovals} />
        <BudgetMetric
          label="Command runtime"
          used={goal.usage.commandRuntimeMs}
          limit={goal.budget.maxCommandRuntimeMs}
          format={formatDuration}
        />
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[10px] text-slate-500">
        <span>{taskSummary || 'No task status recorded'}</span>
        <time dateTime={goal.updatedAt} title={absoluteTimeLabel(goal.updatedAt)}>
          Updated {timeLabel(goal.updatedAt)}
        </time>
      </div>
      {goal.mission && (
        <p className="mt-2 rounded-lg bg-slate-950/60 px-2.5 py-2 text-[10px] leading-relaxed text-slate-400">
          Mission {humanize(goal.mission.status)}
          {goal.mission.stage ? ` / ${humanize(goal.mission.stage)}` : ''}
          {` / ${goal.mission.capturedSourceCount} of ${goal.mission.sourceCount} sources captured`}
        </p>
      )}
    </article>
  );
};

const SurfaceCard: React.FC<{ label: string; activity?: ObservatoryActivity }> = ({ label, activity }) => {
  if (!activity?.surface) {
    return (
      <div className="rounded-xl border border-dashed border-slate-700/80 bg-black/10 p-3">
        <p className="text-xs font-semibold text-slate-300">{label}</p>
        <p className="mt-1.5 text-xs leading-relaxed text-slate-500">
          No recorded {label.toLowerCase()} activity. This panel does not simulate a live view.
        </p>
      </div>
    );
  }
  const Icon = surfaceIcon(activity.surface);
  return (
    <div className="rounded-xl border border-slate-700/80 bg-slate-950/60 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="rounded-lg border border-slate-700 bg-slate-900 p-2 text-cyan-300">
            <Icon size={15} />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-semibold text-slate-200">{label}</p>
            <p className="truncate text-[11px] text-slate-500">{humanize(activity.surface.action)}</p>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className={`rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase ${statusClasses[activity.status]}`}>
            {activity.status}
          </span>
          <time
            className="text-[10px] text-slate-500"
            dateTime={activity.timestamp}
            title={absoluteTimeLabel(activity.timestamp)}
          >
            {timeLabel(activity.timestamp)}
          </time>
        </div>
      </div>
      <p className="mt-3 break-all rounded-lg bg-black/20 px-2.5 py-2 text-xs leading-relaxed text-slate-300">
        {activity.surface.primary}
      </p>
      {activity.surface.secondary && (
        <p className="mt-1.5 break-all text-[11px] leading-relaxed text-slate-500">
          {activity.surface.secondary}
        </p>
      )}
      <p className="mt-2 text-[11px] leading-relaxed text-slate-400">{activity.summary}</p>
      <p className="mt-2 text-[10px] uppercase tracking-wider text-slate-600">
        Last recorded evidence, not a live video feed
      </p>
    </div>
  );
};

const ApprovalCard: React.FC<{
  approval: ObservatoryApproval;
  reason: string;
  disabled: boolean;
  onReason: (reason: string) => void;
  onDecision: (status: 'approved' | 'denied') => void;
}> = ({ approval, reason, disabled, onReason, onDecision }) => {
  const Icon = approval.surface ? surfaceIcon(approval.surface) : ShieldCheck;
  const approved = approval.status === 'approved';
  return (
    <article className={`rounded-xl border p-3 ${
      approved
        ? 'border-emerald-500/30 bg-emerald-500/[0.06]'
        : 'border-amber-500/30 bg-amber-500/[0.06]'
    }`}>
      <div className="flex items-start gap-2.5">
        <span className={`rounded-lg border p-2 ${
          approved
            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
            : 'border-amber-500/30 bg-amber-500/10 text-amber-300'
        }`}>
          <Icon size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <p className="text-xs font-semibold leading-relaxed text-slate-100">{approval.actionSummary}</p>
            <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
              approved ? 'border-emerald-500/40 text-emerald-300' : 'border-amber-500/40 text-amber-300'
            }`}>
              {approved ? 'Approved, not executed' : approval.riskLevel}
            </span>
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-slate-400">{approval.reason}</p>
          <code className="mt-2 block break-all text-[10px] leading-relaxed text-slate-600">
            {approval.requestedAction}
          </code>
        </div>
      </div>
      {approved && (
        <div className="mt-3 rounded-lg border border-emerald-500/20 bg-emerald-500/[0.06] p-2.5 text-[11px] leading-relaxed text-emerald-200">
          The decision is recorded. Execution remains a separate kernel-governed action in the owning workspace.
          {approval.decisionReason && <span className="mt-1 block text-slate-400">Reason: {approval.decisionReason}</span>}
        </div>
      )}
      {!approved && (
        <>
      <label className="mt-3 block text-[11px] font-medium text-slate-400" htmlFor={`approval-reason-${approval.id}`}>
        Audit reason
      </label>
      <textarea
        id={`approval-reason-${approval.id}`}
        value={reason}
        onChange={(event) => onReason(event.target.value)}
        disabled={disabled}
        maxLength={1_000}
        rows={2}
        placeholder="Why is this exact action approved or denied?"
        className="mt-1.5 w-full resize-none rounded-lg border border-slate-700 bg-slate-950/70 px-2.5 py-2 text-xs text-slate-200 outline-none focus:border-cyan-500 disabled:opacity-50"
      />
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          disabled={disabled || !reason.trim()}
          onClick={() => onDecision('approved')}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2 py-2 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40"
          aria-label={`Approve ${approval.actionSummary}`}
        >
          <Check size={14} />
          Approve once
        </button>
        <button
          type="button"
          disabled={disabled || !reason.trim()}
          onClick={() => onDecision('denied')}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-rose-500/40 bg-rose-500/10 px-2 py-2 text-xs font-semibold text-rose-300 hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-40"
          aria-label={`Deny ${approval.actionSummary}`}
        >
          <X size={14} />
          Deny
        </button>
      </div>
        </>
      )}
    </article>
  );
};

export const AgentObservatory: React.FC<AgentObservatoryProps> = ({
  className = 'flex',
  closeButtonRef,
  drawerOpen = false,
  enabled = true,
  onClose,
}) => {
  const [snapshot, setSnapshot] = useState<ObservatorySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [controlDraft, setControlDraft] = useState<ControlDraft | null>(null);
  const [approvalReasons, setApprovalReasons] = useState<Record<string, string>>({});
  const [controlMutating, setControlMutating] = useState(false);
  const [approvalMutationId, setApprovalMutationId] = useState<string | null>(null);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({});
  const [authRevision, setAuthRevision] = useState(0);
  const mountedRef = useRef(false);
  const enabledRef = useRef(enabled);
  const inFlightRef = useRef(false);
  const refreshPendingRef = useRef(false);
  const authEpochRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const controlAbortRef = useRef<AbortController | null>(null);
  const approvalAbortRef = useRef<AbortController | null>(null);
  const controlLockRef = useRef(false);
  const approvalLockRef = useRef(false);
  const suspendedRef = useRef(false);
  const refreshTimeoutRef = useRef<number | null>(null);
  const previousStopAllRef = useRef<boolean | null>(null);
  enabledRef.current = enabled;

  const loadSnapshot = useCallback(async (showLoading = false) => {
    if (!enabledRef.current) return;
    if (suspendedRef.current && !showLoading) return;
    if (showLoading) suspendedRef.current = false;
    if (inFlightRef.current) {
      refreshPendingRef.current = true;
      return;
    }
    inFlightRef.current = true;
    if (showLoading) setLoading(true);
    else setRefreshing(true);
    const epoch = authEpochRef.current;
    const controller = new AbortController();
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    abortRef.current = controller;
    try {
      const response = await authenticatedFetch('/api/kernel/observatory', { signal: controller.signal });
      if (response.status === 401) {
        if (epoch !== authEpochRef.current) return;
        suspendedRef.current = true;
        if (mountedRef.current) {
          setSnapshot(null);
          setError('Authentication is required. Sign in from the Overview workspace.');
          setControlDraft(null);
          setApprovalReasons({});
        }
        return;
      }
      if (!response.ok) {
        throw new Error(await readResponseError(response, `Observatory request failed with status ${response.status}.`));
      }
      const value: unknown = await response.json();
      if (!isObservatorySnapshot(value)) throw new Error('The observatory response failed schema validation.');
      if (mountedRef.current && epoch === authEpochRef.current) {
        setSnapshot(value);
        setError(null);
      }
    } catch (loadError) {
      if (loadError instanceof Error && loadError.name === 'AbortError' && !timedOut) return;
      if (mountedRef.current && epoch === authEpochRef.current) {
        setError(timedOut
          ? 'The observatory request timed out.'
          : loadError instanceof Error ? loadError.message : 'The observatory is unavailable.');
      }
    } finally {
      window.clearTimeout(timeout);
      if (abortRef.current === controller) abortRef.current = null;
      inFlightRef.current = false;
      if (mountedRef.current) {
        setLoading(false);
        setRefreshing(false);
        if (refreshPendingRef.current) {
          refreshPendingRef.current = false;
          refreshTimeoutRef.current = window.setTimeout(() => {
            refreshTimeoutRef.current = null;
            void loadSnapshot(false);
          }, 0);
        }
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    if (enabled) {
      void loadSnapshot(true);
    } else {
      setLoading(false);
      setRefreshing(false);
      setSnapshot(null);
      setError(null);
      setControlDraft(null);
      setApprovalReasons({});
      setExpandedSections({});
      refreshPendingRef.current = false;
    }
    const interval = enabled
      ? window.setInterval(() => void loadSnapshot(false), POLL_INTERVAL_MS)
      : undefined;
    const unsubscribe = subscribeAuth(() => {
      authEpochRef.current += 1;
      setAuthRevision((value) => value + 1);
      setSnapshot(null);
      setError(null);
      setControlDraft(null);
      setApprovalReasons({});
      setControlMutating(false);
      setApprovalMutationId(null);
      setExpandedSections({});
      controlLockRef.current = false;
      approvalLockRef.current = false;
      suspendedRef.current = false;
      controlAbortRef.current?.abort();
      approvalAbortRef.current?.abort();
      abortRef.current?.abort();
      if (enabled) void loadSnapshot(true);
    });
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      controlAbortRef.current?.abort();
      approvalAbortRef.current?.abort();
      if (refreshTimeoutRef.current !== null) window.clearTimeout(refreshTimeoutRef.current);
      if (interval !== undefined) window.clearInterval(interval);
      unsubscribe();
    };
  }, [enabled, loadSnapshot]);

  const session = useMemo(() => getAuthSession(), [authRevision]);
  const viewer = session?.role === 'viewer';
  const stopped = snapshot?.controls.stopAll ?? false;
  const controlAction: ControlAction = stopped ? 'resume' : 'stop';
  const controlReason = controlDraft?.action === controlAction ? controlDraft.reason : '';
  const latestBrowser = snapshot?.activities.find((activity) => activity.surface?.kind === 'browser');
  const latestDesktop = snapshot?.activities.find((activity) => activity.surface?.kind === 'desktop');
  const latestConnector = snapshot?.activities.find((activity) => activity.surface?.kind === 'connector');
  const configuredProviders = snapshot?.providers.filter((provider) => provider.configured) ?? [];
  const availableWorkers = snapshot?.workers.filter((worker) => worker.availability === 'available') ?? [];

  useEffect(() => {
    const nextStopAll = snapshot?.controls.stopAll;
    if (nextStopAll === undefined) {
      previousStopAllRef.current = null;
      setControlDraft(null);
      return;
    }
    if (previousStopAllRef.current !== null && previousStopAllRef.current !== nextStopAll) {
      setControlDraft(null);
    }
    previousStopAllRef.current = nextStopAll;
  }, [snapshot?.controls.stopAll]);

  const mutate = async (
    kind: MutationKind,
    url: string,
    body: Record<string, unknown>,
  ): Promise<void> => {
    if (!enabledRef.current) return;
    const controlLane = kind === 'control';
    const lockRef = controlLane ? controlLockRef : approvalLockRef;
    if (lockRef.current) return;
    lockRef.current = true;
    const epoch = authEpochRef.current;
    const controller = new AbortController();
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, MUTATION_TIMEOUT_MS);
    if (controlLane) {
      controlAbortRef.current = controller;
      setControlMutating(true);
    } else {
      approvalAbortRef.current = controller;
      setApprovalMutationId(kind.slice('approval:'.length));
    }
    setError(null);
    try {
      const response = await authenticatedFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!mountedRef.current || epoch !== authEpochRef.current) return;
      if (!response.ok) {
        throw new Error(await readResponseError(response, `Mutation failed with status ${response.status}.`));
      }
      if (controlLane) setControlDraft(null);
      if (kind.startsWith('approval:')) {
        const approvalId = kind.slice('approval:'.length);
        setApprovalReasons((reasons) => ({ ...reasons, [approvalId]: '' }));
      }
      await loadSnapshot(false);
    } catch (mutationError) {
      if (mutationError instanceof Error && mutationError.name === 'AbortError' && !timedOut) return;
      if (mountedRef.current && epoch === authEpochRef.current) {
        setError(timedOut
          ? 'The requested mutation timed out before confirmation.'
          : mutationError instanceof Error ? mutationError.message : 'The requested mutation failed.');
      }
    } finally {
      window.clearTimeout(timeout);
      const abortControllerRef = controlLane ? controlAbortRef : approvalAbortRef;
      if (abortControllerRef.current === controller) abortControllerRef.current = null;
      if (epoch === authEpochRef.current) {
        lockRef.current = false;
        if (mountedRef.current) {
          if (controlLane) setControlMutating(false);
          else setApprovalMutationId(null);
        }
      }
    }
  };

  const decideApproval = (approval: ObservatoryApproval, status: 'approved' | 'denied') => {
    const reason = approvalReasons[approval.id]?.trim() ?? '';
    if (!reason) return;
    void mutate(
      `approval:${approval.id}`,
      `/api/kernel/approvals/${encodeURIComponent(approval.id)}/decision`,
      { status, reason },
    );
  };

  return (
    <aside
      id="agent-activity-inspector"
      className={`${className} h-full min-h-0 flex-col bg-[#0d1117] text-slate-300`}
      aria-label="Agent activity inspector"
      aria-busy={loading || refreshing}
      aria-modal={drawerOpen || undefined}
      role={drawerOpen ? 'dialog' : undefined}
      onKeyDown={drawerOpen ? trapDrawerFocus : undefined}
    >
      <header className="border-b border-slate-800 bg-[#10161f] px-4 py-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Activity size={17} className="text-cyan-300" />
              <h2 className="text-sm font-bold tracking-tight text-white">Operations Monitor</h2>
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
              Kernel-recorded activity and evidence. No private model reasoning is shown.
            </p>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => {
                suspendedRef.current = false;
                void loadSnapshot(false);
              }}
              className="rounded-lg p-2 text-slate-400 hover:bg-slate-800 hover:text-white"
              aria-label="Refresh agent activity"
              disabled={!enabled || refreshing}
            >
              <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} />
            </button>
            {onClose && (
              <button
                ref={closeButtonRef}
                type="button"
                onClick={onClose}
                className="rounded-lg p-2 text-slate-400 hover:bg-slate-800 hover:text-white 2xl:hidden"
                aria-label="Close agent activity inspector"
              >
                <X size={16} />
              </button>
            )}
          </div>
        </div>
        <div className="mt-3 flex items-center justify-between gap-2 rounded-lg border border-slate-800 bg-black/20 px-3 py-2">
          <span className="flex items-center gap-2 text-xs">
            {snapshot && !error ? (
              <Wifi size={14} className="text-emerald-400" />
            ) : (
              <WifiOff size={14} className={error ? 'text-rose-400' : enabled ? 'text-slate-500' : 'text-amber-400'} />
            )}
            <span className={snapshot && !error ? 'text-emerald-300' : 'text-slate-400'}>
              {snapshot
                ? (error ? 'Last known state' : 'Snapshot current')
                : !enabled
                  ? 'Sign-in required'
                  : loading
                    ? 'Connecting'
                    : 'Unavailable'}
            </span>
          </span>
          <span className="text-[10px] text-slate-500">
            {snapshot ? `Synced ${timeLabel(snapshot.generatedAt)}` : 'No snapshot'}
          </span>
        </div>
      </header>

      {error && (
        <div role="alert" className="border-b border-rose-500/30 bg-rose-500/10 px-4 py-3 text-xs leading-relaxed text-rose-200">
          {snapshot && <strong className="mr-1">Showing stale data.</strong>}
          {error}
        </div>
      )}

      {loading && !snapshot && (
        <div role="status" className="flex flex-1 items-center justify-center p-8 text-center">
          <div>
            <RefreshCw size={22} className="mx-auto animate-spin text-cyan-300" />
            <p className="mt-3 text-sm font-semibold text-slate-200">Connecting to the trusted kernel</p>
            <p className="mt-1 text-xs text-slate-500">Loading the authenticated operational projection.</p>
          </div>
        </div>
      )}

      {snapshot && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <section className="border-b border-slate-800/80 p-4">
            <div className={`rounded-xl border p-3 ${
              stopped
                ? 'border-rose-500/40 bg-rose-500/[0.08]'
                : 'border-emerald-500/30 bg-emerald-500/[0.06]'
            }`}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-2.5">
                  {stopped
                    ? <CircleStop size={18} className="mt-0.5 text-rose-300" />
                    : <CheckCircle2 size={18} className="mt-0.5 text-emerald-300" />}
                  <div>
                    <p className="text-xs font-semibold text-slate-100">
                      {stopped ? 'Dispatch halted by Stop All' : 'Stop All is inactive'}
                    </p>
                    <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
                      {stopped
                        ? snapshot.controls.stopAllReason ?? 'All dispatch is halted.'
                        : 'Models can propose actions; kernel policy still decides every dispatch.'}
                    </p>
                  </div>
                </div>
                <span className={`rounded-full px-2 py-1 text-[10px] font-bold uppercase ${
                  stopped ? 'bg-rose-500/15 text-rose-300' : 'bg-emerald-500/15 text-emerald-300'
                }`}>
                  {stopped ? 'Dispatch halted' : 'Stop All clear'}
                </span>
              </div>
              <label htmlFor="kernel-control-reason" className="mt-3 block text-[11px] font-medium text-slate-400">
                {stopped ? 'Resume audit reason' : 'Stop All audit reason'}
              </label>
              <div className="mt-1.5 flex gap-2">
                <input
                  id="kernel-control-reason"
                  value={controlReason}
                  onChange={(event) => setControlDraft({ action: controlAction, reason: event.target.value })}
                  disabled={viewer || controlMutating}
                  maxLength={1_000}
                  placeholder={stopped ? 'Why is it safe to resume?' : 'Why must execution stop?'}
                  className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950/70 px-2.5 py-2 text-xs text-slate-200 outline-none focus:border-cyan-500 disabled:opacity-50"
                />
                <button
                  type="button"
                  disabled={viewer || controlMutating || !controlReason.trim()}
                  onClick={() => {
                    const draft = controlDraft;
                    if (!draft || draft.action !== controlAction || !draft.reason.trim()) return;
                    void mutate(
                      'control',
                      draft.action === 'resume' ? '/api/kernel/controls/resume' : '/api/kernel/controls/stop-all',
                      { reason: draft.reason.trim() },
                    );
                  }}
                  className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${
                    stopped
                      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20'
                      : 'border-rose-500/40 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20'
                  }`}
                >
                  {stopped ? <Play size={14} /> : <CircleStop size={14} />}
                  {stopped ? 'Resume' : 'Stop All'}
                </button>
              </div>
              {viewer && <p className="mt-2 text-[10px] text-amber-300">Viewer access is read-only.</p>}
            </div>

            <div className="mt-3 grid grid-cols-4 gap-2">
              {[
                ['Active goals', snapshot.counts.activeGoals],
                ['Running', snapshot.counts.runningTasks],
                ['Approvals', snapshot.counts.pendingApprovals],
                ['Recent evidence', snapshot.counts.recentEvents],
              ].map(([label, count]) => (
                <div key={String(label)} className="rounded-lg border border-slate-800 bg-black/20 px-2 py-2 text-center">
                  <p className="text-base font-bold text-slate-100">{count}</p>
                  <p className="text-[9px] uppercase tracking-wider text-slate-500">{label}</p>
                </div>
              ))}
            </div>
          </section>

          <Section title="Goals & Budgets" count={snapshot.counts.goals}>
            {snapshot.truncated.goals && (
              <p className="mb-2 text-[10px] text-amber-300">Showing the newest 24 kernel-bounded goals.</p>
            )}
            {snapshot.goals.length === 0 ? (
              <p className="rounded-xl border border-dashed border-slate-700/80 p-3 text-xs text-slate-500">
                No kernel goal or budget has been recorded.
              </p>
            ) : (
              <div className="space-y-2">
                {snapshot.goals
                  .slice(0, expandedSections.goals ? snapshot.goals.length : GOAL_PREVIEW_LIMIT)
                  .map((goal) => <GoalCard key={goal.id} goal={goal} />)}
                <ShowAllToggle
                  expanded={Boolean(expandedSections.goals)}
                  noun="goals"
                  previewLimit={GOAL_PREVIEW_LIMIT}
                  total={snapshot.goals.length}
                  onToggle={() => setExpandedSections((sections) => ({ ...sections, goals: !sections.goals }))}
                />
              </div>
            )}
          </Section>

          <Section title="Current Work" count={snapshot.currentWork.length}>
            {snapshot.truncated.currentWork && (
              <p className="mb-2 text-[10px] text-amber-300">Showing the newest bounded work queue.</p>
            )}
            {snapshot.currentWork.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-700/80 p-4 text-center">
                <Clock3 size={18} className="mx-auto text-slate-600" />
                <p className="mt-2 text-xs font-semibold text-slate-300">No active task</p>
                <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
                  The kernel has not recorded queued, running, blocked, or approval-waiting work.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {snapshot.currentWork
                  .slice(0, expandedSections.work ? snapshot.currentWork.length : WORK_PREVIEW_LIMIT)
                  .map((work) => (
                    <article key={`${work.kind}:${work.id}`} className="rounded-xl border border-slate-800 bg-black/20 p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-xs font-semibold leading-relaxed text-slate-100">{work.title}</p>
                          <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-slate-500">{work.detail}</p>
                        </div>
                        <span className={`shrink-0 rounded-full px-2 py-1 text-[9px] font-bold uppercase ${workClasses[work.status]}`}>
                          {humanize(work.status)}
                        </span>
                      </div>
                      {work.surface && (
                        <p className="mt-2 truncate rounded-md bg-slate-950/70 px-2 py-1.5 text-[10px] text-cyan-300">
                          {work.surface.primary}
                        </p>
                      )}
                    </article>
                  ))}
                <ShowAllToggle
                  expanded={Boolean(expandedSections.work)}
                  noun="work items"
                  previewLimit={WORK_PREVIEW_LIMIT}
                  total={snapshot.currentWork.length}
                  onToggle={() => setExpandedSections((sections) => ({ ...sections, work: !sections.work }))}
                />
              </div>
            )}
          </Section>

          <Section title="Execution Surfaces" defaultOpen>
            <div className="grid gap-2">
              <SurfaceCard label="Browser" activity={latestBrowser} />
              <SurfaceCard label="Desktop" activity={latestDesktop} />
              <SurfaceCard label="Connector" activity={latestConnector} />
            </div>
          </Section>

          <Section title="Approval Inbox" count={snapshot.approvals.length} defaultOpen={snapshot.approvals.length > 0}>
            {snapshot.truncated.approvals && (
              <p className="mb-2 text-[10px] text-amber-300">Showing the newest 100 actionable approvals.</p>
            )}
            {snapshot.approvals.length === 0 ? (
              <p className="rounded-xl border border-dashed border-slate-700/80 p-3 text-xs text-slate-500">
                No pending approvals. Risky actions remain blocked until a request appears here.
              </p>
            ) : (
              <div className="space-y-3">
                {snapshot.approvals
                  .slice(0, expandedSections.approvals ? snapshot.approvals.length : APPROVAL_PREVIEW_LIMIT)
                  .map((approval) => (
                    <ApprovalCard
                      key={approval.id}
                      approval={approval}
                      reason={approvalReasons[approval.id] ?? ''}
                      disabled={viewer || approvalMutationId !== null}
                      onReason={(reason) => setApprovalReasons((reasons) => ({ ...reasons, [approval.id]: reason }))}
                      onDecision={(status) => decideApproval(approval, status)}
                    />
                  ))}
                <ShowAllToggle
                  expanded={Boolean(expandedSections.approvals)}
                  noun="approval records"
                  previewLimit={APPROVAL_PREVIEW_LIMIT}
                  total={snapshot.approvals.length}
                  onToggle={() => setExpandedSections((sections) => ({ ...sections, approvals: !sections.approvals }))}
                />
              </div>
            )}
          </Section>

          <Section title="Evidence Timeline" count={snapshot.activities.length}>
            {snapshot.truncated.activities && (
              <p className="mb-2 text-[10px] text-slate-500">Showing the newest 100 authenticated ledger events.</p>
            )}
            {snapshot.activities.length === 0 ? (
              <p className="rounded-xl border border-dashed border-slate-700/80 p-3 text-xs text-slate-500">
                No ledger activity has been recorded.
              </p>
            ) : (
              <ol className="space-y-2" aria-label="Recent kernel evidence">
                {snapshot.activities
                  .slice(0, expandedSections.activities ? snapshot.activities.length : ACTIVITY_PREVIEW_LIMIT)
                  .map((activity) => (
                    <li key={activity.id} className="relative rounded-xl border border-slate-800 bg-black/20 p-3">
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-xs leading-relaxed text-slate-300">{activity.summary}</p>
                        <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase ${statusClasses[activity.status]}`}>
                          {activity.status}
                        </span>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[9px] uppercase tracking-wider text-slate-600">
                        <span>{humanize(activity.type)}</span>
                        <span aria-hidden="true">/</span>
                        <span>{activity.actor}</span>
                        <span aria-hidden="true">/</span>
                        <time dateTime={activity.timestamp} title={absoluteTimeLabel(activity.timestamp)}>
                          {timeLabel(activity.timestamp)}
                        </time>
                      </div>
                    </li>
                  ))}
                <li>
                  <ShowAllToggle
                    expanded={Boolean(expandedSections.activities)}
                    noun="evidence events"
                    previewLimit={ACTIVITY_PREVIEW_LIMIT}
                    total={snapshot.activities.length}
                    onToggle={() => setExpandedSections((sections) => ({ ...sections, activities: !sections.activities }))}
                  />
                </li>
              </ol>
            )}
          </Section>

          <Section title="Runtime" defaultOpen={false}>
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-xl border border-slate-800 bg-black/20 p-3">
                <Server size={15} className="text-violet-300" />
                <p className="mt-2 text-lg font-bold text-white">{configuredProviders.length}</p>
                <p className="text-[10px] uppercase tracking-wider text-slate-500">Providers configured</p>
                <p className="mt-1 truncate text-[10px] text-slate-400">
                  {configuredProviders.map((provider) => provider.id).join(', ') || 'None configured'}
                </p>
              </div>
              <div className="rounded-xl border border-slate-800 bg-black/20 p-3">
                <Database size={15} className="text-cyan-300" />
                <p className="mt-2 text-lg font-bold text-white">{availableWorkers.length}</p>
                <p className="text-[10px] uppercase tracking-wider text-slate-500">Workers available</p>
                <p className="mt-1 truncate text-[10px] text-slate-400">
                  {availableWorkers.map((worker) => worker.family).join(', ') || 'None available'}
                </p>
              </div>
            </div>
            <div className="mt-2 rounded-xl border border-slate-800 bg-black/20 p-3 text-[11px] leading-relaxed text-slate-500">
              <div className="flex items-center gap-2 text-slate-300">
                <ShieldCheck size={14} className="text-emerald-300" />
                Authority boundary
              </div>
              <p className="mt-1.5">
                This inspector can request controls and decisions. Only the server-side kernel can grant and dispatch authority.
              </p>
            </div>
          </Section>
        </div>
      )}

      {!loading && !snapshot && (
        <div className="flex flex-1 items-center justify-center p-6 text-center" role="status">
          <div>
            <AlertTriangle size={24} className="mx-auto text-amber-300" />
            <p className="mt-3 text-sm font-semibold text-slate-200">
              {enabled ? 'Operational state unavailable' : 'Authenticated activity is locked'}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">
              {enabled
                ? 'Retry the inspector after the protected endpoint is available.'
                : 'Sign in from Overview to load kernel activity and controls.'}
            </p>
          </div>
        </div>
      )}
    </aside>
  );
};

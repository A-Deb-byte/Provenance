import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarClock,
  Clock3,
  Link2,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  SkipForward,
} from 'lucide-react';
import type {
  RecurringResearchOccurrenceRecord,
  RecurringResearchScheduleRecord,
  ResearchMission,
} from '../kernel/types';
import { authenticatedFetch, getAuthSession, subscribeAuth } from '../lib/auth';

interface RecurringResearchConfig {
  available: boolean;
  reason: string;
  schedulerEnabled: boolean;
  tickIntervalMs: number;
  minIntervalMinutes: number;
  maxIntervalMinutes: number;
  allowedOrigins: string[];
  maxSources: number;
}

interface RecurringResearchDetail {
  schedule: RecurringResearchScheduleRecord;
  occurrences: RecurringResearchOccurrenceRecord[];
}

interface MissionProjection {
  id: string;
  status: ResearchMission['status'];
  reportArtifactId?: string;
  reportContentHash?: string;
}

interface RecurringResearchPanelProps {
  onOpenMission?: (missionId: string) => void;
}

type SchedulerAction = 'create' | 'toggle' | 'tick' | 'resume' | 'skip';

const occurrenceStatuses = new Set([
  'due', 'claimed', 'running', 'completed', 'failed', 'blocked', 'uncertain', 'skipped',
]);
const missionStatuses = new Set([
  'planning', 'collecting', 'synthesizing', 'verifying', 'blocked', 'completed', 'cancelled',
]);

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const isStringArray = (value: unknown): value is string[] => (
  Array.isArray(value) && value.every((item) => typeof item === 'string')
);

const isConfig = (value: unknown): value is RecurringResearchConfig => (
  isRecord(value) &&
  typeof value.available === 'boolean' &&
  typeof value.reason === 'string' &&
  typeof value.schedulerEnabled === 'boolean' &&
  Number.isSafeInteger(value.tickIntervalMs) &&
  Number.isSafeInteger(value.minIntervalMinutes) &&
  Number.isSafeInteger(value.maxIntervalMinutes) &&
  isStringArray(value.allowedOrigins) &&
  Number.isSafeInteger(value.maxSources)
);

const isScheduleRecord = (value: unknown): value is RecurringResearchScheduleRecord => {
  if (!isRecord(value) || !isRecord(value.contract)) return false;
  const contract = value.contract;
  return (
    typeof contract.id === 'string' &&
    typeof contract.enabled === 'boolean' &&
    typeof contract.objective === 'string' &&
    isStringArray(contract.sourceUrls) &&
    isRecord(contract.trigger) &&
    typeof contract.trigger.everyMs === 'number' &&
    typeof contract.trigger.startsAt === 'string' &&
    isRecord(contract.budget) &&
    typeof contract.budget.maxRuntimeMs === 'number' &&
    typeof value.maxRuns === 'number' &&
    typeof value.maxConsecutiveFailures === 'number' &&
    typeof value.runsClaimed === 'number' &&
    typeof value.consecutiveFailures === 'number' &&
    typeof value.nextDueAt === 'string'
  );
};

const isOccurrence = (value: unknown): value is RecurringResearchOccurrenceRecord => (
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.scheduleId === 'string' &&
  typeof value.status === 'string' &&
  occurrenceStatuses.has(value.status) &&
  typeof value.scheduledFor === 'string' &&
  typeof value.catchUpApplied === 'boolean' &&
  typeof value.skippedIntervals === 'number' &&
  typeof value.deadlineAt === 'string' &&
  typeof value.goalId === 'string' &&
  typeof value.missionId === 'string' &&
  typeof value.attempt === 'number' &&
  typeof value.leaseId === 'string' &&
  typeof value.leaseFence === 'number' &&
  Array.isArray(value.evidenceRefs)
);

const isScheduleList = (value: unknown): value is { schedules: RecurringResearchScheduleRecord[] } => (
  isRecord(value) && Array.isArray(value.schedules) && value.schedules.every(isScheduleRecord)
);

const isDetail = (value: unknown): value is RecurringResearchDetail => (
  isRecord(value) &&
  isScheduleRecord(value.schedule) &&
  Array.isArray(value.occurrences) &&
  value.occurrences.every(isOccurrence)
);

const isMissionProjection = (value: unknown): value is { mission: MissionProjection } => (
  isRecord(value) &&
  isRecord(value.mission) &&
  typeof value.mission.id === 'string' &&
  typeof value.mission.status === 'string' &&
  missionStatuses.has(value.mission.status)
);

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

const statusClass = (status: string): string => {
  if (status === 'completed' || status === 'enabled') return 'border-emerald-800 bg-emerald-950/20 text-emerald-300';
  if (status === 'failed' || status === 'blocked' || status === 'uncertain' || status === 'halted') {
    return 'border-rose-900 bg-rose-950/20 text-rose-300';
  }
  if (status === 'running' || status === 'claimed' || status === 'due') {
    return 'border-amber-800 bg-amber-950/20 text-amber-300';
  }
  return 'border-slate-700 bg-slate-950/30 text-slate-300';
};

const formatDate = (value: string | undefined): string => {
  if (!value) return 'Not recorded';
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : 'Invalid timestamp';
};

const shortHash = (value: string | undefined): string => value ? `${value.slice(0, 12)}...` : 'Not recorded';

const parseInteger = (value: string, field: string, minimum: number, maximum: number): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${field} must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
};

const parseSources = (value: string, config: RecurringResearchConfig): string[] => {
  const rawUrls = value.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean);
  if (rawUrls.length < 1 || rawUrls.length > config.maxSources) {
    throw new Error(`Enter between 1 and ${config.maxSources} HTTPS source URLs, one per line.`);
  }
  const allowedOrigins = new Set(config.allowedOrigins);
  const sourceUrls = rawUrls.map((rawUrl) => {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new Error(`${rawUrl} is not a valid URL.`);
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
      throw new Error(`${rawUrl} must be HTTPS without credentials or a fragment.`);
    }
    if (!allowedOrigins.has(parsed.origin)) {
      throw new Error(`${parsed.origin} is outside the configured source origins.`);
    }
    return parsed.toString();
  });
  if (new Set(sourceUrls).size !== sourceUrls.length) throw new Error('Source URLs must be unique.');
  return sourceUrls;
};

export const RecurringResearchPanel: React.FC<RecurringResearchPanelProps> = ({ onOpenMission }) => {
  const [config, setConfig] = useState<RecurringResearchConfig | null>(null);
  const [schedules, setSchedules] = useState<RecurringResearchScheduleRecord[]>([]);
  const [selectedScheduleId, setSelectedScheduleId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RecurringResearchDetail | null>(null);
  const [selectedOccurrenceId, setSelectedOccurrenceId] = useState<string | null>(null);
  const [mission, setMission] = useState<MissionProjection | null>(null);
  const [objective, setObjective] = useState('');
  const [sourceText, setSourceText] = useState('');
  const [intervalMinutes, setIntervalMinutes] = useState('60');
  const [maxRuns, setMaxRuns] = useState('100');
  const [maxConsecutiveFailures, setMaxConsecutiveFailures] = useState('3');
  const [maxRuntimeMinutes, setMaxRuntimeMinutes] = useState('10');
  const [stateReason, setStateReason] = useState('');
  const [resolutionReason, setResolutionReason] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [missionError, setMissionError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const [activeAction, setActiveAction] = useState<SchedulerAction | null>(null);
  const [authRevision, setAuthRevision] = useState(0);
  const [session, setSession] = useState(() => getAuthSession());
  const authEpoch = useRef(0);

  const clearProtectedState = useCallback(() => {
    setConfig(null);
    setSchedules([]);
    setSelectedScheduleId(null);
    setDetail(null);
    setSelectedOccurrenceId(null);
    setMission(null);
    setIsLoading(false);
    setDetailLoading(false);
    setLoadError(null);
    setDetailError(null);
    setMissionError(null);
    setActionError(null);
    setActionStatus(null);
    setActiveAction(null);
  }, []);

  const clearForUnauthorized = useCallback((error: unknown): boolean => {
    if (!isUnauthorized(error)) return false;
    authEpoch.current += 1;
    clearProtectedState();
    return true;
  }, [clearProtectedState]);

  useEffect(() => subscribeAuth(() => {
    authEpoch.current += 1;
    const nextSession = getAuthSession();
    if (!nextSession) clearProtectedState();
    setSession(nextSession);
    setAuthRevision((revision) => revision + 1);
  }), [clearProtectedState]);

  const fetchSchedules = useCallback(async (): Promise<RecurringResearchScheduleRecord[]> => {
    const payload = await requestJson('/api/kernel/recurring-research');
    if (!isScheduleList(payload)) throw new Error('Recurring research schedule list response is invalid.');
    return payload.schedules;
  }, []);

  const fetchDetail = useCallback(async (scheduleId: string): Promise<RecurringResearchDetail> => {
    const payload = await requestJson(`/api/kernel/recurring-research/${encodeURIComponent(scheduleId)}`);
    if (!isDetail(payload)) throw new Error('Recurring research schedule detail response is invalid.');
    return payload;
  }, []);

  useEffect(() => {
    let disposed = false;
    const epoch = authEpoch.current;
    const isCurrent = () => !disposed && epoch === authEpoch.current;
    const load = async () => {
      try {
        const [nextConfig, nextSchedules] = await Promise.all([
          requestJson('/api/kernel/recurring-research/config'),
          fetchSchedules(),
        ]);
        if (!isConfig(nextConfig)) throw new Error('Recurring research configuration response is invalid.');
        if (isCurrent()) {
          setConfig(nextConfig);
          setSchedules(nextSchedules);
          setSelectedScheduleId((current) => (
            current && nextSchedules.some((schedule) => schedule.contract.id === current)
              ? current
              : nextSchedules[0]?.contract.id ?? null
          ));
          setLoadError(null);
        }
      } catch (error) {
        clearForUnauthorized(error);
        if (isCurrent()) setLoadError(error instanceof Error ? error.message : 'Recurring research schedules are unavailable.');
      } finally {
        if (isCurrent()) setIsLoading(false);
      }
    };
    void load();
    const interval = window.setInterval(() => void load(), 5_000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [authRevision, clearForUnauthorized, fetchSchedules]);

  useEffect(() => {
    if (!selectedScheduleId) {
      setDetail(null);
      setSelectedOccurrenceId(null);
      return;
    }
    let disposed = false;
    const epoch = authEpoch.current;
    const isCurrent = () => !disposed && epoch === authEpoch.current;
    setDetailLoading(true);
    const load = async () => {
      try {
        const nextDetail = await fetchDetail(selectedScheduleId);
        if (isCurrent()) {
          setDetail(nextDetail);
          setSelectedOccurrenceId((current) => {
            if (current && nextDetail.occurrences.some((occurrence) => occurrence.id === current)) return current;
            return nextDetail.schedule.activeOccurrenceId ?? nextDetail.occurrences[0]?.id ?? null;
          });
          setDetailError(null);
        }
      } catch (error) {
        clearForUnauthorized(error);
        if (isCurrent()) setDetailError(error instanceof Error ? error.message : 'Schedule detail is unavailable.');
      } finally {
        if (isCurrent()) setDetailLoading(false);
      }
    };
    void load();
    const interval = window.setInterval(() => void load(), 5_000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [authRevision, clearForUnauthorized, fetchDetail, selectedScheduleId]);

  const selectedOccurrence = useMemo(
    () => detail?.occurrences.find((occurrence) => occurrence.id === selectedOccurrenceId) ?? null,
    [detail?.occurrences, selectedOccurrenceId],
  );

  useEffect(() => {
    if (!selectedOccurrence?.missionId) {
      setMission(null);
      setMissionError(null);
      return;
    }
    let disposed = false;
    const epoch = authEpoch.current;
    const isCurrent = () => !disposed && epoch === authEpoch.current;
    const load = async () => {
      try {
        const payload = await requestJson(`/api/kernel/research-missions/${encodeURIComponent(selectedOccurrence.missionId)}`);
        if (!isMissionProjection(payload)) throw new Error('Linked mission response is invalid.');
        if (isCurrent()) {
          setMission(payload.mission);
          setMissionError(null);
        }
      } catch (error) {
        clearForUnauthorized(error);
        if (isCurrent()) {
          setMission(null);
          setMissionError(error instanceof Error ? error.message : 'Linked mission is unavailable.');
        }
      }
    };
    void load();
    const interval = window.setInterval(() => void load(), 5_000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [authRevision, clearForUnauthorized, selectedOccurrence?.missionId]);

  const refresh = async (scheduleId?: string): Promise<void> => {
    const epoch = authEpoch.current;
    const nextSchedules = await fetchSchedules();
    if (epoch !== authEpoch.current) return;
    setSchedules(nextSchedules);
    const targetId = scheduleId ?? selectedScheduleId;
    if (targetId && nextSchedules.some((schedule) => schedule.contract.id === targetId)) {
      const nextDetail = await fetchDetail(targetId);
      if (epoch !== authEpoch.current) return;
      setSelectedScheduleId(targetId);
      setDetail(nextDetail);
      setSelectedOccurrenceId((current) => (
        current && nextDetail.occurrences.some((occurrence) => occurrence.id === current)
          ? current
          : nextDetail.schedule.activeOccurrenceId ?? nextDetail.occurrences[0]?.id ?? null
      ));
    }
  };

  const createSchedule = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!config || !config.available || activeAction) return;
    setActionError(null);
    setActionStatus(null);
    try {
      const normalizedObjective = objective.trim();
      if (!normalizedObjective) throw new Error('Research objective is required.');
      const sourceUrls = parseSources(sourceText, config);
      const input = {
        objective: normalizedObjective,
        sourceUrls,
        intervalMinutes: parseInteger(intervalMinutes, 'Interval minutes', config.minIntervalMinutes, config.maxIntervalMinutes),
        maxRuns: parseInteger(maxRuns, 'Maximum runs', 1, 1_000),
        maxConsecutiveFailures: parseInteger(maxConsecutiveFailures, 'Maximum consecutive failures', 1, 100),
        maxRuntimeMinutes: parseInteger(maxRuntimeMinutes, 'Maximum runtime minutes', 1, 15),
      };
      setActiveAction('create');
      const payload = await requestJson('/api/kernel/recurring-research', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!isScheduleRecord(payload)) throw new Error('Schedule creation response is invalid.');
      setObjective('');
      setSourceText('');
      await refresh(payload.contract.id);
      setActionStatus('Schedule created disabled. Add a reason and enable it when ready.');
    } catch (error) {
      clearForUnauthorized(error);
      setActionError(error instanceof Error ? error.message : 'Schedule creation failed.');
    } finally {
      setActiveAction(null);
    }
  };

  const toggleSchedule = async () => {
    if (!detail || activeAction) return;
    const reason = stateReason.trim();
    if (!reason) {
      setActionError('Schedule state change reason is required.');
      return;
    }
    setActiveAction('toggle');
    setActionError(null);
    setActionStatus(null);
    try {
      const enabled = !detail.schedule.contract.enabled;
      const payload = await requestJson(`/api/kernel/recurring-research/${encodeURIComponent(detail.schedule.contract.id)}/enabled`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled, reason }),
      });
      if (!isScheduleRecord(payload)) throw new Error('Schedule state response is invalid.');
      setStateReason('');
      await refresh(payload.contract.id);
      setActionStatus(`Schedule ${enabled ? 'enabled' : 'disabled'}.`);
    } catch (error) {
      clearForUnauthorized(error);
      setActionError(error instanceof Error ? error.message : 'Schedule state change failed.');
    } finally {
      setActiveAction(null);
    }
  };

  const tickScheduler = async () => {
    if (activeAction) return;
    setActiveAction('tick');
    setActionError(null);
    setActionStatus(null);
    try {
      const payload = await requestJson('/api/kernel/recurring-research/tick', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!isRecord(payload) || typeof payload.outcome !== 'string') throw new Error('Scheduler tick response is invalid.');
      const scheduleId = isScheduleRecord(payload.schedule) ? payload.schedule.contract.id : selectedScheduleId ?? undefined;
      await refresh(scheduleId);
      setActionStatus(typeof payload.reason === 'string' ? payload.reason : `Scheduler tick: ${payload.outcome}.`);
    } catch (error) {
      clearForUnauthorized(error);
      setActionError(error instanceof Error ? error.message : 'Scheduler tick failed.');
    } finally {
      setActiveAction(null);
    }
  };

  const resolveOccurrence = async (kind: 'resume' | 'skip') => {
    if (!detail || !selectedOccurrence || activeAction) return;
    const reason = resolutionReason.trim();
    if (!reason) {
      setActionError('Occurrence resolution reason is required.');
      return;
    }
    setActiveAction(kind);
    setActionError(null);
    setActionStatus(null);
    try {
      const url = `/api/kernel/recurring-research/${encodeURIComponent(detail.schedule.contract.id)}/occurrences/${encodeURIComponent(selectedOccurrence.id)}/${kind}`;
      const payload = await requestJson(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      if (kind === 'skip' && !isOccurrence(payload)) throw new Error('Occurrence skip response is invalid.');
      if (kind === 'resume' && (!isRecord(payload) || typeof payload.outcome !== 'string')) {
        throw new Error('Occurrence resume response is invalid.');
      }
      setResolutionReason('');
      await refresh(detail.schedule.contract.id);
      setActionStatus(kind === 'resume' ? 'Occurrence resume completed.' : 'Occurrence skipped with recorded reason.');
    } catch (error) {
      clearForUnauthorized(error);
      setActionError(error instanceof Error ? error.message : `Occurrence ${kind} failed.`);
    } finally {
      setActiveAction(null);
    }
  };

  const isViewer = session?.role === 'viewer';
  const canMutate = Boolean(config?.available && !isViewer && !activeAction);
  const selectedSchedule = detail?.schedule;
  const resolvable = selectedOccurrence?.status === 'blocked' || selectedOccurrence?.status === 'uncertain';

  return (
    <section aria-labelledby="recurring-research-title" className="rounded-3xl border border-slate-800 bg-[#101114]/90 p-5 shadow-2xl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-mono font-bold uppercase tracking-[0.35em] text-violet-400">Durable Scheduler</p>
          <h2 id="recurring-research-title" className="mt-1 text-xl font-black tracking-tight text-white">Recurring Research Missions</h2>
          <p className="mt-2 max-w-2xl text-xs leading-relaxed text-slate-400">
            Run fixed, allowlisted research missions on bounded UTC intervals. Occurrences are leased, deadline-bound, and never replayed silently after interruption.
          </p>
        </div>
        <span className={`rounded-full border px-3 py-1 text-[10px] font-mono ${config?.available ? statusClass('enabled') : statusClass('halted')}`}>
          {config ? (config.available ? 'Scheduler available' : 'Scheduler unavailable') : 'Checking scheduler...'}
        </span>
      </div>

      {isLoading && <p role="status" className="mt-4 rounded-lg border border-violet-900/50 bg-violet-950/20 px-3 py-2 text-xs text-violet-300">Loading recurring research schedules...</p>}
      {loadError && <p role="alert" className="mt-4 rounded-lg border border-rose-900/60 bg-rose-950/20 px-3 py-2 text-xs text-rose-300">Recurring research unavailable: {loadError}</p>}
      {detailError && <p role="alert" className="mt-4 rounded-lg border border-rose-900/60 bg-rose-950/20 px-3 py-2 text-xs text-rose-300">Schedule detail unavailable: {detailError}</p>}
      {actionError && <p role="alert" className="mt-4 rounded-lg border border-rose-900/60 bg-rose-950/20 px-3 py-2 text-xs text-rose-300">{actionError}</p>}
      {actionStatus && <p role="status" className="mt-4 rounded-lg border border-emerald-900/60 bg-emerald-950/20 px-3 py-2 text-xs text-emerald-300">{actionStatus}</p>}
      {config && !config.available && <p className="mt-4 rounded-lg border border-amber-900/60 bg-amber-950/20 px-3 py-2 text-xs text-amber-300">{config.reason}</p>}
      {isViewer && <p className="mt-4 rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2 text-xs text-slate-300">Viewer sessions can inspect schedules and occurrences but cannot create, tick, enable, resume, or skip them.</p>}

      {config && (
        <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-4">
          <div className="rounded-xl border border-slate-800 bg-black/20 p-3"><div className="text-[9px] uppercase tracking-wider text-slate-500">Runtime tick</div><div className="mt-1 text-sm font-bold text-slate-200">{Math.round(config.tickIntervalMs / 1_000)} sec</div></div>
          <div className="rounded-xl border border-slate-800 bg-black/20 p-3"><div className="text-[9px] uppercase tracking-wider text-slate-500">Interval bounds</div><div className="mt-1 text-sm font-bold text-slate-200">{config.minIntervalMinutes}-{config.maxIntervalMinutes} min</div></div>
          <div className="rounded-xl border border-slate-800 bg-black/20 p-3"><div className="text-[9px] uppercase tracking-wider text-slate-500">Source bound</div><div className="mt-1 text-sm font-bold text-slate-200">1-{config.maxSources} URLs</div></div>
          <div className="rounded-xl border border-slate-800 bg-black/20 p-3"><div className="text-[9px] uppercase tracking-wider text-slate-500">Authority</div><div className="mt-1 text-sm font-bold text-emerald-300">L0/L1 read only</div></div>
        </div>
      )}

      <div className="mt-5 grid grid-cols-1 gap-4 xl:grid-cols-[1.15fr_0.85fr]">
        <form onSubmit={(event) => void createSchedule(event)} className="rounded-2xl border border-slate-800 bg-black/20 p-4">
          <div className="flex items-center gap-2 text-sm font-bold text-slate-100"><CalendarClock size={15} className="text-violet-400" /> New Schedule</div>
          <p className="mt-1 text-[10px] leading-relaxed text-slate-500">New schedules are created disabled. Their objective and source authority remain fixed.</p>
          <label className="mt-4 block text-[10px] font-mono font-bold uppercase tracking-wider text-slate-500">
            Research objective
            <textarea aria-label="Scheduled research objective" value={objective} onChange={(event) => setObjective(event.target.value)} rows={3} maxLength={2_000} disabled={!canMutate} className="mt-1 w-full rounded-xl border border-slate-800 bg-slate-950/70 p-3 text-xs normal-case tracking-normal text-slate-200 outline-none focus:border-violet-700 disabled:opacity-50" />
          </label>
          <label className="mt-3 block text-[10px] font-mono font-bold uppercase tracking-wider text-slate-500">
            HTTPS source URLs, one per line
            <textarea aria-label="Scheduled HTTPS source URLs, one per line" value={sourceText} onChange={(event) => setSourceText(event.target.value)} rows={4} disabled={!canMutate} className="mt-1 w-full rounded-xl border border-slate-800 bg-slate-950/70 p-3 text-xs normal-case tracking-normal text-slate-200 outline-none focus:border-violet-700 disabled:opacity-50" />
          </label>
          <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
            <label className="text-[9px] uppercase tracking-wider text-slate-500">Interval minutes<input aria-label="Interval minutes" type="number" value={intervalMinutes} onChange={(event) => setIntervalMinutes(event.target.value)} disabled={!canMutate} className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-950 p-2 text-xs text-slate-200 disabled:opacity-50" /></label>
            <label className="text-[9px] uppercase tracking-wider text-slate-500">Maximum runs<input aria-label="Maximum runs" type="number" value={maxRuns} onChange={(event) => setMaxRuns(event.target.value)} disabled={!canMutate} className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-950 p-2 text-xs text-slate-200 disabled:opacity-50" /></label>
            <label className="text-[9px] uppercase tracking-wider text-slate-500">Failure bound<input aria-label="Maximum consecutive failures" type="number" value={maxConsecutiveFailures} onChange={(event) => setMaxConsecutiveFailures(event.target.value)} disabled={!canMutate} className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-950 p-2 text-xs text-slate-200 disabled:opacity-50" /></label>
            <label className="text-[9px] uppercase tracking-wider text-slate-500">Runtime minutes<input aria-label="Maximum runtime minutes" type="number" value={maxRuntimeMinutes} onChange={(event) => setMaxRuntimeMinutes(event.target.value)} disabled={!canMutate} className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-950 p-2 text-xs text-slate-200 disabled:opacity-50" /></label>
          </div>
          <button type="submit" disabled={!canMutate} className="mt-4 inline-flex items-center gap-2 rounded-lg border border-violet-800 bg-violet-950/30 px-3 py-2 text-xs font-bold text-violet-200 disabled:cursor-not-allowed disabled:opacity-40"><ShieldCheck size={13} />{activeAction === 'create' ? 'Creating...' : 'Create schedule'}</button>
          {config && <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/50 p-3 text-[10px] text-slate-500"><span className="font-bold text-slate-400">Allowed origins:</span> {config.allowedOrigins.length ? config.allowedOrigins.join(', ') : 'None configured'}</div>}
        </form>

        <div className="rounded-2xl border border-slate-800 bg-black/20 p-4">
          <div className="flex items-center justify-between gap-2"><div className="text-sm font-bold text-slate-100">Schedules</div><button type="button" onClick={() => void tickScheduler()} disabled={!canMutate} className="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-2.5 py-1.5 text-[10px] font-bold text-slate-300 disabled:opacity-40"><RefreshCw size={11} className={activeAction === 'tick' ? 'animate-spin' : ''} /> Tick now</button></div>
          <div className="mt-3 space-y-2">
            {!isLoading && schedules.length === 0 && <p className="rounded-xl border border-dashed border-slate-800 p-4 text-center text-xs text-slate-500">No recurring schedules yet.</p>}
            {schedules.map((schedule) => {
              const state = schedule.haltedReason ? 'halted' : schedule.contract.enabled ? 'enabled' : 'disabled';
              return <button key={schedule.contract.id} type="button" data-testid={`recurring-schedule-${schedule.contract.id}`} onClick={() => setSelectedScheduleId(schedule.contract.id)} className={`w-full rounded-xl border p-3 text-left transition ${selectedScheduleId === schedule.contract.id ? 'border-violet-700 bg-violet-950/20' : 'border-slate-800 bg-slate-950/30 hover:border-slate-700'}`}>
                <div className="flex items-start justify-between gap-2"><span className="line-clamp-2 text-xs font-bold text-slate-200">{schedule.contract.objective}</span><span className={`rounded-full border px-2 py-0.5 text-[9px] uppercase ${statusClass(state)}`}>{state}</span></div>
                <div className="mt-2 text-[9px] font-mono text-slate-500">Next: {formatDate(schedule.nextDueAt)}</div>
                <div className="mt-1 text-[9px] font-mono text-slate-600">Runs {schedule.runsClaimed}/{schedule.maxRuns} / failures {schedule.consecutiveFailures}/{schedule.maxConsecutiveFailures}</div>
              </button>;
            })}
          </div>
        </div>
      </div>

      {detailLoading && <p role="status" className="mt-4 text-xs text-violet-300">Loading schedule detail...</p>}
      {selectedSchedule && (
        <div className="mt-5 rounded-2xl border border-slate-800 bg-black/20 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><div className="text-[9px] uppercase tracking-wider text-slate-500">Selected schedule</div><div className="mt-1 text-sm font-bold text-slate-100">{selectedSchedule.contract.objective}</div><div className="mt-1 font-mono text-[9px] text-slate-600">{selectedSchedule.contract.id} / version {selectedSchedule.contract.version}</div></div>
            <span className={`rounded-full border px-2 py-1 text-[9px] uppercase ${statusClass(selectedSchedule.haltedReason ? 'halted' : selectedSchedule.contract.enabled ? 'enabled' : 'disabled')}`}>{selectedSchedule.haltedReason ? 'halted' : selectedSchedule.contract.enabled ? 'enabled' : 'disabled'}</span>
          </div>
          {selectedSchedule.haltedReason && <p className="mt-3 rounded-lg border border-rose-900/50 bg-rose-950/20 p-2 text-xs text-rose-300">{selectedSchedule.haltedReason}</p>}
          <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-5">
            <div className="rounded-lg border border-slate-800 p-2"><div className="text-[8px] uppercase text-slate-600">Next due</div><div className="mt-1 text-[10px] text-slate-300">{formatDate(selectedSchedule.nextDueAt)}</div></div>
            <div className="rounded-lg border border-slate-800 p-2"><div className="text-[8px] uppercase text-slate-600">Interval</div><div className="mt-1 text-[10px] text-slate-300">{selectedSchedule.contract.trigger.everyMs / 60_000} min</div></div>
            <div className="rounded-lg border border-slate-800 p-2"><div className="text-[8px] uppercase text-slate-600">Run budget</div><div className="mt-1 text-[10px] text-slate-300">{selectedSchedule.runsClaimed} / {selectedSchedule.maxRuns}</div></div>
            <div className="rounded-lg border border-slate-800 p-2"><div className="text-[8px] uppercase text-slate-600">Failures</div><div className="mt-1 text-[10px] text-slate-300">{selectedSchedule.consecutiveFailures} / {selectedSchedule.maxConsecutiveFailures}</div></div>
            <div className="rounded-lg border border-slate-800 p-2"><div className="text-[8px] uppercase text-slate-600">Runtime</div><div className="mt-1 text-[10px] text-slate-300">{selectedSchedule.contract.budget.maxRuntimeMs / 60_000} min</div></div>
          </div>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="min-w-[260px] flex-1 text-[9px] uppercase tracking-wider text-slate-500">State change reason<input aria-label="Schedule state change reason" value={stateReason} onChange={(event) => setStateReason(event.target.value)} disabled={!canMutate} className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-950 p-2 text-xs normal-case text-slate-200 disabled:opacity-50" /></label>
            <button type="button" onClick={() => void toggleSchedule()} disabled={!canMutate} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-2 text-xs font-bold text-slate-200 disabled:opacity-40">{selectedSchedule.contract.enabled ? <Pause size={12} /> : <Play size={12} />}{selectedSchedule.contract.enabled ? 'Disable schedule' : 'Enable schedule'}</button>
          </div>
        </div>
      )}

      {detail && (
        <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[0.85fr_1.15fr]">
          <div className="rounded-2xl border border-slate-800 bg-black/20 p-4">
            <div className="text-sm font-bold text-slate-100">Occurrence History</div>
            <div className="mt-3 space-y-2">
              {detail.occurrences.length === 0 && <p className="rounded-xl border border-dashed border-slate-800 p-4 text-center text-xs text-slate-500">No occurrences claimed.</p>}
              {detail.occurrences.map((occurrence) => <button key={occurrence.id} type="button" data-testid={`recurring-occurrence-${occurrence.id}`} onClick={() => setSelectedOccurrenceId(occurrence.id)} className={`w-full rounded-xl border p-3 text-left ${selectedOccurrenceId === occurrence.id ? 'border-violet-700 bg-violet-950/20' : 'border-slate-800 bg-slate-950/30'}`}>
                <div className="flex items-center justify-between gap-2"><span className="text-[10px] font-bold text-slate-300">{formatDate(occurrence.scheduledFor)}</span><span className={`rounded-full border px-2 py-0.5 text-[9px] uppercase ${statusClass(occurrence.status)}`}>{occurrence.status}</span></div>
                <div className="mt-1 font-mono text-[9px] text-slate-600">Attempt {occurrence.attempt} / skipped intervals {occurrence.skippedIntervals}</div>
              </button>)}
            </div>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-black/20 p-4">
            <div className="text-sm font-bold text-slate-100">Occurrence Evidence</div>
            {!selectedOccurrence && <p className="mt-3 text-xs text-slate-500">Select an occurrence to inspect its durable lease and mission evidence.</p>}
            {selectedOccurrence && <>
              <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
                <div className="rounded-lg border border-slate-800 p-2"><Clock3 size={11} className="text-violet-400" /><div className="mt-1 text-[8px] uppercase text-slate-600">Deadline</div><div className="mt-1 text-[10px] text-slate-300">{formatDate(selectedOccurrence.deadlineAt)}</div></div>
                <div className="rounded-lg border border-slate-800 p-2"><div className="text-[8px] uppercase text-slate-600">Lease owner</div><div className="mt-1 break-all font-mono text-[9px] text-slate-300">{selectedOccurrence.lease?.owner ?? 'Released'}</div><div className="mt-1 text-[8px] text-slate-600">Fence {selectedOccurrence.leaseFence}</div></div>
                <div className="rounded-lg border border-slate-800 p-2"><div className="text-[8px] uppercase text-slate-600">Catch-up</div><div className="mt-1 text-[10px] text-slate-300">{selectedOccurrence.catchUpApplied ? 'Latest once' : 'Exact boundary'}</div><div className="mt-1 text-[8px] text-slate-600">Skipped {selectedOccurrence.skippedIntervals}</div></div>
                <div className="rounded-lg border border-slate-800 p-2"><div className="text-[8px] uppercase text-slate-600">Status</div><div className="mt-1 text-[10px] font-bold text-slate-300">{selectedOccurrence.status}</div><div className="mt-1 text-[8px] text-slate-600">Attempt {selectedOccurrence.attempt}</div></div>
              </div>
              {selectedOccurrence.statusReason && <p className="mt-3 rounded-lg border border-slate-800 bg-slate-950/50 p-2 text-xs text-slate-300">{selectedOccurrence.statusReason}</p>}
              <div className="mt-3 rounded-xl border border-slate-800 bg-slate-950/40 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-1.5 text-xs font-bold text-slate-200"><Link2 size={12} className="text-cyan-400" /> Linked mission</div>{onOpenMission && <button type="button" onClick={() => onOpenMission(selectedOccurrence.missionId)} className="text-[10px] font-bold text-cyan-300 hover:text-cyan-200">Open mission cockpit</button>}</div>
                <div className="mt-2 break-all font-mono text-[9px] text-slate-500">{selectedOccurrence.missionId}</div>
                <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-3"><div><div className="text-[8px] uppercase text-slate-600">Mission status</div><div className="mt-1 text-[10px] text-slate-300">{mission?.status ?? (missionError ? 'Unavailable' : 'Loading...')}</div></div><div><div className="text-[8px] uppercase text-slate-600">Report artifact</div><div title={selectedOccurrence.reportArtifactId ?? mission?.reportArtifactId} className="mt-1 font-mono text-[10px] text-slate-300">{shortHash(selectedOccurrence.reportArtifactId ?? mission?.reportArtifactId)}</div></div><div><div className="text-[8px] uppercase text-slate-600">Report hash</div><div title={selectedOccurrence.reportContentHash ?? mission?.reportContentHash} className="mt-1 font-mono text-[10px] text-slate-300">{shortHash(selectedOccurrence.reportContentHash ?? mission?.reportContentHash)}</div></div></div>
                {missionError && <p className="mt-2 text-[9px] text-amber-400">Mission status unavailable: {missionError}</p>}
              </div>
              {resolvable && <div className="mt-3 rounded-xl border border-amber-900/40 bg-amber-950/10 p-3"><label className="text-[9px] uppercase tracking-wider text-slate-500">Occurrence resolution reason<input aria-label="Occurrence resolution reason" value={resolutionReason} onChange={(event) => setResolutionReason(event.target.value)} disabled={!canMutate} className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-950 p-2 text-xs normal-case text-slate-200 disabled:opacity-50" /></label><div className="mt-2 flex flex-wrap gap-2"><button type="button" onClick={() => void resolveOccurrence('resume')} disabled={!canMutate} className="inline-flex items-center gap-1.5 rounded-lg border border-amber-800 px-3 py-2 text-xs font-bold text-amber-200 disabled:opacity-40"><RotateCcw size={12} /> Resume occurrence</button><button type="button" onClick={() => void resolveOccurrence('skip')} disabled={!canMutate} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-2 text-xs font-bold text-slate-300 disabled:opacity-40"><SkipForward size={12} /> Skip occurrence</button></div></div>}
            </>}
          </div>
        </div>
      )}
    </section>
  );
};

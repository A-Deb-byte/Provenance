import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ApprovalRecord,
  GoalContract,
  KernelControls,
  KernelEvent,
  KernelTask,
  ResearchMission,
  ResearchMissionSource,
} from '../kernel/types';
import { authenticatedFetch, getAuthSession, subscribeAuth } from '../lib/auth';

interface ResearchMissionConfig {
  available: boolean;
  reason: string;
  allowedOrigins: string[];
  maxSources: number;
}

interface ResearchMissionDetail {
  mission: ResearchMission;
  goal: GoalContract;
  tasks: KernelTask[];
  approvals: ApprovalRecord[];
  events: KernelEvent[];
  controls: KernelControls;
}

interface ResearchMissionReport {
  content: string;
  contentHash: string;
}

interface ResearchMissionStepResult {
  outcome: 'advanced' | 'in_progress' | 'blocked' | 'completed';
  mission: ResearchMission;
}

type MissionAction = 'create' | 'run' | 'step' | 'resume';

const missionStatuses = new Set([
  'planning', 'collecting', 'synthesizing', 'verifying', 'blocked', 'completed', 'cancelled',
]);

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const isStringArray = (value: unknown): value is string[] => (
  Array.isArray(value) && value.every((item) => typeof item === 'string')
);

const isResearchMissionConfig = (value: unknown): value is ResearchMissionConfig => (
  isRecord(value) &&
  typeof value.available === 'boolean' &&
  typeof value.reason === 'string' &&
  isStringArray(value.allowedOrigins) &&
  typeof value.maxSources === 'number' &&
  Number.isSafeInteger(value.maxSources) &&
  value.maxSources > 0
);

const isResearchMissionSource = (value: unknown): value is ResearchMissionSource => (
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.url === 'string' &&
  typeof value.origin === 'string' &&
  typeof value.status === 'string' &&
  Array.isArray(value.chunks) &&
  isStringArray(value.injectionSignalCodes)
);

const isResearchMission = (value: unknown): value is ResearchMission => (
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.goalId === 'string' &&
  typeof value.objective === 'string' &&
  typeof value.status === 'string' &&
  missionStatuses.has(value.status) &&
  typeof value.revision === 'number' &&
  typeof value.checkpoint === 'number' &&
  Array.isArray(value.sources) &&
  value.sources.every(isResearchMissionSource) &&
  Array.isArray(value.providerRuns) &&
  isStringArray(value.lastVerificationIssues) &&
  typeof value.createdAt === 'string' &&
  typeof value.updatedAt === 'string'
);

const isGoalContract = (value: unknown): value is GoalContract => (
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.objective === 'string' &&
  typeof value.status === 'string' &&
  isRecord(value.budget) &&
  isRecord(value.usage)
);

const isKernelTask = (value: unknown): value is KernelTask => (
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.goalId === 'string' &&
  typeof value.title === 'string' &&
  typeof value.status === 'string' &&
  isStringArray(value.evidenceEventIds)
);

const isApprovalRecord = (value: unknown): value is ApprovalRecord => (
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.goalId === 'string' &&
  typeof value.status === 'string' &&
  typeof value.requestedAction === 'string'
);

const isKernelEvent = (value: unknown): value is KernelEvent => (
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.type === 'string' &&
  typeof value.timestamp === 'string' &&
  typeof value.actor === 'string' &&
  isRecord(value.payload)
);

const isKernelControls = (value: unknown): value is KernelControls => (
  isRecord(value) && typeof value.stopAll === 'boolean'
);

const isMissionList = (value: unknown): value is { missions: ResearchMission[] } => (
  isRecord(value) && Array.isArray(value.missions) && value.missions.every(isResearchMission)
);

const isMissionDetail = (value: unknown): value is ResearchMissionDetail => (
  isRecord(value) &&
  isResearchMission(value.mission) &&
  isGoalContract(value.goal) &&
  Array.isArray(value.tasks) && value.tasks.every(isKernelTask) &&
  Array.isArray(value.approvals) && value.approvals.every(isApprovalRecord) &&
  Array.isArray(value.events) && value.events.every(isKernelEvent) &&
  isKernelControls(value.controls)
);

const isMissionReport = (value: unknown): value is ResearchMissionReport => (
  isRecord(value) && typeof value.content === 'string' && typeof value.contentHash === 'string'
);

const isMissionStepResult = (value: unknown): value is ResearchMissionStepResult => (
  isRecord(value) &&
  (value.outcome === 'advanced' || value.outcome === 'in_progress' || value.outcome === 'blocked' || value.outcome === 'completed') &&
  isResearchMission(value.mission)
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
  if (status === 'completed' || status === 'captured' || status === 'passed') {
    return 'border-emerald-800 text-emerald-300 bg-emerald-950/20';
  }
  if (status === 'blocked' || status === 'failed' || status === 'quarantined' || status === 'cancelled') {
    return 'border-rose-900 text-rose-300 bg-rose-950/20';
  }
  if (status === 'running' || status === 'verifying' || status === 'awaiting_approval') {
    return 'border-amber-800 text-amber-300 bg-amber-950/20';
  }
  return 'border-cyan-900 text-cyan-300 bg-cyan-950/20';
};

const eventSummary = (event: KernelEvent): string => {
  const evidence = event.payload.evidence;
  if (isRecord(evidence) && typeof evidence.summary === 'string') return evidence.summary;
  if (typeof event.payload.summary === 'string') return event.payload.summary;
  if (typeof event.payload.reason === 'string') return event.payload.reason;
  return event.type.replaceAll('.', ' ');
};

const parseSourceUrls = (
  value: string,
  config: ResearchMissionConfig,
): { urls?: string[]; error?: string } => {
  const rawUrls = value.split(/\r?\n/).map((url) => url.trim()).filter(Boolean);
  if (rawUrls.length < 1 || rawUrls.length > config.maxSources) {
    return { error: `Enter between 1 and ${config.maxSources} source URLs, one per line.` };
  }

  const urls: string[] = [];
  for (const rawUrl of rawUrls) {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return { error: `${rawUrl} is not a valid URL.` };
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
      return { error: 'Sources must be HTTPS URLs without credentials or fragments.' };
    }
    if (config.allowedOrigins.length > 0 && !config.allowedOrigins.includes(parsed.origin)) {
      return { error: `${parsed.origin} is outside the configured source origins.` };
    }
    urls.push(parsed.toString());
  }
  if (new Set(urls).size !== urls.length) {
    return { error: 'Source URLs must be unique after normalization.' };
  }
  return { urls };
};

const usageLabel = (used: number, maximum: number): string => `${used} / ${maximum}`;

interface ResearchMissionPanelProps {
  initialMissionId?: string | null;
}

export const ResearchMissionPanel: React.FC<ResearchMissionPanelProps> = ({ initialMissionId = null }) => {
  const [config, setConfig] = useState<ResearchMissionConfig | null>(null);
  const [missions, setMissions] = useState<ResearchMission[]>([]);
  const [selectedMissionId, setSelectedMissionId] = useState<string | null>(initialMissionId);
  const [detail, setDetail] = useState<ResearchMissionDetail | null>(null);
  const [report, setReport] = useState<ResearchMissionReport | null>(null);
  const [objective, setObjective] = useState('');
  const [sourceText, setSourceText] = useState('');
  const [resumeReason, setResumeReason] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [isReportLoading, setIsReportLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [activeAction, setActiveAction] = useState<MissionAction | null>(null);
  const [authRevision, setAuthRevision] = useState(0);
  const [session, setSession] = useState(() => getAuthSession());
  const authEpoch = useRef(0);

  const clearProtectedState = useCallback(() => {
    setConfig(null);
    setMissions([]);
    setSelectedMissionId(null);
    setDetail(null);
    setReport(null);
    setIsLoading(false);
    setIsDetailLoading(false);
    setIsReportLoading(false);
    setLoadError(null);
    setDetailError(null);
    setReportError(null);
    setActionError(null);
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

  useEffect(() => {
    if (initialMissionId) setSelectedMissionId(initialMissionId);
  }, [initialMissionId]);

  const fetchMissionList = useCallback(async (): Promise<ResearchMission[]> => {
    const payload = await requestJson('/api/kernel/research-missions');
    if (!isMissionList(payload)) throw new Error('Research mission list response is invalid.');
    return payload.missions;
  }, []);

  const fetchMissionDetail = useCallback(async (missionId: string): Promise<ResearchMissionDetail> => {
    const payload = await requestJson(`/api/kernel/research-missions/${encodeURIComponent(missionId)}`);
    if (!isMissionDetail(payload)) throw new Error('Research mission detail response is invalid.');
    return payload;
  }, []);

  useEffect(() => {
    let disposed = false;
    const epoch = authEpoch.current;
    const isCurrent = () => !disposed && epoch === authEpoch.current;
    const load = async () => {
      try {
        const [nextConfig, nextMissions] = await Promise.all([
          requestJson('/api/kernel/research-missions/config'),
          fetchMissionList(),
        ]);
        if (!isResearchMissionConfig(nextConfig)) {
          throw new Error('Research mission configuration response is invalid.');
        }
        if (isCurrent()) {
          setConfig(nextConfig);
          setMissions(nextMissions);
          setSelectedMissionId((current) => (
            current && nextMissions.some((mission) => mission.id === current)
              ? current
              : nextMissions[0]?.id ?? null
          ));
          setLoadError(null);
        }
      } catch (error) {
        clearForUnauthorized(error);
        if (isCurrent()) setLoadError(error instanceof Error ? error.message : 'Research missions are unavailable.');
      } finally {
        if (isCurrent()) setIsLoading(false);
      }
    };
    void load();
    const interval = window.setInterval(() => void load(), 5000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [authRevision, clearForUnauthorized, fetchMissionList]);

  useEffect(() => {
    if (!selectedMissionId) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    let disposed = false;
    const epoch = authEpoch.current;
    const isCurrent = () => !disposed && epoch === authEpoch.current;
    setDetail(null);
    setDetailError(null);
    setIsDetailLoading(true);
    const load = async () => {
      try {
        const nextDetail = await fetchMissionDetail(selectedMissionId);
        if (isCurrent()) {
          setDetail(nextDetail);
          setDetailError(null);
        }
      } catch (error) {
        clearForUnauthorized(error);
        if (isCurrent()) setDetailError(error instanceof Error ? error.message : 'Mission detail is unavailable.');
      } finally {
        if (isCurrent()) setIsDetailLoading(false);
      }
    };
    void load();
    const interval = window.setInterval(() => void load(), 5000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [authRevision, clearForUnauthorized, fetchMissionDetail, selectedMissionId]);

  const reportArtifactId = detail?.mission.reportArtifactId;
  const expectedReportHash = detail?.mission.reportContentHash;
  useEffect(() => {
    if (!selectedMissionId || !reportArtifactId) {
      setReport(null);
      setReportError(null);
      return;
    }
    let disposed = false;
    const epoch = authEpoch.current;
    const isCurrent = () => !disposed && epoch === authEpoch.current;
    setIsReportLoading(true);
    setReport(null);
    const load = async () => {
      try {
        const payload = await requestJson(`/api/kernel/research-missions/${encodeURIComponent(selectedMissionId)}/report`);
        if (!isMissionReport(payload)) throw new Error('Research mission report response is invalid.');
        if (expectedReportHash && payload.contentHash !== expectedReportHash) {
          throw new Error('Report content hash does not match the mission checkpoint.');
        }
        if (isCurrent()) {
          setReport(payload);
          setReportError(null);
        }
      } catch (error) {
        clearForUnauthorized(error);
        if (isCurrent()) setReportError(error instanceof Error ? error.message : 'Mission report is unavailable.');
      } finally {
        if (isCurrent()) setIsReportLoading(false);
      }
    };
    void load();
    return () => {
      disposed = true;
    };
  }, [authRevision, clearForUnauthorized, expectedReportHash, reportArtifactId, selectedMissionId]);

  const refreshAfterMutation = async (missionId: string): Promise<void> => {
    const epoch = authEpoch.current;
    const [nextMissions, nextDetail] = await Promise.all([
      fetchMissionList(),
      fetchMissionDetail(missionId),
    ]);
    if (epoch !== authEpoch.current) return;
    setMissions(nextMissions);
    setDetail(nextDetail);
    setSelectedMissionId(missionId);
    setLoadError(null);
    setDetailError(null);
  };

  const createMission = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!config || !config.available || activeAction) return;
    const normalizedObjective = objective.trim();
    if (!normalizedObjective) {
      setActionError('Research objective is required.');
      return;
    }
    const parsedSources = parseSourceUrls(sourceText, config);
    if (!parsedSources.urls) {
      setActionError(parsedSources.error ?? 'Source URLs are invalid.');
      return;
    }

    setActiveAction('create');
    setActionError(null);
    try {
      const payload = await requestJson('/api/kernel/research-missions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ objective: normalizedObjective, sourceUrls: parsedSources.urls }),
      });
      if (!isResearchMission(payload)) throw new Error('Research mission creation response is invalid.');
      setObjective('');
      setSourceText('');
      await refreshAfterMutation(payload.id);
    } catch (error) {
      clearForUnauthorized(error);
      setActionError(error instanceof Error ? error.message : 'Research mission creation failed.');
    } finally {
      setActiveAction(null);
    }
  };

  const invokeMissionAction = async (kind: 'run' | 'step') => {
    if (!selectedMissionId || activeAction) return;
    setActiveAction(kind);
    setActionError(null);
    try {
      const payload = await requestJson(`/api/kernel/research-missions/${encodeURIComponent(selectedMissionId)}/${kind}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!isMissionStepResult(payload) || payload.mission.id !== selectedMissionId) {
        throw new Error(`Mission ${kind} response is invalid.`);
      }
      await refreshAfterMutation(selectedMissionId);
    } catch (error) {
      clearForUnauthorized(error);
      setActionError(error instanceof Error ? error.message : `Mission ${kind} failed.`);
    } finally {
      setActiveAction(null);
    }
  };

  const resumeMission = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedMissionId || activeAction) return;
    const reason = resumeReason.trim();
    if (!reason) {
      setActionError('Resume reason is required.');
      return;
    }
    setActiveAction('resume');
    setActionError(null);
    try {
      const payload = await requestJson(`/api/kernel/research-missions/${encodeURIComponent(selectedMissionId)}/resume`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      if (!isResearchMission(payload) || payload.id !== selectedMissionId) {
        throw new Error('Mission resume response is invalid.');
      }
      setResumeReason('');
      await refreshAfterMutation(selectedMissionId);
    } catch (error) {
      clearForUnauthorized(error);
      setActionError(error instanceof Error ? error.message : 'Mission resume failed.');
    } finally {
      setActiveAction(null);
    }
  };

  const selectedMission = detail?.mission;
  const isViewer = session?.role === 'viewer';
  const isTerminal = selectedMission?.status === 'completed' || selectedMission?.status === 'cancelled';
  const canExecute = Boolean(
    config?.available &&
    selectedMission &&
    !isTerminal &&
    selectedMission.status !== 'blocked' &&
    !detail?.controls.stopAll &&
    !isViewer &&
    !activeAction,
  );
  const pendingApprovals = useMemo(
    () => detail?.approvals.filter((approval) => approval.status === 'pending') ?? [],
    [detail?.approvals],
  );
  const recentEvents = useMemo(
    () => [...(detail?.events ?? [])].sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp)).slice(0, 8),
    [detail?.events],
  );

  return (
    <section aria-labelledby="research-mission-title" className="rounded-3xl border border-slate-800 bg-[#101114]/90 p-5 shadow-2xl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-mono font-bold uppercase tracking-[0.35em] text-cyan-400">Mission Control</p>
          <h2 id="research-mission-title" className="mt-1 text-xl font-black tracking-tight text-white">Research To Verified Report</h2>
          <p className="mt-2 max-w-2xl text-xs leading-relaxed text-slate-400">
            Capture explicit sources, synthesize citation-bound claims, run deterministic checks and a separate critique, then publish only recorded evidence.
          </p>
        </div>
        <span className={`rounded-full border px-3 py-1 text-[10px] font-mono ${config?.available ? 'border-emerald-800 text-emerald-300' : 'border-amber-800 text-amber-300'}`}>
          {config ? (config.available ? 'Runtime available' : 'Runtime unavailable') : 'Checking runtime...'}
        </span>
      </div>

      {isLoading && <p role="status" className="mt-4 rounded-lg border border-cyan-900/50 bg-cyan-950/20 px-3 py-2 text-xs text-cyan-300">Loading research missions...</p>}
      {loadError && <p role="alert" className="mt-4 rounded-lg border border-rose-900/60 bg-rose-950/20 px-3 py-2 text-xs text-rose-300">Research missions unavailable: {loadError}</p>}
      {actionError && <p role="alert" className="mt-4 rounded-lg border border-rose-900/60 bg-rose-950/20 px-3 py-2 text-xs text-rose-300">{actionError}</p>}
      {config && !config.available && <p className="mt-4 rounded-lg border border-amber-900/60 bg-amber-950/20 px-3 py-2 text-xs text-amber-300">{config.reason}</p>}
      {isViewer && <p className="mt-4 rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2 text-xs text-slate-300">Viewer sessions can inspect missions but cannot create, run, step, or resume them.</p>}

      <div className="mt-5 grid grid-cols-1 gap-4 xl:grid-cols-[1.15fr_0.85fr]">
        <form onSubmit={(event) => void createMission(event)} className="rounded-2xl border border-slate-800 bg-black/20 p-4">
          <div className="text-sm font-bold text-slate-100">New Research Mission</div>
          <p className="mt-1 text-[10px] leading-relaxed text-slate-500">The kernel derives browser scope from these URLs. Sources cannot add authority or change the mission.</p>
          <label className="mt-4 block text-[10px] font-mono font-bold uppercase tracking-wider text-slate-500">
            Research objective
            <textarea
              value={objective}
              onChange={(event) => setObjective(event.target.value)}
              rows={3}
              maxLength={2000}
              disabled={!config?.available || isViewer || activeAction !== null}
              className="mt-1.5 w-full resize-y rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs font-sans normal-case text-slate-200 outline-none focus:border-cyan-700 disabled:opacity-50"
              placeholder="Compare the evidence for..."
            />
          </label>
          <label className="mt-3 block text-[10px] font-mono font-bold uppercase tracking-wider text-slate-500">
            HTTPS source URLs, one per line
            <textarea
              value={sourceText}
              onChange={(event) => setSourceText(event.target.value)}
              rows={4}
              disabled={!config?.available || isViewer || activeAction !== null}
              className="mt-1.5 w-full resize-y rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs font-mono normal-case text-slate-200 outline-none focus:border-cyan-700 disabled:opacity-50"
              placeholder="https://example.com/source"
            />
          </label>
          {config && (
            <div className="mt-3 rounded-lg border border-slate-800 bg-slate-950/40 p-2.5 text-[10px] text-slate-500">
              <p>Maximum {config.maxSources} source{config.maxSources === 1 ? '' : 's'}.</p>
              <p className="mt-1 break-all">Allowed origins: {config.allowedOrigins.length > 0 ? config.allowedOrigins.join(', ') : 'None configured'}</p>
            </div>
          )}
          <button
            type="submit"
            disabled={!config?.available || isViewer || activeAction !== null}
            className="mt-3 rounded-lg bg-cyan-700 px-4 py-2 text-xs font-bold text-white hover:bg-cyan-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {activeAction === 'create' ? 'Creating...' : 'Create mission'}
          </button>
        </form>

        <div className="rounded-2xl border border-slate-800 bg-black/20 p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-bold text-slate-100">Mission Ledger</div>
            <span className="text-[10px] font-mono text-slate-500">{missions.length} recorded</span>
          </div>
          {!isLoading && !loadError && missions.length === 0 && <p className="mt-4 text-xs text-slate-500">No research missions yet.</p>}
          {missions.length > 0 && (
            <ul className="mt-3 max-h-72 space-y-2 overflow-y-auto pr-1">
              {[...missions].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)).map((mission) => (
                <li key={mission.id}>
                  <button
                    type="button"
                    aria-pressed={selectedMissionId === mission.id}
                    onClick={() => setSelectedMissionId(mission.id)}
                    className={`w-full rounded-xl border p-3 text-left transition ${selectedMissionId === mission.id ? 'border-cyan-800 bg-cyan-950/20' : 'border-slate-800 bg-slate-950/40 hover:border-slate-700'}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="line-clamp-2 text-xs font-semibold leading-relaxed text-slate-200">{mission.objective}</span>
                      <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[9px] uppercase ${statusClass(mission.status)}`}>{mission.status}</span>
                    </div>
                    <p className="mt-2 text-[9px] font-mono uppercase tracking-wider text-slate-600">Checkpoint {mission.checkpoint} / revision {mission.revision}</p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {isDetailLoading && !detail && <p role="status" className="mt-4 text-xs text-cyan-300">Loading selected mission...</p>}
      {detailError && <p role="alert" className="mt-4 rounded-lg border border-rose-900/60 bg-rose-950/20 px-3 py-2 text-xs text-rose-300">Mission detail unavailable: {detailError}</p>}

      {detail && selectedMission && (
        <div className="mt-5 space-y-4" data-testid={`research-mission-${selectedMission.id}`}>
          <div className="rounded-2xl border border-slate-800 bg-black/20 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-[10px] font-mono uppercase tracking-wider text-slate-500">Active mission</p>
                <h3 className="mt-1 text-base font-black leading-snug text-white">{selectedMission.objective}</h3>
                <p className="mt-1 text-[10px] font-mono text-slate-600">{selectedMission.id} / goal {selectedMission.goalId}</p>
              </div>
              <span className={`rounded-full border px-3 py-1 text-[10px] font-mono uppercase ${statusClass(selectedMission.status)}`}>{selectedMission.status}</span>
            </div>

            {detail.controls.stopAll && <p className="mt-3 rounded-lg border border-rose-900/60 bg-rose-950/20 px-3 py-2 text-xs text-rose-300">Stop All is active{detail.controls.stopAllReason ? `: ${detail.controls.stopAllReason}` : '.'}</p>}
            {selectedMission.lastError && <p className="mt-3 rounded-lg border border-amber-900/60 bg-amber-950/20 px-3 py-2 text-xs text-amber-300">{selectedMission.lastError}</p>}

            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" disabled={!canExecute} onClick={() => void invokeMissionAction('run')} className="rounded-lg bg-cyan-700 px-3 py-1.5 text-xs font-bold text-white hover:bg-cyan-600 disabled:opacity-50">
                {activeAction === 'run' ? 'Running...' : 'Run bounded loop'}
              </button>
              <button type="button" disabled={!canExecute} onClick={() => void invokeMissionAction('step')} className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-bold text-slate-200 hover:border-cyan-700 hover:text-cyan-300 disabled:opacity-50">
                {activeAction === 'step' ? 'Stepping...' : 'Run one step'}
              </button>
            </div>

            {selectedMission.status === 'blocked' && selectedMission.retryable && (
              <form onSubmit={(event) => void resumeMission(event)} className="mt-4 flex flex-col gap-2 rounded-xl border border-amber-900/50 bg-amber-950/10 p-3 sm:flex-row sm:items-end">
                <label className="flex-1 text-[10px] font-mono font-bold uppercase tracking-wider text-amber-300">
                  Resume reason
                  <input value={resumeReason} onChange={(event) => setResumeReason(event.target.value)} disabled={isViewer || activeAction !== null || detail.controls.stopAll} className="mt-1.5 w-full rounded-lg border border-amber-900/60 bg-slate-950 px-3 py-2 text-xs font-sans normal-case text-slate-200 outline-none focus:border-amber-600 disabled:opacity-50" />
                </label>
                <button type="submit" disabled={isViewer || activeAction !== null || detail.controls.stopAll} className="rounded-lg bg-amber-700 px-3 py-2 text-xs font-bold text-white hover:bg-amber-600 disabled:opacity-50">
                  {activeAction === 'resume' ? 'Resuming...' : 'Resume mission'}
                </button>
              </form>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3"><p className="text-[9px] font-mono uppercase text-slate-600">Operations</p><p className="mt-1 text-xs font-bold text-slate-200">{usageLabel(detail.goal.usage.operations, detail.goal.budget.maxOperations)}</p></div>
            <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3"><p className="text-[9px] font-mono uppercase text-slate-600">Provider calls</p><p className="mt-1 text-xs font-bold text-slate-200">{usageLabel(detail.goal.usage.providerCalls, detail.goal.budget.maxProviderCalls)}</p></div>
            <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3"><p className="text-[9px] font-mono uppercase text-slate-600">Sources captured</p><p className="mt-1 text-xs font-bold text-slate-200">{selectedMission.sources.filter((source) => source.status === 'captured').length} / {selectedMission.sources.length}</p></div>
            <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3"><p className="text-[9px] font-mono uppercase text-slate-600">Evidence events</p><p className="mt-1 text-xs font-bold text-slate-200">{detail.events.length}</p></div>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="rounded-2xl border border-slate-800 bg-black/20 p-4">
              <div className="text-sm font-bold text-slate-100">Task Graph</div>
              <ul className="mt-3 space-y-2">
                {detail.tasks.map((task) => (
                  <li key={task.id} className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
                    <div className="flex items-start justify-between gap-2"><span className="text-xs font-semibold text-slate-200">{task.title}</span><span className={`shrink-0 rounded-full border px-2 py-0.5 text-[9px] uppercase ${statusClass(task.status)}`}>{task.status}</span></div>
                    <p className="mt-1 text-[10px] leading-relaxed text-slate-500">{task.expectedEvidence}</p>
                    <p className="mt-2 text-[9px] font-mono uppercase text-slate-600">{task.missionStep ?? task.capabilityFamily} / {task.evidenceEventIds.length} evidence</p>
                  </li>
                ))}
              </ul>
            </div>

            <div className="rounded-2xl border border-slate-800 bg-black/20 p-4">
              <div className="flex items-center justify-between gap-2"><div className="text-sm font-bold text-slate-100">Captured Sources</div><span className="text-[10px] font-mono text-slate-500">Read-only</span></div>
              <ul className="mt-3 space-y-2">
                {selectedMission.sources.map((source) => (
                  <li key={source.id} className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
                    <div className="flex items-start justify-between gap-2"><a href={source.url} target="_blank" rel="noreferrer noopener" className="break-all text-xs font-semibold text-cyan-300 hover:underline">{source.id}: {source.url}</a><span className={`shrink-0 rounded-full border px-2 py-0.5 text-[9px] uppercase ${statusClass(source.status)}`}>{source.status}</span></div>
                    <p className="mt-2 text-[10px] text-slate-500">{source.chunks.length} authenticated chunk{source.chunks.length === 1 ? '' : 's'} / risk {source.observationRisk ?? 'unassessed'}</p>
                    {source.injectionSignalCodes.length > 0 && <p className="mt-1 text-[10px] text-amber-300">Signals: {source.injectionSignalCodes.join(', ')}</p>}
                    {source.failureReason && <p className="mt-1 text-[10px] text-rose-300">{source.failureReason}</p>}
                    {source.contentHash && <p className="mt-1 break-all font-mono text-[9px] text-slate-600">sha256 {source.contentHash}</p>}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {selectedMission.draft && (
            <div className="rounded-2xl border border-slate-800 bg-black/20 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2"><div className="text-sm font-bold text-slate-100">Grounded Claims</div><span className={`rounded-full border px-2 py-0.5 text-[9px] uppercase ${statusClass(selectedMission.verification?.status ?? 'draft')}`}>{selectedMission.verification ? `verification ${selectedMission.verification.status}` : 'draft'}</span></div>
              <p className="mt-2 text-xs leading-relaxed text-slate-400">{selectedMission.draft.executiveSummary}</p>
              <ul className="mt-3 space-y-3">
                {selectedMission.draft.claims.map((claim) => (
                  <li key={claim.id} className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
                    <p className="text-xs font-semibold leading-relaxed text-slate-200">{claim.statement}</p>
                    <p className="mt-1 text-[9px] font-mono uppercase text-slate-600">{claim.id} / confidence {claim.confidence}</p>
                    {claim.evidence.map((evidence, index) => <blockquote key={`${claim.id}-${evidence.sourceId}-${evidence.chunkId}-${index}`} className="mt-2 border-l border-cyan-800 pl-2 text-[10px] leading-relaxed text-slate-400">{evidence.quote}<span className="mt-1 block font-mono text-[9px] text-slate-600">{evidence.sourceId} / {evidence.chunkId}</span></blockquote>)}
                  </li>
                ))}
              </ul>
              {selectedMission.verification && (
                <div className="mt-3 rounded-xl border border-slate-800 bg-slate-950/40 p-3"><p className="text-xs font-semibold text-slate-200">Separate critique pass: {selectedMission.verification.criticVerdict}</p><p className="mt-1 text-[10px] leading-relaxed text-slate-500">{selectedMission.verification.criticSummary}</p>{selectedMission.verification.deterministicIssues.length > 0 && <p className="mt-2 text-[10px] text-rose-300">Deterministic issues: {selectedMission.verification.deterministicIssues.join('; ')}</p>}</div>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="rounded-2xl border border-slate-800 bg-black/20 p-4">
              <div className="flex items-center justify-between gap-2"><div className="text-sm font-bold text-slate-100">Evidence Feed</div><span className="text-[10px] font-mono text-slate-500">{pendingApprovals.length} pending approvals</span></div>
              {recentEvents.length === 0 ? <p className="mt-3 text-xs text-slate-500">No mission evidence recorded yet.</p> : <ul className="mt-3 space-y-2">{recentEvents.map((event) => <li key={event.id} className="rounded-lg border border-slate-800 bg-slate-950/40 p-2.5"><p className="text-xs leading-relaxed text-slate-300">{eventSummary(event)}</p><p className="mt-1 text-[9px] font-mono uppercase text-slate-600">{event.type} / {event.actor}</p></li>)}</ul>}
            </div>

            <div className="rounded-2xl border border-slate-800 bg-black/20 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2"><div className="text-sm font-bold text-slate-100">Report Artifact</div>{selectedMission.reportArtifactId && <span className={`rounded-full border px-2 py-0.5 text-[9px] uppercase ${statusClass(selectedMission.verification?.status ?? 'draft')}`}>{selectedMission.verification?.status === 'passed' ? 'Verified report' : 'Unverified report'}</span>}</div>
              {!selectedMission.reportArtifactId && <p className="mt-3 text-xs text-slate-500">No report has been published.</p>}
              {isReportLoading && <p role="status" className="mt-3 text-xs text-cyan-300">Loading report artifact...</p>}
              {reportError && <p role="alert" className="mt-3 text-xs text-rose-300">{reportError}</p>}
              {report && <><p className="mt-3 break-all font-mono text-[9px] text-slate-600">sha256 {report.contentHash}</p><pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-xs leading-relaxed text-slate-300 select-text">{report.content}</pre></>}
              {selectedMission.providerRuns.length > 0 && <ul className="mt-3 space-y-1.5">{selectedMission.providerRuns.map((run) => <li key={run.requestId} className="rounded-lg border border-slate-800 px-2.5 py-2 text-[10px] text-slate-400"><span className="font-mono text-cyan-300">{run.purpose}: {run.provider} / {run.model}</span><span className="mt-1 block">{run.totalTokens} tokens / {run.latencyMs} ms</span></li>)}</ul>}
            </div>
          </div>
        </div>
      )}
    </section>
  );
};

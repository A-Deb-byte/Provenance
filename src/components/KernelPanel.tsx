import React, { useEffect, useState } from 'react';
import type { ApprovalRecord, GoalContract, KernelEvent } from '../kernel/types';

interface KernelSnapshot {
  goals: GoalContract[];
  approvals: ApprovalRecord[];
  events: KernelEvent[];
}

const emptySnapshot: KernelSnapshot = {
  goals: [],
  approvals: [],
  events: [],
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const fetchCollection = async <T,>(url: string, key: string): Promise<T[]> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${key} request failed with status ${response.status}.`);
  }

  const payload: unknown = await response.json();
  if (!isRecord(payload) || !Array.isArray(payload[key])) {
    throw new Error(`${key} response is invalid.`);
  }
  return payload[key] as T[];
};

const getNextVerificationCommand = (goal: GoalContract): string | null => {
  if (goal.status !== 'drafted' && goal.status !== 'active' && goal.status !== 'blocked') {
    return null;
  }

  const operationCount = Number.isInteger(goal.usage?.operations)
    ? Math.max(0, goal.usage.operations)
    : 0;
  return goal.verificationCommands[operationCount] ?? null;
};

const getEventSummary = (event: KernelEvent): string => {
  const evidence = event.payload.evidence;
  if (isRecord(evidence) && typeof evidence.summary === 'string') {
    return evidence.summary;
  }
  if (typeof event.payload.summary === 'string') return event.payload.summary;
  if (typeof event.payload.reason === 'string') return event.payload.reason;
  return event.type.replaceAll('.', ' ');
};

export const KernelPanel: React.FC = () => {
  const [snapshot, setSnapshot] = useState<KernelSnapshot>(emptySnapshot);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isDisposed = false;

    const loadSnapshot = async () => {
      try {
        const [goals, approvals, events] = await Promise.all([
          fetchCollection<GoalContract>('/api/kernel/goals', 'goals'),
          fetchCollection<ApprovalRecord>('/api/kernel/approvals', 'approvals'),
          fetchCollection<KernelEvent>('/api/kernel/events', 'events'),
        ]);
        if (!isDisposed) {
          setSnapshot({ goals, approvals, events });
          setError(null);
        }
      } catch (loadError) {
        if (!isDisposed) {
          setError(loadError instanceof Error ? loadError.message : 'Unknown kernel request failure.');
        }
      } finally {
        if (!isDisposed) setIsLoading(false);
      }
    };

    void loadSnapshot();
    const interval = setInterval(() => {
      void loadSnapshot();
    }, 5000);
    return () => {
      isDisposed = true;
      clearInterval(interval);
    };
  }, []);

  const goals = [...snapshot.goals]
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, 3);
  const pendingApprovals = snapshot.approvals
    .filter((approval) => approval.status === 'pending')
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .slice(0, 3);
  const recentEvents = [...snapshot.events]
    .sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp))
    .slice(0, 3);

  return (
    <section
      aria-labelledby="kernel-panel-title"
      className="rounded-3xl border border-slate-800 bg-[#101114]/90 p-5 shadow-2xl"
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-[0.35em] text-cyan-400 font-mono">
            Kernel MVP
          </p>
          <h2 id="kernel-panel-title" className="text-xl font-black text-white tracking-tight mt-1">
            Trusted Local Control Plane
          </h2>
        </div>
        <span className="text-[10px] font-mono text-slate-400 border border-slate-700 rounded-full px-3 py-1">
          Phase 1
        </span>
      </div>

      {isLoading && (
        <p role="status" className="mt-4 rounded-lg border border-cyan-900/50 bg-cyan-950/20 px-3 py-2 text-xs text-cyan-300">
          Loading kernel state...
        </p>
      )}
      {!isLoading && error && (
        <p role="alert" className="mt-4 rounded-lg border border-rose-900/60 bg-rose-950/20 px-3 py-2 text-xs text-rose-300">
          Kernel state unavailable: {error}
        </p>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-5">
        <div className="rounded-2xl border border-slate-800 bg-black/20 p-4">
          <div className="text-sm font-bold text-slate-100">Goal Contracts</div>
          <p className="text-xs text-slate-400 mt-2">
            Objectives, constraints, budgets, and verification commands are owned by the kernel API.
          </p>
          {!isLoading && !error && (
            goals.length === 0 ? (
              <p className="mt-4 text-xs text-slate-500">No goal contracts yet.</p>
            ) : (
              <ul className="mt-4 space-y-2">
                {goals.map((goal) => {
                  const nextCommand = getNextVerificationCommand(goal);
                  return (
                    <li key={goal.id} className="rounded-lg border border-slate-800 bg-slate-950/50 p-2.5">
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-xs font-semibold text-slate-200">{goal.objective}</p>
                        <span className="shrink-0 rounded-full border border-slate-700 px-1.5 py-0.5 text-[9px] uppercase text-cyan-300">
                          {goal.status}
                        </span>
                      </div>
                      <div className="mt-2 text-[10px] text-slate-500">
                        <span className="block uppercase tracking-wider">Next task</span>
                        <code className="mt-0.5 block break-all text-slate-300">
                          {nextCommand ?? 'No eligible task'}
                        </code>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )
          )}
        </div>
        <div className="rounded-2xl border border-slate-800 bg-black/20 p-4">
          <div className="text-sm font-bold text-slate-100">Approval Broker</div>
          <p className="text-xs text-slate-400 mt-2">
            Risky actions block until explicit approval or denial is recorded.
          </p>
          {!isLoading && !error && (
            pendingApprovals.length === 0 ? (
              <p className="mt-4 text-xs text-slate-500">No pending approvals.</p>
            ) : (
              <ul className="mt-4 space-y-2">
                {pendingApprovals.map((approval) => (
                  <li key={approval.id} className="rounded-lg border border-amber-900/40 bg-amber-950/10 p-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <code className="break-all text-xs text-amber-200">{approval.requestedAction}</code>
                      <span className="shrink-0 text-[9px] font-bold uppercase text-amber-400">
                        {approval.riskLevel}
                      </span>
                    </div>
                    <p className="mt-1.5 text-[10px] leading-relaxed text-slate-500">{approval.reason}</p>
                  </li>
                ))}
              </ul>
            )
          )}
        </div>
        <div className="rounded-2xl border border-slate-800 bg-black/20 p-4">
          <div className="text-sm font-bold text-slate-100">Evidence Ledger</div>
          <p className="text-xs text-slate-400 mt-2">
            Task outcomes link to recorded events instead of generated progress stories.
          </p>
          {!isLoading && !error && (
            recentEvents.length === 0 ? (
              <p className="mt-4 text-xs text-slate-500">No evidence recorded yet.</p>
            ) : (
              <ul className="mt-4 space-y-2">
                {recentEvents.map((event) => (
                  <li key={event.id} className="rounded-lg border border-slate-800 bg-slate-950/50 p-2.5">
                    <p className="text-xs leading-relaxed text-slate-300">{getEventSummary(event)}</p>
                    <p className="mt-1 text-[9px] uppercase tracking-wider text-slate-600">
                      {event.type} / {event.actor}
                    </p>
                  </li>
                ))}
              </ul>
            )
          )}
        </div>
      </div>
    </section>
  );
};

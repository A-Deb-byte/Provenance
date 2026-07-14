import React, { useEffect, useState } from 'react';
import type { KernelMemoryRecord, SkillEvaluation, SkillPackage } from '../kernel/types';
import { authenticatedFetch } from '../lib/auth';

interface LearningSnapshot {
  memories: KernelMemoryRecord[];
  skills: SkillPackage[];
  evaluations: SkillEvaluation[];
}

type MemoryActionKind = 'promote' | 'revoke';

interface MemoryActionDraft {
  memoryId: string;
  kind: MemoryActionKind;
  reason: string;
}

const emptySnapshot: LearningSnapshot = {
  memories: [],
  skills: [],
  evaluations: [],
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const isKernelMemoryRecord = (value: unknown): value is KernelMemoryRecord => (
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.kind === 'string' &&
  typeof value.status === 'string' &&
  typeof value.content === 'string' &&
  typeof value.contentHash === 'string' &&
  Array.isArray(value.evidenceRefs)
);

const isSkillPackage = (value: unknown): value is SkillPackage => (
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.status === 'string' &&
  isRecord(value.manifest) &&
  typeof value.manifest.name === 'string' &&
  typeof value.manifest.version === 'string'
);

const isSkillEvaluation = (value: unknown): value is SkillEvaluation => (
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.skillId === 'string' &&
  typeof value.baselineScore === 'number' &&
  Number.isFinite(value.baselineScore) &&
  typeof value.candidateScore === 'number' &&
  Number.isFinite(value.candidateScore)
);

const fetchCollection = async <T,>(
  url: string,
  key: string,
  guard: (value: unknown) => value is T,
): Promise<T[]> => {
  const response = await authenticatedFetch(url);
  if (!response.ok) throw new Error(`${key} request failed with status ${response.status}.`);
  const payload: unknown = await response.json();
  if (!isRecord(payload) || !Array.isArray(payload[key]) || !payload[key].every(guard)) {
    throw new Error(`${key} response is invalid.`);
  }
  return payload[key] as T[];
};

const statusClass = (status: string): string => {
  if (status === 'promoted') return 'border-emerald-800 text-emerald-300 bg-emerald-950/20';
  if (status === 'revoked' || status === 'rejected' || status === 'rolled_back') {
    return 'border-rose-900 text-rose-300 bg-rose-950/20';
  }
  if (status === 'canary' || status === 'evaluated') return 'border-amber-800 text-amber-300 bg-amber-950/20';
  if (status === 'superseded') return 'border-slate-700 text-slate-400 bg-slate-900/40';
  return 'border-cyan-900 text-cyan-300 bg-cyan-950/20';
};

const latestEvaluation = (
  evaluations: readonly SkillEvaluation[],
  skillId: string,
): SkillEvaluation | undefined => {
  return evaluations
    .filter((evaluation) => evaluation.skillId === skillId)
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
    .at(-1);
};

const formatScore = (score: number): string => `${(score * 100).toFixed(1)}%`;

export const LearningPanel: React.FC = () => {
  const [snapshot, setSnapshot] = useState<LearningSnapshot>(emptySnapshot);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [action, setAction] = useState<MemoryActionDraft | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    let disposed = false;
    const load = async () => {
      try {
        const [memories, skills, evaluations] = await Promise.all([
          fetchCollection('/api/kernel/memories', 'memories', isKernelMemoryRecord),
          fetchCollection('/api/kernel/skills', 'skills', isSkillPackage),
          fetchCollection('/api/kernel/skill-evaluations', 'evaluations', isSkillEvaluation),
        ]);
        if (!disposed) {
          setSnapshot({ memories, skills, evaluations });
          setLoadError(null);
        }
      } catch (error) {
        if (!disposed) setLoadError(error instanceof Error ? error.message : 'Unknown learning request failure.');
      } finally {
        if (!disposed) setIsLoading(false);
      }
    };
    void load();
    const interval = setInterval(() => {
      void load();
    }, 5000);
    return () => {
      disposed = true;
      clearInterval(interval);
    };
  }, []);

  const beginAction = (memoryId: string, kind: MemoryActionKind) => {
    setAction({ memoryId, kind, reason: '' });
    setActionError(null);
  };

  const submitAction = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!action) return;
    const reason = action.reason.trim();
    if (!reason) {
      setActionError(`${action.kind === 'promote' ? 'Promotion' : 'Revocation'} reason is required.`);
      return;
    }

    setIsSubmitting(true);
    setActionError(null);
    try {
      const response = await authenticatedFetch(
        `/api/kernel/memories/${encodeURIComponent(action.memoryId)}/${action.kind}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reason }),
        },
      );
      const payload: unknown = await response.json();
      if (!response.ok) {
        const message = isRecord(payload) && typeof payload.error === 'string'
          ? payload.error
          : `Memory ${action.kind} request failed with status ${response.status}.`;
        throw new Error(message);
      }
      if (!isKernelMemoryRecord(payload) || payload.id !== action.memoryId) {
        throw new Error(`Memory ${action.kind} response is invalid.`);
      }
      setSnapshot((current) => ({
        ...current,
        memories: current.memories.map((memory) => memory.id === payload.id ? payload : memory),
      }));
      setAction(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unknown memory lifecycle failure.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const memories = [...snapshot.memories]
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const skills = [...snapshot.skills]
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));

  return (
    <section
      aria-labelledby="learning-panel-title"
      className="rounded-3xl border border-slate-800 bg-[#101114]/90 p-5 shadow-2xl"
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-[0.35em] text-violet-400 font-mono">Learning Cockpit</p>
          <h2 id="learning-panel-title" className="text-xl font-black text-white tracking-tight mt-1">
            Evidence-Gated Memory And Skills
          </h2>
        </div>
        <span className="text-[10px] font-mono text-slate-400 border border-slate-700 rounded-full px-3 py-1">
          Phase 2
        </span>
      </div>

      {isLoading && (
        <p role="status" className="mt-4 rounded-lg border border-violet-900/50 bg-violet-950/20 px-3 py-2 text-xs text-violet-300">
          Loading learning state...
        </p>
      )}
      {!isLoading && loadError && (
        <p role="alert" className="mt-4 rounded-lg border border-rose-900/60 bg-rose-950/20 px-3 py-2 text-xs text-rose-300">
          Learning state unavailable: {loadError}
        </p>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-5">
        <div className="rounded-2xl border border-slate-800 bg-black/20 p-4">
          <div className="text-sm font-bold text-slate-100">Kernel Memory</div>
          <p className="text-xs text-slate-400 mt-2">
            Candidates become active only through evidence-backed promotion. Revocation preserves their audit history.
          </p>
          {!isLoading && !loadError && (
            memories.length === 0 ? (
              <p className="mt-4 text-xs text-slate-500">No kernel memory records yet.</p>
            ) : (
              <ul className="mt-4 space-y-3">
                {memories.map((memory) => {
                  const currentAction = action?.memoryId === memory.id ? action : null;
                  const evidenceLabel = `${memory.evidenceRefs.length} evidence ref${memory.evidenceRefs.length === 1 ? '' : 's'}`;
                  return (
                    <li
                      key={memory.id}
                      data-testid={`memory-${memory.id}`}
                      className="rounded-xl border border-slate-800 bg-slate-950/50 p-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-xs leading-relaxed text-slate-200">{memory.content}</p>
                          <p className="mt-1.5 text-[10px] uppercase tracking-wider text-slate-500">
                            {memory.kind} / <span>{evidenceLabel}</span>
                          </p>
                        </div>
                        <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[9px] uppercase ${statusClass(memory.status)}`}>
                          {memory.status}
                        </span>
                      </div>

                      {!currentAction && memory.status !== 'revoked' && memory.status !== 'superseded' && (
                        <div className="mt-3 flex gap-2">
                          {memory.status === 'candidate' && (
                            <button
                              type="button"
                              onClick={() => beginAction(memory.id, 'promote')}
                              className="rounded-md border border-emerald-900 bg-emerald-950/20 px-2.5 py-1 text-[10px] font-bold text-emerald-300"
                            >
                              Promote
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => beginAction(memory.id, 'revoke')}
                            className="rounded-md border border-rose-900 bg-rose-950/20 px-2.5 py-1 text-[10px] font-bold text-rose-300"
                          >
                            Revoke
                          </button>
                        </div>
                      )}

                      {currentAction && (
                        <form className="mt-3 space-y-2" onSubmit={submitAction}>
                          <label
                            htmlFor={`memory-reason-${memory.id}`}
                            className="block text-[10px] font-bold uppercase tracking-wider text-slate-400"
                          >
                            {currentAction.kind === 'promote' ? 'Promotion reason' : 'Revocation reason'}
                          </label>
                          <input
                            id={`memory-reason-${memory.id}`}
                            value={currentAction.reason}
                            onChange={(event) => setAction({ ...currentAction, reason: event.target.value })}
                            disabled={isSubmitting}
                            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-200 outline-none focus:border-violet-600"
                          />
                          {actionError && <p role="alert" className="text-[10px] text-rose-300">{actionError}</p>}
                          <div className="flex gap-2">
                            <button
                              type="submit"
                              disabled={isSubmitting}
                              className="rounded-md bg-violet-700 px-2.5 py-1 text-[10px] font-bold text-white disabled:opacity-50"
                            >
                              {currentAction.kind === 'promote' ? 'Confirm promotion' : 'Confirm revocation'}
                            </button>
                            <button
                              type="button"
                              disabled={isSubmitting}
                              onClick={() => {
                                setAction(null);
                                setActionError(null);
                              }}
                              className="rounded-md border border-slate-700 px-2.5 py-1 text-[10px] text-slate-300 disabled:opacity-50"
                            >
                              Cancel
                            </button>
                          </div>
                        </form>
                      )}
                    </li>
                  );
                })}
              </ul>
            )
          )}
        </div>

        <div className="rounded-2xl border border-slate-800 bg-black/20 p-4">
          <div className="text-sm font-bold text-slate-100">Skill Foundry</div>
          <p className="text-xs text-slate-400 mt-2">
            Skill lifecycle and deterministic evaluation evidence are projected here without executing arbitrary generated code.
          </p>
          {!isLoading && !loadError && (
            skills.length === 0 ? (
              <p className="mt-4 text-xs text-slate-500">No skill packages yet.</p>
            ) : (
              <ul className="mt-4 space-y-3">
                {skills.map((skill) => {
                  const evaluation = latestEvaluation(snapshot.evaluations, skill.id);
                  return (
                    <li
                      key={skill.id}
                      data-testid={`skill-${skill.id}`}
                      className="rounded-xl border border-slate-800 bg-slate-950/50 p-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-xs font-bold text-slate-200">{skill.manifest.name}</p>
                          <p className="mt-1 text-[10px] text-slate-500">Version {skill.manifest.version}</p>
                        </div>
                        <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[9px] uppercase ${statusClass(skill.status)}`}>
                          {skill.status}
                        </span>
                      </div>
                      {evaluation ? (
                        <div className="mt-3 grid grid-cols-2 gap-2 text-[10px]">
                          <span className="rounded-md border border-slate-800 px-2 py-1 text-slate-400">
                            Baseline {formatScore(evaluation.baselineScore)}
                          </span>
                          <span className="rounded-md border border-violet-900/60 px-2 py-1 text-violet-300">
                            Candidate {formatScore(evaluation.candidateScore)}
                          </span>
                        </div>
                      ) : (
                        <p className="mt-3 text-[10px] text-slate-500">No evaluation recorded for this skill.</p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )
          )}

          {!isLoading && !loadError && snapshot.evaluations.length === 0 && (
            <p className="mt-4 text-xs text-slate-500">No skill evaluations yet.</p>
          )}
          {!isLoading && !loadError && snapshot.evaluations.length > 0 && (
            <p className="mt-4 text-[10px] uppercase tracking-wider text-slate-600">
              {snapshot.evaluations.length} recorded evaluation{snapshot.evaluations.length === 1 ? '' : 's'}
            </p>
          )}
        </div>
      </div>
    </section>
  );
};

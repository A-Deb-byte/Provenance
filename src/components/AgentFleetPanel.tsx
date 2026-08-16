import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Bot, Brain, ChevronRight, Layers, Play, PowerOff, ShieldAlert, ShieldCheck, Sparkles, Split, XOctagon } from 'lucide-react';
import type {
  AgentAuthorityMode,
  AgentDomain,
  AgentFleetState,
  AgentProposal,
  AgentSpawn,
  AgentTier,
} from '../kernel/agents/types';
import { authenticatedFetch } from '../lib/auth';

const TIERS: { value: AgentTier; label: string; ceiling: string }[] = [
  { value: 'T0_reader', label: 'T0 Reader', ceiling: 'L0' },
  { value: 'T1_operator', label: 'T1 Operator', ceiling: 'L2' },
  { value: 'T2_connector', label: 'T2 Connector', ceiling: 'L3' },
  { value: 'T3_orchestrator', label: 'T3 Orchestrator', ceiling: 'L0 + may spawn' },
];

const DOMAINS: AgentDomain[] = ['research', 'web', 'desktop', 'code', 'connector'];

/**
 * The authority selector is the consequential control on this panel, so each
 * option states plainly what it costs in oversight rather than only what it
 * enables. An operator choosing `autonomous` should not be able to say later
 * that the interface implied per-action review still applied.
 */
const AUTHORITY_MODES: {
  value: AgentAuthorityMode;
  label: string;
  consequence: string;
  elevated: boolean;
}[] = [
  {
    value: 'propose_only',
    label: 'Propose only',
    consequence: 'Agent works freely at L0/L1 and proposes anything consequential. You approve each one.',
    elevated: false,
  },
  {
    value: 'envelope',
    label: 'Bounded envelope',
    consequence: 'Agent acts without per-action prompts inside a bounded, expiring delegation you approve once.',
    elevated: true,
  },
  {
    value: 'autonomous',
    label: 'Autonomous',
    consequence: 'Agent self-authorises up to its tier ceiling. No per-action approval. Revocable at any time.',
    elevated: true,
  },
];

const statusTone = (status: AgentSpawn['status']): string => {
  if (status === 'running') return 'border-emerald-800/60 bg-emerald-950/30 text-emerald-300';
  if (status === 'approval_required') return 'border-amber-800/60 bg-amber-950/30 text-amber-300';
  if (status === 'revoked' || status === 'failed') return 'border-rose-900/60 bg-rose-950/30 text-rose-300';
  return 'border-slate-700 bg-slate-900/50 text-slate-300';
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const request = async <T,>(url: string, init?: RequestInit): Promise<T> => {
  const response = await authenticatedFetch(url, init);
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new Error(
      isRecord(payload) && typeof payload.error === 'string' ? payload.error : `Request failed (${response.status}).`,
    );
  }
  return payload as T;
};

interface GoalOption {
  id: string;
  objective: string;
}

interface AgentFleetPanelProps {
  /** Optional caller-supplied goal; otherwise the operator picks one here. */
  goalId?: string;
}

interface ExecutionStatus {
  enabled: boolean;
  reason: string;
}

export const AgentFleetPanel: React.FC<AgentFleetPanelProps> = ({ goalId: fixedGoalId }) => {
  const [fleet, setFleet] = useState<AgentFleetState | undefined>(undefined);
  const [execution, setExecution] = useState<ExecutionStatus | undefined>(undefined);
  const [goals, setGoals] = useState<GoalOption[]>([]);
  const [selectedGoalId, setSelectedGoalId] = useState<string>('');
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const [actionStatus, setActionStatus] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const [tier, setTier] = useState<AgentTier>('T0_reader');
  const [domain, setDomain] = useState<AgentDomain>('research');
  const [name, setName] = useState('');
  const [objective, setObjective] = useState('');
  const [targets, setTargets] = useState('');
  const [authority, setAuthority] = useState<AgentAuthorityMode>('propose_only');

  const goalId = fixedGoalId ?? (selectedGoalId || undefined);

  const refresh = useCallback(async () => {
    try {
      const payload = await request<AgentFleetState & { execution?: ExecutionStatus }>('/api/kernel/agents');
      setFleet(payload);
      setExecution(payload.execution);
      setLoadError(undefined);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Agent fleet is unavailable.');
    }
  }, []);

  const loadGoals = useCallback(async () => {
    if (fixedGoalId) return;
    try {
      const payload = await request<{ goals?: GoalOption[] }>('/api/kernel/goals');
      setGoals(Array.isArray(payload?.goals) ? payload.goals : []);
    } catch {
      // A goal list failure is not fatal to the panel; the spawn button stays
      // disabled and the operator is told to select a goal.
      setGoals([]);
    }
  }, [fixedGoalId]);

  useEffect(() => { void refresh(); void loadGoals(); }, [refresh, loadGoals]);

  const selectedAuthority = useMemo(
    () => AUTHORITY_MODES.find((mode) => mode.value === authority) ?? AUTHORITY_MODES[0],
    [authority],
  );

  const runAction = useCallback(async (work: () => Promise<string>) => {
    setBusy(true);
    setActionError(undefined);
    setActionStatus(undefined);
    try {
      setActionStatus(await work());
      await refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Agent action failed.');
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const spawn = () => runAction(async () => {
    if (!goalId) throw new Error('Select a goal before spawning an agent.');
    const targetList = targets.split('\n').map((line) => line.trim()).filter(Boolean);
    const definition = await request<{ id: string }>('/api/kernel/agents/definitions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: name.trim() || `${tier} ${domain}`, description: objective.trim() || 'Operator-defined agent', tier, domain, workerIds: [] }),
    });
    const created = await request<AgentSpawn>('/api/kernel/agents/spawns', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        definitionId: definition.id,
        goalId,
        objective,
        requestedAuthority: authority,
        targets: targetList,
      }),
    });
    return created.status === 'approval_required'
      ? 'Agent requested. Elevated authority needs an approval before it starts.'
      : 'Agent spawned under propose-only authority.';
  });

  const authorize = (spawnId: string) => runAction(async () => {
    await request(`/api/kernel/agents/spawns/${spawnId}/authorize`, { method: 'POST' });
    return 'Elevated authority authorized; agent is running.';
  });

  const step = (spawnId: string) => runAction(async () => {
    const outcome = await request<{ kind: string; reason: string }>(
      `/api/kernel/agents/spawns/${spawnId}/step`, { method: 'POST' },
    );
    return `${outcome.kind}: ${outcome.reason}`;
  });

  const planWithModel = (spawnId: string) => runAction(async () => {
    const outcome = await request<{ ok: boolean; reason: string; rejected?: { value: string }[] }>(
      `/api/kernel/agents/spawns/${spawnId}/plan`, { method: 'POST' },
    );
    const refused = outcome.rejected?.length
      ? ` ${outcome.rejected.length} proposed target(s) were outside this agent's permitted origins and were discarded.`
      : '';
    return `${outcome.ok ? 'Plan accepted' : 'Plan rejected'}: ${outcome.reason}${refused}`;
  });

  const dispatchProposal = (proposalId: string) => runAction(async () => {
    const outcome = await request<{ kind: string; reason: string }>(
      `/api/kernel/agents/proposals/${proposalId}/dispatch`, { method: 'POST' },
    );
    return `${outcome.kind}: ${outcome.reason}`;
  });

  const revoke = (spawnId: string) => runAction(async () => {
    const reason = window.prompt('Reason for revoking this agent?')?.trim();
    if (!reason) throw new Error('A revocation reason is required.');
    await request(`/api/kernel/agents/spawns/${spawnId}/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason }),
    });
    return 'Agent revoked.';
  });

  const spawns = fleet?.spawns ?? [];
  const pendingProposals: AgentProposal[] = (fleet?.proposals ?? []).filter(
    (item) => item.status === 'pending',
  );

  return (
    <section aria-labelledby="agent-fleet-title" className="rounded-3xl border border-slate-800 bg-[#101114]/90 p-5 shadow-2xl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-mono font-bold uppercase tracking-[0.35em] text-sky-400">Agent Fleet</p>
          <h2 id="agent-fleet-title" className="mt-1 text-xl font-black tracking-tight text-white">Tiered Domain Specialists</h2>
          <p className="mt-2 max-w-2xl text-xs leading-relaxed text-slate-400">
            Every agent runs under an authority you choose. Whatever you choose, the kernel still decides
            each action and consumes a single-use grant — autonomy changes who approves, never whether policy applies.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className="flex items-center gap-1 rounded-full border border-slate-700 bg-slate-900/60 px-3 py-1 text-[10px] font-mono text-slate-300">
            <Layers className="h-3 w-3" aria-hidden="true" />{spawns.length} spawned
          </span>
          {execution && (
            <span
              data-testid="execution-status"
              className={`flex items-center gap-1 rounded-full border px-3 py-1 text-[10px] font-mono ${
                execution.enabled
                  ? 'border-emerald-800/60 bg-emerald-950/30 text-emerald-300'
                  : 'border-slate-700 bg-slate-900/60 text-slate-400'
              }`}
            >
              {execution.enabled
                ? <><Play className="h-3 w-3" aria-hidden="true" />execution on</>
                : <><PowerOff className="h-3 w-3" aria-hidden="true" />execution off</>}
            </span>
          )}
        </div>
      </div>

      {loadError && <p role="alert" className="mt-4 rounded-lg border border-rose-900/60 bg-rose-950/20 px-3 py-2 text-xs text-rose-300">{loadError}</p>}
      {actionError && <p role="alert" className="mt-4 rounded-lg border border-rose-900/60 bg-rose-950/20 px-3 py-2 text-xs text-rose-300">{actionError}</p>}
      {actionStatus && <p role="status" className="mt-4 rounded-lg border border-emerald-900/60 bg-emerald-950/20 px-3 py-2 text-xs text-emerald-300">{actionStatus}</p>}
      {execution && !execution.enabled && (
        <p role="note" className="mt-4 rounded-lg border border-slate-700 bg-slate-900/40 px-3 py-2 text-xs text-slate-300">
          {execution.reason} Agents can still be defined, spawned, authorized, and revoked — the
          authority model applies either way — but they will not run until this deployment sets
          <code className="mx-1 rounded bg-slate-950 px-1 font-mono text-[10px]">AGENT_FLEET_EXECUTION=1</code>.
        </p>
      )}
      {!goalId && <p className="mt-4 rounded-lg border border-amber-900/60 bg-amber-950/20 px-3 py-2 text-xs text-amber-300">Select a goal to spawn agents against it.</p>}

      {!fixedGoalId && (
        <label className="mt-4 flex flex-col gap-1 text-xs text-slate-300">
          <span className="font-mono uppercase tracking-wider text-slate-500">Goal</span>
          <select
            value={selectedGoalId}
            onChange={(event) => setSelectedGoalId(event.target.value)}
            className="rounded-lg border border-slate-700 bg-slate-950/70 px-3 py-2 text-sm text-white outline-none focus:border-sky-600"
          >
            <option value="">Select a goal…</option>
            {goals.map((goal) => (
              <option key={goal.id} value={goal.id}>{goal.objective}</option>
            ))}
          </select>
        </label>
      )}

      <div className="mt-5 grid gap-3 md:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs text-slate-300">
          <span className="font-mono uppercase tracking-wider text-slate-500">Agent name</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Source reviewer"
            className="rounded-lg border border-slate-700 bg-slate-950/70 px-3 py-2 text-sm text-white outline-none focus:border-sky-600"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-slate-300">
          <span className="font-mono uppercase tracking-wider text-slate-500">Domain</span>
          <select
            value={domain}
            onChange={(event) => setDomain(event.target.value as AgentDomain)}
            className="rounded-lg border border-slate-700 bg-slate-950/70 px-3 py-2 text-sm text-white outline-none focus:border-sky-600"
          >
            {DOMAINS.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-slate-300">
          <span className="font-mono uppercase tracking-wider text-slate-500">Tier (risk ceiling)</span>
          <select
            value={tier}
            onChange={(event) => setTier(event.target.value as AgentTier)}
            className="rounded-lg border border-slate-700 bg-slate-950/70 px-3 py-2 text-sm text-white outline-none focus:border-sky-600"
          >
            {TIERS.map((value) => (
              <option key={value.value} value={value.value}>{value.label} — max {value.ceiling}</option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-slate-300">
          <span className="font-mono uppercase tracking-wider text-slate-500">Authority</span>
          <select
            value={authority}
            onChange={(event) => setAuthority(event.target.value as AgentAuthorityMode)}
            className="rounded-lg border border-slate-700 bg-slate-950/70 px-3 py-2 text-sm text-white outline-none focus:border-sky-600"
          >
            {AUTHORITY_MODES.map((mode) => (
              <option key={mode.value} value={mode.value}>{mode.label}</option>
            ))}
          </select>
        </label>
      </div>

      <label className="mt-3 flex flex-col gap-1 text-xs text-slate-300">
        <span className="font-mono uppercase tracking-wider text-slate-500">Targets (one URL per line)</span>
        <textarea
          value={targets}
          onChange={(event) => setTargets(event.target.value)}
          rows={2}
          placeholder="https://example.com/page"
          className="rounded-lg border border-slate-700 bg-slate-950/70 px-3 py-2 font-mono text-xs text-white outline-none focus:border-sky-600"
        />
      </label>

      <label className="mt-3 flex flex-col gap-1 text-xs text-slate-300">
        <span className="font-mono uppercase tracking-wider text-slate-500">Objective</span>
        <textarea
          value={objective}
          onChange={(event) => setObjective(event.target.value)}
          rows={2}
          placeholder="What should this agent accomplish?"
          className="rounded-lg border border-slate-700 bg-slate-950/70 px-3 py-2 text-sm text-white outline-none focus:border-sky-600"
        />
      </label>

      <p
        role="note"
        data-testid="authority-note"
        className={`mt-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${
          selectedAuthority.elevated
            ? 'border-amber-800/60 bg-amber-950/20 text-amber-200'
            : 'border-slate-700 bg-slate-900/40 text-slate-300'
        }`}
      >
        {selectedAuthority.elevated
          ? <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          : <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
        <span>
          {selectedAuthority.consequence}
          {selectedAuthority.elevated && <strong className="ml-1 font-semibold">Requires your explicit approval, recorded against your identity.</strong>}
        </span>
      </p>

      <button
        type="button"
        onClick={spawn}
        disabled={busy || !goalId}
        className="mt-4 inline-flex items-center gap-2 rounded-xl border border-sky-700 bg-sky-950/40 px-4 py-2 text-sm font-semibold text-sky-200 transition hover:bg-sky-900/40 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Sparkles className="h-4 w-4" aria-hidden="true" />
        {busy ? 'Working…' : 'Spawn agent'}
      </button>

      {pendingProposals.length > 0 && (
        <div className="mt-6 rounded-xl border border-amber-900/60 bg-amber-950/10 p-3">
          <p className="text-[10px] font-mono font-bold uppercase tracking-[0.25em] text-amber-400">
            Awaiting your decision
          </p>
          <p className="mt-1 text-xs text-slate-400">
            These actions exceed the agent's ceiling. Approve the request in the approvals queue,
            then dispatch it here — the kernel re-derives the action and refuses if it changed.
          </p>
          <div className="mt-3 space-y-2">
            {pendingProposals.map((proposal) => (
              <article
                key={proposal.id}
                data-testid="agent-proposal"
                className="rounded-lg border border-slate-800 bg-slate-950/50 p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-xs text-slate-200">{proposal.summary}</span>
                  <span className="rounded-full border border-amber-800/60 bg-amber-950/30 px-2 py-0.5 text-[10px] font-mono text-amber-300">
                    {proposal.riskLevel}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => dispatchProposal(proposal.id)}
                  disabled={busy || !execution?.enabled}
                  className="mt-2 inline-flex items-center gap-1 rounded-lg border border-amber-700 bg-amber-950/30 px-3 py-1 text-xs font-semibold text-amber-200 hover:bg-amber-900/30 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <ShieldCheck className="h-3 w-3" aria-hidden="true" />Dispatch approved action
                </button>
              </article>
            ))}
          </div>
        </div>
      )}

      <div className="mt-6 space-y-2">
        {spawns.length === 0 && !loadError && (
          <p className="rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-4 text-center text-xs text-slate-500">
            No agents spawned yet.
          </p>
        )}
        {spawns.map((item) => (
          <article key={item.id} className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Bot className="h-4 w-4 text-sky-400" aria-hidden="true" />
                <span className="font-mono text-xs text-slate-300">{item.tier}</span>
                <ChevronRight className="h-3 w-3 text-slate-600" aria-hidden="true" />
                <span className="font-mono text-xs text-slate-400">{item.domain}</span>
              </div>
              <span className={`rounded-full border px-2 py-0.5 text-[10px] font-mono ${statusTone(item.status)}`}>
                {item.status}
              </span>
            </div>
            <p className="mt-2 text-sm text-slate-200">{item.objective}</p>
            <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] font-mono text-slate-500">
              <div><dt className="inline">authority </dt><dd className="inline text-slate-300">{item.effectiveAuthority}</dd></div>
              <div><dt className="inline">ceiling </dt><dd className="inline text-slate-300">{item.effectiveRiskCeiling}</dd></div>
              <div><dt className="inline">ops </dt><dd className="inline text-slate-300">{item.operationsUsed}/{item.budget.maxOperations}</dd></div>
              <div><dt className="inline">depth </dt><dd className="inline text-slate-300">{item.depth}</dd></div>
              {item.authorizedBy && (
                <div><dt className="inline">authorized by </dt><dd className="inline text-slate-300">{item.authorizedBy.principalId}</dd></div>
              )}
            </dl>
            <div className="mt-3 flex gap-2">
              {item.status === 'approval_required' && (
                <button
                  type="button"
                  onClick={() => authorize(item.id)}
                  disabled={busy}
                  className="inline-flex items-center gap-1 rounded-lg border border-amber-700 bg-amber-950/30 px-3 py-1 text-xs font-semibold text-amber-200 hover:bg-amber-900/30 disabled:opacity-50"
                >
                  <ShieldCheck className="h-3 w-3" aria-hidden="true" />Authorize
                </button>
              )}
              {item.status === 'running' && execution?.enabled && (
                <button
                  type="button"
                  onClick={() => planWithModel(item.id)}
                  disabled={busy}
                  title="Ask a model what to work on. Anything outside this agent's permitted origins is discarded."
                  className="inline-flex items-center gap-1 rounded-lg border border-violet-700 bg-violet-950/30 px-3 py-1 text-xs font-semibold text-violet-200 hover:bg-violet-900/30 disabled:opacity-50"
                >
                  <Brain className="h-3 w-3" aria-hidden="true" />Plan with model
                </button>
              )}
              {item.status === 'running' && execution?.enabled && (
                <button
                  type="button"
                  onClick={() => step(item.id)}
                  disabled={busy}
                  className="inline-flex items-center gap-1 rounded-lg border border-sky-700 bg-sky-950/30 px-3 py-1 text-xs font-semibold text-sky-200 hover:bg-sky-900/30 disabled:opacity-50"
                >
                  <Split className="h-3 w-3" aria-hidden="true" />Run step
                </button>
              )}
              {(item.status === 'running' || item.status === 'approval_required' || item.status === 'requested') && (
                <button
                  type="button"
                  onClick={() => revoke(item.id)}
                  disabled={busy}
                  className="inline-flex items-center gap-1 rounded-lg border border-rose-800 bg-rose-950/30 px-3 py-1 text-xs font-semibold text-rose-200 hover:bg-rose-900/30 disabled:opacity-50"
                >
                  <XOctagon className="h-3 w-3" aria-hidden="true" />Revoke
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
};

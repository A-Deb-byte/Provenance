import type { ActionIntent, CapabilityRiskLevel, WorkerRegistration } from '../../capabilities/types';
import { minimumRiskForAction } from '../../capabilities/policy';
import { RISK_RANK, type AgentSpawn } from './types';

/**
 * Turning an agent's objective into concrete actions.
 *
 * This is deliberately deterministic rather than model-driven. A reader agent
 * is given explicit targets and inspects them one per step; nothing here asks a
 * model what to do next. That keeps the executor auditable and replayable, and
 * means the authority boundary is exercised by real dispatches rather than by a
 * simulation of them. A model-driven planner can later produce this same target
 * list without changing anything below it.
 */

export interface AgentStepPlan {
  /** Absent when the agent has no work left. */
  action?: ActionIntent['action'];
  scope?: ActionIntent['scope'];
  targetIndex?: number;
  done: boolean;
  reason: string;
}

const canonicalOrigin = (url: string): string | undefined => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
    if (parsed.username || parsed.password) return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
};

/**
 * Chooses the agent's next action from its remaining targets.
 *
 * `operationsUsed` doubles as the cursor: every admitted operation consumes one
 * budget unit and advances exactly one target, so a resumed agent cannot repeat
 * work it already did.
 */
export const planAgentStep = (spawn: AgentSpawn): AgentStepPlan => {
  const targets = spawn.targets ?? [];
  if (targets.length === 0) {
    return { done: true, reason: 'Agent has no targets to inspect.' };
  }
  const index = spawn.operationsUsed;
  if (index >= targets.length) {
    return { done: true, reason: 'Agent completed every target.' };
  }

  const url = targets[index];
  const origin = canonicalOrigin(url);
  if (!origin) {
    return { done: true, reason: `Agent target ${index + 1} is not a usable http(s) URL.` };
  }

  return {
    done: false,
    targetIndex: index,
    reason: `Inspecting target ${index + 1} of ${targets.length}.`,
    action: { type: 'browser.inspect', origin, url },
    scope: { family: 'browser', operations: ['browser.inspect'], origins: [origin], downloadRoots: [] },
  };
};

/**
 * Whether the agent may perform this action itself, or must propose it.
 *
 * The ceiling check is intentionally duplicated here rather than left to
 * `admitOperation` alone: an action above the ceiling is not a failure, it is a
 * proposal, and the caller needs to know which before it dispatches anything.
 */
export const requiresProposal = (
  spawn: AgentSpawn,
  action: ActionIntent['action'],
): boolean => RISK_RANK[minimumRiskForAction(action)] > RISK_RANK[spawn.effectiveRiskCeiling];

/** Risk to request for an action, never below the policy floor for its type. */
export const riskForAgentAction = (action: ActionIntent['action']): CapabilityRiskLevel =>
  minimumRiskForAction(action);

/**
 * An envelope narrows an already-authorized agent further, so it is checked at
 * dispatch rather than only at spawn: the envelope may expire while the agent
 * is still running.
 */
export const envelopePermits = (
  spawn: AgentSpawn,
  worker: WorkerRegistration,
  risk: CapabilityRiskLevel,
  now: string,
): { allowed: boolean; reason: string } => {
  if (spawn.effectiveAuthority !== 'envelope') return { allowed: true, reason: 'No envelope applies.' };
  const envelope = spawn.envelope;
  if (!envelope) return { allowed: false, reason: 'Envelope authority has no envelope on record.' };
  if (Date.parse(now) >= Date.parse(envelope.expiresAt)) {
    return { allowed: false, reason: 'Agent envelope has expired.' };
  }
  if (RISK_RANK[risk] > RISK_RANK[envelope.maxRiskLevel]) {
    return { allowed: false, reason: `Envelope permits at most ${envelope.maxRiskLevel}.` };
  }
  if (!envelope.workerIds.includes(worker.id)) {
    return { allowed: false, reason: 'Envelope does not cover this worker.' };
  }
  if (spawn.operationsUsed >= envelope.maxOperations) {
    return { allowed: false, reason: 'Envelope operation allowance is exhausted.' };
  }
  return { allowed: true, reason: 'Envelope permits this action.' };
};

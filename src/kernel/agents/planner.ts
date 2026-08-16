import type { CapabilityScope, WorkerRegistration } from '../../capabilities/types';
import type { AgentSpawn } from './types';

/**
 * Model-driven planning.
 *
 * A model may *propose* what an agent should work on. It gains no authority by
 * doing so: everything it returns is untrusted data, validated deterministically
 * against bounds the model cannot see or influence. The rules below are the
 * whole security story of this module.
 *
 * The most important one: **a model can never introduce a new origin.** Every
 * proposed target must fall inside an origin already configured for the agent's
 * worker. A hallucinated, attacker-suggested, or prompt-injected URL is dropped
 * rather than clamped, and the rejection is reported so it can be ledgered.
 */

export type PlannedAction = 'inspect' | 'click';

/** The shape a model is asked to return. Nothing here is trusted. */
export interface ProposedAgentPlan {
  targets?: unknown;
  action?: unknown;
  selector?: unknown;
  rationale?: unknown;
}

export interface RejectedTarget {
  value: string;
  reasonCode: 'malformed_url' | 'unsupported_scheme' | 'embedded_credentials' | 'origin_not_configured' | 'duplicate';
}

export interface AgentPlanValidation {
  ok: boolean;
  reason: string;
  targets: string[];
  action: PlannedAction;
  selector?: string;
  /** Reported rather than silently dropped, so a narrowed plan is visible. */
  rejected: RejectedTarget[];
  /** Truncated by the remaining operation budget, if any. */
  truncated: number;
  rationale?: string;
}

const MAX_RATIONALE_CHARS = 500;
const MAX_SELECTOR_CHARS = 200;
const MAX_PROPOSED_TARGETS = 100;

/** Origins the worker is already configured for. The model cannot add to this. */
export const configuredOrigins = (worker: WorkerRegistration): string[] => (
  worker.configuredScopes
    .filter((scope): scope is Extract<CapabilityScope, { family: 'browser' }> => scope.family === 'browser')
    .flatMap((scope) => scope.origins)
);

const originOf = (url: string): { origin?: string; reasonCode?: RejectedTarget['reasonCode'] } => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { reasonCode: 'malformed_url' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { reasonCode: 'unsupported_scheme' };
  }
  // Credentials in a URL would be written into evidence and sent to a worker.
  if (parsed.username || parsed.password) return { reasonCode: 'embedded_credentials' };
  return { origin: parsed.origin };
};

const asText = (value: unknown, max: number): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : undefined;
};

/**
 * Validates a model-proposed plan against what the agent is actually permitted
 * to do. Returns the narrowed plan plus everything that was refused.
 *
 * Note what this does *not* do: it never widens anything, never substitutes a
 * default for a rejected value, and never lets an unrecognised action through.
 * An unparseable or fully-rejected plan fails rather than degrading into an
 * empty-but-successful one.
 */
export const validateAgentPlan = (
  proposal: ProposedAgentPlan,
  spawn: AgentSpawn,
  worker: WorkerRegistration,
  remainingOperations: number,
): AgentPlanValidation => {
  const rejected: RejectedTarget[] = [];
  const fail = (reason: string): AgentPlanValidation =>
    ({ ok: false, reason, targets: [], action: 'inspect', rejected, truncated: 0 });

  const action: PlannedAction = proposal.action === 'click' ? 'click' : 'inspect';
  if (proposal.action !== undefined && proposal.action !== 'click' && proposal.action !== 'inspect') {
    return fail(`Planner proposed an unrecognised action.`);
  }
  const requiredOperation = action === 'click' ? 'browser.click' : 'browser.inspect';
  if (!worker.supportedActions.includes(requiredOperation)) {
    return fail(`Agent worker does not support ${requiredOperation}.`);
  }

  const selector = asText(proposal.selector, MAX_SELECTOR_CHARS);
  if (action === 'click' && !selector) {
    return fail('Planner proposed a click without a usable selector.');
  }

  if (!Array.isArray(proposal.targets) || proposal.targets.length === 0) {
    return fail('Planner returned no targets.');
  }
  if (proposal.targets.length > MAX_PROPOSED_TARGETS) {
    return fail(`Planner returned more than ${MAX_PROPOSED_TARGETS} targets.`);
  }

  const allowedOrigins = new Set(configuredOrigins(worker));
  if (allowedOrigins.size === 0) return fail('Agent worker has no configured browser origins to plan within.');

  const accepted: string[] = [];
  const seen = new Set<string>();
  for (const candidate of proposal.targets) {
    const value = asText(candidate, 2048);
    if (!value) {
      rejected.push({ value: String(candidate).slice(0, 120), reasonCode: 'malformed_url' });
      continue;
    }
    if (seen.has(value)) {
      rejected.push({ value, reasonCode: 'duplicate' });
      continue;
    }
    seen.add(value);
    const { origin, reasonCode } = originOf(value);
    if (!origin) {
      rejected.push({ value, reasonCode: reasonCode ?? 'malformed_url' });
      continue;
    }
    // The containment rule: a model may reorder and select, never introduce.
    if (!allowedOrigins.has(origin)) {
      rejected.push({ value, reasonCode: 'origin_not_configured' });
      continue;
    }
    accepted.push(value);
  }

  if (accepted.length === 0) {
    return fail('No proposed target fell inside an origin configured for this agent.');
  }

  const budget = Math.max(0, Math.min(remainingOperations, spawn.budget.maxOperations - spawn.operationsUsed));
  const targets = accepted.slice(0, budget);
  const truncated = accepted.length - targets.length;
  if (targets.length === 0) {
    return fail('The agent has no remaining operation budget for a plan.');
  }

  return {
    ok: true,
    reason: truncated > 0
      ? `Planned ${targets.length} target(s); ${truncated} exceeded the remaining operation budget.`
      : `Planned ${targets.length} target(s).`,
    targets,
    action,
    selector: action === 'click' ? selector : undefined,
    rejected,
    truncated,
    rationale: asText(proposal.rationale, MAX_RATIONALE_CHARS),
  };
};

/** Parses a model response body into a proposal shape. Never throws. */
export const parseProposedPlan = (content: string): ProposedAgentPlan | undefined => {
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as ProposedAgentPlan;
  } catch {
    return undefined;
  }
};

/**
 * The planning prompt.
 *
 * Candidate origins are supplied so the model selects rather than invents, and
 * it is told plainly that anything outside them is discarded. That is a
 * usability measure, not a security one -- validation enforces it regardless of
 * whether the model cooperates.
 */
export const buildPlannerPrompt = (
  spawn: AgentSpawn,
  worker: WorkerRegistration,
): { system: string; user: string } => ({
  system: [
    'You plan work for a bounded automation agent.',
    'Return ONLY a JSON object: {"targets":["https://..."],"action":"inspect"|"click","selector":"#id","rationale":"..."}.',
    'Use "click" only when the objective requires interacting with a control; it needs a selector.',
    'Every target must be an https URL whose origin is one of the permitted origins listed below.',
    'Targets outside those origins are discarded by the kernel, so proposing them wastes the plan.',
    'Do not include credentials in URLs. Do not invent origins.',
  ].join('\n'),
  user: [
    `Objective: ${spawn.objective}`,
    `Agent domain: ${spawn.domain}`,
    `Permitted origins: ${configuredOrigins(worker).join(', ') || '(none)'}`,
    `Maximum targets: ${Math.max(0, spawn.budget.maxOperations - spawn.operationsUsed)}`,
  ].join('\n'),
});

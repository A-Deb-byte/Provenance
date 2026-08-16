import type { CapabilityRiskLevel } from '../../capabilities/types';
import type { ApprovalDecisionPrincipal } from '../types';
import {
  AUTHORITY_REQUIRES_APPROVAL,
  RISK_RANK,
  TIER_MAY_SPAWN,
  TIER_RISK_CEILING,
  type AgentAuthorityEnvelope,
  type AgentAuthorityMode,
  type AgentBudget,
  type AgentDefinition,
  type AgentSpawn,
} from './types';

export interface SpawnRequestInput {
  id: string;
  definition: AgentDefinition;
  goalId: string;
  objective: string;
  requestedAuthority: AgentAuthorityMode;
  budget?: Partial<AgentBudget>;
  envelope?: AgentAuthorityEnvelope;
  parent?: AgentSpawn;
  now: string;
}

export type SpawnRefusalReason =
  | 'objective_required'
  | 'parent_may_not_spawn'
  | 'depth_exceeded'
  | 'child_limit_exceeded'
  | 'parent_not_running'
  | 'budget_invalid'
  | 'envelope_required'
  | 'envelope_exceeds_ceiling'
  | 'envelope_worker_not_permitted'
  | 'envelope_expired';

/**
 * Result shape follows the existing `DispatchAuthorizationResult` /
 * `GrantValidationResult` convention: one interface with optional fields rather
 * than a discriminated union. This project compiles without `strictNullChecks`,
 * so a boolean literal discriminant widens to `boolean` and never narrows.
 */
export interface SpawnDecision {
  ok: boolean;
  reason: string;
  reasonCode?: SpawnRefusalReason;
  spawn?: AgentSpawn;
  /** True when an operator must approve before the agent may start. */
  approvalRequired?: boolean;
}

const refuse = (reasonCode: SpawnRefusalReason, reason: string): SpawnDecision => ({
  ok: false, reasonCode, reason,
});

const minimumRisk = (
  left: CapabilityRiskLevel,
  right: CapabilityRiskLevel,
): CapabilityRiskLevel => (RISK_RANK[left] <= RISK_RANK[right] ? left : right);

/**
 * The floor rule, and the core safety property of the fleet.
 *
 * An agent's ceiling is the tightest of every constraint that applies: its tier,
 * how much autonomy it was granted, and -- when spawned by another agent -- the
 * parent's own ceiling. Delegation narrows; it can never widen. A `T0_reader`
 * spawned `autonomous` by an `autonomous` parent is still L0.
 *
 * `propose_only` is pinned to L1 because anything above that is exactly what a
 * human is supposed to decide; the agent proposes it instead of performing it.
 */
export const effectiveRiskCeiling = (
  tier: AgentDefinition['tier'],
  authority: AgentAuthorityMode,
  parentCeiling?: CapabilityRiskLevel,
): CapabilityRiskLevel => {
  const tierCeiling = TIER_RISK_CEILING[tier];
  const authorityCeiling: CapabilityRiskLevel = authority === 'propose_only' ? 'L1' : tierCeiling;
  const combined = minimumRisk(tierCeiling, authorityCeiling);
  return parentCeiling ? minimumRisk(combined, parentCeiling) : combined;
};

/** A child may never be more autonomous than its parent. */
export const inheritedAuthority = (
  requested: AgentAuthorityMode,
  parent?: AgentSpawn,
): AgentAuthorityMode => {
  if (!parent) return requested;
  const rank: Record<AgentAuthorityMode, number> = { propose_only: 0, envelope: 1, autonomous: 2 };
  return rank[requested] <= rank[parent.effectiveAuthority] ? requested : parent.effectiveAuthority;
};

const DEFAULT_BUDGET: AgentBudget = {
  maxOperations: 25,
  maxChildren: 4,
  maxDepth: 3,
  deadlineMs: 10 * 60 * 1000,
};

const resolveBudget = (
  definition: AgentDefinition,
  requested: Partial<AgentBudget> | undefined,
  parent: AgentSpawn | undefined,
): AgentBudget | undefined => {
  const base = { ...DEFAULT_BUDGET, ...definition.defaultBudget, ...requested };
  const bounded: AgentBudget = {
    maxOperations: Math.min(base.maxOperations, parent?.budget.maxOperations ?? base.maxOperations),
    maxChildren: Math.min(base.maxChildren, parent?.budget.maxChildren ?? base.maxChildren),
    maxDepth: Math.min(base.maxDepth, parent?.budget.maxDepth ?? base.maxDepth),
    deadlineMs: Math.min(base.deadlineMs, parent?.budget.deadlineMs ?? base.deadlineMs),
  };
  const valid = Number.isSafeInteger(bounded.maxOperations) && bounded.maxOperations >= 1 &&
    Number.isSafeInteger(bounded.maxChildren) && bounded.maxChildren >= 0 &&
    Number.isSafeInteger(bounded.maxDepth) && bounded.maxDepth >= 0 &&
    Number.isSafeInteger(bounded.deadlineMs) && bounded.deadlineMs >= 1_000;
  return valid ? bounded : undefined;
};

const validateEnvelope = (
  envelope: AgentAuthorityEnvelope | undefined,
  definition: AgentDefinition,
  ceiling: CapabilityRiskLevel,
  now: string,
): SpawnDecision | undefined => {
  if (!envelope) {
    return refuse('envelope_required', 'Envelope authority requires an explicit bounded envelope.');
  }
  if (RISK_RANK[envelope.maxRiskLevel] > RISK_RANK[ceiling]) {
    return refuse('envelope_exceeds_ceiling', `Envelope may not exceed the effective ceiling ${ceiling}.`);
  }
  if (!envelope.workerIds.every((id) => definition.workerIds.includes(id))) {
    return refuse('envelope_worker_not_permitted', 'Envelope references a worker outside the agent definition.');
  }
  if (!Number.isFinite(Date.parse(envelope.expiresAt)) || Date.parse(envelope.expiresAt) <= Date.parse(now)) {
    return refuse('envelope_expired', 'Envelope expiry must be in the future.');
  }
  return undefined;
};

/**
 * Decides whether a spawn may proceed, and under what authority.
 *
 * Refusals are returned rather than thrown so the caller can ledger them: a
 * refused spawn is evidence, not an error.
 */
export const decideSpawn = (input: SpawnRequestInput): SpawnDecision => {
  const { definition, parent, now } = input;
  if (!input.objective.trim()) {
    return refuse('objective_required', 'An agent spawn requires a stated objective.');
  }

  if (parent) {
    if (!TIER_MAY_SPAWN[parent.tier]) {
      return refuse('parent_may_not_spawn', `Tier ${parent.tier} may not spawn child agents.`);
    }
    if (parent.status !== 'running') {
      return refuse('parent_not_running', 'Only a running agent may spawn children.');
    }
    if (parent.depth + 1 > parent.budget.maxDepth) {
      return refuse('depth_exceeded', `Spawn depth would exceed the parent limit of ${parent.budget.maxDepth}.`);
    }
    if (parent.childCount + 1 > parent.budget.maxChildren) {
      return refuse('child_limit_exceeded', `Parent already spawned its limit of ${parent.budget.maxChildren} children.`);
    }
  }

  const budget = resolveBudget(definition, input.budget, parent);
  if (!budget) return refuse('budget_invalid', 'Agent budget must be positive and bounded.');

  const effectiveAuthority = inheritedAuthority(input.requestedAuthority, parent);
  const ceiling = effectiveRiskCeiling(definition.tier, effectiveAuthority, parent?.effectiveRiskCeiling);

  if (effectiveAuthority === 'envelope') {
    const invalid = validateEnvelope(input.envelope, definition, ceiling, now);
    if (invalid) return invalid;
  }

  const approvalRequired = AUTHORITY_REQUIRES_APPROVAL[effectiveAuthority];
  return {
    ok: true,
    reason: approvalRequired
      ? 'Spawn requires operator authorization for elevated autonomy.'
      : 'Spawn admitted under propose-only authority.',
    approvalRequired,
    spawn: {
      schemaVersion: 1,
      id: input.id,
      definitionId: definition.id,
      goalId: input.goalId,
      parentSpawnId: parent?.id,
      depth: parent ? parent.depth + 1 : 0,
      tier: definition.tier,
      domain: definition.domain,
      requestedAuthority: input.requestedAuthority,
      effectiveAuthority,
      effectiveRiskCeiling: ceiling,
      envelope: effectiveAuthority === 'envelope' ? input.envelope : undefined,
      status: approvalRequired ? 'approval_required' : 'requested',
      objective: input.objective.trim(),
      budget,
      operationsUsed: 0,
      childCount: 0,
      createdAt: now,
      updatedAt: now,
    },
  };
};

/** Records the operator who authorised elevated autonomy and starts the agent. */
export const authorizeSpawn = (
  spawn: AgentSpawn,
  approvalId: string,
  authorizedBy: ApprovalDecisionPrincipal | undefined,
  now: string,
): AgentSpawn => {
  if (spawn.status !== 'approval_required') {
    throw new Error('Only a spawn awaiting authorization can be authorized.');
  }
  return { ...spawn, status: 'running', approvalId, authorizedBy, startedAt: now, updatedAt: now };
};

export const startSpawn = (spawn: AgentSpawn, now: string): AgentSpawn => {
  if (spawn.status !== 'requested') {
    throw new Error('Only a requested spawn can start without authorization.');
  }
  return { ...spawn, status: 'running', startedAt: now, updatedAt: now };
};

export type OperationRefusal = 'not_running' | 'operation_budget_exceeded' | 'deadline_exceeded' | 'risk_above_ceiling';

export interface OperationDecision {
  allowed: boolean;
  reason: string;
  reasonCode?: OperationRefusal;
  /** Present only when allowed: the spawn with its operation count incremented. */
  spawn?: AgentSpawn;
}

/**
 * Gate for a single agent operation. Enforces the ceiling, the operation budget
 * and the deadline together -- an agent that has run out of any of the three is
 * refused, and the refusal names which.
 */
export const admitOperation = (
  spawn: AgentSpawn,
  riskLevel: CapabilityRiskLevel,
  now: string,
): OperationDecision => {
  if (spawn.status !== 'running') {
    return { allowed: false, reasonCode: 'not_running', reason: 'Agent is not running.' };
  }
  if (RISK_RANK[riskLevel] > RISK_RANK[spawn.effectiveRiskCeiling]) {
    return {
      allowed: false,
      reasonCode: 'risk_above_ceiling',
      reason: `Agent ceiling is ${spawn.effectiveRiskCeiling}; ${riskLevel} must be proposed for human approval.`,
    };
  }
  if (spawn.operationsUsed + 1 > spawn.budget.maxOperations) {
    return {
      allowed: false,
      reasonCode: 'operation_budget_exceeded',
      reason: `Agent exhausted its ${spawn.budget.maxOperations} operation budget.`,
    };
  }
  const started = Date.parse(spawn.startedAt ?? spawn.createdAt);
  if (Number.isFinite(started) && Date.parse(now) - started > spawn.budget.deadlineMs) {
    return { allowed: false, reasonCode: 'deadline_exceeded', reason: 'Agent exceeded its deadline.' };
  }
  return {
    allowed: true,
    reason: 'Agent operation admitted within tier ceiling, budget, and deadline.',
    spawn: { ...spawn, operationsUsed: spawn.operationsUsed + 1, updatedAt: now },
  };
};

export const completeSpawn = (spawn: AgentSpawn, now: string): AgentSpawn =>
  ({ ...spawn, status: 'completed', finishedAt: now, updatedAt: now });

export const failSpawn = (spawn: AgentSpawn, failureReason: string, now: string): AgentSpawn =>
  ({ ...spawn, status: 'failed', failureReason, finishedAt: now, updatedAt: now });

/** Revocation is always available to an operator, at any status before terminal. */
export const revokeSpawn = (spawn: AgentSpawn, reason: string, now: string): AgentSpawn => {
  if (spawn.status === 'completed' || spawn.status === 'failed' || spawn.status === 'revoked') {
    throw new Error('Only a live agent can be revoked.');
  }
  return { ...spawn, status: 'revoked', failureReason: reason, finishedAt: now, updatedAt: now };
};

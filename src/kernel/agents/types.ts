import type { CapabilityRiskLevel } from '../../capabilities/types';
import type { ApprovalDecisionPrincipal, RiskLevel } from '../types';

/**
 * Tier is a ceiling on what an agent may ever request, independent of how much
 * autonomy it was granted. Separating the two means a highly autonomous reader
 * still cannot click anything.
 */
export type AgentTier = 'T0_reader' | 'T1_operator' | 'T2_connector' | 'T3_orchestrator';

/**
 * How consequential (L2/L3) actions are authorised for this agent.
 *
 * `propose_only` is the default and the safe one: the agent works freely at L0/L1
 * and emits proposals a human decides. The other two shift *who* approves, never
 * *whether policy applies* -- every mode still dispatches through
 * `decideActionPolicy` and consumes a single-use grant.
 */
export type AgentAuthorityMode = 'propose_only' | 'envelope' | 'autonomous';

export type AgentDomain = 'research' | 'web' | 'desktop' | 'code' | 'connector';

export type AgentSpawnStatus =
  | 'requested'
  | 'approval_required'
  | 'running'
  | 'completed'
  | 'failed'
  | 'revoked';

/** Highest risk an agent of this tier may ever request. */
export const TIER_RISK_CEILING: Record<AgentTier, CapabilityRiskLevel> = {
  T0_reader: 'L0',
  T1_operator: 'L2',
  T2_connector: 'L3',
  // An orchestrator plans and spawns; it never touches the world itself, so
  // every world-touching action traces to a narrowly scoped leaf agent.
  T3_orchestrator: 'L0',
};

/** Only orchestrators may spawn children. */
export const TIER_MAY_SPAWN: Record<AgentTier, boolean> = {
  T0_reader: false,
  T1_operator: false,
  T2_connector: false,
  T3_orchestrator: true,
};

/** Elevated autonomy is an operator decision, so it requires an approval. */
export const AUTHORITY_REQUIRES_APPROVAL: Record<AgentAuthorityMode, boolean> = {
  propose_only: false,
  envelope: true,
  autonomous: true,
};

export const RISK_RANK: Record<CapabilityRiskLevel, number> = {
  L0: 0, L1: 1, L2: 2, L3: 3, L4: 4,
};

export interface AgentBudget {
  maxOperations: number;
  maxChildren: number;
  maxDepth: number;
  deadlineMs: number;
}

export interface AgentDefinition {
  schemaVersion: 1;
  id: string;
  name: string;
  tier: AgentTier;
  domain: AgentDomain;
  description: string;
  /** Worker ids this agent may request. Never widens the tier ceiling. */
  workerIds: string[];
  defaultBudget: AgentBudget;
  createdAt: string;
}

/**
 * A bounded, revocable delegation for `envelope` mode: the operator approves a
 * policy once, and the agent acts inside it without per-action prompts.
 */
export interface AgentAuthorityEnvelope {
  maxRiskLevel: CapabilityRiskLevel;
  workerIds: string[];
  maxOperations: number;
  expiresAt: string;
}

export interface AgentSpawn {
  schemaVersion: 1;
  id: string;
  definitionId: string;
  goalId: string;
  parentSpawnId?: string;
  depth: number;
  tier: AgentTier;
  domain: AgentDomain;
  /** Mode requested by the operator. */
  requestedAuthority: AgentAuthorityMode;
  /** Mode actually in force -- never above `requestedAuthority`. */
  effectiveAuthority: AgentAuthorityMode;
  /** Ceiling after tier, authority, and any parent delegation are combined. */
  effectiveRiskCeiling: CapabilityRiskLevel;
  envelope?: AgentAuthorityEnvelope;
  status: AgentSpawnStatus;
  objective: string;
  budget: AgentBudget;
  operationsUsed: number;
  childCount: number;
  approvalId?: string;
  /** Who authorised elevated autonomy. Absent for `propose_only`. */
  authorizedBy?: ApprovalDecisionPrincipal;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  failureReason?: string;
}

/** An agent's request for a consequential action a human must decide. */
export interface AgentProposal {
  schemaVersion: 1;
  id: string;
  spawnId: string;
  riskLevel: RiskLevel;
  summary: string;
  /** Commitment to the intent, so the proposal cannot be swapped after approval. */
  intentHash: string;
  createdAt: string;
}

export interface AgentFleetState {
  schemaVersion: 1;
  definitions: AgentDefinition[];
  spawns: AgentSpawn[];
  proposals: AgentProposal[];
}

export const emptyAgentFleetState = (): AgentFleetState => ({
  schemaVersion: 1,
  definitions: [],
  spawns: [],
  proposals: [],
});

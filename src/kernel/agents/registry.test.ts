import { describe, expect, it } from 'vitest';
import {
  admitOperation,
  authorizeSpawn,
  decideSpawn,
  effectiveRiskCeiling,
  inheritedAuthority,
  revokeSpawn,
  startSpawn,
  type SpawnDecision,
} from './registry';
import type { AgentAuthorityMode, AgentDefinition, AgentSpawn, AgentTier } from './types';

const NOW = '2026-08-16T12:00:00.000Z';

const definition = (tier: AgentTier, overrides: Partial<AgentDefinition> = {}): AgentDefinition => ({
  schemaVersion: 1,
  id: `agent_${tier}`,
  name: `${tier} specialist`,
  tier,
  domain: 'web',
  description: 'test agent',
  workerIds: ['worker.browser.playwright'],
  defaultBudget: { maxOperations: 10, maxChildren: 2, maxDepth: 2, deadlineMs: 60_000 },
  createdAt: NOW,
  ...overrides,
});

const accepted = (decision: SpawnDecision): { spawn: AgentSpawn; approvalRequired: boolean } => {
  if (!decision.ok || !decision.spawn) {
    throw new Error(`expected acceptance, got ${decision.reasonCode ?? 'no spawn'}`);
  }
  return { spawn: decision.spawn, approvalRequired: Boolean(decision.approvalRequired) };
};

const spawnOf = (
  tier: AgentTier,
  authority: AgentAuthorityMode,
  extra: Partial<Parameters<typeof decideSpawn>[0]> = {},
): AgentSpawn => accepted(decideSpawn({
  id: 'spawn_1',
  definition: definition(tier),
  goalId: 'goal_1',
  objective: 'do the thing',
  requestedAuthority: authority,
  now: NOW,
  ...(authority === 'envelope'
    ? {
      envelope: {
        maxRiskLevel: 'L2' as const,
        workerIds: ['worker.browser.playwright'],
        maxOperations: 5,
        expiresAt: '2026-08-16T13:00:00.000Z',
      },
    }
    : {}),
  ...extra,
})).spawn;

describe('effective risk ceiling', () => {
  it('takes the tightest of tier, authority, and parent delegation', () => {
    // Tier binds even at maximum autonomy.
    expect(effectiveRiskCeiling('T0_reader', 'autonomous')).toBe('L0');
    // propose_only caps at L1 regardless of tier: anything above is for a human.
    expect(effectiveRiskCeiling('T2_connector', 'propose_only')).toBe('L1');
    expect(effectiveRiskCeiling('T2_connector', 'autonomous')).toBe('L3');
    expect(effectiveRiskCeiling('T1_operator', 'autonomous')).toBe('L2');
    // Parent delegation narrows further.
    expect(effectiveRiskCeiling('T2_connector', 'autonomous', 'L2')).toBe('L2');
  });

  it('never lets an orchestrator act on the world', () => {
    expect(effectiveRiskCeiling('T3_orchestrator', 'autonomous')).toBe('L0');
  });
});

describe('delegation narrows and never widens', () => {
  it('caps a child at the parent authority', () => {
    const parent = { effectiveAuthority: 'envelope' } as AgentSpawn;
    expect(inheritedAuthority('autonomous', parent)).toBe('envelope');
    expect(inheritedAuthority('propose_only', parent)).toBe('propose_only');
    expect(inheritedAuthority('autonomous', undefined)).toBe('autonomous');
  });

  it('caps a child budget at the parent budget', () => {
    const parent: AgentSpawn = {
      ...spawnOf('T3_orchestrator', 'propose_only'),
      status: 'running',
      budget: { maxOperations: 3, maxChildren: 2, maxDepth: 2, deadlineMs: 30_000 },
    };
    const child = accepted(decideSpawn({
      id: 'spawn_child',
      definition: definition('T1_operator'),
      goalId: 'goal_1',
      objective: 'child work',
      requestedAuthority: 'propose_only',
      budget: { maxOperations: 999, deadlineMs: 999_999 },
      parent,
      now: NOW,
    })).spawn;

    expect(child.budget.maxOperations).toBe(3);
    expect(child.budget.deadlineMs).toBe(30_000);
    expect(child.depth).toBe(1);
  });
});

describe('spawn admission', () => {
  it('does not require approval for propose_only, and does for elevated modes', () => {
    expect(accepted(decideSpawn({
      id: 's', definition: definition('T1_operator'), goalId: 'g', objective: 'o',
      requestedAuthority: 'propose_only', now: NOW,
    })).approvalRequired).toBe(false);

    // Raising autonomy is itself an operator decision, so it is gated.
    const elevated = accepted(decideSpawn({
      id: 's', definition: definition('T1_operator'), goalId: 'g', objective: 'o',
      requestedAuthority: 'autonomous', now: NOW,
    }));
    expect(elevated.approvalRequired).toBe(true);
    expect(elevated.spawn.status).toBe('approval_required');
  });

  it('refuses a spawn from a tier that may not spawn', () => {
    const parent = { ...spawnOf('T1_operator', 'propose_only'), status: 'running' as const };
    const decision = decideSpawn({
      id: 'c', definition: definition('T0_reader'), goalId: 'g', objective: 'o',
      requestedAuthority: 'propose_only', parent, now: NOW,
    });
    expect(decision.ok).toBe(false);
    expect(decision.reasonCode).toBe('parent_may_not_spawn');
  });

  it('bounds recursion by depth and fan-out', () => {
    const base = { ...spawnOf('T3_orchestrator', 'propose_only'), status: 'running' as const };

    const tooDeep = decideSpawn({
      id: 'c', definition: definition('T0_reader'), goalId: 'g', objective: 'o',
      requestedAuthority: 'propose_only',
      parent: { ...base, depth: 2, budget: { ...base.budget, maxDepth: 2 } },
      now: NOW,
    });
    expect(tooDeep.ok).toBe(false);
    expect(tooDeep.reasonCode).toBe('depth_exceeded');

    const tooWide = decideSpawn({
      id: 'c', definition: definition('T0_reader'), goalId: 'g', objective: 'o',
      requestedAuthority: 'propose_only',
      parent: { ...base, childCount: 2, budget: { ...base.budget, maxChildren: 2 } },
      now: NOW,
    });
    expect(tooWide.ok).toBe(false);
    expect(tooWide.reasonCode).toBe('child_limit_exceeded');
  });

  it('refuses an envelope that exceeds the ceiling or escapes the definition', () => {
    const overReach = decideSpawn({
      id: 's', definition: definition('T1_operator'), goalId: 'g', objective: 'o',
      requestedAuthority: 'envelope',
      envelope: { maxRiskLevel: 'L3', workerIds: ['worker.browser.playwright'], maxOperations: 5, expiresAt: '2026-08-16T13:00:00.000Z' },
      now: NOW,
    });
    expect(overReach.ok).toBe(false);
    expect(overReach.reasonCode).toBe('envelope_exceeds_ceiling');

    const foreignWorker = decideSpawn({
      id: 's', definition: definition('T1_operator'), goalId: 'g', objective: 'o',
      requestedAuthority: 'envelope',
      envelope: { maxRiskLevel: 'L2', workerIds: ['worker.connector.gmail'], maxOperations: 5, expiresAt: '2026-08-16T13:00:00.000Z' },
      now: NOW,
    });
    expect(foreignWorker.ok).toBe(false);
    expect(foreignWorker.reasonCode).toBe('envelope_worker_not_permitted');

    const expired = decideSpawn({
      id: 's', definition: definition('T1_operator'), goalId: 'g', objective: 'o',
      requestedAuthority: 'envelope',
      envelope: { maxRiskLevel: 'L2', workerIds: ['worker.browser.playwright'], maxOperations: 5, expiresAt: '2026-08-16T11:00:00.000Z' },
      now: NOW,
    });
    expect(expired.ok).toBe(false);
    expect(expired.reasonCode).toBe('envelope_expired');
  });

  it('requires a stated objective', () => {
    const decision = decideSpawn({
      id: 's', definition: definition('T0_reader'), goalId: 'g', objective: '   ',
      requestedAuthority: 'propose_only', now: NOW,
    });
    expect(decision.ok).toBe(false);
    expect(decision.reasonCode).toBe('objective_required');
  });
});

describe('operation admission', () => {
  it('refuses an action above the ceiling and says it must be proposed', () => {
    const running = startSpawn(spawnOf('T1_operator', 'propose_only'), NOW);
    const result = admitOperation(running, 'L2', NOW);

    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe('risk_above_ceiling');
    expect(result.reason).toContain('proposed for human approval');
    // The same action is admitted once autonomy was explicitly authorised.
    const autonomous = authorizeSpawn(spawnOf('T1_operator', 'autonomous'), 'approval_1', undefined, NOW);
    expect(admitOperation(autonomous, 'L2', NOW).allowed).toBe(true);
  });

  it('enforces the operation budget and the deadline', () => {
    const running = { ...startSpawn(spawnOf('T0_reader', 'propose_only'), NOW), operationsUsed: 10 };
    const exhausted = admitOperation(running, 'L0', NOW);
    expect(exhausted.allowed).toBe(false);
    expect(exhausted.reasonCode).toBe('operation_budget_exceeded');

    const late = admitOperation(startSpawn(spawnOf('T0_reader', 'propose_only'), NOW), 'L0', '2026-08-16T12:05:00.000Z');
    expect(late.allowed).toBe(false);
    expect(late.reasonCode).toBe('deadline_exceeded');
  });

  it('refuses any operation once revoked', () => {
    const running = startSpawn(spawnOf('T0_reader', 'propose_only'), NOW);
    const revoked = revokeSpawn(running, 'Operator halted the fleet.', NOW);

    expect(revoked.status).toBe('revoked');
    const result = admitOperation(revoked, 'L0', NOW);
    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe('not_running');
    expect(() => revokeSpawn(revoked, 'again', NOW)).toThrow('live agent');
  });

  it('records who authorised elevated autonomy', () => {
    const authorized = authorizeSpawn(
      spawnOf('T2_connector', 'autonomous'),
      'approval_9',
      { principalId: 'user:alice', mode: 'multi_user', role: 'operator', attribution: 'natural_person' },
      NOW,
    );

    expect(authorized.status).toBe('running');
    expect(authorized.authorizedBy?.principalId).toBe('user:alice');
    expect(authorized.authorizedBy?.attribution).toBe('natural_person');
  });
});

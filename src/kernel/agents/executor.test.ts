import { describe, expect, it } from 'vitest';
import { envelopePermits, planAgentStep, requiresProposal, riskForAgentAction } from './executor';
import { decomposeObjective } from './orchestrator';
import type { AgentDefinition, AgentSpawn } from './types';
import { hashIntentAuthorityBinding } from '../../capabilities/decisionRecord';

const NOW = '2026-08-16T12:00:00.000Z';

const spawn = (overrides: Partial<AgentSpawn> = {}): AgentSpawn => ({
  schemaVersion: 1,
  id: 'spawn_1',
  definitionId: 'agent_1',
  goalId: 'goal_1',
  depth: 0,
  tier: 'T0_reader',
  domain: 'research',
  requestedAuthority: 'propose_only',
  effectiveAuthority: 'propose_only',
  effectiveRiskCeiling: 'L1',
  status: 'running',
  objective: 'Review the sources',
  budget: { maxOperations: 10, maxChildren: 3, maxDepth: 2, deadlineMs: 600_000 },
  operationsUsed: 0,
  childCount: 0,
  targets: ['https://example.com/a', 'https://example.com/b'],
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const definition = (tier: AgentDefinition['tier']): AgentDefinition => ({
  schemaVersion: 1,
  id: `agent_${tier}`,
  name: 'child',
  tier,
  domain: 'research',
  description: 'child',
  workerIds: ['worker.browser.web_inspect'],
  defaultBudget: { maxOperations: 10, maxChildren: 2, maxDepth: 2, deadlineMs: 60_000 },
  createdAt: NOW,
});

describe('agent step planning', () => {
  it('advances one target per operation and never repeats one', () => {
    const first = planAgentStep(spawn({ operationsUsed: 0 }));
    expect(first.done).toBe(false);
    expect(first.action).toMatchObject({ type: 'browser.inspect', url: 'https://example.com/a', origin: 'https://example.com' });

    // operationsUsed is the cursor, so a resumed agent picks up where it left off.
    const second = planAgentStep(spawn({ operationsUsed: 1 }));
    expect(second.action).toMatchObject({ url: 'https://example.com/b' });

    const finished = planAgentStep(spawn({ operationsUsed: 2 }));
    expect(finished.done).toBe(true);
    expect(finished.reason).toContain('completed every target');
  });

  it('scopes each action to exactly the origin it will touch', () => {
    const plan = planAgentStep(spawn({ targets: ['https://alpha.test/page?q=1'] }));
    expect(plan.scope).toEqual({
      family: 'browser',
      operations: ['browser.inspect'],
      origins: ['https://alpha.test'],
      downloadRoots: [],
    });
  });

  it('stops on a target it cannot safely turn into an origin', () => {
    for (const target of ['not-a-url', 'file:///etc/passwd', 'https://user:pass@example.com/x']) {
      const plan = planAgentStep(spawn({ targets: [target] }));
      expect(plan.done).toBe(true);
      expect(plan.action).toBeUndefined();
    }
  });

  it('has nothing to do without targets', () => {
    expect(planAgentStep(spawn({ targets: [] })).done).toBe(true);
    expect(planAgentStep(spawn({ targets: undefined })).done).toBe(true);
  });
});

describe('proposal boundary', () => {
  it('performs L0 work itself but proposes anything above the ceiling', () => {
    const reader = spawn();
    expect(riskForAgentAction({ type: 'browser.inspect', origin: 'https://example.com', url: 'https://example.com/a' })).toBe('L0');
    expect(requiresProposal(reader, { type: 'browser.inspect', origin: 'https://example.com', url: 'https://example.com/a' })).toBe(false);

    // A reader may never click, whatever authority it holds.
    expect(requiresProposal(reader, {
      type: 'browser.click', origin: 'https://example.com', url: 'https://example.com/a', selector: '#go',
    })).toBe(true);
    expect(requiresProposal(
      spawn({ effectiveAuthority: 'autonomous', effectiveRiskCeiling: 'L0' }),
      { type: 'browser.click', origin: 'https://example.com', url: 'https://example.com/a', selector: '#go' },
    )).toBe(true);
  });

  it('lets an authorized operator agent perform L2 directly', () => {
    const operator = spawn({ tier: 'T1_operator', effectiveAuthority: 'autonomous', effectiveRiskCeiling: 'L2' });
    expect(requiresProposal(operator, {
      type: 'browser.click', origin: 'https://example.com', url: 'https://example.com/a', selector: '#go',
    })).toBe(false);
  });
});

describe('envelope enforcement at dispatch', () => {
  const worker = { id: 'worker.browser.web_inspect' } as never;
  const enveloped = (expiresAt: string, overrides = {}) => spawn({
    effectiveAuthority: 'envelope',
    effectiveRiskCeiling: 'L2',
    envelope: {
      maxRiskLevel: 'L2', workerIds: ['worker.browser.web_inspect'], maxOperations: 2, expiresAt, ...overrides,
    },
  });

  it('permits an action inside the envelope', () => {
    expect(envelopePermits(enveloped('2026-08-16T13:00:00.000Z'), worker, 'L0', NOW).allowed).toBe(true);
  });

  it('refuses once the envelope expires mid-run', () => {
    // Checked at dispatch, not only at spawn: an envelope can lapse while the
    // agent is still running.
    const result = envelopePermits(enveloped('2026-08-16T11:00:00.000Z'), worker, 'L0', NOW);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('expired');
  });

  it('refuses risk, workers, and operation counts beyond the envelope', () => {
    expect(envelopePermits(enveloped('2026-08-16T13:00:00.000Z'), worker, 'L3', NOW).allowed).toBe(false);
    expect(envelopePermits(enveloped('2026-08-16T13:00:00.000Z'), { id: 'worker.other' } as never, 'L0', NOW).allowed).toBe(false);
    expect(envelopePermits(
      { ...enveloped('2026-08-16T13:00:00.000Z'), operationsUsed: 2 },
      worker, 'L0', NOW,
    ).allowed).toBe(false);
  });

  it('does not apply to non-envelope agents', () => {
    expect(envelopePermits(spawn(), worker, 'L0', NOW).allowed).toBe(true);
  });
});

describe('orchestrator decomposition', () => {
  const orchestrator = spawn({
    tier: 'T3_orchestrator',
    effectiveRiskCeiling: 'L0',
    targets: ['https://a.test/1', 'https://b.test/2', 'https://c.test/3'],
  });

  it('creates one child per target, in order', () => {
    const plan = decomposeObjective({ parent: orchestrator, childDefinition: definition('T0_reader') });
    expect(plan.ok).toBe(true);
    expect(plan.children).toHaveLength(3);
    expect(plan.children[0].targets).toEqual(['https://a.test/1']);
    expect(plan.deferred).toEqual([]);
  });

  it('reports what the child budget could not cover instead of dropping it silently', () => {
    const plan = decomposeObjective({
      parent: { ...orchestrator, budget: { ...orchestrator.budget, maxChildren: 2 } },
      childDefinition: definition('T0_reader'),
    });
    expect(plan.children).toHaveLength(2);
    expect(plan.deferred).toEqual(['https://c.test/3']);
    expect(plan.reason).toContain('exceed the child budget');
  });

  it('refuses to spawn another orchestrator', () => {
    // Depth caps alone are a fragile defence against an unbounded tree.
    const plan = decomposeObjective({ parent: orchestrator, childDefinition: definition('T3_orchestrator') });
    expect(plan.ok).toBe(false);
    expect(plan.reason).toContain('may not spawn another orchestrator');
  });

  it('refuses decomposition from a tier that cannot spawn, or an agent not running', () => {
    expect(decomposeObjective({ parent: spawn(), childDefinition: definition('T0_reader') }).ok).toBe(false);
    expect(decomposeObjective({
      parent: { ...orchestrator, status: 'completed' },
      childDefinition: definition('T0_reader'),
    }).ok).toBe(false);
  });

  it('requires at least one target', () => {
    const plan = decomposeObjective({ parent: { ...orchestrator, targets: [] }, childDefinition: definition('T0_reader') });
    expect(plan.ok).toBe(false);
    expect(plan.reason).toContain('at least one target');
  });
});

describe('approval binding survives the authority change', () => {
  // dispatchAgentProposal re-derives the intent and compares this hash to the
  // one the operator approved. The check is defense-in-depth: spawn targets
  // cannot currently drift through any API, so it guards against a future
  // planner or a state-corruption bug rather than a reachable path today.
  const intentFor = (
    action: { type: string; origin: string; url: string; selector?: string },
    authority: { kind: 'kernel_policy' | 'approval'; referenceId: string },
  ) => ({
    schemaVersion: 1 as const,
    id: 'intent_1',
    goalId: 'goal_1',
    taskId: 'agent:spawn_1',
    workerId: 'worker.browser.playwright',
    riskLevel: 'L2' as const,
    action,
    scope: {
      family: 'browser' as const,
      operations: ['browser.click' as const],
      origins: [action.origin],
      downloadRoots: [],
    },
    authority,
    untrustedObservationIds: [],
    createdAt: NOW,
  });

  const click = { type: 'browser.click', origin: 'https://example.com', url: 'https://example.com/a', selector: '#accept' };

  it('is unchanged when only the authority changes', () => {
    // This is why the proposal commits to the binding hash rather than a whole
    // intent hash: the authority necessarily differs between propose and dispatch.
    const proposed = hashIntentAuthorityBinding(intentFor(click, { kind: 'kernel_policy', referenceId: 'spawn_1' }) as never);
    const dispatched = hashIntentAuthorityBinding(intentFor(click, { kind: 'approval', referenceId: 'approval_1' }) as never);

    expect(dispatched).toBe(proposed);
  });

  it('changes when the action being approved changes', () => {
    const approved = hashIntentAuthorityBinding(intentFor(click, { kind: 'approval', referenceId: 'approval_1' }) as never);

    const otherSelector = { ...click, selector: '#delete-everything' };
    const otherOrigin = { ...click, origin: 'https://elsewhere.test', url: 'https://elsewhere.test/a' };

    expect(hashIntentAuthorityBinding(intentFor(otherSelector, { kind: 'approval', referenceId: 'approval_1' }) as never)).not.toBe(approved);
    expect(hashIntentAuthorityBinding(intentFor(otherOrigin, { kind: 'approval', referenceId: 'approval_1' }) as never)).not.toBe(approved);
  });
});

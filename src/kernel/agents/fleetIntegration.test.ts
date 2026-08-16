import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createKernelService } from '../kernel';
import { readKernelEvents } from '../ledger';
import type { AgentFleetState } from './types';
import type { KernelActionWorker } from '../kernel';

let runtimeDir = '';
let kernel: ReturnType<typeof createKernelService>;

const workspaceRoot = process.cwd();

const goalInput = {
  objective: 'Exercise the agent fleet authority boundary',
  successCriteria: ['Fleet spawns are admitted under the correct authority'],
  constraints: ['Stay inside workspace'],
  autonomyLevel: 'supervised' as const,
  workspaceRoot,
  verificationCommands: ['npm test'],
  budget: { maxOperations: 50, maxCommandRuntimeMs: 120_000, maxApprovals: 10, maxProviderCalls: 0 },
};

const READER_WORKER_ID = 'worker.browser.web_inspect';

const readerRegistration = {
  id: READER_WORKER_ID,
  family: 'browser' as const,
  availability: 'available' as const,
  supportedActions: ['browser.inspect' as const],
  configuredScopes: [{
    family: 'browser' as const,
    operations: ['browser.inspect' as const],
    origins: ['https://example.com'],
    downloadRoots: [],
  }],
  registeredAt: '2026-08-16T11:00:00.000Z',
};

const CLICK_WORKER_ID = 'worker.browser.playwright';

const clickRegistration = {
  id: CLICK_WORKER_ID,
  family: 'browser' as const,
  availability: 'available' as const,
  supportedActions: ['browser.inspect' as const, 'browser.click' as const],
  configuredScopes: [{
    family: 'browser' as const,
    operations: ['browser.inspect' as const, 'browser.click' as const],
    origins: ['https://example.com', 'https://elsewhere.test'],
    downloadRoots: [],
  }],
  registeredAt: '2026-08-16T11:00:00.000Z',
};

let dispatched: string[] = [];

const recordingWorker: KernelActionWorker = {
  execute: async (intent) => {
    dispatched.push((intent.action as { url?: string }).url ?? intent.action.type);
    return { status: 'succeeded', summary: 'inspected', sourceRef: 'test' };
  },
};

const makeKernel = (agentExecutionEnabled: boolean) => createKernelService({
  runtimeDir,
  allowedWorkspaceRoot: workspaceRoot,
  agentExecutionEnabled,
  workerRegistrations: [readerRegistration, clickRegistration],
  actionWorkers: { [READER_WORKER_ID]: recordingWorker, [CLICK_WORKER_ID]: recordingWorker },
});

beforeEach(async () => {
  runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'provenance-fleet-'));
  dispatched = [];
  kernel = createKernelService({ runtimeDir, allowedWorkspaceRoot: workspaceRoot });
});

afterEach(async () => {
  await rm(runtimeDir, { recursive: true, force: true });
});

const defineAgent = (tier: string, domain: string) => kernel.createAgentDefinition({
  name: `${tier} specialist`,
  description: 'integration fixture',
  tier,
  domain,
  workerIds: [],
});

const eventTypes = async (): Promise<string[]> =>
  (await readKernelEvents(runtimeDir)).map((event) => event.type);

describe('agent fleet through the kernel', () => {
  it('starts a propose-only agent immediately and ledgers the authority it received', async () => {
    const goal = await kernel.createGoal(goalInput);
    const definition = await defineAgent('T1_operator', 'web');

    const spawn = await kernel.spawnAgent({
      definitionId: definition.id,
      goalId: goal.id,
      objective: 'Summarise the target page',
      requestedAuthority: 'propose_only',
    });

    expect(spawn.status).toBe('running');
    // propose_only is pinned to L1: anything consequential is for a human.
    expect(spawn.effectiveRiskCeiling).toBe('L1');
    expect(spawn.approvalId).toBeUndefined();
    expect(await eventTypes()).toContain('agent.spawn_requested');

    const fleet = await kernel.getAgentFleet() as AgentFleetState;
    expect(fleet.spawns).toHaveLength(1);
    expect(fleet.definitions).toHaveLength(1);
  });

  it('refuses to start an autonomous agent until an operator authorizes it', async () => {
    const goal = await kernel.createGoal(goalInput);
    const definition = await defineAgent('T1_operator', 'web');

    const spawn = await kernel.spawnAgent({
      definitionId: definition.id,
      goalId: goal.id,
      objective: 'Act without per-action prompts',
      requestedAuthority: 'autonomous',
    });

    // The agent does not run, and an approval exists for the escalation itself.
    expect(spawn.status).toBe('approval_required');
    expect(spawn.approvalId).toBeTruthy();
    const state = await kernel.getState();
    const approval = state.approvals.find((candidate) => candidate.id === spawn.approvalId);
    expect(approval?.status).toBe('pending');
    expect(approval?.requestedAction).toContain('autonomous');

    // Authorizing before the approval is decided must fail.
    await expect(kernel.authorizeAgentSpawn(spawn.id)).rejects.toThrow('approved approval record');

    await kernel.decideApproval(approval!.id, 'approved', 'Reviewed scope; autonomy granted.', {
      principalId: 'user:alice', mode: 'multi_user', role: 'operator', attribution: 'natural_person',
    });

    const authorized = await kernel.authorizeAgentSpawn(spawn.id);
    expect(authorized.status).toBe('running');
    expect(authorized.effectiveRiskCeiling).toBe('L2');
    // The escalation is attributed to the person who granted it.
    expect(authorized.authorizedBy?.principalId).toBe('user:alice');
    expect(authorized.authorizedBy?.attribution).toBe('natural_person');
    expect(await eventTypes()).toContain('agent.spawn_authorized');
  });

  it('ledgers a refused spawn rather than silently dropping it', async () => {
    const goal = await kernel.createGoal(goalInput);
    const definition = await defineAgent('T0_reader', 'research');

    await expect(kernel.spawnAgent({
      definitionId: definition.id,
      goalId: goal.id,
      objective: '   ',
      requestedAuthority: 'propose_only',
    })).rejects.toThrow('objective');

    expect(await eventTypes()).toContain('agent.spawn_refused');
    const fleet = await kernel.getAgentFleet() as AgentFleetState;
    expect(fleet.spawns).toHaveLength(0);
  });

  it('revokes a live agent and records the reason', async () => {
    const goal = await kernel.createGoal(goalInput);
    const definition = await defineAgent('T0_reader', 'research');
    const spawn = await kernel.spawnAgent({
      definitionId: definition.id,
      goalId: goal.id,
      objective: 'Read the docs',
      requestedAuthority: 'propose_only',
    });

    const revoked = await kernel.revokeAgentSpawn(spawn.id, 'Operator halted this agent.');
    expect(revoked.status).toBe('revoked');
    expect(revoked.failureReason).toBe('Operator halted this agent.');
    expect(await eventTypes()).toContain('agent.revoked');

    await expect(kernel.revokeAgentSpawn(spawn.id, 'again')).rejects.toThrow('live agent');
  });

  it('refuses to spawn while Stop All is active', async () => {
    const goal = await kernel.createGoal(goalInput);
    const definition = await defineAgent('T0_reader', 'research');
    await kernel.setStopAll(true, 'Halting the fleet for a drill.');

    await expect(kernel.spawnAgent({
      definitionId: definition.id,
      goalId: goal.id,
      objective: 'Should not start',
      requestedAuthority: 'propose_only',
    })).rejects.toThrow('Stop All');
  });

  it('keeps the ledger verifiable across fleet operations', async () => {
    const goal = await kernel.createGoal(goalInput);
    const definition = await defineAgent('T0_reader', 'research');
    await kernel.spawnAgent({
      definitionId: definition.id,
      goalId: goal.id,
      objective: 'Read the docs',
      requestedAuthority: 'propose_only',
    });

    // readKernelEvents re-verifies the whole chain, so this failing would mean
    // a fleet event broke the hash chain.
    const events = await readKernelEvents(runtimeDir);
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((event) => event.entityType === 'agent')).toBe(true);
  });
});

describe('agent execution', () => {
  const defineReader = (target: string[] = ['https://example.com/a', 'https://example.com/b']) => ({
    target,
  });

  it('refuses to run when fleet execution is not enabled for the deployment', async () => {
    kernel = makeKernel(false);
    const goal = await kernel.createGoal(goalInput);
    const definition = await kernel.createAgentDefinition({
      name: 'reader', description: 'reads', tier: 'T0_reader', domain: 'research',
      workerIds: [READER_WORKER_ID],
    });
    const spawn = await kernel.spawnAgent({
      definitionId: definition.id, goalId: goal.id, objective: 'Read',
      requestedAuthority: 'propose_only', targets: defineReader().target,
    });

    expect(kernel.agentExecutionStatus().enabled).toBe(false);
    await expect(kernel.runAgentStep(spawn.id)).rejects.toThrow('Agent execution is disabled');
    expect(dispatched).toEqual([]);
  });

  it('actually dispatches real work through the capability path, one target per step', async () => {
    kernel = makeKernel(true);
    const goal = await kernel.createGoal(goalInput);
    const definition = await kernel.createAgentDefinition({
      name: 'reader', description: 'reads', tier: 'T0_reader', domain: 'research',
      workerIds: [READER_WORKER_ID],
    });
    const spawn = await kernel.spawnAgent({
      definitionId: definition.id, goalId: goal.id, objective: 'Read',
      requestedAuthority: 'propose_only', targets: defineReader().target,
    });

    const first = await kernel.runAgentStep(spawn.id);
    expect(first.kind).toBe('stepped');
    expect(first.spawn.operationsUsed).toBe(1);
    expect(dispatched).toEqual(['https://example.com/a']);

    const second = await kernel.runAgentStep(spawn.id);
    expect(second.kind).toBe('stepped');
    expect(dispatched).toEqual(['https://example.com/a', 'https://example.com/b']);

    // Out of targets: the agent completes rather than looping.
    const third = await kernel.runAgentStep(spawn.id);
    expect(third.kind).toBe('completed');
    expect(third.spawn.status).toBe('completed');

    // The dispatch consumed a real single-use grant, so the evidence is there.
    const types = await eventTypes();
    expect(types).toContain('capability.grant_consumed');
    expect(types).toContain('agent.step_completed');
    expect(types).toContain('agent.completed');
  });

  it('stops a revoked agent from doing any further work', async () => {
    kernel = makeKernel(true);
    const goal = await kernel.createGoal(goalInput);
    const definition = await kernel.createAgentDefinition({
      name: 'reader', description: 'reads', tier: 'T0_reader', domain: 'research',
      workerIds: [READER_WORKER_ID],
    });
    const spawn = await kernel.spawnAgent({
      definitionId: definition.id, goalId: goal.id, objective: 'Read',
      requestedAuthority: 'propose_only', targets: defineReader().target,
    });

    await kernel.revokeAgentSpawn(spawn.id, 'Operator halted this agent.');
    const outcome = await kernel.runAgentStep(spawn.id);

    expect(outcome.kind).toBe('failed');
    expect(dispatched).toEqual([]);
  });

  it('fans an orchestrator out into one child per target and ledgers the plan', async () => {
    kernel = makeKernel(true);
    const goal = await kernel.createGoal(goalInput);
    const orchestratorDefinition = await kernel.createAgentDefinition({
      name: 'planner', description: 'plans', tier: 'T3_orchestrator', domain: 'research',
      workerIds: [READER_WORKER_ID],
    });
    const readerDefinition = await kernel.createAgentDefinition({
      name: 'reader', description: 'reads', tier: 'T0_reader', domain: 'research',
      workerIds: [READER_WORKER_ID],
    });
    const parent = await kernel.spawnAgent({
      definitionId: orchestratorDefinition.id, goalId: goal.id, objective: 'Survey sources',
      requestedAuthority: 'propose_only',
      targets: ['https://example.com/a', 'https://example.com/b'],
    });

    const result = await kernel.runAgentOrchestration(parent.id, readerDefinition.id);

    expect(result.children).toHaveLength(2);
    expect(result.children[0].parentSpawnId).toBe(parent.id);
    expect(result.children[0].depth).toBe(1);
    expect(result.children[0].targets).toEqual(['https://example.com/a']);
    expect(result.deferred).toEqual([]);

    const fleet = await kernel.getAgentFleet() as AgentFleetState;
    expect(fleet.spawns).toHaveLength(3);

    // Children do real work through the same path as any other agent.
    const step = await kernel.runAgentStep(result.children[0].id);
    expect(step.kind).toBe('stepped');
    expect(dispatched).toEqual(['https://example.com/a']);
  });

  it('refuses orchestration from a tier that cannot spawn', async () => {
    kernel = makeKernel(true);
    const goal = await kernel.createGoal(goalInput);
    const readerDefinition = await kernel.createAgentDefinition({
      name: 'reader', description: 'reads', tier: 'T0_reader', domain: 'research',
      workerIds: [READER_WORKER_ID],
    });
    const spawn = await kernel.spawnAgent({
      definitionId: readerDefinition.id, goalId: goal.id, objective: 'Read',
      requestedAuthority: 'propose_only', targets: ['https://example.com/a'],
    });

    await expect(kernel.runAgentOrchestration(spawn.id, readerDefinition.id))
      .rejects.toThrow('may not decompose work');
  });
});

describe('proposal to dispatch loop', () => {
  const setup = async () => {
    kernel = makeKernel(true);
    const goal = await kernel.createGoal(goalInput);
    const definition = await kernel.createAgentDefinition({
      name: 'operator', description: 'clicks', tier: 'T1_operator', domain: 'web',
      workerIds: [CLICK_WORKER_ID],
    });
    const spawn = await kernel.spawnAgent({
      definitionId: definition.id, goalId: goal.id, objective: 'Interact',
      requestedAuthority: 'propose_only', targets: ['https://example.com/a'],
      targetAction: 'click', targetSelector: '#accept',
    });
    return { goal, definition, spawn };
  };

  it('proposes instead of acting, and raises the approval a human decides', async () => {
    const { spawn } = await setup();

    const outcome = await kernel.runAgentStep(spawn.id);

    expect(outcome.kind).toBe('proposed');
    expect(dispatched).toEqual([]);
    const proposal = outcome.proposal!;
    expect(proposal.status).toBe('pending');
    expect(proposal.riskLevel).toBe('L2');

    // The approval exists and is pending; nothing has been authorized yet.
    const state = await kernel.getState();
    const approval = state.approvals.find((item) => item.id === proposal.approvalId);
    expect(approval?.status).toBe('pending');
    expect(await eventTypes()).toContain('agent.proposed');
  });

  it('refuses to dispatch a proposal whose approval is still pending', async () => {
    const { spawn } = await setup();
    const proposal = (await kernel.runAgentStep(spawn.id)).proposal!;

    await expect(kernel.dispatchAgentProposal(proposal.id))
      .rejects.toThrow('only dispatch under an approved approval');
    expect(dispatched).toEqual([]);
  });

  it('dispatches once approved, then refuses to dispatch again', async () => {
    const { spawn } = await setup();
    const proposal = (await kernel.runAgentStep(spawn.id)).proposal!;
    await kernel.decideApproval(proposal.approvalId, 'approved', 'Reviewed the click target.', {
      principalId: 'user:alice', mode: 'multi_user', role: 'operator', attribution: 'natural_person',
    });

    const result = await kernel.dispatchAgentProposal(proposal.id);

    expect(result.kind).toBe('stepped');
    expect(dispatched).toEqual(['https://example.com/a']);
    expect(result.proposal?.status).toBe('dispatched');

    const types = await eventTypes();
    expect(types).toContain('agent.proposal_dispatched');
    expect(types).toContain('capability.grant_consumed');

    // Single use: the approval was spent, so a retry needs a new approval.
    await expect(kernel.dispatchAgentProposal(proposal.id)).rejects.toThrow('already dispatched');
    expect(dispatched).toHaveLength(1);
  });

  it('refuses to dispatch for a revoked agent', async () => {
    const { spawn } = await setup();
    const proposal = (await kernel.runAgentStep(spawn.id)).proposal!;
    await kernel.decideApproval(proposal.approvalId, 'approved', 'Approved.', {
      principalId: 'user:alice', mode: 'multi_user', role: 'operator', attribution: 'natural_person',
    });
    await kernel.revokeAgentSpawn(spawn.id, 'Operator halted this agent.');

    await expect(kernel.dispatchAgentProposal(proposal.id)).rejects.toThrow('revoked');
    expect(dispatched).toEqual([]);
  });
});

describe('model-driven planning', () => {
  // A stub router standing in for a model. What matters is not what it says but
  // that the kernel keeps only what the agent was already permitted to do.
  const routerReturning = (content: string) => ({
    plan: () => ({ selections: [{ provider: 'gemini', model: 'stub' }], mode: 'automatic' }),
    execute: async () => ({
      plan: { selections: [{ provider: 'gemini', model: 'stub' }], mode: 'automatic' },
      results: [{
        requestId: 'req_1', provider: 'gemini', model: 'stub', text: content,
        toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: 'stop', latencyMs: 1,
      }],
      errors: [],
      disagreement: false,
    }),
  }) as never;

  const plannerKernel = (content: string) => createKernelService({
    runtimeDir,
    allowedWorkspaceRoot: workspaceRoot,
    agentExecutionEnabled: true,
    workerRegistrations: [clickRegistration],
    actionWorkers: { [CLICK_WORKER_ID]: recordingWorker },
    providerRouter: routerReturning(content),
  });

  const plannedAgent = async () => {
    // Planning spends a provider call, so the goal must budget for one.
    const goal = await kernel.createGoal({
      ...goalInput,
      budget: { ...goalInput.budget, maxProviderCalls: 5 },
    });
    const definition = await kernel.createAgentDefinition({
      name: 'planner-driven', description: 'reads', tier: 'T0_reader', domain: 'research',
      workerIds: [CLICK_WORKER_ID],
    });
    const spawn = await kernel.spawnAgent({
      definitionId: definition.id, goalId: goal.id, objective: 'Survey the docs',
      requestedAuthority: 'propose_only',
    });
    return spawn;
  };

  it('accepts a model plan and turns it into real, dispatchable work', async () => {
    kernel = plannerKernel(JSON.stringify({
      targets: ['https://example.com/a', 'https://example.com/b'],
      action: 'inspect',
      rationale: 'Both pages cover the topic.',
    }));
    const spawn = await plannedAgent();

    const planned = await kernel.planAgentWithModel(spawn.id);

    expect(planned.ok).toBe(true);
    expect(planned.spawn.targets).toEqual(['https://example.com/a', 'https://example.com/b']);
    expect(await eventTypes()).toContain('agent.plan_accepted');

    // The plan is real: the agent now does the work the model chose.
    const step = await kernel.runAgentStep(spawn.id);
    expect(step.kind).toBe('stepped');
    expect(dispatched).toEqual(['https://example.com/a']);
  });

  it('discards targets outside the worker origins and ledgers the refusal', async () => {
    // A model steered by injected page content still cannot reach a new origin.
    kernel = plannerKernel(JSON.stringify({
      targets: ['https://example.com/keep', 'https://evil.test/exfiltrate'],
      action: 'inspect',
    }));
    const spawn = await plannedAgent();

    const planned = await kernel.planAgentWithModel(spawn.id);

    expect(planned.ok).toBe(true);
    expect(planned.spawn.targets).toEqual(['https://example.com/keep']);
    expect(planned.rejected).toEqual([
      { value: 'https://evil.test/exfiltrate', reasonCode: 'origin_not_configured' },
    ]);
    expect(await eventTypes()).toContain('agent.plan_accepted');
  });

  it('rejects a plan whose every target is outside the boundary', async () => {
    kernel = plannerKernel(JSON.stringify({ targets: ['https://evil.test/a'], action: 'inspect' }));
    const spawn = await plannedAgent();

    const planned = await kernel.planAgentWithModel(spawn.id);

    expect(planned.ok).toBe(false);
    expect(planned.spawn.targets).toBeUndefined();
    expect(await eventTypes()).toContain('agent.plan_rejected');
    // Nothing was dispatched, and the agent has no work.
    const step = await kernel.runAgentStep(spawn.id);
    expect(step.kind).toBe('completed');
    expect(dispatched).toEqual([]);
  });

  it('rejects a non-JSON model response rather than guessing', async () => {
    kernel = plannerKernel('I think you should visit https://evil.test');
    const spawn = await plannedAgent();

    const planned = await kernel.planAgentWithModel(spawn.id);

    expect(planned.ok).toBe(false);
    expect(planned.reason).toContain('not a JSON object');
    expect(await eventTypes()).toContain('agent.plan_rejected');
  });

  it('keeps a model-planned click below the agent ceiling by proposing it', async () => {
    // The planner may choose a click; that does not grant the agent authority
    // to perform one. A T0 reader still has to propose it.
    kernel = plannerKernel(JSON.stringify({
      targets: ['https://example.com/a'], action: 'click', selector: '#accept',
    }));
    const spawn = await plannedAgent();

    const planned = await kernel.planAgentWithModel(spawn.id);
    expect(planned.ok).toBe(true);
    expect(planned.spawn.targetAction).toBe('click');

    const step = await kernel.runAgentStep(spawn.id);
    expect(step.kind).toBe('proposed');
    expect(dispatched).toEqual([]);
  });

  it('refuses to plan while execution is disabled', async () => {
    kernel = makeKernel(false);
    const spawn = await plannedAgent();

    await expect(kernel.planAgentWithModel(spawn.id)).rejects.toThrow('Agent execution is disabled');
  });
});

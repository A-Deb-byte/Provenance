import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createKernelService } from '../kernel';
import { readKernelEvents } from '../ledger';
import type { AgentFleetState } from './types';

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

beforeEach(async () => {
  runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'provenance-fleet-'));
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

import { describe, expect, it } from 'vitest';
import type { AutomationContract, WorkerRegistration } from '../capabilities/types';
import type { ProviderPublicStatus } from '../providers/types';
import { createApprovalRecord } from './approvals';
import { buildObservatorySnapshot } from './observatory';
import { createEmptyKernelState } from './store';
import type { GoalContract, KernelEvent } from './types';

const now = '2026-07-29T10:00:00.000Z';
const secretSentinel = 'DO_NOT_RENDER_PROVIDER_PROMPT';

const goal: GoalContract = {
  id: 'goal_1',
  objective: 'Inspect the operator fixture',
  successCriteria: ['Evidence is recorded'],
  constraints: ['Stay inside scope'],
  autonomyLevel: 'bounded',
  workspaceRoot: 'C:\\fixture',
  verificationCommands: ['npm test'],
  budget: {
    maxOperations: 10,
    maxCommandRuntimeMs: 30_000,
    maxApprovals: 3,
    maxProviderCalls: 5,
  },
  usage: {
    operations: 1,
    commandRuntimeMs: 0,
    approvals: 1,
    providerCalls: 0,
  },
  status: 'active',
  createdAt: now,
  updatedAt: now,
};

const automation: AutomationContract = {
  schemaVersion: 1,
  id: 'automation_browser_1',
  name: 'Inspect account page',
  enabled: true,
  goalId: goal.id,
  workerId: 'worker.browser.local',
  riskLevel: 'L2',
  action: {
    type: 'browser.type',
    origin: 'https://example.com',
    url: 'https://example.com/account',
    selector: '#query',
    payloadArtifactId: 'artifact_payload_1',
    payloadHash: 'a'.repeat(64),
  },
  scope: {
    family: 'browser',
    operations: ['browser.type'],
    origins: ['https://example.com'],
    downloadRoots: [],
  },
  trigger: { type: 'manual' },
  approvalMode: 'per_run',
  budget: { maxRuns: 3, maxConsecutiveFailures: 1, maxRuntimeMsPerRun: 10_000 },
  createdAt: now,
  updatedAt: now,
};

const worker: WorkerRegistration = {
  id: 'worker.browser.local',
  family: 'browser',
  availability: 'available',
  supportedActions: ['browser.inspect', 'browser.type'],
  configuredScopes: [automation.scope],
  registeredAt: now,
  lastSeenAt: now,
};

const provider: ProviderPublicStatus = {
  id: 'openrouter',
  configured: true,
  credentialSource: 'server_env',
  endpoint: 'https://openrouter.ai/api/v1',
  defaultModel: 'openrouter/free',
  allowedModels: ['openrouter/free'],
  capabilities: ['text'],
  routingPriority: 1,
};

const event = (
  id: string,
  timestamp: string,
  type: string,
  payload: Record<string, unknown>,
): KernelEvent => ({
  id,
  timestamp,
  actor: type.endsWith('completed') ? 'worker' : 'kernel',
  type,
  entityId: automation.id,
  entityType: 'automation',
  payload,
  previousHash: null,
  hash: id.padEnd(64, '0').slice(0, 64),
});

describe('kernel observatory projection', () => {
  it('joins exact action targets while excluding raw payload fields and secrets', () => {
    const approval = createApprovalRecord({
      goalId: goal.id,
      taskId: `automation:${automation.id}`,
      requestedAction: `automation-run:${automation.id}:${'b'.repeat(64)}`,
      riskLevel: 'L2',
      reason: 'Typing requires explicit approval.',
    }, now);
    const events = [
      event('event_1', '2026-07-29T09:59:00.000Z', 'automation.run_started', {
        automationId: automation.id,
        intentId: 'intent_1',
        actionType: automation.action.type,
        rawPrompt: secretSentinel,
      }),
      event('event_2', '2026-07-29T09:59:10.000Z', 'automation.run_completed', {
        automationId: automation.id,
        intentId: 'intent_1',
        summary: 'Browser typing completed.',
        rawObservation: secretSentinel,
      }),
    ];
    const state = {
      ...createEmptyKernelState(),
      goals: [goal],
      approvals: [approval],
      automations: [automation],
      lastEventHash: events.at(-1)?.hash ?? null,
    };

    const projection = buildObservatorySnapshot({
      state,
      events,
      workers: [worker],
      providers: [provider],
      now,
    });

    expect(projection.schemaVersion).toBe(1);
    expect(projection.ledgerHead).toBe(events.at(-1)?.hash);
    expect(projection.approvals[0]).toMatchObject({
      actionSummary: 'Browser Type on https://example.com/account',
      surface: {
        kind: 'browser',
        primary: 'https://example.com/account',
        secondary: '#query',
      },
    });
    expect(projection.activities[0]).toMatchObject({
      type: 'automation.run_completed',
      status: 'succeeded',
      summary: 'Browser typing completed.',
      surface: { kind: 'browser', primary: 'https://example.com/account' },
    });
    expect(projection.currentWork).toEqual([
      expect.objectContaining({
        kind: 'automation',
        status: 'awaiting_approval',
        title: 'Inspect account page',
      }),
    ]);
    expect(projection.providers[0]).toMatchObject({ id: 'openrouter', defaultModel: 'openrouter/free' });
    expect(JSON.stringify(projection)).not.toContain(secretSentinel);
    expect(JSON.stringify(projection)).not.toContain('artifact_payload_1');
  });

  it('derives in-flight automation and provider work from unmatched start events', () => {
    const events: KernelEvent[] = [
      event('event_3', '2026-07-29T09:59:30.000Z', 'automation.run_started', {
        automationId: automation.id,
        intentId: 'intent_active',
        actionType: automation.action.type,
      }),
      {
        ...event('event_4', '2026-07-29T09:59:40.000Z', 'provider.call.started', {
          goalId: goal.id,
          selections: [{ provider: 'openrouter', model: 'openrouter/free' }],
        }),
        entityId: 'request_1',
        entityType: 'provider',
      },
    ];
    const state = {
      ...createEmptyKernelState(),
      goals: [goal],
      automations: [automation],
      lastEventHash: events.at(-1)?.hash ?? null,
    };

    const projection = buildObservatorySnapshot({
      state,
      events,
      workers: [worker],
      providers: [provider],
      activeRuntime: {
        actions: [{
          id: 'intent_active',
          kind: 'automation',
          goalId: goal.id,
          taskId: `automation:${automation.id}`,
          automationId: automation.id,
          startedAt: '2026-07-29T09:59:30.000Z',
          action: automation.action,
        }],
        providers: [{
          id: 'request_1',
          goalId: goal.id,
          startedAt: '2026-07-29T09:59:40.000Z',
          routes: [{ provider: 'openrouter', model: 'openrouter/free' }],
        }],
        recurring: [],
        recovery: { inProgress: false },
      },
      now,
    });

    expect(projection.currentWork.map((work) => work.kind)).toEqual(['provider', 'automation']);
    expect(projection.currentWork[0]).toMatchObject({
      title: 'Provider: openrouter',
      detail: 'openrouter/free',
    });
    expect(projection.currentWork[1]).toMatchObject({
      title: 'Inspect account page',
      surface: { primary: 'https://example.com/account' },
    });
  });

  it('keeps canonical ledger order, labels uncertainty, and exposes surfaces only for execution evidence', () => {
    const events = [
      event('event_created', now, 'automation.created', {
        automationId: automation.id,
      }),
      event('event_uncertain', now, 'automation.run_uncertain', {
        automationId: automation.id,
        intentId: 'intent_uncertain',
        summary: 'The worker outcome could not be proven.',
      }),
    ];
    const state = {
      ...createEmptyKernelState(),
      goals: [goal],
      automations: [automation],
      lastEventHash: events.at(-1)?.hash ?? null,
    };

    const projection = buildObservatorySnapshot({
      state,
      events,
      workers: [worker],
      now,
    });

    expect(projection.activities.map((activity) => activity.id)).toEqual([
      'event_uncertain',
      'event_created',
    ]);
    expect(projection.activities[0]).toMatchObject({
      status: 'uncertain',
      surface: { kind: 'browser', primary: 'https://example.com/account' },
    });
    expect(projection.activities[1].surface).toBeUndefined();
  });

  it('does not present historical starts as running without a live runtime controller', () => {
    const events = [
      event('event_historical', now, 'automation.run_started', {
        automationId: automation.id,
        intentId: 'intent_no_longer_active',
      }),
    ];
    const state = {
      ...createEmptyKernelState(),
      automations: [automation],
      lastEventHash: events.at(-1)?.hash ?? null,
    };

    const projection = buildObservatorySnapshot({
      state,
      events,
      workers: [worker],
      now,
    });

    expect(projection.currentWork).toEqual([]);
  });

  it('rejects a state projection that does not match the authenticated ledger head', () => {
    const events = [
      event('event_head', now, 'automation.created', { automationId: automation.id }),
    ];
    const state = {
      ...createEmptyKernelState(),
      automations: [automation],
      lastEventHash: 'f'.repeat(64),
    };

    expect(() => buildObservatorySnapshot({
      state,
      events,
      workers: [worker],
      now,
    })).toThrow('Observatory state does not match the authenticated ledger head.');
  });

  it('redacts token-like content across every free-form operator surface', () => {
    const token = `sk-or-v1-${'a'.repeat(48)}`;
    const sensitiveAutomation: AutomationContract = {
      ...automation,
      name: `Inspect credential ${token}`,
      action: {
        type: 'browser.type',
        origin: 'https://example.com',
        url: `https://example.com/account?api_key=${token}`,
        selector: '#query',
        payloadArtifactId: 'artifact_payload_sensitive',
        payloadHash: 'a'.repeat(64),
      },
    };
    const approval = createApprovalRecord({
      goalId: goal.id,
      taskId: `automation:${sensitiveAutomation.id}`,
      requestedAction: `token=${token}`,
      riskLevel: 'L2',
      reason: `Authorization: Bearer ${token}`,
    }, now);
    const events = [
      event('event_sensitive', now, 'automation.run_failed', {
        automationId: sensitiveAutomation.id,
        summary: `provider token=${token}`,
      }),
    ];
    const state = {
      ...createEmptyKernelState(),
      goals: [{ ...goal, objective: `Inspect ${token}` }],
      approvals: [approval],
      automations: [sensitiveAutomation],
      controls: {
        stopAll: true,
        stopAllReason: `password=${token}`,
        updatedAt: now,
      },
      lastEventHash: events.at(-1)?.hash ?? null,
    };

    const projection = buildObservatorySnapshot({
      state,
      events,
      workers: [worker],
      now,
    });
    const serialized = JSON.stringify(projection);

    expect(serialized).not.toContain(token);
    expect(serialized).toContain('[REDACTED]');
    expect(projection.goals[0]?.objective).toBe('Inspect [REDACTED]');
    expect(projection.controls.stopAllReason).toBe('password=[REDACTED]');
    expect(projection.approvals[0]?.surface?.url).toContain('api_key=[REDACTED]');
    expect(projection.activities[0]?.summary).toBe('provider token=[REDACTED]');
  });

  it('orders pending approvals before newer approved decisions', () => {
    const pending = createApprovalRecord({
      goalId: goal.id,
      taskId: 'task_pending',
      requestedAction: 'Run pending task',
      riskLevel: 'L2',
      reason: 'Pending operator review.',
    }, '2026-07-29T09:00:00.000Z');
    const approvedBase = createApprovalRecord({
      goalId: goal.id,
      taskId: 'task_approved',
      requestedAction: 'Run approved task',
      riskLevel: 'L2',
      reason: 'Already reviewed.',
    }, '2026-07-29T10:00:00.000Z');
    const approved = {
      ...approvedBase,
      status: 'approved' as const,
      decidedAt: '2026-07-29T10:01:00.000Z',
      decisionReason: 'Approved for one execution.',
    };

    const projection = buildObservatorySnapshot({
      state: {
        ...createEmptyKernelState(),
        approvals: [approved, pending],
      },
      events: [],
      workers: [],
      now,
    });

    expect(projection.approvals.map((item) => item.id)).toEqual([pending.id, approved.id]);
    expect(projection.currentWork.map((item) => item.status)).toEqual([
      'awaiting_approval',
      'approved_waiting_execution',
    ]);
  });

  it('shows controller-owned recurring and recovery work without reconstructing historical starts', () => {
    const projection = buildObservatorySnapshot({
      state: {
        ...createEmptyKernelState(),
        goals: [goal],
      },
      events: [],
      workers: [],
      activeRuntime: {
        providers: [],
        actions: [],
        recurring: [{
          occurrenceId: 'occurrence_1',
          scheduleId: 'schedule_1',
          goalId: goal.id,
          missionId: 'mission_1',
          startedAt: '2026-07-29T09:55:00.000Z',
        }],
        recovery: {
          inProgress: true,
          startedAt: '2026-07-29T09:56:00.000Z',
        },
      },
      now,
    });

    expect(projection.currentWork).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'recurring', status: 'running', id: 'occurrence_1' }),
      expect.objectContaining({ kind: 'recovery', status: 'running', id: 'kernel-recovery' }),
    ]));
  });
});

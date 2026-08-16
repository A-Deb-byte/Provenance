import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildDispatchDecisionRecord,
  hashIntentAuthorityBinding,
  type DispatchDecisionRecord,
} from '../src/capabilities/decisionRecord';
import { createCapabilityGrant } from '../src/capabilities/grants';
import { hashKernelEvent } from '../src/kernel/ledger';
import { browserScope, browserWorker } from '../src/capabilities/testFixtures';
import type { ActionIntent } from '../src/capabilities/types';
import { createKernelService } from '../src/kernel/kernel';

const replayerPath = path.resolve(process.cwd(), 'scripts', 'replay-ledger.mjs');
const temporaryDirectories: string[] = [];

interface ReplayReport {
  ok: boolean;
  events?: number;
  decisionsReplayed?: number;
  outcomeOnlyDecisions?: number;
  divergences?: { code: string; detail: string }[];
  warnings?: { code: string; detail: string }[];
  explicitlyAllowedEmpty?: boolean;
  error?: string;
}

const makeDirectory = async (prefix = 'provenance-replay-'): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};

const runReplayer = (runtimeDirectory: string, options: string[] = []) => {
  const result = spawnSync(
    process.execPath,
    [replayerPath, '--json', ...options, runtimeDirectory],
    { encoding: 'utf8' },
  );
  return {
    status: result.status,
    report: JSON.parse(result.stdout) as ReplayReport,
    stderr: result.stderr,
  };
};

const canonical = (value: unknown): string => {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(',')}}`;
};

const canonicalHash = (value: unknown): string =>
  crypto.createHash('sha256').update(canonical(value), 'utf8').digest('hex');

const writeLedger = async (
  directory: string,
  entries: Record<string, unknown>[],
): Promise<void> => {
  let previousHash: string | null = null;
  const lines: string[] = [];
  for (const [index, entry] of entries.entries()) {
    const withoutHash = {
      id: `event_${index}`,
      timestamp: new Date(Date.UTC(2026, 6, 25, 12, index)).toISOString(),
      previousHash,
      actor: 'kernel',
      ...entry,
    };
    // The kernel's own hash, so a fixture can never drift from the real chain
    // format. A change to event hashing must break these tests loudly.
    const hash = hashKernelEvent(withoutHash as unknown as Parameters<typeof hashKernelEvent>[0]);
    previousHash = hash;
    lines.push(JSON.stringify({ ...withoutHash, hash }));
  }
  await writeFile(path.join(directory, 'events.jsonl'), `${lines.join('\n')}\n`, 'utf8');
};

const intent: ActionIntent = {
  schemaVersion: 1,
  id: 'intent_1',
  goalId: 'goal_1',
  taskId: 'task_1',
  workerId: browserWorker.id,
  riskLevel: 'L2',
  action: {
    type: 'browser.navigate',
    origin: 'https://example.com',
    url: 'https://example.com/private?credential=never-record-this#private',
  },
  scope: browserScope,
  authority: { kind: 'approval', referenceId: 'approval_1' },
  untrustedObservationIds: [],
  createdAt: '2026-07-25T12:01:00.000Z',
};

const dispatchRecord = (grantId = 'cap_1'): DispatchDecisionRecord => {
  const grant = createCapabilityGrant(intent, {
    id: grantId,
    issuedAt: '2026-07-25T12:01:00.000Z',
    expiresAt: '2026-07-25T12:10:00.000Z',
    maxOps: 1,
    approvalId: 'approval_1',
  });
  return buildDispatchDecisionRecord(
    {
      grant,
      intent,
      worker: browserWorker,
      now: '2026-07-25T12:02:00.000Z',
      operationsUsed: 1,
    },
    {
      allowed: true,
      reasonCode: 'allowed',
      reason: 'Capability grant consumed.',
      riskLevel: 'L2',
      grantStatus: 'consumed',
      usedOps: 1,
      consumedAt: '2026-07-25T12:02:00.000Z',
    },
  );
};

const approvalEvents = (bindingHash = hashIntentAuthorityBinding(intent)) => [
  {
    type: 'approval.requested',
    entityId: 'approval_1',
    entityType: 'approval',
    payload: {
      goalId: intent.goalId,
      taskId: intent.taskId,
      riskLevel: intent.riskLevel,
      authorityBindingHash: bindingHash,
    },
  },
  {
    actor: 'user',
    type: 'approval.approved',
    entityId: 'approval_1',
    entityType: 'approval',
    payload: {
      goalId: intent.goalId,
      taskId: intent.taskId,
      riskLevel: intent.riskLevel,
      authorityBindingHash: bindingHash,
    },
  },
];

const consumedEvent = (
  record: DispatchDecisionRecord,
  overrides: Record<string, unknown> = {},
) => ({
  type: 'capability.grant_consumed',
  entityId: record.inputs.grant.id,
  entityType: 'capability',
  payload: {
    grantId: record.inputs.grant.id,
    intentId: record.inputs.intent.id,
    approvalId: record.inputs.grant.approvalId,
    grantStatus: record.outcome.grantStatus,
    decision: record,
  },
  ...overrides,
});

const rehashInputs = (record: DispatchDecisionRecord): void => {
  record.inputsHash = canonicalHash(record.inputs);
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })),
  );
});

describe('independent ledger decision replay', () => {
  it('replays a valid schema-2 dispatch and its exact approval chain', async () => {
    const directory = await makeDirectory();
    await writeLedger(directory, [
      ...approvalEvents(),
      consumedEvent(dispatchRecord()),
    ]);

    const { status, report } = runReplayer(directory);

    expect(status).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.decisionsReplayed).toBe(1);
    expect(report.divergences).toEqual([]);
  });

  it('fails closed on no evidence by default and permits only an explicit diagnostic override', async () => {
    const directory = await makeDirectory();

    const denied = runReplayer(directory);
    const allowed = runReplayer(directory, ['--allow-empty']);

    expect(denied.status).toBe(1);
    expect(denied.report.error).toMatch(/events\.jsonl/);
    expect(allowed.status).toBe(0);
    expect(allowed.report.explicitlyAllowedEmpty).toBe(true);
  });

  it.each<[string, (record: DispatchDecisionRecord) => void, string]>([
    ['record schema', (record: DispatchDecisionRecord) => { record.schemaVersion = 99 as 2; }, 'unsupported_record_schema'],
    ['policy version', (record: DispatchDecisionRecord) => { record.policyVersion = 'unknown'; }, 'unknown_policy_version'],
    ['grant version', (record: DispatchDecisionRecord) => { record.grantPolicyVersion = 'unknown'; }, 'unknown_grant_policy_version'],
  ])('fails an unknown %s in normal mode', async (_label, mutate, code) => {
    const directory = await makeDirectory();
    const record = dispatchRecord();
    mutate(record);
    await writeLedger(directory, [...approvalEvents(), consumedEvent(record)]);

    const { status, report } = runReplayer(directory);

    expect(status).toBe(1);
    expect(report.divergences?.map((item) => item.code)).toContain(code);
  });

  it('independently rejects an invalid intent schema even when the record and ledger are rehashed', async () => {
    const directory = await makeDirectory();
    const record = dispatchRecord();
    record.inputs.intent.schemaVersion = 99 as 1;
    rehashInputs(record);
    await writeLedger(directory, [...approvalEvents(), consumedEvent(record)]);

    const { status, report } = runReplayer(directory);

    expect(status).toBe(1);
    expect(report.divergences?.map((item) => item.code)).toContain('invalid_dispatch_record');
  });

  it.each<[string, (event: ReturnType<typeof consumedEvent>) => void]>([
    ['entity', (event: ReturnType<typeof consumedEvent>) => { event.entityId = 'cap_other'; }],
    ['grant', (event: ReturnType<typeof consumedEvent>) => { event.payload.grantId = 'cap_other'; }],
    ['intent', (event: ReturnType<typeof consumedEvent>) => { event.payload.intentId = 'intent_other'; }],
    ['status', (event: ReturnType<typeof consumedEvent>) => { event.payload.grantStatus = 'revoked'; }],
    ['approval', (event: ReturnType<typeof consumedEvent>) => { event.payload.approvalId = 'approval_other'; }],
  ])('rejects a mismatched event %s envelope', async (_label, mutate) => {
    const directory = await makeDirectory();
    const event = consumedEvent(dispatchRecord());
    mutate(event);
    await writeLedger(directory, [...approvalEvents(), event]);

    const { status, report } = runReplayer(directory);

    expect(status).toBe(1);
    expect(report.divergences?.some((item) => item.code.includes('envelope'))).toBe(true);
  });

  it('rejects an approval issued for a different action authority', async () => {
    const directory = await makeDirectory();
    await writeLedger(directory, [
      ...approvalEvents('f'.repeat(64)),
      consumedEvent(dispatchRecord()),
    ]);

    const { status, report } = runReplayer(directory);

    expect(status).toBe(1);
    expect(report.divergences?.map((item) => item.code)).toContain('approval_authority_mismatch');
  });

  it.each([
    ['request', 0, 'user'],
    ['decision', 1, 'kernel'],
  ])('rejects a forged approval %s actor', async (_label, eventIndex, actor) => {
    const directory = await makeDirectory();
    const events: Record<string, unknown>[] = approvalEvents();
    (events[eventIndex] as Record<string, unknown>).actor = actor;
    await writeLedger(directory, [...events, consumedEvent(dispatchRecord())]);

    const { status, report } = runReplayer(directory);

    expect(status).toBe(1);
    expect(report.divergences?.map((item) => item.code)).toContain('approval_actor_mismatch');
  });

  it('rejects reuse of one approval across two independently valid grants', async () => {
    const directory = await makeDirectory();
    await writeLedger(directory, [
      ...approvalEvents(),
      consumedEvent(dispatchRecord('cap_1')),
      consumedEvent(dispatchRecord('cap_2')),
    ]);

    const { status, report } = runReplayer(directory);

    expect(status).toBe(1);
    expect(report.divergences?.map((item) => item.code)).toContain('approval_reused');
  });

  it('rejects an approval decision that happened after grant issuance', async () => {
    const directory = await makeDirectory();
    const record = dispatchRecord();
    record.inputs.now = '2026-07-25T12:04:00.000Z';
    record.outcome.consumedAt = record.inputs.now;
    rehashInputs(record);
    const events: Record<string, unknown>[] = approvalEvents();
    events[1] = { ...events[1], timestamp: '2026-07-25T12:03:00.000Z' };
    await writeLedger(directory, [
      ...events,
      consumedEvent(record, { timestamp: '2026-07-25T12:05:00.000Z' }),
    ]);

    const { status, report } = runReplayer(directory);

    expect(status).toBe(1);
    expect(report.divergences?.map((item) => item.code)).toContain('approval_time_mismatch');
  });

  it('rejects dispatch before the grant issuance time', async () => {
    const directory = await makeDirectory();
    const record = dispatchRecord();
    record.inputs.grant.issuedAt = '2026-07-25T12:03:00.000Z';
    rehashInputs(record);
    await writeLedger(directory, [...approvalEvents(), consumedEvent(record)]);

    const { status, report } = runReplayer(directory);

    expect(status).toBe(1);
    expect(report.divergences?.map((item) => item.code)).toContain('dispatch_outcome_mismatch');
  });

  it('rejects a denied outcome mislabeled as grant_consumed', async () => {
    const directory = await makeDirectory();
    const record = dispatchRecord();
    record.inputs.grant.expiresAt = '2026-07-25T12:01:30.000Z';
    record.outcome = {
      allowed: false,
      reasonCode: 'grant_expired',
      reason: 'Capability grant is expired.',
      riskLevel: 'L2',
      grantStatus: 'active',
      usedOps: 0,
      consumedAt: null,
    };
    rehashInputs(record);
    await writeLedger(directory, [...approvalEvents(), consumedEvent(record)]);

    const { status, report } = runReplayer(directory);

    expect(status).toBe(1);
    expect(report.divergences?.map((item) => item.code)).toContain('dispatch_event_outcome_mismatch');
  });

  it('requires an automation approval to have a prior matching blocked decision', async () => {
    const directory = await makeDirectory();
    const automationIntent: ActionIntent = {
      ...intent,
      taskId: 'automation:automation_1',
    };
    const grant = createCapabilityGrant(automationIntent, {
      id: 'cap_automation',
      issuedAt: '2026-07-25T12:01:00.000Z',
      expiresAt: '2026-07-25T12:10:00.000Z',
      maxOps: 1,
      approvalId: 'approval_1',
    });
    const record = buildDispatchDecisionRecord(
      {
        grant,
        intent: automationIntent,
        worker: browserWorker,
        now: '2026-07-25T12:02:00.000Z',
        operationsUsed: 1,
      },
      {
        allowed: true,
        reasonCode: 'allowed',
        reason: 'Capability grant consumed.',
        riskLevel: 'L2',
        grantStatus: 'consumed',
        usedOps: 1,
        consumedAt: '2026-07-25T12:02:00.000Z',
      },
    );
    const bindingHash = hashIntentAuthorityBinding(automationIntent);
    await writeLedger(directory, [
      {
        type: 'approval.requested',
        entityId: 'approval_1',
        entityType: 'approval',
        payload: {
          goalId: automationIntent.goalId,
          taskId: automationIntent.taskId,
          automationId: 'automation_1',
          riskLevel: automationIntent.riskLevel,
          authorityBindingHash: bindingHash,
        },
      },
      {
        actor: 'user',
        type: 'approval.approved',
        entityId: 'approval_1',
        entityType: 'approval',
        payload: {
          goalId: automationIntent.goalId,
          taskId: automationIntent.taskId,
          automationId: 'automation_1',
          riskLevel: automationIntent.riskLevel,
          authorityBindingHash: bindingHash,
        },
      },
      {
        ...consumedEvent(record),
        payload: {
          ...consumedEvent(record).payload,
          automationId: 'automation_1',
        },
      },
    ]);

    const { status, report } = runReplayer(directory);

    expect(status).toBe(1);
    expect(report.divergences?.map((item) => item.code)).toContain('blocked_dispatch_mismatch');
  });

  it('replays Unicode connector ancestry and permits empty configured connector roots', async () => {
    const directory = await makeDirectory();
    const connectorRoot = 'mailbox/\u{1f512}/thread';
    const connectorIntent: ActionIntent = {
      ...intent,
      id: 'intent_connector',
      taskId: 'task_connector',
      workerId: 'worker.connector.test',
      riskLevel: 'L3',
      action: {
        type: 'connector.send',
        connectorId: 'connector_private',
        resourceId: `${connectorRoot}/message`,
        payloadHash: 'a'.repeat(64),
      },
      scope: {
        family: 'connector',
        operations: ['connector.send'],
        connectorId: 'connector_private',
        resourceRoots: [connectorRoot],
      },
    };
    const connectorWorker = {
      id: connectorIntent.workerId,
      family: 'connector' as const,
      availability: 'available' as const,
      supportedActions: ['connector.send' as const],
      configuredScopes: [
        {
          family: 'connector' as const,
          operations: ['connector.send' as const],
          connectorId: 'connector_private',
          resourceRoots: [],
        },
        connectorIntent.scope,
      ],
      registeredAt: '2026-07-25T11:00:00.000Z',
    };
    const grant = createCapabilityGrant(connectorIntent, {
      id: 'cap_connector',
      issuedAt: '2026-07-25T12:01:00.000Z',
      expiresAt: '2026-07-25T12:10:00.000Z',
      maxOps: 1,
      approvalId: 'approval_1',
    });
    const record = buildDispatchDecisionRecord(
      {
        grant,
        intent: connectorIntent,
        worker: connectorWorker,
        now: '2026-07-25T12:02:00.000Z',
        operationsUsed: 1,
      },
      {
        allowed: true,
        reasonCode: 'allowed',
        reason: 'Capability grant consumed.',
        riskLevel: 'L3',
        grantStatus: 'consumed',
        usedOps: 1,
        consumedAt: '2026-07-25T12:02:00.000Z',
      },
    );
    const bindingHash = hashIntentAuthorityBinding(connectorIntent);
    const events = [
      {
        type: 'approval.requested',
        entityId: 'approval_1',
        entityType: 'approval',
        payload: {
          goalId: connectorIntent.goalId,
          taskId: connectorIntent.taskId,
          riskLevel: connectorIntent.riskLevel,
          authorityBindingHash: bindingHash,
        },
      },
      {
        actor: 'user',
        type: 'approval.approved',
        entityId: 'approval_1',
        entityType: 'approval',
        payload: {
          goalId: connectorIntent.goalId,
          taskId: connectorIntent.taskId,
          riskLevel: connectorIntent.riskLevel,
          authorityBindingHash: bindingHash,
        },
      },
      consumedEvent(record),
    ];
    await writeLedger(directory, events);

    const { status, report } = runReplayer(directory);

    expect(status).toBe(0);
    expect(report.ok).toBe(true);
  });

  it.each<[string, string, (record: DispatchDecisionRecord) => void]>([
    ['risk', 'dispatch_outcome_mismatch', (record: DispatchDecisionRecord) => { record.outcome.riskLevel = 'L1'; }],
    ['consumption time', 'dispatch_outcome_mismatch', (record: DispatchDecisionRecord) => {
      record.outcome.consumedAt = '2026-07-25T12:03:00.000Z';
    }],
    ['denial reason', 'invalid_dispatch_record', (record: DispatchDecisionRecord) => {
      record.outcome.reasonCode = 'grant_expired';
      record.outcome.reason = 'Capability grant is expired.';
    }],
  ])('rejects a forged exact outcome field: %s', async (_label, expectedCode, mutate) => {
    const directory = await makeDirectory();
    const record = dispatchRecord();
    mutate(record);
    await writeLedger(directory, [...approvalEvents(), consumedEvent(record)]);

    const { status, report } = runReplayer(directory);

    expect(status).toBe(1);
    expect(report.divergences?.map((item) => item.code)).toContain(expectedCode);
  });

  it('rejects legacy authorization events without replay evidence', async () => {
    const directory = await makeDirectory();
    const event = consumedEvent(dispatchRecord());
    delete (event.payload as { decision?: unknown }).decision;
    await writeLedger(directory, [...approvalEvents(), event]);

    const { status, report } = runReplayer(directory);

    expect(status).toBe(1);
    expect(report.outcomeOnlyDecisions).toBe(1);
    expect(report.divergences?.map((item) => item.code)).toContain('missing_decision_evidence');
  });

  it('replays a real createKernelService approval, persisted grant, and dispatch ledger', async () => {
    const runtimeDirectory = await makeDirectory('provenance-replay-e2e-');
    const workspaceRoot = await makeDirectory('provenance-replay-workspace-');
    await writeFile(path.join(workspaceRoot, 'package.json'), JSON.stringify({ private: true }), 'utf8');
    const kernel = createKernelService({
      runtimeDir: runtimeDirectory,
      allowedWorkspaceRoot: workspaceRoot,
      workerRegistrations: [browserWorker],
      actionWorkers: {
        [browserWorker.id]: {
          execute: async () => ({
            status: 'succeeded',
            summary: 'Navigation completed.',
            sourceRef: 'https://example.com',
            content: 'Fixture result.',
          }),
        },
      },
    });
    const goal = await kernel.createGoal({
      objective: 'Replay an exact approved dispatch',
      successCriteria: ['Dispatch is replayable'],
      constraints: ['Stay inside workspace'],
      autonomyLevel: 'supervised',
      workspaceRoot,
      verificationCommands: ['npm test'],
      budget: {
        maxOperations: 4,
        maxCommandRuntimeMs: 120_000,
        maxApprovals: 1,
        maxProviderCalls: 0,
      },
    });
    const automation = await kernel.createAutomation({
      name: 'Private navigation fixture',
      goalId: goal.id,
      workerId: browserWorker.id,
      riskLevel: 'L2',
      action: {
        type: 'browser.navigate',
        origin: 'https://example.com',
        url: 'https://example.com/private?credential=e2e-secret#private-fragment',
      },
      scope: browserScope,
      trigger: { type: 'manual' },
      approvalMode: 'per_run',
      budget: { maxRuns: 1, maxConsecutiveFailures: 1, maxRuntimeMsPerRun: 30_000 },
    });
    await kernel.setAutomationEnabled(automation.id, true, 'Enable replay fixture.');
    const blocked = await kernel.runAutomation(automation.id);
    await kernel.decideApproval(blocked.approvalId!, 'approved', 'Approve this exact action.');
    const completed = await kernel.runAutomation(automation.id);

    expect(completed.dispatch?.status).toBe('succeeded');
    const { status, report } = runReplayer(runtimeDirectory);
    expect(status).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.decisionsReplayed).toBe(2);

    const ledger = await readFile(path.join(runtimeDirectory, 'events.jsonl'), 'utf8');
    expect(ledger).not.toContain('/private');
    expect(ledger).not.toContain('e2e-secret');
    expect(ledger).not.toContain('private-fragment');
  });
});

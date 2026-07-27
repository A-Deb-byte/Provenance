import { describe, expect, it } from 'vitest';
import {
  buildDispatchDecisionRecord,
  buildPolicyDecisionRecord,
  CAPABILITY_DECISION_RECORD_SCHEMA_VERSION,
  hashIntentAuthorityBinding,
} from './decisionRecord';
import { createCapabilityGrant, consumeCapabilityGrant } from './grants';
import { CAPABILITY_POLICY_VERSION, decideActionPolicy } from './policy';
import { createWorkerRegistry } from './registry';
import type { ActionIntent, CapabilityScope, WorkerRegistration } from './types';

const scope: CapabilityScope = {
  family: 'browser',
  operations: ['browser.navigate', 'browser.download'],
  origins: ['https://example.com'],
  downloadRoots: ['C:\\Private\\AgentDownloads'],
};

const worker: WorkerRegistration = {
  id: 'worker.browser.playwright',
  family: 'browser',
  availability: 'available',
  supportedActions: ['browser.navigate', 'browser.download'],
  configuredScopes: [scope],
  registeredAt: '2026-07-25T11:00:00.000Z',
};

const intent: ActionIntent = {
  schemaVersion: 1,
  id: 'intent_1',
  goalId: 'goal_1',
  taskId: 'automation:automation_1',
  workerId: worker.id,
  riskLevel: 'L2',
  action: {
    type: 'browser.navigate',
    origin: 'https://example.com',
    url: 'https://example.com/private/account?reset_token=top-secret#security',
  },
  scope,
  authority: { kind: 'approval', referenceId: 'approval_1' },
  untrustedObservationIds: ['observation_private'],
  createdAt: '2026-07-25T12:00:00.000Z',
};

const successfulOutcome = {
  allowed: true as const,
  reasonCode: 'allowed' as const,
  reason: 'Capability grant consumed.',
  riskLevel: 'L2' as const,
  grantStatus: 'consumed' as const,
  usedOps: 1,
  consumedAt: '2026-07-25T12:01:00.000Z',
};

describe('privacy-preserving capability decision records', () => {
  it('records a schema-2 semantic witness with exact outcome fields', () => {
    const grant = createCapabilityGrant(intent, {
      id: 'cap_1',
      issuedAt: '2026-07-25T12:00:00.000Z',
      expiresAt: '2026-07-25T12:10:00.000Z',
      maxOps: 1,
      approvalId: 'approval_1',
    });
    const consumed = consumeCapabilityGrant(grant, intent, worker, {
      now: successfulOutcome.consumedAt,
      operationsUsed: 1,
    });
    expect(consumed.allowed).toBe(true);

    const record = buildDispatchDecisionRecord(
      {
        grant,
        intent,
        worker,
        now: successfulOutcome.consumedAt,
        operationsUsed: 1,
      },
      successfulOutcome,
    );

    expect(record.schemaVersion).toBe(CAPABILITY_DECISION_RECORD_SCHEMA_VERSION);
    expect(record.policyVersion).toBe(CAPABILITY_POLICY_VERSION);
    expect(record.inputs.grant.status).toBe('active');
    expect(record.inputs.grant.usedOps).toBe(0);
    expect(record.outcome).toEqual(successfulOutcome);
    expect(record.inputsHash).toMatch(/^[a-f0-9]{64}$/);
    expect(record.inputs.authorityBindingHash).toBe(hashIntentAuthorityBinding(intent));
  });

  it('does not persist URL origins, paths, query strings, fragments, local roots, or observation ids', () => {
    const grant = createCapabilityGrant(intent, {
      id: 'cap_1',
      issuedAt: '2026-07-25T12:00:00.000Z',
      expiresAt: '2026-07-25T12:10:00.000Z',
      maxOps: 1,
      approvalId: 'approval_1',
    });
    const record = buildDispatchDecisionRecord(
      { grant, intent, worker, now: successfulOutcome.consumedAt, operationsUsed: 1 },
      successfulOutcome,
    );
    const serialized = JSON.stringify(record);

    expect(serialized).not.toContain('https://example.com');
    expect(serialized).not.toContain('/private/account');
    expect(serialized).not.toContain('reset_token');
    expect(serialized).not.toContain('top-secret');
    expect(serialized).not.toContain('#security');
    expect(serialized).not.toContain('C:\\\\Private\\\\AgentDownloads');
    expect(serialized).not.toContain('observation_private');
  });

  it('hashes desktop shortcut keys instead of persisting them', () => {
    const shortcutIntent: ActionIntent = {
      ...intent,
      workerId: 'worker.desktop.windows_uia',
      action: {
        type: 'desktop.shortcut',
        appId: 'notepad',
        windowId: 'window_1',
        treeRevision: 'revision_1',
        keys: ['CTRL', 'SHIFT', 'P'],
      },
      scope: {
        family: 'desktop',
        operations: ['desktop.shortcut'],
        appId: 'notepad',
        windowId: 'window_1',
        treeRevision: 'revision_1',
      },
    };
    const shortcutWorker: WorkerRegistration = {
      id: shortcutIntent.workerId,
      family: 'desktop',
      availability: 'available',
      supportedActions: ['desktop.shortcut'],
      configuredScopes: [shortcutIntent.scope],
      registeredAt: worker.registeredAt,
    };
    const grant = createCapabilityGrant(shortcutIntent, {
      id: 'cap_shortcut',
      issuedAt: intent.createdAt,
      expiresAt: '2026-07-25T12:10:00.000Z',
      maxOps: 1,
      approvalId: 'approval_1',
    });
    const record = buildDispatchDecisionRecord(
      {
        grant,
        intent: shortcutIntent,
        worker: shortcutWorker,
        now: successfulOutcome.consumedAt,
        operationsUsed: 1,
      },
      successfulOutcome,
    );
    const serialized = JSON.stringify(record);

    expect(serialized).not.toContain('"CTRL"');
    expect(serialized).not.toContain('"SHIFT"');
    expect(serialized).not.toContain('"P"');
    expect(record.inputs.intent.action.keyHashes).toHaveLength(3);
  });

  it('does not persist connector resource identifiers or connector credentials', () => {
    const connectorScope: CapabilityScope = {
      family: 'connector',
      operations: ['connector.send'],
      connectorId: 'gmail-user@example.com',
      resourceRoots: ['mailbox/private-thread'],
    };
    const connectorWorker: WorkerRegistration = {
      id: 'worker.connector.gmail',
      family: 'connector',
      availability: 'available',
      supportedActions: ['connector.send'],
      configuredScopes: [connectorScope],
      registeredAt: worker.registeredAt,
    };
    const connectorIntent: ActionIntent = {
      ...intent,
      workerId: connectorWorker.id,
      riskLevel: 'L3',
      action: {
        type: 'connector.send',
        connectorId: 'gmail-user@example.com',
        resourceId: 'mailbox/private-thread/message-123',
        payloadHash: 'a'.repeat(64),
      },
      scope: connectorScope,
    };
    const grant = createCapabilityGrant(connectorIntent, {
      id: 'cap_connector',
      issuedAt: intent.createdAt,
      expiresAt: '2026-07-25T12:10:00.000Z',
      maxOps: 1,
      approvalId: 'approval_1',
    });
    const record = buildDispatchDecisionRecord(
      {
        grant,
        intent: connectorIntent,
        worker: connectorWorker,
        now: successfulOutcome.consumedAt,
        operationsUsed: 1,
      },
      { ...successfulOutcome, riskLevel: 'L3' },
    );
    const serialized = JSON.stringify(record);

    expect(serialized).not.toContain('gmail-user@example.com');
    expect(serialized).not.toContain('mailbox/private-thread');
    expect(serialized).not.toContain('message-123');
  });

  it('binds approval authority to action semantics, not ephemeral intent metadata', () => {
    const retry: ActionIntent = {
      ...intent,
      id: 'intent_retry',
      authority: { kind: 'kernel_policy', referenceId: 'automation_1' },
      createdAt: '2026-07-25T12:02:00.000Z',
    };
    const differentAction: ActionIntent = {
      ...retry,
      action: {
        type: 'browser.navigate',
        origin: 'https://example.com',
        url: 'https://example.com/a-different-account',
      },
    };

    expect(hashIntentAuthorityBinding(retry)).toBe(hashIntentAuthorityBinding(intent));
    expect(hashIntentAuthorityBinding(differentAction)).not.toBe(hashIntentAuthorityBinding(intent));
  });

  it('records exact policy reasons and risk levels', () => {
    const registry = createWorkerRegistry([worker]);
    const unapproved: ActionIntent = {
      ...intent,
      authority: { kind: 'user_request', referenceId: 'request_1' },
    };
    const decision = decideActionPolicy(unapproved, registry);
    const record = buildPolicyDecisionRecord(
      { intent: unapproved, worker, now: unapproved.createdAt },
      decision,
    );

    expect(record.outcome).toEqual({
      kind: 'approval_required',
      reasonCode: 'approval_required',
      reason: 'L2 actions require an explicit approval grant.',
      riskLevel: 'L2',
    });
  });
});

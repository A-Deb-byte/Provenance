import { describe, expect, it } from 'vitest';
import { browserIntent, browserScope, browserWorker } from './testFixtures';
import { decideActionPolicy } from './policy';
import { createWorkerRegistry } from './registry';
import { ActionIntent, WorkerRegistration } from './types';

describe('capability policy', () => {
  it('allows L0 and L1 only for an available worker and configured scope', () => {
    const registry = createWorkerRegistry([browserWorker]);
    expect(decideActionPolicy(browserIntent(), registry).kind).toBe('allow');
    expect(decideActionPolicy(browserIntent({
      riskLevel: 'L1',
      action: {
        type: 'browser.navigate', origin: 'https://example.com', url: 'https://example.com/next',
      },
    }), registry).kind).toBe('allow');

    const configured: WorkerRegistration = { ...browserWorker, availability: 'configured' };
    expect(decideActionPolicy(browserIntent(), createWorkerRegistry([configured]))).toMatchObject({
      kind: 'deny',
      reasonCode: 'worker_unavailable',
    });
    expect(decideActionPolicy(browserIntent({
      scope: { ...browserScope, origins: ['https://other.example'] },
      action: {
        type: 'browser.inspect', origin: 'https://other.example', url: 'https://other.example/',
      },
    }), registry)).toMatchObject({ kind: 'deny', reasonCode: 'scope_not_configured' });
  });

  it('requires approval for L2 external and L3 consequential actions', () => {
    const worker: WorkerRegistration = {
      id: 'worker.connector.mail',
      family: 'connector',
      availability: 'available',
      supportedActions: ['connector.read', 'connector.send'],
      configuredScopes: [{
        family: 'connector',
        operations: ['connector.read', 'connector.send'],
        connectorId: 'mail',
        resourceRoots: ['mailbox'],
      }],
      registeredAt: '2026-07-12T00:00:00.000Z',
    };
    const base: ActionIntent = {
      schemaVersion: 1,
      id: 'intent_mail', goalId: 'goal_1', taskId: 'task_1', workerId: worker.id,
      riskLevel: 'L2',
      action: { type: 'connector.read', connectorId: 'mail', resourceId: 'mailbox/inbox' },
      scope: worker.configuredScopes[0],
      authority: { kind: 'user_request', referenceId: 'request_1' },
      untrustedObservationIds: [], createdAt: '2026-07-12T00:00:00.000Z',
    };
    const registry = createWorkerRegistry([worker]);
    expect(decideActionPolicy(base, registry).kind).toBe('approval_required');
    expect(decideActionPolicy({
      ...base,
      riskLevel: 'L3',
      action: { type: 'connector.send', connectorId: 'mail', resourceId: 'mailbox/draft-1', payloadHash: 'b'.repeat(64) },
    }, registry).kind).toBe('approval_required');
  });

  it('denies L4, understated risk, and forged untrusted authority', () => {
    const registry = createWorkerRegistry([browserWorker]);
    expect(decideActionPolicy(browserIntent({ riskLevel: 'L4' }), registry).reasonCode).toBe('forbidden_risk');
    expect(decideActionPolicy(browserIntent({
      riskLevel: 'L0',
      action: { type: 'browser.navigate', origin: 'https://example.com', url: 'https://example.com/' },
    }), registry).reasonCode).toBe('risk_understated');
    expect(decideActionPolicy({
      ...browserIntent(),
      authority: { kind: 'untrusted_observation', referenceId: 'observation_1' },
    } as unknown as ActionIntent, registry).reasonCode).toBe('untrusted_authority');
  });
});

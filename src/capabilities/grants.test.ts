import { describe, expect, it } from 'vitest';
import { browserIntent, browserWorker } from './testFixtures';
import {
  consumeCapabilityGrant,
  createCapabilityGrant,
  hashActionIntent,
  revokeCapabilityGrant,
  validateCapabilityGrant,
} from './grants';

describe('persistent capability grants', () => {
  const grantInput = {
    id: 'grant_1',
    issuedAt: '2026-07-12T00:02:00.000Z',
    expiresAt: '2026-07-12T00:12:00.000Z',
    maxOps: 3,
  };

  it('uses a canonical intent hash and requires approval for L2/L3', () => {
    const intent = browserIntent();
    if (intent.scope.family !== 'browser') throw new Error('Expected browser fixture scope.');
    const reordered = browserIntent({
      scope: {
        ...intent.scope,
        operations: [...intent.scope.operations].reverse(),
      },
    });
    expect(hashActionIntent(intent)).toBe(hashActionIntent(reordered));
    expect(createCapabilityGrant(intent, grantInput).status).toBe('active');
    expect(() => createCapabilityGrant({ ...intent, riskLevel: 'L2' }, grantInput))
      .toThrow('approval');
    expect(() => createCapabilityGrant({ ...intent, riskLevel: 'L2' }, {
      ...grantInput, approvalId: 'approval_1',
    })).toThrow('exact approval');
    const approvedIntent = {
      ...intent,
      riskLevel: 'L2' as const,
      authority: { kind: 'approval' as const, referenceId: 'approval_1' },
    };
    expect(createCapabilityGrant(approvedIntent, {
      ...grantInput, approvalId: 'approval_1',
    }).approvalId).toBe('approval_1');
    expect(() => createCapabilityGrant(approvedIntent, {
      ...grantInput, approvalId: 'approval_other',
    })).toThrow('exact approval');
  });

  it('consumes once and rejects reuse, mismatch, expiry, and excessive operations', () => {
    const intent = browserIntent();
    const grant = createCapabilityGrant(intent, grantInput);
    const consumed = consumeCapabilityGrant(grant, intent, browserWorker, {
      now: '2026-07-12T00:03:00.000Z', operationsUsed: 2,
    });
    expect(consumed.allowed).toBe(true);
    expect(consumed.grant).toMatchObject({ status: 'consumed', usedOps: 2 });
    expect(consumeCapabilityGrant(consumed.grant, intent, browserWorker, {
      now: '2026-07-12T00:04:00.000Z', operationsUsed: 1,
    }).reasonCode).toBe('grant_consumed');
    expect(validateCapabilityGrant(grant, { ...intent, id: 'intent_changed' }, browserWorker, '2026-07-12T00:03:00.000Z').reasonCode)
      .toBe('intent_mismatch');
    expect(validateCapabilityGrant(grant, intent, browserWorker, '2026-07-12T00:13:00.000Z').reasonCode)
      .toBe('grant_expired');
    expect(validateCapabilityGrant(grant, intent, browserWorker, '2026-07-12T00:01:59.999Z').reasonCode)
      .toBe('grant_not_yet_valid');
    expect(consumeCapabilityGrant(grant, intent, browserWorker, {
      now: '2026-07-12T00:03:00.000Z', operationsUsed: 4,
    }).reasonCode).toBe('operation_budget_exceeded');
  });

  it('rejects a persisted L2/L3 grant that is not bound to the exact intent approval', () => {
    const intent = browserIntent({
      riskLevel: 'L2',
      action: {
        type: 'browser.navigate',
        origin: 'https://example.com',
        url: 'https://example.com/account',
      },
      authority: { kind: 'approval', referenceId: 'approval_1' },
    });
    const grant = createCapabilityGrant(intent, { ...grantInput, approvalId: 'approval_1' });

    expect(validateCapabilityGrant(
      { ...grant, approvalId: 'approval_other' },
      intent,
      browserWorker,
      '2026-07-12T00:03:00.000Z',
    ).reasonCode).toBe('approval_mismatch');
  });

  it('fails closed for revoked grants and workers no longer available', () => {
    const intent = browserIntent();
    const grant = createCapabilityGrant(intent, grantInput);
    const revoked = revokeCapabilityGrant(grant, 'User stopped the workflow.', '2026-07-12T00:03:00.000Z');
    expect(validateCapabilityGrant(revoked, intent, browserWorker, '2026-07-12T00:04:00.000Z').reasonCode)
      .toBe('grant_revoked');
    expect(validateCapabilityGrant(grant, intent, { ...browserWorker, availability: 'configured' }, '2026-07-12T00:04:00.000Z').reasonCode)
      .toBe('worker_unavailable');
  });

  it('fails closed for malformed persisted grants and worker scope drift', () => {
    const intent = browserIntent();
    const grant = createCapabilityGrant(intent, grantInput);
    const configuredScope = browserWorker.configuredScopes[0];
    if (configuredScope.family !== 'browser') throw new Error('Expected browser worker scope.');
    expect(validateCapabilityGrant(
      { ...grant, expiresAt: 'not-a-date' }, intent, browserWorker, '2026-07-12T00:04:00.000Z',
    ).reasonCode).toBe('grant_invalid');
    expect(validateCapabilityGrant(
      { ...grant, status: 'unknown' } as unknown as typeof grant,
      intent,
      browserWorker,
      '2026-07-12T00:04:00.000Z',
    ).reasonCode).toBe('grant_invalid');
    expect(validateCapabilityGrant(grant, intent, {
      ...browserWorker,
      configuredScopes: [{ ...configuredScope, origins: ['https://other.example'] }],
    }, '2026-07-12T00:04:00.000Z').reasonCode).toBe('scope_mismatch');
  });
});

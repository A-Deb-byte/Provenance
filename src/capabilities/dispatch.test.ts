import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { browserIntent, browserWorker } from './testFixtures';
import { authorizeCapabilityDispatch, claimCapabilityDispatchAuthorization, revokePersistedCapabilityGrant } from './dispatch';
import { createCapabilityGrant } from './grants';
import { createFileCapabilityGrantStore, createMemoryCapabilityGrantStore } from './grantStore';

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'grant-dispatch-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const navigationIntent = () => browserIntent({
  riskLevel: 'L2',
  action: { type: 'browser.navigate', origin: 'https://example.com', url: 'https://example.com/account' },
  authority: { kind: 'approval', referenceId: 'approval_1' },
});

const approvedGrant = () => createCapabilityGrant(navigationIntent(), {
  id: 'grant_dispatch_1',
  issuedAt: '2026-07-12T00:02:00.000Z',
  expiresAt: '2026-07-12T00:12:00.000Z',
  maxOps: 1,
  approvalId: 'approval_1',
});

describe('pre-dispatch grant authorization', () => {
  it('persists consumption before minting an opaque single-use authorization', async () => {
    const file = path.join(dir, 'grants.json');
    const store = await createFileCapabilityGrantStore(file);
    await store.create(approvedGrant());

    const intent = navigationIntent();
    const authorized = await authorizeCapabilityDispatch(store, 'grant_dispatch_1', intent, browserWorker, {
      now: '2026-07-12T00:03:00.000Z', operationsUsed: 1,
    });

    expect(authorized.allowed).toBe(true);
    expect(authorized.grant?.status).toBe('consumed');
    const reloaded = await createFileCapabilityGrantStore(file);
    expect((await reloaded.get('grant_dispatch_1'))?.status).toBe('consumed');

    expect(claimCapabilityDispatchAuthorization(authorized.authorization, intent, browserWorker.id).allowed).toBe(true);
    expect(claimCapabilityDispatchAuthorization(authorized.authorization, intent, browserWorker.id).reasonCode)
      .toBe('authorization_reused');
    expect(claimCapabilityDispatchAuthorization({
      grantId: 'forged', intentId: intent.id, intentHash: 'a'.repeat(64), workerId: browserWorker.id,
      operationsAuthorized: 1, authorizedAt: '2026-07-12T00:03:00.000Z',
    }, intent, browserWorker.id).reasonCode).toBe('authorization_invalid');
  });

  it('allows only one winner when two dispatches race for the same grant', async () => {
    const store = createMemoryCapabilityGrantStore([approvedGrant()]);
    const intent = navigationIntent();
    const attempts = await Promise.all([
      authorizeCapabilityDispatch(store, 'grant_dispatch_1', intent, browserWorker, { now: '2026-07-12T00:03:00.000Z', operationsUsed: 1 }),
      authorizeCapabilityDispatch(store, 'grant_dispatch_1', intent, browserWorker, { now: '2026-07-12T00:03:00.000Z', operationsUsed: 1 }),
    ]);
    expect(attempts.filter((attempt) => attempt.allowed)).toHaveLength(1);
    expect(attempts.find((attempt) => !attempt.allowed)?.reasonCode).toBe('grant_persistence_conflict');
  });

  it('persists revocation and refuses subsequent dispatch', async () => {
    const store = createMemoryCapabilityGrantStore([approvedGrant()]);
    const revoked = await revokePersistedCapabilityGrant(
      store, 'grant_dispatch_1', 'Operator stopped the action.', '2026-07-12T00:03:00.000Z',
    );
    expect(revoked?.status).toBe('revoked');
    const attempt = await authorizeCapabilityDispatch(store, 'grant_dispatch_1', navigationIntent(), browserWorker, {
      now: '2026-07-12T00:04:00.000Z', operationsUsed: 1,
    });
    expect(attempt.reasonCode).toBe('grant_revoked');
  });
});

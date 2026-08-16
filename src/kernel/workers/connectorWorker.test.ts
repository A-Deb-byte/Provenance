import { describe, expect, it, vi } from 'vitest';
import { createConnectorWorker, type ConnectorAdapter } from './connectorWorker';
import { authorizeCapabilityDispatch } from '../../capabilities/dispatch';
import { createCapabilityGrant } from '../../capabilities/grants';
import { createMemoryCapabilityGrantStore } from '../../capabilities/grantStore';
import type { ActionIntent, ConnectorAction, WorkerRegistration } from '../../capabilities/types';

const NOW = '2026-08-16T12:00:00.000Z';
const CONNECTOR_ID = 'mail.primary';

const registration: WorkerRegistration = {
  id: 'worker.connector.mail',
  family: 'connector',
  availability: 'available',
  supportedActions: ['connector.read', 'connector.draft', 'connector.send', 'connector.delete'],
  configuredScopes: [{
    family: 'connector',
    operations: ['connector.read', 'connector.draft', 'connector.send', 'connector.delete'],
    connectorId: CONNECTOR_ID,
    resourceRoots: ['mailbox/team'],
  }],
  registeredAt: NOW,
};

const intentFor = (action: ConnectorAction, resourceRoots = ['mailbox/team']): ActionIntent => ({
  schemaVersion: 1,
  id: 'intent_1',
  goalId: 'goal_1',
  taskId: 'task_1',
  workerId: registration.id,
  riskLevel: action.type === 'connector.send' || action.type === 'connector.delete' ? 'L3' : 'L2',
  action,
  scope: {
    family: 'connector',
    operations: [action.type],
    connectorId: CONNECTOR_ID,
    resourceRoots,
  },
  authority: { kind: 'approval', referenceId: 'approval_1' },
  untrustedObservationIds: [],
  createdAt: NOW,
});

/** Mints a real authorization so the worker's claim path is genuinely exercised. */
const authorizeFor = async (intent: ActionIntent) => {
  const store = createMemoryCapabilityGrantStore();
  const grant = createCapabilityGrant(intent, {
    id: 'cap_1',
    issuedAt: NOW,
    expiresAt: '2026-08-16T12:10:00.000Z',
    maxOps: 1,
    approvalId: 'approval_1',
  });
  await store.create(grant);
  const authorized = await authorizeCapabilityDispatch(store, grant.id, intent, registration, {
    now: '2026-08-16T12:01:00.000Z',
    operationsUsed: 1,
  });
  return authorized.authorization;
};

const adapter = (overrides: Partial<ConnectorAdapter> = {}): ConnectorAdapter => ({
  connectorId: CONNECTOR_ID,
  read: vi.fn(async () => ({ status: 'succeeded' as const, summary: 'read', content: 'body text' })),
  draft: vi.fn(async () => ({ status: 'succeeded' as const, summary: 'drafted', externalRef: 'draft_9' })),
  send: vi.fn(async () => ({ status: 'succeeded' as const, summary: 'sent', externalRef: 'msg_9' })),
  remove: vi.fn(async () => ({ status: 'succeeded' as const, summary: 'deleted' })),
  ...overrides,
});

const payloadStore = (content: string, contentHash: string) =>
  vi.fn(async () => ({ content, contentHash }));

const run = async (
  action: ConnectorAction,
  options: {
    adapters?: ConnectorAdapter[];
    payload?: ReturnType<typeof payloadStore>;
    resourceRoots?: string[];
    authorization?: unknown;
  } = {},
) => {
  const intent = intentFor(action, options.resourceRoots);
  const worker = createConnectorWorker(options.adapters ?? [adapter()], options.payload);
  return worker.execute(intent, {
    timeoutMs: 5_000,
    authorization: (options.authorization === undefined
      ? await authorizeFor(intent)
      : undefined) as never,
  });
};

// Note: the worker's own scope checks (connector id, resource roots) are not
// exercised here because they are unreachable through the authorized path --
// isActionIntent rejects a scope-mismatched intent before a grant can be minted,
// and a dispatch authorization cannot be forged (WeakSet identity). They are
// retained in the worker as defense-in-depth against a future caller that
// constructs intents differently.
describe('connector worker', () => {
  it('reads a resource inside the granted roots', async () => {
    const result = await run({
      type: 'connector.read', connectorId: CONNECTOR_ID, resourceId: 'mailbox/team/thread-1',
    });

    expect(result.status).toBe('succeeded');
    expect(result.content).toBe('body text');
  });

  it('refuses an intent mutated after authorization', async () => {
    // The claim recomputes the intent hash, so a swapped action is caught
    // before any scope reasoning happens.
    const intent = intentFor({
      type: 'connector.read', connectorId: CONNECTOR_ID, resourceId: 'mailbox/team/a',
    });
    const worker = createConnectorWorker([adapter()]);
    const result = await worker.execute({
      ...intent,
      action: { type: 'connector.read', connectorId: 'other.connector', resourceId: 'mailbox/team/a' },
    }, { timeoutMs: 5_000, authorization: await authorizeFor(intent) });

    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('authorization_invalid');
  });

  it('refuses without a valid pre-dispatch authorization', async () => {
    const result = await run({
      type: 'connector.read', connectorId: CONNECTOR_ID, resourceId: 'mailbox/team/a',
    }, { authorization: null });

    expect(result.status).toBe('failed');
  });

  it('refuses when no adapter is configured for the connector', async () => {
    const result = await run({
      type: 'connector.read', connectorId: CONNECTOR_ID, resourceId: 'mailbox/team/a',
    }, { adapters: [] });

    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('adapter_unavailable');
  });

  it('sends only content that matches the staged payload hash', async () => {
    const send = vi.fn(async () => ({ status: 'succeeded' as const, summary: 'sent' }));
    const result = await run({
      type: 'connector.send',
      connectorId: CONNECTOR_ID,
      resourceId: 'mailbox/team/thread-1',
      payloadArtifactId: 'artifact_1',
      payloadHash: 'a'.repeat(64),
    }, {
      adapters: [adapter({ send })],
      payload: payloadStore('approved body', 'a'.repeat(64)),
    });

    expect(result.status).toBe('succeeded');
    expect(send).toHaveBeenCalledWith('mailbox/team/thread-1', 'approved body', expect.anything());
  });

  it('refuses to send content whose hash does not match what was staged', async () => {
    // The operator approved a summary bound to a hash; different content behind
    // that hash is exactly the substitution this prevents.
    const send = vi.fn();
    const result = await run({
      type: 'connector.send',
      connectorId: CONNECTOR_ID,
      resourceId: 'mailbox/team/thread-1',
      payloadArtifactId: 'artifact_1',
      payloadHash: 'a'.repeat(64),
    }, {
      adapters: [adapter({ send })],
      payload: payloadStore('substituted body', 'b'.repeat(64)),
    });

    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('payload_hash_mismatch');
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses drafting when no payload store is configured', async () => {
    const result = await run({
      type: 'connector.draft',
      connectorId: CONNECTOR_ID,
      resourceId: 'mailbox/team/thread-1',
      payloadArtifactId: 'artifact_1',
      payloadHash: 'a'.repeat(64),
    });

    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('no_payload_store');
  });

  it('reports a lost send as uncertain, never as failed', async () => {
    // "failed" invites a retry, and a retried send may deliver twice.
    const result = await run({
      type: 'connector.send',
      connectorId: CONNECTOR_ID,
      resourceId: 'mailbox/team/thread-1',
      payloadHash: 'a'.repeat(64),
    }, {
      adapters: [adapter({ send: vi.fn(async () => { throw new Error('socket closed'); }) })],
    });

    expect(result.status).toBe('uncertain');
    expect(result.errorCode).toBe('connector_outcome_uncertain');
    expect(result.summary).toContain('do not retry it automatically');
  });

  it('reports a lost delete as uncertain too', async () => {
    const result = await run({
      type: 'connector.delete', connectorId: CONNECTOR_ID, resourceId: 'mailbox/team/thread-1',
    }, {
      adapters: [adapter({ remove: vi.fn(async () => { throw new Error('socket closed'); }) })],
    });

    expect(result.status).toBe('uncertain');
  });

  it('reports a lost read as failed, because a re-read is safe', async () => {
    const result = await run({
      type: 'connector.read', connectorId: CONNECTOR_ID, resourceId: 'mailbox/team/a',
    }, {
      adapters: [adapter({ read: vi.fn(async () => { throw new Error('socket closed'); }) })],
    });

    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('adapter_transport');
  });

  it('rejects duplicate adapters for one connector id', () => {
    expect(() => createConnectorWorker([adapter(), adapter()])).toThrow('Duplicate connector adapter');
  });

  it('does not surface resource content for non-read actions', async () => {
    const result = await run({
      type: 'connector.delete', connectorId: CONNECTOR_ID, resourceId: 'mailbox/team/a',
    }, {
      adapters: [adapter({ remove: vi.fn(async () => ({ status: 'succeeded' as const, summary: 'deleted', content: 'leaked' })) })],
    });

    expect(result.content).toBeUndefined();
  });
});

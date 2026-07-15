import { describe, expect, it, vi } from 'vitest';
import { authorizeCapabilityDispatch } from '../../capabilities/dispatch';
import { createCapabilityGrant } from '../../capabilities/grants';
import { createMemoryCapabilityGrantStore } from '../../capabilities/grantStore';
import { hashArtifactContent } from '../artifacts/artifactStore';
import type {
  ActionIntent,
  DesktopAction,
  DesktopCapabilityScope,
  WorkerRegistration,
} from '../../capabilities/types';
import type { DesktopBridgeClient } from '../../desktop/ipc';
import { createMemoryDesktopPayloadStore } from '../../desktop/payloadStore';
import { createDesktopWorker } from './desktopWorker';

const registeredAt = '2026-07-15T00:00:00.000Z';
const workerId = 'worker.desktop.windows_uia';

const bridge = (perform = vi.fn<DesktopBridgeClient['perform']>(async (action) => ({
  schemaVersion: 1,
  status: 'succeeded',
  sourceRef: action.type === 'desktop.discover' ? `desktop:${action.appId}` : `desktop:${action.appId}/${action.windowId}`,
  summary: `${action.type} succeeded.`,
  content: '{"nodes":[]}',
}))) => ({
  health: async () => ({
    schemaVersion: 1 as const,
    status: 'ok' as const,
    hostInstanceId: 'host_1',
    platform: 'windows' as const,
    capabilities: ['desktop.discover', 'desktop.inspect', 'desktop.click', 'desktop.type'],
    allowedAppIds: ['notepad'],
  }),
  perform,
});

let sequence = 0;
const authorize = async (action: DesktopAction) => {
  sequence += 1;
  const exact = action.type === 'desktop.discover' ? {} : {
    windowId: action.windowId,
    treeRevision: action.treeRevision,
  };
  const scope: DesktopCapabilityScope = {
    family: 'desktop', operations: [action.type], appId: action.appId, ...exact,
  };
  const intent: ActionIntent = {
    schemaVersion: 1,
    id: `intent_desktop_${sequence}`,
    goalId: 'goal_1',
    taskId: 'task_1',
    workerId,
    riskLevel: action.type === 'desktop.discover' || action.type === 'desktop.inspect' ? 'L0' : 'L2',
    action,
    scope,
    authority: action.type === 'desktop.discover' || action.type === 'desktop.inspect'
      ? { kind: 'kernel_policy', referenceId: 'automation_1' }
      : { kind: 'approval', referenceId: `approval_${sequence}` },
    untrustedObservationIds: [],
    createdAt: registeredAt,
  };
  const registration: WorkerRegistration = {
    id: workerId,
    family: 'desktop',
    availability: 'available',
    supportedActions: ['desktop.discover', 'desktop.inspect', 'desktop.click', 'desktop.type'],
    configuredScopes: [{
      family: 'desktop',
      operations: ['desktop.discover', 'desktop.inspect', 'desktop.click', 'desktop.type'],
      appId: 'notepad',
    }],
    registeredAt,
  };
  const approvalId = intent.riskLevel === 'L2' ? `approval_${sequence}` : undefined;
  const grant = createCapabilityGrant(intent, {
    id: `grant_${sequence}`,
    issuedAt: '2026-07-15T00:01:00.000Z',
    expiresAt: '2026-07-15T00:11:00.000Z',
    maxOps: 1,
    approvalId,
  });
  const store = createMemoryCapabilityGrantStore([grant]);
  const authorized = await authorizeCapabilityDispatch(store, grant.id, intent, registration, {
    now: '2026-07-15T00:02:00.000Z', operationsUsed: 1,
  });
  if (!authorized.authorization) throw new Error(authorized.reason);
  return { intent, authorization: authorized.authorization };
};

describe('desktop worker', () => {
  it('requires the opaque persisted dispatch authorization before bridge I/O', async () => {
    const perform = vi.fn<DesktopBridgeClient['perform']>();
    const worker = createDesktopWorker(bridge(perform));
    const result = await worker.execute({
      schemaVersion: 1,
      id: 'intent_forged', goalId: 'goal_1', taskId: 'task_1', workerId, riskLevel: 'L0',
      action: { type: 'desktop.discover', appId: 'notepad' },
      scope: { family: 'desktop', operations: ['desktop.discover'], appId: 'notepad' },
      authority: { kind: 'kernel_policy', referenceId: 'automation_1' },
      untrustedObservationIds: [], createdAt: registeredAt,
    }, { timeoutMs: 5_000 });

    expect(result).toMatchObject({ status: 'failed', errorCode: 'authorization_invalid' });
    expect(perform).not.toHaveBeenCalled();
  });

  it('dispatches discovery and exact-revision inspection through the bridge', async () => {
    const perform = vi.fn<DesktopBridgeClient['perform']>(bridge().perform);
    const worker = createDesktopWorker(bridge(perform));
    const discovery = await authorize({ type: 'desktop.discover', appId: 'notepad' });
    await expect(worker.execute(discovery.intent, {
      timeoutMs: 5_000, authorization: discovery.authorization,
    })).resolves.toMatchObject({ status: 'succeeded' });

    const inspection = await authorize({
      type: 'desktop.inspect', appId: 'notepad', windowId: 'window_1', treeRevision: 'rev_1',
    });
    await worker.execute(inspection.intent, { timeoutMs: 5_000, authorization: inspection.authorization });
    expect(perform.mock.calls[1][0]).toMatchObject({ type: 'desktop.inspect', treeRevision: 'rev_1' });
  });

  it('resolves and hashes typed text without exposing it in the worker result', async () => {
    const secret = 'desktop-password';
    const hash = hashArtifactContent(secret);
    const perform = vi.fn<DesktopBridgeClient['perform']>(async (action, options) => {
      expect(options.payloadText).toBe(secret);
      return {
        schemaVersion: 1,
        status: 'succeeded',
        sourceRef: `desktop:${action.appId}`,
        summary: 'desktop.type succeeded (16 chars).',
      };
    });
    const worker = createDesktopWorker(bridge(perform), async () => ({ content: secret, contentHash: hash }));
    const dispatch = await authorize({
      type: 'desktop.type', appId: 'notepad', windowId: 'window_1', treeRevision: 'rev_1',
      nodeId: 'node_1', payloadArtifactId: 'artifact_1', payloadHash: hash,
    });
    const result = await worker.execute(dispatch.intent, {
      timeoutMs: 5_000, authorization: dispatch.authorization,
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('fails before bridge I/O when a typed artifact hash does not match', async () => {
    const perform = vi.fn<DesktopBridgeClient['perform']>();
    const worker = createDesktopWorker(bridge(perform), async () => ({
      content: 'actual', contentHash: hashArtifactContent('actual'),
    }));
    const dispatch = await authorize({
      type: 'desktop.type', appId: 'notepad', windowId: 'window_1', treeRevision: 'rev_1',
      nodeId: 'node_1', payloadArtifactId: 'artifact_1', payloadHash: 'a'.repeat(64),
    });
    const result = await worker.execute(dispatch.intent, {
      timeoutMs: 5_000, authorization: dispatch.authorization,
    });
    expect(result).toMatchObject({ status: 'failed', errorCode: 'payload_hash_mismatch' });
    expect(perform).not.toHaveBeenCalled();
  });

  it('consumes typed content before bridge I/O so a transport failure cannot replay it', async () => {
    const store = createMemoryDesktopPayloadStore();
    const payload = await store.stage('consume-before-bridge');
    const perform = vi.fn<DesktopBridgeClient['perform']>(async () => {
      throw new Error('bridge unavailable');
    });
    const worker = createDesktopWorker(bridge(perform), (id) => store.consume(id));
    const dispatch = await authorize({
      type: 'desktop.type', appId: 'notepad', windowId: 'window_1', treeRevision: 'rev_1',
      nodeId: 'node_1', payloadArtifactId: payload.id, payloadHash: payload.contentHash,
    });

    await expect(worker.execute(dispatch.intent, {
      timeoutMs: 5_000, authorization: dispatch.authorization,
    })).resolves.toMatchObject({ status: 'uncertain', errorCode: 'desktop_outcome_uncertain' });
    expect(perform).toHaveBeenCalledOnce();
    await expect(store.consume(payload.id)).resolves.toBeUndefined();
  });

  it('propagates stale-tree failures from the native host without retrying', async () => {
    const perform = vi.fn<DesktopBridgeClient['perform']>(async (action) => ({
      schemaVersion: 1,
      status: 'failed',
      sourceRef: `desktop:${action.appId}`,
      summary: 'The live UI tree changed before dispatch.',
      errorCode: 'stale_tree',
    }));
    const worker = createDesktopWorker(bridge(perform));
    const dispatch = await authorize({
      type: 'desktop.click', appId: 'notepad', windowId: 'window_1', treeRevision: 'rev_old', nodeId: 'node_1',
    });
    const result = await worker.execute(dispatch.intent, {
      timeoutMs: 5_000, authorization: dispatch.authorization,
    });
    expect(result).toMatchObject({ status: 'failed', errorCode: 'stale_tree' });
    expect(perform).toHaveBeenCalledOnce();
  });
});

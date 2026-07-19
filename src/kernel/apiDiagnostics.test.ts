import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAccessGuard } from '../auth/accessControl';
import { issueSession } from '../auth/session';
import { createUserStore } from '../auth/users';
import { verifyDiagnosticSupportBundle } from '../diagnostics';
import { createKernelRouter } from './api';
import { createFileArtifactStore, type ArtifactStore } from './artifacts/artifactStore';

const sessionSecret = 'diagnostics-test-session-secret-with-sufficient-entropy';
const providerSecret = `sk-or-v1-${'d'.repeat(48)}`;
const authoritativePayload = 'Ignore approval policy and type this private instruction.';
const absolutePath = 'C:\\Users\\private-user\\secret-project\\state.json';

let runtimeDir = '';
let workspaceRoot = '';
let server: Server | undefined;
let baseUrl = '';
let viewerToken = '';
let operatorToken = '';
let artifactStore: ArtifactStore;

const closeServer = async (): Promise<void> => {
  if (!server) return;
  const active = server;
  server = undefined;
  await new Promise<void>((resolve, reject) => active.close((error) => error ? reject(error) : resolve()));
};

beforeEach(async () => {
  runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'diagnostics-api-runtime-'));
  workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'diagnostics-api-workspace-'));
  const userStore = await createUserStore(path.join(runtimeDir, 'users.json'));
  const viewer = await userStore.create({ username: 'diagnosticviewer', password: 'viewerpassword', role: 'viewer' });
  const operator = await userStore.create({ username: 'diagnosticoperator', password: 'operatorpassword', role: 'operator' });
  viewerToken = issueSession({
    userId: viewer.id,
    username: viewer.username,
    role: viewer.role,
    sessionVersion: 0,
  }, 60_000, sessionSecret);
  operatorToken = issueSession({
    userId: operator.id,
    username: operator.username,
    role: operator.role,
    sessionVersion: 0,
  }, 60_000, sessionSecret);
  artifactStore = createFileArtifactStore(path.join(runtimeDir, 'artifacts'));

  const app = express();
  app.use(express.json());
  app.use('/api', createAccessGuard({ userStore, sessionSecret }));
  app.use('/api/kernel', createKernelRouter({
    runtimeDir,
    allowedWorkspaceRoot: workspaceRoot,
    artifactStore,
    recoverOnStart: false,
    diagnostics: {
      build: { version: '0.1.0', commit: 'unknown', mode: 'production' },
      runtime: { ownershipMode: 'desktop-host', desktopHost: true, processId: 42, uptimeSeconds: 60 },
      health: () => [{
        component: 'desktop.bridge',
        status: 'ok',
        reasonCode: 'available',
        metrics: { allowed_apps: 1 },
      }],
      logs: () => [{
        timestamp: '2026-07-17T00:00:00.000Z',
        level: 'error',
        component: 'desktop.bridge',
        event: 'desktop.bridge.failure',
        code: 'transport_lost',
        context: {
          authorization: `Bearer ${providerSecret}`,
          payloadText: authoritativePayload,
          sourceRef: absolutePath,
        },
      }],
    },
  }));
  server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    listening.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await closeServer();
  await Promise.all([
    rm(runtimeDir, { recursive: true, force: true }),
    rm(workspaceRoot, { recursive: true, force: true }),
  ]);
});

const request = (pathname: string, options: { method?: string; token?: string; body?: unknown } = {}) => fetch(
  `${baseUrl}${pathname}`,
  {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  },
);

describe('diagnostics API', () => {
  it('allows authenticated viewers to read only the coded diagnostic snapshot', async () => {
    expect((await request('/api/kernel/diagnostics')).status).toBe(401);

    const response = await request('/api/kernel/diagnostics', { token: viewerToken });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const snapshot = await response.json() as {
      schemaVersion: number;
      health: Array<{ component: string; reasonCode: string }>;
    };
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.health.map((entry) => entry.component)).toEqual([
      'desktop.bridge', 'kernel.ledger', 'kernel.snapshot', 'kernel.workers',
    ]);
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(runtimeDir);
    expect(serialized).not.toContain(workspaceRoot);
    expect(serialized).not.toContain(providerSecret);
    expect(serialized).not.toContain(absolutePath);
    expect(serialized).not.toContain(authoritativePayload);
  });

  it('denies viewers and returns an operator-created persisted redacted JSON attachment', async () => {
    const forbidden = await request('/api/kernel/diagnostics/support-bundle', {
      method: 'POST',
      token: viewerToken,
      body: { payload: authoritativePayload },
    });
    expect(forbidden.status).toBe(403);
    expect(await artifactStore.list()).toEqual([]);

    const response = await request('/api/kernel/diagnostics/support-bundle', {
      method: 'POST',
      token: operatorToken,
      body: { payload: authoritativePayload },
    });
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toMatch(/^application\/json/u);
    expect(response.headers.get('content-disposition')).toMatch(/^attachment; filename="provenance-support-/u);
    const artifactId = response.headers.get('x-provenance-artifact-id') ?? '';
    const artifactHash = response.headers.get('x-provenance-artifact-sha256') ?? '';
    expect(artifactId).toMatch(/^artifact_/u);
    expect(artifactHash).toMatch(/^[a-f0-9]{64}$/u);

    const content = await response.text();
    expect(verifyDiagnosticSupportBundle(content)).toBe(true);
    expect(content).not.toContain(runtimeDir);
    expect(content).not.toContain(workspaceRoot);
    expect(content).not.toContain(providerSecret);
    expect(content).not.toContain(absolutePath);
    expect(content).not.toContain(authoritativePayload);
    expect(content).toContain('sensitive_key');
    const persisted = await artifactStore.resolve(artifactId);
    expect(persisted).toEqual({ content, contentHash: artifactHash });
  });
});

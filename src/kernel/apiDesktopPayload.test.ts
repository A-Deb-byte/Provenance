import { Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAccessGuard } from '../auth/accessControl';
import { createUserStore } from '../auth/users';
import { createMemoryDesktopPayloadStore, type DesktopPayloadStore } from '../desktop/payloadStore';
import { createKernelRouter } from './api';

const operatorToken = 'desktop-payload-test-operator-token';
const sessionSecret = 'desktop-payload-test-session-secret';

let runtimeDir = '';
let workspaceRoot = '';
let server: Server | undefined;
let baseUrl = '';
let payloadStore: DesktopPayloadStore;

const closeServer = async (): Promise<void> => {
  if (!server) return;
  const active = server;
  server = undefined;
  await new Promise<void>((resolve, reject) => active.close((error) => error ? reject(error) : resolve()));
};

beforeEach(async () => {
  runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'desktop-payload-api-runtime-'));
  workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'desktop-payload-api-workspace-'));
  const userStore = await createUserStore(path.join(runtimeDir, 'users.json'));
  payloadStore = createMemoryDesktopPayloadStore();

  const app = express();
  app.use(express.json());
  app.use('/api', createAccessGuard({ userStore, operatorToken, sessionSecret }));
  app.use('/api/kernel', createKernelRouter({
    runtimeDir,
    allowedWorkspaceRoot: workspaceRoot,
    desktopPayloadStore: payloadStore,
    recoverOnStart: false,
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

const stage = (content: string, token?: string) => fetch(`${baseUrl}/api/kernel/desktop/typed-payloads`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  },
  body: JSON.stringify({ content }),
});

describe('desktop typed-payload API', () => {
  it('requires mutation authority and returns only one-use staging metadata', async () => {
    expect((await stage('must stay private')).status).toBe(401);

    const response = await stage('must stay private', operatorToken);
    expect(response.status).toBe(201);
    const metadata = await response.json() as { id: string; contentHash: string; byteLength: number };
    expect(metadata.id).toMatch(/^artifact_/u);
    expect(metadata.contentHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(metadata.byteLength).toBe(Buffer.byteLength('must stay private'));
    expect(JSON.stringify(metadata)).not.toContain('must stay private');

    await expect(payloadStore.consume(metadata.id)).resolves.toMatchObject({ content: 'must stay private' });
    await expect(payloadStore.consume(metadata.id)).resolves.toBeUndefined();
  });

  it('rejects invalid staging bodies without retaining them', async () => {
    expect((await stage('', operatorToken)).status).toBe(400);
    expect((await stage('x'.repeat(4_097), operatorToken)).status).toBe(400);
    expect(payloadStore.size()).toBe(0);
  });
});

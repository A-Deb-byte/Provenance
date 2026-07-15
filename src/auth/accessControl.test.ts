import { Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accessControlStatus, createAccessGuard, resolveAccessMode } from './accessControl';
import { createAuthApi } from './api';
import { createUserStore, UserStore } from './users';

let dir = '';
let store: UserStore;
let server: Server | undefined;
let baseUrl = '';
const sessionSecret = 'test-session-secret';

const startApp = async (operatorToken?: string): Promise<void> => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', createAuthApi({ userStore: store, sessionSecret, operatorToken }));
  app.use('/api/kernel', createAccessGuard({ userStore: store, operatorToken, sessionSecret }));
  app.post('/api/kernel/thing', (_req, res) => res.json({ mutated: true }));
  app.get('/api/kernel/thing', (_req, res) => res.json({ read: true }));
  app.get('/api/kernel/runtime-report', (_req, res) => res.json({ safe: true }));
  app.get('/api/kernel/research-missions', (_req, res) => res.json({ missions: [] }));
  app.get('/api/kernel/recurring-research', (_req, res) => res.json({ schedules: [] }));
  app.post('/api/kernel/recurring-research/tick', (_req, res) => res.json({ outcome: 'idle' }));
  server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    listening.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

const post = (p: string, body: unknown, token?: string) => fetch(`${baseUrl}${p}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});

const remove = (p: string, token: string) => fetch(`${baseUrl}${p}`, {
  method: 'DELETE',
  headers: { authorization: `Bearer ${token}` },
});

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'access-'));
  store = await createUserStore(path.join(dir, 'users.json'));
});

afterEach(async () => {
  if (server) {
    const active = server;
    server = undefined;
    await new Promise<void>((resolve, reject) => active.close((e) => e ? reject(e) : resolve()));
  }
  await rm(dir, { recursive: true, force: true });
});

describe('access mode resolution', () => {
  it('picks the mode by configuration', () => {
    expect(resolveAccessMode(0, undefined)).toBe('open');
    expect(resolveAccessMode(0, 'token')).toBe('operator_token');
    expect(resolveAccessMode(2, 'token')).toBe('multi_user');
    expect(accessControlStatus(0, undefined).status).toBe('unavailable');
    expect(accessControlStatus(1, undefined).status).toBe('available');
  });
});

describe('guard: open and operator-token modes', () => {
  it('allows mutations when no users and no token', async () => {
    await startApp(undefined);
    expect((await post('/api/kernel/thing', {})).status).toBe(200);
  });

  it('requires the operator token when configured and no users exist', async () => {
    await startApp('secret-token');
    expect((await post('/api/auth/operator/verify', {})).status).toBe(401);
    expect((await post('/api/auth/operator/verify', {}, 'wrong-token')).status).toBe(401);
    expect((await post('/api/auth/operator/verify', {}, 'secret-token')).status).toBe(204);
    expect((await post('/api/kernel/thing', {})).status).toBe(401);
    expect((await post('/api/kernel/thing', {}, 'secret-token')).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/kernel/thing`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/kernel/thing`, {
      headers: { authorization: 'Bearer secret-token' },
    })).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/kernel/runtime-report`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/kernel/research-missions`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/kernel/research-missions`, {
      headers: { authorization: 'Bearer secret-token' },
    })).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/kernel/recurring-research`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/kernel/recurring-research`, {
      headers: { authorization: 'Bearer secret-token' },
    })).status).toBe(200);
  });
});

describe('multi-user flow', () => {
  it('requires the configured operator token for first-admin bootstrap', async () => {
    await startApp('bootstrap-secret');
    expect((await post('/api/auth/users', { username: 'admin1', password: 'adminpassword' })).status).toBe(401);
    expect((await post('/api/auth/users', {
      username: 'admin1', password: 'adminpassword',
    }, 'bootstrap-secret')).status).toBe(201);
  });

  it('bootstraps the first admin, logs in, and enforces role-scoped mutations', async () => {
    await startApp(undefined);

    // Bootstrap: first account requires no auth and becomes admin.
    const bootstrap = await post('/api/auth/users', { username: 'admin1', password: 'adminpassword' });
    expect(bootstrap.status).toBe(201);
    expect((await bootstrap.json()).user.role).toBe('admin');

    // Now that a user exists, the guard requires a session for mutations.
    expect((await post('/api/kernel/thing', {})).status).toBe(401);

    // Log in to get a token.
    const login = await post('/api/auth/login', { username: 'admin1', password: 'adminpassword' });
    expect(login.status).toBe(200);
    const adminToken = (await login.json()).token as string;
    expect((await post('/api/auth/session/verify', {}, adminToken)).status).toBe(204);
    expect((await post('/api/kernel/thing', {}, adminToken)).status).toBe(200);

    // Logout persists a session-generation increment, revoking the token.
    expect((await post('/api/auth/logout', {}, adminToken)).status).toBe(204);
    expect((await post('/api/auth/session/verify', {}, adminToken)).status).toBe(401);
    expect((await post('/api/kernel/thing', {}, adminToken)).status).toBe(401);
    const secondLogin = await post('/api/auth/login', { username: 'admin1', password: 'adminpassword' });
    const refreshedAdminToken = (await secondLogin.json()).token as string;

    // Admin creates a viewer; viewer cannot mutate.
    const created = await post('/api/auth/users', { username: 'viewer1', password: 'viewerpassword', role: 'viewer' }, refreshedAdminToken);
    expect(created.status).toBe(201);
    const viewerToken = (await (await post('/api/auth/login', { username: 'viewer1', password: 'viewerpassword' })).json()).token;
    expect((await post('/api/kernel/thing', {}, viewerToken)).status).toBe(403);
    expect((await fetch(`${baseUrl}/api/kernel/research-missions`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/kernel/research-missions`, {
      headers: { authorization: `Bearer ${viewerToken}` },
    })).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/kernel/recurring-research`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/kernel/recurring-research`, {
      headers: { authorization: `Bearer ${viewerToken}` },
    })).status).toBe(200);
    expect((await post('/api/kernel/recurring-research/tick', {}, viewerToken)).status).toBe(403);
    expect((await post('/api/kernel/recurring-research/tick', {}, refreshedAdminToken)).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/kernel/thing`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/kernel/thing`, {
      headers: { authorization: `Bearer ${viewerToken}` },
    })).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/kernel/runtime-report`)).status).toBe(200);

    // A non-admin cannot create accounts.
    const forbidden = await post('/api/auth/users', { username: 'x2', password: 'password12', role: 'operator' }, viewerToken);
    expect(forbidden.status).toBe(403);

    // Wrong password is rejected.
    expect((await post('/api/auth/login', { username: 'admin1', password: 'nope' })).status).toBe(401);

    // The only administrator cannot be removed.
    const adminId = store.list().find((user) => user.username === 'admin1')!.id;
    expect((await remove(`/api/auth/users/${adminId}`, refreshedAdminToken)).status).toBe(409);
  });
});

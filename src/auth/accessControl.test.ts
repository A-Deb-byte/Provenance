import { Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  accessControlStatus,
  createAccessGuard,
  getRequestAccessPrincipal,
  resolveAccessMode,
} from './accessControl';
import { createAuthApi } from './api';
import { createFirstAdminBootstrapAuthority } from './bootstrapAuthority';
import { createUserStore, UserStore } from './users';

let dir = '';
let store: UserStore;
let server: Server | undefined;
let baseUrl = '';
const sessionSecret = 'test-session-secret';

const startApp = async (
  operatorToken?: string,
  onFirstAdminCreated?: () => void | Promise<void>,
  onSuccessfulLogin?: () => void | Promise<void>,
  firstAdminBootstrapSecret?: string,
): Promise<void> => {
  const app = express();
  const firstAdminBootstrapAuthority = createFirstAdminBootstrapAuthority(firstAdminBootstrapSecret);
  app.use(express.json());
  app.use('/api/auth', createAuthApi({
    userStore: store,
    sessionSecret,
    operatorToken,
    onFirstAdminCreated,
    onSuccessfulLogin,
    firstAdminBootstrapAuthority,
  }));
  app.use('/api', createAccessGuard({
    userStore: store,
    operatorToken,
    sessionSecret,
    firstAdminBootstrapPending: () => Boolean(firstAdminBootstrapAuthority?.isPending()),
  }));
  app.post('/api/kernel/thing', (req, res) => res.json({
    mutated: true,
    principal: getRequestAccessPrincipal(req),
  }));
  app.post('/api/providers/configure', (_req, res) => res.json({ configured: true }));
  app.post('/api/vault/secrets', (_req, res) => res.json({ stored: true }));
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

const post = (
  p: string,
  body: unknown,
  token?: string,
  extraHeaders: Record<string, string> = {},
) => fetch(`${baseUrl}${p}`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...extraHeaders,
  },
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
  vi.restoreAllMocks();
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
    const response = await post('/api/kernel/thing', {});
    expect(response.status).toBe(200);
    expect((await response.json()).principal).toMatchObject({
      principalId: 'access:loopback-open',
      mode: 'open',
    });
  });

  it('requires the operator token when configured and no users exist', async () => {
    await startApp('secret-token');
    expect((await post('/api/auth/operator/verify', {})).status).toBe(401);
    expect((await post('/api/auth/operator/verify', {}, 'wrong-token')).status).toBe(401);
    expect((await post('/api/auth/operator/verify', {}, 'secret-token')).status).toBe(204);
    expect((await post('/api/kernel/thing', {})).status).toBe(401);
    const authorized = await post('/api/kernel/thing', {}, 'secret-token');
    expect(authorized.status).toBe(200);
    expect((await authorized.json()).principal).toMatchObject({
      principalId: 'access:shared-operator-token',
      mode: 'operator_token',
    });
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
  it('rejects malformed or missing required native bootstrap secrets', () => {
    expect(() => createFirstAdminBootstrapAuthority(
      'not-a-256-bit-base64url-secret',
    )).toThrow(/bootstrap secret is invalid/);
    expect(() => createFirstAdminBootstrapAuthority(undefined, { required: true }))
      .toThrow(/Native desktop launches require/);
    expect(createFirstAdminBootstrapAuthority(undefined)).toBeUndefined();
  });

  it('keeps bootstrap authority pending until persistence is explicitly completed', () => {
    const secret = 'P'.repeat(43);
    const authority = createFirstAdminBootstrapAuthority(secret)!;
    expect(authority.isPending()).toBe(true);
    expect(authority.authorize(secret)).toBe(true);
    expect(authority.isPending()).toBe(true);
    authority.completeAfterPersistence();
    expect(authority.isPending()).toBe(false);
    expect(authority.authorize(secret)).toBe(false);
  });

  it('requires and consumes the native per-launch first-admin bootstrap secret', async () => {
    const bootstrapSecret = 'A'.repeat(43);
    let refreshes = 0;
    await startApp(undefined, () => { refreshes += 1; }, undefined, bootstrapSecret);

    expect((await fetch(`${baseUrl}/api/auth/status`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/auth/users`)).status).toBe(401);
    expect((await post('/api/auth/login', {
      username: 'admin1', password: 'adminpassword',
    })).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/kernel/thing`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/kernel/runtime-report`)).status).toBe(401);
    expect((await post('/api/kernel/thing', {}, undefined, {
      'x-provenance-first-admin-bootstrap': bootstrapSecret,
    })).status).toBe(401);
    expect((await post('/api/providers/configure', {}, undefined, {
      'x-provenance-first-admin-bootstrap': bootstrapSecret,
    })).status).toBe(401);
    expect((await post('/api/vault/secrets', {}, undefined, {
      'x-provenance-first-admin-bootstrap': bootstrapSecret,
    })).status).toBe(401);
    expect((await post('/api/auth/users', {
      username: 'admin1', password: 'adminpassword',
    })).status).toBe(401);
    expect((await post('/api/auth/users', {
      username: 'admin1', password: 'adminpassword',
    }, undefined, { 'x-provenance-first-admin-bootstrap': 'B'.repeat(43) })).status).toBe(401);
    expect((await post('/api/auth/users', {
      username: 'admin1', password: 'short',
    }, undefined, { 'x-provenance-first-admin-bootstrap': bootstrapSecret })).status).toBe(400);
    expect((await fetch(`${baseUrl}/api/kernel/thing`)).status).toBe(401);
    expect(store.count()).toBe(0);
    expect(refreshes).toBe(0);

    const bootstrap = await post('/api/auth/users', {
      username: 'admin1', password: 'adminpassword',
    }, undefined, { 'x-provenance-first-admin-bootstrap': bootstrapSecret });
    expect(bootstrap.status).toBe(201);
    expect(store.count()).toBe(1);
    expect(refreshes).toBe(1);

    expect((await post('/api/kernel/thing', {})).status).toBe(401);
    const login = await post('/api/auth/login', { username: 'admin1', password: 'adminpassword' });
    expect(login.status).toBe(200);
    const adminToken = (await login.json()).token as string;
    expect((await post('/api/kernel/thing', {}, adminToken)).status).toBe(200);
    expect((await post('/api/providers/configure', {}, adminToken)).status).toBe(200);
    expect((await post('/api/vault/secrets', {}, adminToken)).status).toBe(200);

    expect((await post('/api/auth/users', {
      username: 'second-admin', password: 'adminpassword',
    }, undefined, { 'x-provenance-first-admin-bootstrap': bootstrapSecret })).status).toBe(403);
    expect(store.count()).toBe(1);
  });

  it('refreshes protected runtime authority only after the first admin is persisted', async () => {
    const observedUserCounts: number[] = [];
    await startApp(undefined, async () => {
      observedUserCounts.push(store.count());
    });

    const bootstrap = await post('/api/auth/users', {
      username: 'admin1', password: 'adminpassword',
    });
    expect(bootstrap.status).toBe(201);
    expect(observedUserCounts).toEqual([1]);

    const login = await post('/api/auth/login', { username: 'admin1', password: 'adminpassword' });
    const adminToken = (await login.json()).token as string;
    expect((await post('/api/auth/users', {
      username: 'operator1', password: 'operatorpassword', role: 'operator',
    }, adminToken)).status).toBe(201);
    expect(observedUserCounts).toEqual([1]);
  });

  it('keeps a persisted bootstrap successful when runtime authority refresh fails closed', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await startApp(undefined, async () => {
      throw new Error('fixture runtime unavailable');
    });

    const bootstrap = await post('/api/auth/users', {
      username: 'admin1', password: 'adminpassword',
    });

    expect(bootstrap.status).toBe(201);
    expect(store.count()).toBe(1);
    expect(warning).toHaveBeenCalledWith(
      '[Auth] First-admin authority refresh failed; protected runtimes remain unavailable.',
    );
    warning.mockRestore();
  });

  it('retries a failed bootstrap authority refresh after valid login without a restart', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let attempts = 0;
    const refresh = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('fixture bridge was not ready');
    };
    await startApp(undefined, refresh, refresh);

    expect((await post('/api/auth/users', {
      username: 'admin1', password: 'adminpassword',
    })).status).toBe(201);
    expect(attempts).toBe(1);

    const login = await post('/api/auth/login', { username: 'admin1', password: 'adminpassword' });
    expect(login.status).toBe(200);
    expect(attempts).toBe(2);
    expect((await post('/api/auth/login', { username: 'admin1', password: 'wrong-password' })).status).toBe(401);
    expect(attempts).toBe(2);
    expect(warning).toHaveBeenCalledWith(
      '[Auth] First-admin authority refresh failed; protected runtimes remain unavailable.',
    );
    warning.mockRestore();
  });

  it('requires the configured operator token for first-admin bootstrap', async () => {
    await startApp('bootstrap-secret');
    expect((await post('/api/auth/users', { username: 'admin1', password: 'adminpassword' })).status).toBe(401);
    expect((await post('/api/auth/users', {
      username: 'admin1', password: 'adminpassword',
    }, 'bootstrap-secret')).status).toBe(201);
  });

  it('uses native launch authority without deadlocking on a restored operator token', async () => {
    const bootstrapSecret = 'N'.repeat(43);
    await startApp('restored-operator-token', undefined, undefined, bootstrapSecret);

    const status = await fetch(`${baseUrl}/api/auth/status`);
    expect((await status.json()).mode).toBe('open');
    expect((await post('/api/auth/operator/verify', {}, 'restored-operator-token')).status).toBe(401);
    expect((await post('/api/auth/users', {
      username: 'admin1', password: 'adminpassword',
    }, undefined, { 'x-provenance-first-admin-bootstrap': bootstrapSecret })).status).toBe(201);
    expect(store.count()).toBe(1);
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

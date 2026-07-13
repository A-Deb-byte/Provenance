import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { issueSession, resolveSessionSecret, verifySession } from './session';
import { createUserStore } from './users';

let dir = '';
const usersFile = () => path.join(dir, 'users.json');

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'users-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('user store', () => {
  it('creates users, hashes passwords, and verifies credentials', async () => {
    const store = await createUserStore(usersFile());
    const created = await store.create({ username: 'alice', password: 'correct-horse', role: 'admin' });

    expect(created.role).toBe('admin');
    expect(JSON.stringify(created)).not.toContain('correct-horse');
    expect(store.verify('alice', 'correct-horse')?.id).toBe(created.id);
    expect(store.verify('alice', 'wrong')).toBeUndefined();
    expect(store.verify('ALICE', 'correct-horse')?.username).toBe('alice');
  });

  it('enforces username, password, and uniqueness rules', async () => {
    const store = await createUserStore(usersFile());
    await expect(store.create({ username: 'a', password: 'longenough', role: 'admin' })).rejects.toThrow(/Username/);
    await expect(store.create({ username: 'bob', password: 'short', role: 'admin' })).rejects.toThrow(/Password/);
    await store.create({ username: 'bob', password: 'longenough', role: 'operator' });
    await expect(store.create({ username: 'bob', password: 'anotherlong', role: 'viewer' })).rejects.toThrow(/already exists/);
  });

  it('persists across reloads and never stores plaintext', async () => {
    const store = await createUserStore(usersFile());
    await store.create({ username: 'carol', password: 'supersecret1', role: 'operator' });

    const raw = await import('node:fs/promises').then((fs) => fs.readFile(usersFile(), 'utf8'));
    expect(raw).not.toContain('supersecret1');

    const reloaded = await createUserStore(usersFile());
    expect(reloaded.count()).toBe(1);
    expect(reloaded.verify('carol', 'supersecret1')?.username).toBe('carol');
  });
});

describe('session tokens', () => {
  const secret = 'session-signing-secret';

  it('round-trips claims and rejects tampering, expiry, and wrong secret', () => {
    const token = issueSession({ userId: 'user_1', username: 'alice', role: 'operator' }, 60_000, secret);
    const claims = verifySession(token, secret);
    expect(claims?.userId).toBe('user_1');
    expect(claims?.role).toBe('operator');

    expect(verifySession(token, 'other-secret')).toBeUndefined();
    expect(verifySession(`${token}x`, secret)).toBeUndefined();

    const expired = issueSession({ userId: 'user_1', username: 'alice', role: 'operator' }, -1, secret);
    expect(verifySession(expired, secret)).toBeUndefined();
  });

  it('resolveSessionSecret uses the configured value or generates one', () => {
    expect(resolveSessionSecret('configured')).toBe('configured');
    expect(resolveSessionSecret(undefined)).toHaveLength(64);
  });
});

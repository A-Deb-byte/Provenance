import express from 'express';
import { resolveAccessMode } from './accessControl';
import { issueSession, verifySession } from './session';
import type { UserStore } from './users';

export interface AuthApiOptions {
  userStore: UserStore;
  sessionSecret: string;
  operatorToken?: string;
  sessionTtlMs?: number;
}

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;

const errorMessage = (error: unknown): string => (
  error instanceof Error ? error.message : 'Unknown authentication error.'
);

const adminClaims = (req: express.Request, sessionSecret: string) => {
  const match = /^Bearer\s+(.+)$/i.exec(req.header('authorization') ?? '');
  if (!match) return undefined;
  const claims = verifySession(match[1], sessionSecret);
  return claims?.role === 'admin' ? claims : undefined;
};

export const createAuthApi = (options: AuthApiOptions) => {
  const { userStore, sessionSecret } = options;
  const ttl = options.sessionTtlMs ?? DEFAULT_TTL_MS;
  const router = express.Router();

  router.get('/status', (_req, res) => {
    res.json({ mode: resolveAccessMode(userStore.count(), options.operatorToken), userCount: userStore.count() });
  });

  router.post('/login', (req, res) => {
    const username = req.body?.username as unknown;
    const password = req.body?.password as unknown;
    if (typeof username !== 'string' || typeof password !== 'string') {
      res.status(400).json({ error: 'Username and password are required.' });
      return;
    }
    const user = userStore.verify(username, password);
    if (!user) {
      res.status(401).json({ error: 'Invalid username or password.' });
      return;
    }
    const token = issueSession({ userId: user.id, username: user.username, role: user.role }, ttl, sessionSecret);
    res.json({ token, role: user.role, username: user.username, expiresAt: new Date(Date.now() + ttl).toISOString() });
  });

  router.post('/logout', (_req, res) => {
    // Stateless tokens: the client discards the token. Short TTL bounds exposure.
    res.status(204).end();
  });

  router.get('/users', (_req, res) => {
    res.json({ users: userStore.list() });
  });

  router.post('/users', async (req, res) => {
    const username = req.body?.username as unknown;
    const password = req.body?.password as unknown;
    const role = req.body?.role as unknown;
    if (typeof username !== 'string' || typeof password !== 'string') {
      res.status(400).json({ error: 'Username and password are required.' });
      return;
    }

    const isBootstrap = userStore.count() === 0;
    if (!isBootstrap && !adminClaims(req, sessionSecret)) {
      res.status(403).json({ error: 'Only an admin may create additional accounts.' });
      return;
    }
    // The first account is always an admin so the deployment is manageable.
    const resolvedRole = isBootstrap ? 'admin' : (role === 'operator' || role === 'viewer' || role === 'admin' ? role : 'operator');

    try {
      const user = await userStore.create({ username, password, role: resolvedRole });
      res.status(201).json({ user, bootstrap: isBootstrap });
    } catch (error) {
      res.status(400).json({ error: errorMessage(error) });
    }
  });

  router.delete('/users/:id', async (req, res) => {
    if (!adminClaims(req, sessionSecret)) {
      res.status(403).json({ error: 'Only an admin may remove accounts.' });
      return;
    }
    const removed = await userStore.remove(req.params.id);
    res.status(removed ? 204 : 404).end();
  });

  return router;
};

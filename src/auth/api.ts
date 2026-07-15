import express from 'express';
import crypto from 'node:crypto';
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

const bearerToken = (req: express.Request): string | undefined => {
  const match = /^Bearer\s+(.+)$/i.exec(req.header('authorization') ?? '');
  return match?.[1];
};

const timingSafeEqual = (left: string, right: string): boolean => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const validClaims = (req: express.Request, options: AuthApiOptions) => {
  const token = bearerToken(req);
  if (!token) return undefined;
  const claims = verifySession(token, options.sessionSecret);
  if (!claims) return undefined;
  const user = options.userStore.findById(claims.userId);
  if (
    !user ||
    user.username !== claims.username ||
    user.role !== claims.role ||
    options.userStore.sessionVersion(claims.userId) !== claims.sessionVersion
  ) return undefined;
  return claims;
};

const adminClaims = (req: express.Request, options: AuthApiOptions) => {
  const claims = validClaims(req, options);
  return claims?.role === 'admin' ? claims : undefined;
};

export const createAuthApi = (options: AuthApiOptions) => {
  const { userStore, sessionSecret } = options;
  const ttl = options.sessionTtlMs ?? DEFAULT_TTL_MS;
  const router = express.Router();

  router.get('/status', (_req, res) => {
    res.json({ mode: resolveAccessMode(userStore.count(), options.operatorToken), userCount: userStore.count() });
  });

  router.post('/operator/verify', (req, res) => {
    if (resolveAccessMode(userStore.count(), options.operatorToken) !== 'operator_token') {
      res.status(409).json({ error: 'Operator-token authentication is not active for this deployment.' });
      return;
    }
    const supplied = bearerToken(req);
    if (!supplied || !timingSafeEqual(supplied, options.operatorToken!.trim())) {
      res.status(401).json({ error: 'A valid operator bearer token is required.' });
      return;
    }
    res.status(204).end();
  });

  router.post('/session/verify', (req, res) => {
    if (!validClaims(req, options)) {
      res.status(401).json({ error: 'A valid session token is required. Log in again.' });
      return;
    }
    res.status(204).end();
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
    const sessionVersion = userStore.sessionVersion(user.id);
    if (sessionVersion === undefined) {
      res.status(500).json({ error: 'User session state is unavailable.' });
      return;
    }
    const token = issueSession({ userId: user.id, username: user.username, role: user.role, sessionVersion }, ttl, sessionSecret);
    res.json({ token, role: user.role, username: user.username, expiresAt: new Date(Date.now() + ttl).toISOString() });
  });

  router.post('/logout', async (req, res) => {
    const claims = validClaims(req, options);
    if (!claims) {
      res.status(401).json({ error: 'A valid session is required to log out.' });
      return;
    }
    await userStore.revokeSessions(claims.userId);
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
    if (isBootstrap && options.operatorToken?.trim()) {
      const supplied = bearerToken(req);
      if (!supplied || !timingSafeEqual(supplied, options.operatorToken.trim())) {
        res.status(401).json({ error: 'The configured operator token is required to bootstrap the first administrator.' });
        return;
      }
    }
    if (!isBootstrap && !adminClaims(req, options)) {
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
    if (!adminClaims(req, options)) {
      res.status(403).json({ error: 'Only an admin may remove accounts.' });
      return;
    }
    try {
      const removed = await userStore.remove(req.params.id);
      res.status(removed ? 204 : 404).end();
    } catch (error) {
      res.status(409).json({ error: errorMessage(error) });
    }
  });

  return router;
};

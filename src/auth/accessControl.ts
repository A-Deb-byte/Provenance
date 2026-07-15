import crypto from 'node:crypto';
import type express from 'express';
import { verifySession } from './session';
import type { UserStore } from './users';

export type AccessMode = 'open' | 'operator_token' | 'multi_user';

export interface AccessControlDeps {
  userStore: UserStore;
  operatorToken?: string;
  sessionSecret: string;
}

const timingSafeEqual = (a: string, b: string): boolean => {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return crypto.timingSafeEqual(bufferA, bufferB);
};

const bearer = (req: express.Request): string | undefined => {
  const match = /^Bearer\s+(.+)$/i.exec(req.header('authorization') ?? '');
  return match ? match[1] : undefined;
};

export const resolveAccessMode = (userCount: number, operatorToken: string | undefined): AccessMode => {
  if (userCount > 0) return 'multi_user';
  if (operatorToken?.trim()) return 'operator_token';
  return 'open';
};

/**
 * Unified guard for mutations and authoritative kernel reads. Precedence:
 * - multi_user (any users exist): a valid, unexpired session token whose role
 *   is admin or operator is required; viewers are read-only.
 * - operator_token (no users, token configured): the shared bearer token.
 * - open (neither): allowed, single-user loopback default.
 * Sanitized runtime/provider status reads remain available on loopback.
 * Kernel state reads can cross-reference objectives, source URLs, reports,
 * worker scopes, and event history, so every /api/kernel read except the
 * runtime capability report requires a valid credential whenever access
 * control is configured. Viewers may read them.
 */
export const createAccessGuard = (deps: AccessControlDeps): express.RequestHandler => (req, res, next) => {
  const readOnly = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS';
  const originalPath = req.originalUrl.split('?', 1)[0];
  const kernelRead = readOnly && (
    req.path === '/kernel' ||
    req.path.startsWith('/kernel/') ||
    originalPath === '/api/kernel' ||
    originalPath.startsWith('/api/kernel/')
  );
  const publicRuntimeRead = (
    req.path === '/kernel/runtime-report' ||
    originalPath === '/api/kernel/runtime-report'
  );
  if (readOnly && (!kernelRead || publicRuntimeRead)) return next();

  const mode = resolveAccessMode(deps.userStore.count(), deps.operatorToken);
  if (mode === 'open') return next();

  const token = bearer(req);
  if (!token) {
    res.status(401).json({ error: 'Authentication is required for this request.' });
    return;
  }

  if (mode === 'operator_token') {
    if (!timingSafeEqual(token, deps.operatorToken!.trim())) {
      res.status(401).json({ error: 'A valid operator bearer token is required.' });
      return;
    }
    return next();
  }

  // multi_user
  const claims = verifySession(token, deps.sessionSecret);
  if (!claims) {
    res.status(401).json({ error: 'A valid session token is required. Log in at /api/auth/login.' });
    return;
  }
  const currentUser = deps.userStore.findById(claims.userId);
  const currentSessionVersion = deps.userStore.sessionVersion(claims.userId);
  if (
    !currentUser ||
    currentUser.username !== claims.username ||
    currentUser.role !== claims.role ||
    currentSessionVersion !== claims.sessionVersion
  ) {
    res.status(401).json({ error: 'This session has been revoked. Log in again.' });
    return;
  }
  if (!readOnly && claims.role === 'viewer') {
    res.status(403).json({ error: 'Your role is read-only and cannot perform this action.' });
    return;
  }
  (req as express.Request & { user?: unknown }).user = claims;
  return next();
};

export const accessControlStatus = (
  userCount: number,
  operatorToken: string | undefined,
): { status: 'available' | 'unavailable'; reason: string } => {
  const mode = resolveAccessMode(userCount, operatorToken);
  if (mode === 'multi_user') {
    return {
      status: 'available',
      reason: `Multi-user access control is active with ${userCount} account(s); authoritative kernel reads and all mutations require a role-scoped session token.`,
    };
  }
  if (mode === 'operator_token') {
    return { status: 'available', reason: 'Authoritative kernel reads and all mutations require the shared operator bearer token.' };
  }
  return { status: 'unavailable', reason: 'No accounts or operator token configured; kernel reads and mutations are open on loopback.' };
};

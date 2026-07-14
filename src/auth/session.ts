import crypto from 'node:crypto';
import type { UserRole } from './users';

export interface SessionClaims {
  userId: string;
  username: string;
  role: UserRole;
  sessionVersion: number;
  exp: number;
}

const base64url = (input: Buffer | string): string => (
  Buffer.from(input).toString('base64url')
);

const sign = (payload: string, secret: string): string => (
  crypto.createHmac('sha256', secret).update(payload).digest('base64url')
);

/**
 * Issues a stateless signed session token: base64url(claims).base64url(hmac).
 * No server-side session state; expiry and integrity are carried in the token.
 */
export const issueSession = (
  claims: Omit<SessionClaims, 'exp'>,
  ttlMs: number,
  secret: string,
  now = Date.now(),
): string => {
  const full: SessionClaims = { ...claims, exp: now + ttlMs };
  const payload = base64url(JSON.stringify(full));
  return `${payload}.${sign(payload, secret)}`;
};

export const verifySession = (
  token: string,
  secret: string,
  now = Date.now(),
): SessionClaims | undefined => {
  const parts = token.split('.');
  if (parts.length !== 2) return undefined;
  const [payload, signature] = parts;
  const expected = sign(payload, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as SessionClaims;
    if (typeof claims.exp !== 'number' || claims.exp <= now) return undefined;
    if (
      typeof claims.userId !== 'string' ||
      typeof claims.username !== 'string' ||
      !['admin', 'operator', 'viewer'].includes(claims.role) ||
      !Number.isSafeInteger(claims.sessionVersion) ||
      claims.sessionVersion < 0
    ) return undefined;
    return claims;
  } catch {
    return undefined;
  }
};

/** A per-process session-signing secret when none is configured. */
export const resolveSessionSecret = (configured: string | undefined): string => (
  configured?.trim() ? configured.trim() : crypto.randomBytes(32).toString('hex')
);

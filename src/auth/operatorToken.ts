import crypto from 'node:crypto';
import type express from 'express';

export interface OperatorTokenStatus {
  status: 'available' | 'unavailable';
  reason: string;
}

const timingSafeEqual = (a: string, b: string): boolean => {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return crypto.timingSafeEqual(bufferA, bufferB);
};

/**
 * Optional operator bearer-token guard for mutating requests. When no token
 * is configured the guard is a no-op (loopback single-user default). When a
 * token is set, every non-GET request must present a matching bearer token;
 * GET reads stay open so the local dashboard keeps working.
 */
export const createOperatorTokenGuard = (token: string | undefined): express.RequestHandler => {
  const configured = token?.trim();
  return (req, res, next) => {
    if (!configured) return next();
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();

    const header = req.header('authorization') ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match || !timingSafeEqual(match[1], configured)) {
      res.status(401).json({ error: 'A valid operator bearer token is required for this request.' });
      return;
    }
    return next();
  };
};

export const operatorTokenStatus = (token: string | undefined): OperatorTokenStatus => (
  token?.trim()
    ? { status: 'available', reason: 'Mutating requests require a matching operator bearer token.' }
    : { status: 'unavailable', reason: 'No operator API token is configured; mutating requests are open on loopback.' }
);

import type express from 'express';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const hostName = (host: string | undefined): string | undefined => {
  if (!host) return undefined;
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return undefined;
  }
};

const isRead = (method: string): boolean => method === 'GET' || method === 'HEAD' || method === 'OPTIONS';

/**
 * Rejects DNS-rebinding and cross-site browser requests before they reach any
 * API handler. Native/CLI clients may omit Origin, but their Host header must
 * still resolve to an explicit loopback name.
 */
export const createLoopbackRequestGuard = (): express.RequestHandler => (req, res, next) => {
  const requestHost = req.header('host');
  const requestHostname = hostName(requestHost);
  if (!requestHostname || !LOOPBACK_HOSTS.has(requestHostname)) {
    res.status(403).json({ error: 'Only explicit loopback Host headers are accepted.' });
    return;
  }

  const fetchSite = req.header('sec-fetch-site');
  if (fetchSite === 'cross-site') {
    res.status(403).json({ error: 'Cross-site browser requests are not accepted.' });
    return;
  }

  const origin = req.header('origin');
  if (origin && !isRead(req.method)) {
    try {
      const parsed = new URL(origin);
      if (!LOOPBACK_HOSTS.has(parsed.hostname) || parsed.host !== requestHost) {
        res.status(403).json({ error: 'Request Origin does not match the loopback server.' });
        return;
      }
    } catch {
      res.status(403).json({ error: 'Request Origin is invalid.' });
      return;
    }
  }

  next();
};

export const createSecurityHeaders = (
  options: { allowViteDevelopment?: boolean } = {},
): express.RequestHandler => (_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    options.allowViteDevelopment
      ? "default-src 'self'; connect-src 'self' ws:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
      : "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  next();
};

export const securityHeaders = createSecurityHeaders();

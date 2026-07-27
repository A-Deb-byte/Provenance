import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createLoopbackRequestGuard,
  createSecurityHeaders,
  securityHeaders,
} from './loopbackGuard';

describe('loopback request guard', () => {
  let server: ReturnType<express.Express['listen']>;
  let url = '';

  const rawStatus = (headers: Record<string, string>): Promise<number> => new Promise((resolve, reject) => {
    const request = http.request(`${url}/api/read`, { headers }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode ?? 0));
    });
    request.on('error', reject);
    request.end();
  });

  beforeEach(async () => {
    const app = express();
    app.use(securityHeaders, createLoopbackRequestGuard());
    app.post('/api/write', (_req, res) => res.json({ ok: true }));
    app.get('/api/read', (_req, res) => res.json({ ok: true }));
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it('allows explicit loopback hosts and emits security headers', async () => {
    const response = await fetch(`${url}/api/read`);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });

  it('rejects DNS-rebinding hosts and cross-site fetch metadata', async () => {
    expect(await rawStatus({ host: 'attacker.example' })).toBe(403);
    const crossSite = await fetch(`${url}/api/write`, {
      method: 'POST',
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(crossSite.status).toBe(403);
  });

  it('requires a matching loopback Origin for browser mutations', async () => {
    const port = (server.address() as AddressInfo).port;
    const allowed = await fetch(`${url}/api/write`, {
      method: 'POST', headers: { origin: `http://127.0.0.1:${port}` },
    });
    expect(allowed.status).toBe(200);
    const denied = await fetch(`${url}/api/write`, {
      method: 'POST', headers: { origin: 'https://attacker.example' },
    });
    expect(denied.status).toBe(403);
  });

  it('grants CSP connect authority only to one exact native mount origin', async () => {
    const mountOrigin = 'http://127.0.0.1:43124';
    const headers = createSecurityHeaders({ nativeAcceptanceMountOrigin: mountOrigin });
    const mountedApp = express();
    mountedApp.use(headers);
    mountedApp.get('/', (_req, res) => res.json({ ok: true }));
    const mountedServer = await new Promise<ReturnType<express.Express['listen']>>((resolve) => {
      const listening = mountedApp.listen(0, '127.0.0.1', () => resolve(listening));
    });
    try {
      const mountedUrl = `http://127.0.0.1:${(mountedServer.address() as AddressInfo).port}`;
      const response = await fetch(mountedUrl);
      expect(response.headers.get('content-security-policy'))
        .toContain(`connect-src 'self' ${mountOrigin};`);
    } finally {
      await new Promise<void>((resolve, reject) => {
        mountedServer.close((error) => error ? reject(error) : resolve());
      });
    }
    expect(() => createSecurityHeaders({
      nativeAcceptanceMountOrigin: 'http://127.0.0.1:43124/path',
    })).toThrow(/exact IPv4 loopback/u);
    expect(() => createSecurityHeaders({
      nativeAcceptanceMountOrigin: 'http://localhost:43124',
    })).toThrow(/exact IPv4 loopback/u);
  });
});

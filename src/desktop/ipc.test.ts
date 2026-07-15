import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createDesktopBridgeClient,
  isLoopbackDesktopBridgeUrl,
  signDesktopBridgeRequest,
  signDesktopBridgeResponse,
} from './ipc';

const token = 't'.repeat(64);
const requestId = 'request-fixed';
const issuedAt = 1_750_000_000_000;

const signedResponse = (body: unknown, status = 200): Response => {
  const text = JSON.stringify(body);
  const hash = crypto.createHash('SHA-256').update(text).digest('hex');
  return new Response(text, {
    status,
    headers: {
      'content-type': 'application/json',
      'x-provenance-response-sha256': hash,
      'x-provenance-response-signature': signDesktopBridgeResponse(token, requestId, status, hash),
    },
  });
};

describe('desktop bridge IPC client', () => {
  it('accepts only explicit loopback HTTP origins', () => {
    expect(isLoopbackDesktopBridgeUrl('http://127.0.0.1:43123/')).toBe(true);
    expect(isLoopbackDesktopBridgeUrl('http://[::1]:43123/')).toBe(true);
    expect(isLoopbackDesktopBridgeUrl('https://127.0.0.1:43123/')).toBe(false);
    expect(isLoopbackDesktopBridgeUrl('http://localhost:43123/')).toBe(false);
    expect(isLoopbackDesktopBridgeUrl('http://127.0.0.1:43123/path')).toBe(false);
    expect(isLoopbackDesktopBridgeUrl('http://127.0.0.1/')).toBe(false);
  });

  it('HMAC-authenticates a health request and verifies the signed response', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => signedResponse({
      schemaVersion: 1,
      status: 'ok',
      hostInstanceId: 'host_1',
      platform: 'windows',
      capabilities: ['desktop.discover', 'desktop.inspect'],
      allowedAppIds: ['notepad'],
    }));
    const client = createDesktopBridgeClient({
      baseUrl: 'http://127.0.0.1:43123/',
      token,
      fetchImpl: fetchImpl as typeof fetch,
      now: () => issuedAt,
      randomId: () => requestId,
    });

    await expect(client.health()).resolves.toMatchObject({ status: 'ok', hostInstanceId: 'host_1' });
    const init = fetchImpl.mock.calls[0][1]!;
    const headers = new Headers(init.headers);
    const emptyHash = crypto.createHash('SHA-256').update('').digest('hex');
    expect(headers.get('x-provenance-content-sha256')).toBe(emptyHash);
    expect(headers.get('x-provenance-signature')).toBe(signDesktopBridgeRequest(token, {
      method: 'GET',
      path: '/v1/health',
      requestId,
      issuedAt,
      expiresAt: issuedAt + 2_000,
      contentHash: emptyHash,
    }));
  });

  it('rejects unsigned, forged, oversized, and invalid bridge responses', async () => {
    const unsigned = createDesktopBridgeClient({
      baseUrl: 'http://127.0.0.1:43123/', token,
      fetchImpl: vi.fn(async () => new Response('{}')) as typeof fetch,
      now: () => issuedAt, randomId: () => requestId,
    });
    await expect(unsigned.health()).rejects.toThrow(/authentication/);

    const invalidSchema = createDesktopBridgeClient({
      baseUrl: 'http://127.0.0.1:43123/', token,
      fetchImpl: vi.fn(async () => signedResponse({ status: 'ok' })) as typeof fetch,
      now: () => issuedAt, randomId: () => requestId,
    });
    await expect(invalidSchema.health()).rejects.toThrow(/schema/);
  });

  it('preserves a signed stale-tree result returned with conflict status', async () => {
    const client = createDesktopBridgeClient({
      baseUrl: 'http://127.0.0.1:43123/', token,
      fetchImpl: vi.fn(async () => signedResponse({
        schemaVersion: 1,
        status: 'failed',
        sourceRef: 'desktop:notepad/window_1',
        summary: 'The live UI tree changed before dispatch.',
        errorCode: 'stale_tree',
      }, 409)) as typeof fetch,
      now: () => issuedAt, randomId: () => requestId,
    });
    await expect(client.perform({
      type: 'desktop.click', appId: 'notepad', windowId: 'window_1',
      treeRevision: 'a'.repeat(64), nodeId: 'b'.repeat(64),
    }, { timeoutMs: 2_000 })).resolves.toMatchObject({ status: 'failed', errorCode: 'stale_tree' });
  });

  it('sends only the hash-bound native type contract and accepts an uncertain result', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => signedResponse({
      schemaVersion: 1,
      status: 'uncertain',
      sourceRef: 'desktop:notepad/window_1',
      summary: 'The mutation may have completed but re-observation failed.',
      errorCode: 'desktop_outcome_uncertain',
    }, 409));
    const client = createDesktopBridgeClient({
      baseUrl: 'http://127.0.0.1:43123/', token,
      fetchImpl: fetchImpl as typeof fetch,
      now: () => issuedAt, randomId: () => requestId,
    });
    const payloadHash = crypto.createHash('sha256').update('transient text').digest('hex');

    await expect(client.perform({
      type: 'desktop.type', appId: 'notepad', windowId: 'window_1',
      treeRevision: 'a'.repeat(64), nodeId: 'b'.repeat(64),
      payloadArtifactId: 'artifact_private', payloadHash,
    }, { timeoutMs: 2_000, payloadText: 'transient text' }))
      .resolves.toMatchObject({ status: 'uncertain', errorCode: 'desktop_outcome_uncertain' });

    const sent = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(sent.action).toEqual({
      type: 'desktop.type', appId: 'notepad', windowId: 'window_1',
      treeRevision: 'a'.repeat(64), nodeId: 'b'.repeat(64), payloadHash,
    });
    expect(sent.action).not.toHaveProperty('payloadArtifactId');
  });

  it('never permits a remote URL or a weak transport token', () => {
    expect(() => createDesktopBridgeClient({ baseUrl: 'http://example.com:80/', token }))
      .toThrow(/loopback/);
    expect(() => createDesktopBridgeClient({ baseUrl: 'http://127.0.0.1:43123/', token: 'short' }))
      .toThrow(/32/);
  });
});

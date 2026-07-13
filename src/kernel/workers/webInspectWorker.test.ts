import { describe, expect, it, vi } from 'vitest';
import { browserIntent } from '../../capabilities/testFixtures';
import { createWebInspectWorker, FetchLike } from './webInspectWorker';

const htmlResponse = (status: number, body: string, url = 'https://example.com/account') => ({
  status,
  url,
  text: async () => body,
});

describe('web inspect worker', () => {
  it('inspects a page and returns bounded stripped text', async () => {
    const fetchMock = vi.fn(async () => htmlResponse(
      200,
      '<html><head><style>body{}</style></head><body><script>steal()</script><h1>Account</h1><p>Balance page</p></body></html>',
    ));
    const worker = createWebInspectWorker({ fetch: fetchMock as unknown as FetchLike });

    const result = await worker.execute(browserIntent(), { timeoutMs: 5000 });

    expect(result.status).toBe('succeeded');
    expect(result.content).toBe('Account Balance page');
    expect(result.content).not.toContain('steal');
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, { redirect: string }];
    expect(init.redirect).toBe('manual');
  });

  it('blocks redirects instead of following them', async () => {
    const worker = createWebInspectWorker({
      fetch: vi.fn(async () => htmlResponse(302, '')) as unknown as FetchLike,
    });

    const result = await worker.execute(browserIntent(), { timeoutMs: 5000 });
    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('redirect_blocked');
  });

  it('refuses non-inspect actions and off-origin urls', async () => {
    const fetchMock = vi.fn();
    const worker = createWebInspectWorker({ fetch: fetchMock as unknown as FetchLike });

    const wrongAction = await worker.execute(browserIntent({
      action: { type: 'browser.navigate', origin: 'https://example.com', url: 'https://example.com/a' },
    }), { timeoutMs: 5000 });
    const wrongOrigin = await worker.execute(browserIntent({
      action: { type: 'browser.inspect', origin: 'https://example.com', url: 'https://attacker.invalid/a' },
    }), { timeoutMs: 5000 });

    expect(wrongAction.errorCode).toBe('not_inspect');
    expect(wrongOrigin.errorCode).toBe('origin_mismatch');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports timeouts as failed dispatches', async () => {
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    const worker = createWebInspectWorker({
      fetch: vi.fn(async () => {
        throw abortError;
      }) as unknown as FetchLike,
    });

    const result = await worker.execute(browserIntent(), { timeoutMs: 1000 });
    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('timeout');
  });
});

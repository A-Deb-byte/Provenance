import { describe, expect, it, vi } from 'vitest';
import { browserIntent } from '../../capabilities/testFixtures';
import { createWebInspectWorker, FetchLike } from './webInspectWorker';

const responseHeaders = (values: Record<string, string>) => ({
  get: (name: string) => values[name.toLowerCase()] ?? null,
});

const htmlResponse = (
  status: number,
  body: string,
  url = 'https://example.com/account',
  headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8' },
) => ({
  status,
  url,
  headers: responseHeaders(headers),
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

  it('rejects a successful response whose final URL drifts outside the authorized origin', async () => {
    const text = vi.fn(async () => 'must not be read');
    const worker = createWebInspectWorker({
      fetch: vi.fn(async () => ({
        ...htmlResponse(200, '', 'https://attacker.invalid/landing'),
        text,
      })) as unknown as FetchLike,
    });

    const result = await worker.execute(browserIntent(), { timeoutMs: 5000 });

    expect(result).toMatchObject({ status: 'failed', errorCode: 'origin_mismatch' });
    expect(result.sourceRef).toBe('https://attacker.invalid/landing');
    expect(text).not.toHaveBeenCalled();
  });

  it.each([
    'text/html; charset=utf-8',
    'text/plain',
    'application/xhtml+xml',
  ])('accepts the permitted content type %s', async (contentType) => {
    const worker = createWebInspectWorker({
      fetch: vi.fn(async () => htmlResponse(200, '<p>Allowed</p>', undefined, {
        'content-type': contentType,
      })) as unknown as FetchLike,
    });

    const result = await worker.execute(browserIntent(), { timeoutMs: 5000 });

    expect(result).toMatchObject({ status: 'succeeded', content: 'Allowed' });
  });

  it('rejects missing and unsupported content types without reading the body', async () => {
    for (const headers of [{}, { 'content-type': 'application/json' }]) {
      const text = vi.fn(async () => '{"unsafe":true}');
      const worker = createWebInspectWorker({
        fetch: vi.fn(async () => ({ ...htmlResponse(200, '', undefined, headers), text })) as unknown as FetchLike,
      });

      const result = await worker.execute(browserIntent(), { timeoutMs: 5000 });

      expect(result.errorCode).toBe('unsupported_content_type');
      expect(text).not.toHaveBeenCalled();
    }
  });

  it('rejects an oversized declared content length before reading the body', async () => {
    const text = vi.fn(async () => 'must not be read');
    const worker = createWebInspectWorker({
      maxResponseBytes: 8,
      fetch: vi.fn(async () => ({
        ...htmlResponse(200, '', undefined, {
          'content-type': 'text/plain',
          'content-length': '9',
        }),
        text,
      })) as unknown as FetchLike,
    });

    const result = await worker.execute(browserIntent(), { timeoutMs: 5000 });

    expect(result.errorCode).toBe('response_too_large');
    expect(result.summary).toContain('8-byte');
    expect(text).not.toHaveBeenCalled();
  });

  it('streams response bytes and cancels the reader as soon as the byte limit is exceeded', async () => {
    const encoder = new TextEncoder();
    const chunks = [encoder.encode('1234'), encoder.encode('56789')];
    const cancel = vi.fn(async () => undefined);
    const text = vi.fn(async () => 'must not use the text fallback');
    const worker = createWebInspectWorker({
      maxResponseBytes: 8,
      fetch: vi.fn(async () => ({
        ...htmlResponse(200, ''),
        body: {
          getReader: () => ({
            read: async () => chunks.length > 0
              ? { done: false, value: chunks.shift() }
              : { done: true },
            cancel,
          }),
        },
        text,
      })) as unknown as FetchLike,
    });

    const result = await worker.execute(browserIntent(), { timeoutMs: 5000 });

    expect(result.errorCode).toBe('response_too_large');
    expect(cancel).toHaveBeenCalledOnce();
    expect(text).not.toHaveBeenCalled();
  });

  it('decodes a bounded streaming response without using the text fallback', async () => {
    const encoder = new TextEncoder();
    const chunks = [encoder.encode('<p>Streamed '), encoder.encode('page</p>')];
    const text = vi.fn(async () => 'must not use the text fallback');
    const worker = createWebInspectWorker({
      maxResponseBytes: 64,
      fetch: vi.fn(async () => ({
        ...htmlResponse(200, ''),
        body: {
          getReader: () => ({
            read: async () => chunks.length > 0
              ? { done: false, value: chunks.shift() }
              : { done: true },
          }),
        },
        text,
      })) as unknown as FetchLike,
    });

    const result = await worker.execute(browserIntent(), { timeoutMs: 5000 });

    expect(result).toMatchObject({ status: 'succeeded', content: 'Streamed page' });
    expect(text).not.toHaveBeenCalled();
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

  it('forwards an external cancellation signal and distinguishes it from timeout', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn((_input: string, init?: { signal?: AbortSignal }) => new Promise<never>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('cancelled');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }));
    const worker = createWebInspectWorker({ fetch: fetchMock as unknown as FetchLike });

    const pending = worker.execute(browserIntent(), { timeoutMs: 5000, signal: controller.signal });
    controller.abort();
    const result = await pending;

    expect(result).toMatchObject({ status: 'failed', errorCode: 'cancelled' });
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
});

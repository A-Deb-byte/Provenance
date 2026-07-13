import { describe, expect, it, vi } from 'vitest';
import { browserIntent } from '../../capabilities/testFixtures';
import { buildBrowserWriteWorkerRegistration } from '../autonomy';
import { isWorkerRegistration } from '../../capabilities/validators';
import { BrowserDriver, createBrowserWorker } from './browserWorker';

const fakeDriver = (over: Partial<BrowserDriver> = {}): BrowserDriver => ({
  isAvailable: async () => true,
  perform: async (request) => ({
    status: 'succeeded',
    finalUrl: request.url,
    content: 'Account dashboard for the signed-in user.',
  }),
  close: async () => undefined,
  ...over,
});

describe('browser write worker', () => {
  it('performs a navigate action and returns observed page text', async () => {
    const perform = vi.fn(fakeDriver().perform);
    const worker = createBrowserWorker(fakeDriver({ perform }));

    const result = await worker.execute(browserIntent({
      action: { type: 'browser.navigate', origin: 'https://example.com', url: 'https://example.com/account' },
    }), { timeoutMs: 10000 });

    expect(result.status).toBe('succeeded');
    expect(result.content).toContain('signed-in user');
    expect(perform).toHaveBeenCalledOnce();
    expect(perform.mock.calls[0][0].type).toBe('browser.navigate');
  });

  it('performs a click action with its selector', async () => {
    const perform = vi.fn(fakeDriver().perform);
    const worker = createBrowserWorker(fakeDriver({ perform }));

    await worker.execute(browserIntent({
      action: {
        type: 'browser.click',
        origin: 'https://example.com',
        url: 'https://example.com/account',
        selector: '#logout',
      },
    }), { timeoutMs: 10000 });

    expect(perform.mock.calls[0][0]).toMatchObject({ type: 'browser.click', selector: '#logout' });
  });

  it('rejects off-origin URLs before touching the driver', async () => {
    const perform = vi.fn(fakeDriver().perform);
    const worker = createBrowserWorker(fakeDriver({ perform }));

    const result = await worker.execute(browserIntent({
      action: { type: 'browser.navigate', origin: 'https://example.com', url: 'https://evil.invalid/x' },
    }), { timeoutMs: 10000 });

    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('origin_mismatch');
    expect(perform).not.toHaveBeenCalled();
  });

  it('rejects action types it does not support (e.g. inspect-only fixtures aside)', async () => {
    const worker = createBrowserWorker(fakeDriver());
    const result = await worker.execute(browserIntent({
      action: { type: 'browser.download', origin: 'https://example.com', url: 'https://example.com/f', downloadRoot: 'C:\\d', fileName: 'a.txt' },
    } as never), { timeoutMs: 10000 });

    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('unsupported_action');
  });

  it('surfaces driver failures with their error code', async () => {
    const worker = createBrowserWorker(fakeDriver({
      perform: async (request) => ({ status: 'failed', finalUrl: request.url, content: '', errorCode: 'timeout' }),
    }));
    const result = await worker.execute(browserIntent({
      action: { type: 'browser.navigate', origin: 'https://example.com', url: 'https://example.com/slow' },
    }), { timeoutMs: 10000 });

    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('timeout');
  });
});

describe('browser write worker registration', () => {
  it('builds a valid available registration from an origin allowlist', () => {
    const reg = buildBrowserWriteWorkerRegistration('https://example.com, https://docs.example.com');
    expect(reg).toBeDefined();
    expect(isWorkerRegistration(reg)).toBe(true);
    expect(reg?.availability).toBe('available');
    expect(reg?.supportedActions).toContain('browser.click');
  });

  it('returns undefined when no valid origins are configured', () => {
    expect(buildBrowserWriteWorkerRegistration('')).toBeUndefined();
    expect(buildBrowserWriteWorkerRegistration('not-an-origin')).toBeUndefined();
  });
});

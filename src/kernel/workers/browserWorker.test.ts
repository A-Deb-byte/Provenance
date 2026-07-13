import { describe, expect, it, vi } from 'vitest';
import { browserIntent } from '../../capabilities/testFixtures';
import { buildBrowserWriteWorkerRegistration } from '../autonomy';
import { isWorkerRegistration } from '../../capabilities/validators';
import { hashArtifactContent } from '../artifacts/artifactStore';
import { ArtifactResolver, BrowserDriver, createBrowserWorker } from './browserWorker';

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

describe('browser write worker: text entry', () => {
  const typeIntent = (payloadHash: string) => browserIntent({
    action: {
      type: 'browser.type',
      origin: 'https://example.com',
      url: 'https://example.com/login',
      selector: '#password',
      payloadArtifactId: 'artifact_abc',
      payloadHash,
    },
  } as never);

  it('resolves the staged payload, verifies the hash, and types it without echoing the value', async () => {
    const secret = 'my-staged-password';
    const hash = hashArtifactContent(secret);
    const perform = vi.fn(fakeDriver().perform);
    const resolver: ArtifactResolver = async () => ({ content: secret, contentHash: hash });
    const worker = createBrowserWorker(fakeDriver({ perform }), resolver);

    const result = await worker.execute(typeIntent(hash), { timeoutMs: 10000 });

    expect(result.status).toBe('succeeded');
    expect(perform.mock.calls[0][0]).toMatchObject({ type: 'browser.type', selector: '#password', text: secret });
    // The typed value must never appear in the summary/observation.
    expect(result.summary).not.toContain(secret);
    expect(result.summary).toContain('chars entered into #password');
  });

  it('refuses when the payload hash does not match the artifact', async () => {
    const resolver: ArtifactResolver = async () => ({ content: 'actual', contentHash: hashArtifactContent('actual') });
    const worker = createBrowserWorker(fakeDriver(), resolver);
    const result = await worker.execute(typeIntent(hashArtifactContent('claimed-different')), { timeoutMs: 10000 });
    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('payload_hash_mismatch');
  });

  it('refuses when the artifact is missing or no store is configured', async () => {
    const missing = createBrowserWorker(fakeDriver(), async () => undefined);
    expect((await missing.execute(typeIntent('a'.repeat(64)), { timeoutMs: 10000 })).errorCode).toBe('artifact_not_found');

    const noStore = createBrowserWorker(fakeDriver());
    expect((await noStore.execute(typeIntent('a'.repeat(64)), { timeoutMs: 10000 })).errorCode).toBe('no_artifact_store');
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

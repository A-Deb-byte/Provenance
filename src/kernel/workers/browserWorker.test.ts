import { describe, expect, it, vi } from 'vitest';
import { authorizeCapabilityDispatch } from '../../capabilities/dispatch';
import { createCapabilityGrant } from '../../capabilities/grants';
import { createMemoryCapabilityGrantStore } from '../../capabilities/grantStore';
import { browserIntent } from '../../capabilities/testFixtures';
import type { ActionIntent, BrowserAction, BrowserCapabilityScope, WorkerRegistration } from '../../capabilities/types';
import { buildBrowserWriteWorkerRegistration } from '../autonomy';
import { isWorkerRegistration } from '../../capabilities/validators';
import { hashArtifactContent } from '../artifacts/artifactStore';
import { ArtifactResolver, BrowserDriver, createBrowserWorker, createPlaywrightDriver } from './browserWorker';

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

let grantSequence = 0;

const authorize = async (rawIntent: ActionIntent) => {
  const action = rawIntent.action as BrowserAction;
  const scope: BrowserCapabilityScope = {
    family: 'browser',
    operations: [action.type],
    origins: [action.origin],
    downloadRoots: action.type === 'browser.download' ? [action.downloadRoot] : [],
  };
  const intent: ActionIntent = { ...rawIntent, riskLevel: 'L2', scope };
  const registration: WorkerRegistration = {
    id: intent.workerId,
    family: 'browser',
    availability: 'available',
    supportedActions: [action.type],
    configuredScopes: [scope],
    registeredAt: '2026-07-12T00:00:00.000Z',
  };
  grantSequence += 1;
  const grant = createCapabilityGrant(intent, {
    id: `grant_browser_${grantSequence}`,
    issuedAt: '2026-07-12T00:02:00.000Z',
    expiresAt: '2026-07-12T00:12:00.000Z',
    maxOps: 1,
    approvalId: `approval_browser_${grantSequence}`,
  });
  const store = createMemoryCapabilityGrantStore([grant]);
  const result = await authorizeCapabilityDispatch(store, grant.id, intent, registration, {
    now: '2026-07-12T00:03:00.000Z', operationsUsed: 1,
  });
  if (!result.allowed || !result.authorization) throw new Error(result.reason);
  return { intent, options: { timeoutMs: 10000, authorization: result.authorization } };
};

describe('browser write worker', () => {
  it('performs a navigate action and returns observed page text', async () => {
    const perform = vi.fn(fakeDriver().perform);
    const worker = createBrowserWorker(fakeDriver({ perform }));

    const dispatch = await authorize(browserIntent({
      action: { type: 'browser.navigate', origin: 'https://example.com', url: 'https://example.com/account' },
    }));
    const result = await worker.execute(dispatch.intent, dispatch.options);

    expect(result.status).toBe('succeeded');
    expect(result.content).toContain('signed-in user');
    expect(perform).toHaveBeenCalledOnce();
    expect(perform.mock.calls[0][0].type).toBe('browser.navigate');
  });

  it('performs a click action with its selector', async () => {
    const perform = vi.fn(fakeDriver().perform);
    const worker = createBrowserWorker(fakeDriver({ perform }));

    const dispatch = await authorize(browserIntent({
      action: {
        type: 'browser.click',
        origin: 'https://example.com',
        url: 'https://example.com/account',
        selector: '#logout',
      },
    }));
    await worker.execute(dispatch.intent, dispatch.options);

    expect(perform.mock.calls[0][0]).toMatchObject({ type: 'browser.click', selector: '#logout' });
  });

  it('requires a persisted pre-dispatch authorization before touching the driver', async () => {
    const perform = vi.fn(fakeDriver().perform);
    const worker = createBrowserWorker(fakeDriver({ perform }));

    const result = await worker.execute(browserIntent({
      action: { type: 'browser.navigate', origin: 'https://example.com', url: 'https://example.com/x' },
    }), { timeoutMs: 10000 });

    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('authorization_invalid');
    expect(perform).not.toHaveBeenCalled();
  });

  it('rejects action types it does not support (e.g. inspect-only fixtures aside)', async () => {
    const worker = createBrowserWorker(fakeDriver());
    const dispatch = await authorize(browserIntent({
      action: { type: 'browser.download', origin: 'https://example.com', url: 'https://example.com/f', downloadRoot: 'C:\\d', fileName: 'a.txt' },
    } as never));
    const result = await worker.execute(dispatch.intent, dispatch.options);

    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('unsupported_action');
  });

  it('surfaces driver failures with their error code', async () => {
    const worker = createBrowserWorker(fakeDriver({
      perform: async (request) => ({ status: 'failed', finalUrl: request.url, content: '', errorCode: 'timeout' }),
    }));
    const dispatch = await authorize(browserIntent({
      action: { type: 'browser.navigate', origin: 'https://example.com', url: 'https://example.com/slow' },
    }));
    const result = await worker.execute(dispatch.intent, dispatch.options);

    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('timeout');
  });

  it('fails closed when even an injected driver reports an off-origin final URL', async () => {
    const worker = createBrowserWorker(fakeDriver({
      perform: async () => ({ status: 'succeeded', finalUrl: 'https://evil.invalid/', content: 'secret page' }),
    }));
    const dispatch = await authorize(browserIntent({
      action: { type: 'browser.navigate', origin: 'https://example.com', url: 'https://example.com/start' },
    }));
    const result = await worker.execute(dispatch.intent, dispatch.options);
    expect(result).toMatchObject({ status: 'failed', errorCode: 'origin_drift' });
    expect(result.content).toBeUndefined();
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

    const dispatch = await authorize(typeIntent(hash));
    const result = await worker.execute(dispatch.intent, dispatch.options);

    expect(result.status).toBe('succeeded');
    expect(perform.mock.calls[0][0]).toMatchObject({ type: 'browser.type', selector: '#password', text: secret });
    // The typed value must never appear in the summary/observation.
    expect(result.summary).not.toContain(secret);
    expect(result.summary).toContain('chars entered into #password');
  });

  it('refuses when the payload hash does not match the artifact', async () => {
    const resolver: ArtifactResolver = async () => ({ content: 'actual', contentHash: hashArtifactContent('actual') });
    const worker = createBrowserWorker(fakeDriver(), resolver);
    const dispatch = await authorize(typeIntent(hashArtifactContent('claimed-different')));
    const result = await worker.execute(dispatch.intent, dispatch.options);
    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('payload_hash_mismatch');
  });

  it('refuses when the artifact is missing or no store is configured', async () => {
    const missing = createBrowserWorker(fakeDriver(), async () => undefined);
    const missingDispatch = await authorize(typeIntent('a'.repeat(64)));
    expect((await missing.execute(missingDispatch.intent, missingDispatch.options)).errorCode).toBe('artifact_not_found');

    const noStore = createBrowserWorker(fakeDriver());
    const noStoreDispatch = await authorize(typeIntent('a'.repeat(64)));
    expect((await noStore.execute(noStoreDispatch.intent, noStoreDispatch.options)).errorCode).toBe('no_artifact_store');
  });
});

describe('Playwright driver origin confinement', () => {
  const createDriver = (page: {
    goto: ReturnType<typeof vi.fn>;
    click: ReturnType<typeof vi.fn>;
    fill: ReturnType<typeof vi.fn>;
    url: () => string;
    innerText: ReturnType<typeof vi.fn>;
  }) => createPlaywrightDriver({
    userDataDir: 'unused-in-injected-test',
    moduleLoader: async () => ({
      chromium: {
        executablePath: () => process.execPath,
        launchPersistentContext: async () => ({ pages: () => [page], newPage: async () => page, close: async () => undefined }),
      },
    }) as never,
  });

  it('rejects a redirect before clicking', async () => {
    let currentUrl = 'about:blank';
    const page = {
      goto: vi.fn(async () => { currentUrl = 'https://evil.invalid/redirected'; }),
      click: vi.fn(async () => undefined),
      fill: vi.fn(async () => undefined),
      url: () => currentUrl,
      innerText: vi.fn(async () => ''),
    };
    const result = await createDriver(page).perform({
      type: 'browser.click', origin: 'https://example.com', url: 'https://example.com/account', selector: '#ok', timeoutMs: 1000,
    });
    expect(result).toMatchObject({ status: 'failed', errorCode: 'origin_drift', finalUrl: 'https://evil.invalid/redirected' });
    expect(page.click).not.toHaveBeenCalled();
  });

  it('rejects origin drift caused by click or type after the operation', async () => {
    for (const type of ['browser.click', 'browser.type'] as const) {
      let currentUrl = 'https://example.com/account';
      const drift = async () => { currentUrl = 'https://evil.invalid/after-action'; };
      const page = {
        goto: vi.fn(async (url: string) => { currentUrl = url; }),
        click: vi.fn(type === 'browser.click' ? drift : async () => undefined),
        fill: vi.fn(type === 'browser.type' ? drift : async () => undefined),
        url: () => currentUrl,
        innerText: vi.fn(async () => 'must not be read'),
      };
      const result = await createDriver(page).perform({
        type, origin: 'https://example.com', url: 'https://example.com/account', selector: '#field', text: 'value', timeoutMs: 1000,
      });
      expect(result).toMatchObject({ status: 'failed', errorCode: 'origin_drift' });
      expect(page.innerText).not.toHaveBeenCalled();
    }
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

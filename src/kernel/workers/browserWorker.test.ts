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
    const controller = new AbortController();

    const dispatch = await authorize(browserIntent({
      action: { type: 'browser.navigate', origin: 'https://example.com', url: 'https://example.com/account' },
    }));
    const result = await worker.execute(dispatch.intent, { ...dispatch.options, signal: controller.signal });

    expect(result.status).toBe('succeeded');
    expect(result.content).toContain('signed-in user');
    expect(perform).toHaveBeenCalledOnce();
    expect(perform.mock.calls[0][0].type).toBe('browser.navigate');
    expect(perform.mock.calls[0][1]?.signal).toBe(controller.signal);
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
  interface TestDownload {
    cancel: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  }

  interface TestPage {
    goto: ReturnType<typeof vi.fn>;
    click: ReturnType<typeof vi.fn>;
    fill: ReturnType<typeof vi.fn>;
    on?: (event: 'download', listener: (download: TestDownload) => void) => void;
    url: () => string;
    innerText: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }

  const createHarness = (initialPage: TestPage) => {
    let routeHandler: ((route: never, request: never) => Promise<void>) | undefined;
    let pageListener: ((page: TestPage) => void) | undefined;
    let launchOptions: unknown;
    const downloadListeners = new WeakMap<TestPage, (download: TestDownload) => void>();
    const preparePage = (page: TestPage): TestPage => {
      page.on ??= vi.fn((_event: 'download', listener: (download: TestDownload) => void) => {
        downloadListeners.set(page, listener);
      });
      return page;
    };
    const pages = [preparePage(initialPage)];
    const contextClose = vi.fn(async () => undefined);
    const context = {
      pages: () => pages,
      newPage: vi.fn(async () => preparePage(initialPage)),
      route: vi.fn(async (_url: string, handler: typeof routeHandler) => { routeHandler = handler; }),
      on: vi.fn((_event: 'page', listener: typeof pageListener) => { pageListener = listener; }),
      close: contextClose,
    };
    const driver = createPlaywrightDriver({
      userDataDir: 'unused-in-injected-test',
      moduleLoader: async () => ({
        chromium: {
          executablePath: () => process.execPath,
          launchPersistentContext: async (_userDataDir: string, options: unknown) => {
            launchOptions = options;
            return context;
          },
        },
      }) as never,
    });
    const requestDocument = async (page: TestPage, url: string) => {
      if (!routeHandler) throw new Error('Route policy is not installed.');
      const abort = vi.fn(async () => undefined);
      const continueRequest = vi.fn(async () => undefined);
      const frame = { parentFrame: () => null, page: () => page };
      await routeHandler({ abort, continue: continueRequest } as never, {
        url: () => url,
        isNavigationRequest: () => true,
        resourceType: () => 'document',
        frame: () => frame,
      } as never);
      return { abort, continueRequest };
    };
    const emitPage = (page: TestPage) => {
      const prepared = preparePage(page);
      pages.push(prepared);
      pageListener?.(prepared);
    };
    const emitDownload = (page: TestPage, download: TestDownload) => {
      downloadListeners.get(page)?.(download);
    };
    return { contextClose, driver, emitDownload, emitPage, launchOptions: () => launchOptions, requestDocument };
  };

  const createDriver = (page: TestPage) => createHarness(page).driver;

  it('rejects a redirect before clicking', async () => {
    let currentUrl = 'about:blank';
    const page = {
      goto: vi.fn(async () => { currentUrl = 'https://evil.invalid/redirected'; }),
      click: vi.fn(async () => undefined),
      fill: vi.fn(async () => undefined),
      url: () => currentUrl,
      innerText: vi.fn(async () => ''),
      close: vi.fn(async () => undefined),
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
        close: vi.fn(async () => undefined),
      };
      const result = await createDriver(page).perform({
        type, origin: 'https://example.com', url: 'https://example.com/account', selector: '#field', text: 'value', timeoutMs: 1000,
      });
      expect(result).toMatchObject({ status: 'failed', errorCode: 'origin_drift' });
      expect(page.innerText).not.toHaveBeenCalled();
    }
  });

  it('rejects and cleans up a click-triggered download without enabling context downloads', async () => {
    let emitDownload!: ReturnType<typeof createHarness>['emitDownload'];
    const download: TestDownload = {
      cancel: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const page: TestPage = {
      goto: vi.fn(async () => undefined),
      click: vi.fn(async () => { emitDownload(page, download); }),
      fill: vi.fn(async () => undefined),
      url: () => 'https://example.com/account',
      innerText: vi.fn(async () => 'must not be read'),
      close: vi.fn(async () => undefined),
    };
    const harness = createHarness(page);
    emitDownload = harness.emitDownload;

    const result = await harness.driver.perform({
      type: 'browser.click', origin: 'https://example.com', url: 'https://example.com/account', selector: '#export', timeoutMs: 1000,
    });

    expect(result).toMatchObject({ status: 'failed', errorCode: 'download_blocked' });
    expect(harness.launchOptions()).toMatchObject({ acceptDownloads: false });
    expect(download.cancel).toHaveBeenCalledOnce();
    expect(download.delete).toHaveBeenCalledOnce();
    expect(page.innerText).not.toHaveBeenCalled();
    expect(harness.contextClose).toHaveBeenCalledOnce();
  });

  it('aborts an off-origin redirect before its document request is dispatched', async () => {
    let currentUrl = 'about:blank';
    let requestDocument!: ReturnType<typeof createHarness>['requestDocument'];
    const dispatched: string[] = [];
    const page: TestPage = {
      goto: vi.fn(async (url: string) => {
        const initial = await requestDocument(page, url);
        if (initial.continueRequest.mock.calls.length > 0) dispatched.push(url);
        currentUrl = url;
        const redirectUrl = 'https://evil.invalid/redirected';
        const redirect = await requestDocument(page, redirectUrl);
        if (redirect.continueRequest.mock.calls.length > 0) dispatched.push(redirectUrl);
        if (redirect.abort.mock.calls.length > 0) throw new Error('Navigation was blocked.');
      }),
      click: vi.fn(async () => undefined),
      fill: vi.fn(async () => undefined),
      url: () => currentUrl,
      innerText: vi.fn(async () => ''),
      close: vi.fn(async () => undefined),
    };
    const harness = createHarness(page);
    requestDocument = harness.requestDocument;

    const result = await harness.driver.perform({
      type: 'browser.navigate', origin: 'https://example.com', url: 'https://example.com/start', timeoutMs: 1000,
    });

    expect(result).toMatchObject({
      status: 'failed', errorCode: 'origin_drift', finalUrl: 'https://evil.invalid/redirected',
    });
    expect(dispatched).toEqual(['https://example.com/start']);
    expect(page.url()).toBe('https://example.com/start');
  });

  it('aborts and closes an unexpected off-origin popup without retaining it', async () => {
    let requestDocument!: ReturnType<typeof createHarness>['requestDocument'];
    let emitPage!: ReturnType<typeof createHarness>['emitPage'];
    let popupRoute: Awaited<ReturnType<typeof requestDocument>> | undefined;
    const popup: TestPage = {
      goto: vi.fn(async () => undefined),
      click: vi.fn(async () => undefined),
      fill: vi.fn(async () => undefined),
      url: () => 'https://evil.invalid/popup',
      innerText: vi.fn(async () => 'must not be read'),
      close: vi.fn(async () => undefined),
    };
    const page: TestPage = {
      goto: vi.fn(async () => undefined),
      click: vi.fn(async () => {
        emitPage(popup);
        popupRoute = await requestDocument(popup, popup.url());
      }),
      fill: vi.fn(async () => undefined),
      url: () => 'https://example.com/account',
      innerText: vi.fn(async () => 'account'),
      close: vi.fn(async () => undefined),
    };
    const harness = createHarness(page);
    requestDocument = harness.requestDocument;
    emitPage = harness.emitPage;

    const result = await harness.driver.perform({
      type: 'browser.click', origin: 'https://example.com', url: 'https://example.com/account', selector: '#open', timeoutMs: 1000,
    });

    expect(result).toMatchObject({ status: 'failed', errorCode: 'origin_drift', finalUrl: popup.url() });
    expect(popupRoute?.abort).toHaveBeenCalledOnce();
    expect(popupRoute?.continueRequest).not.toHaveBeenCalled();
    expect(popup.close).toHaveBeenCalled();
    expect(popup.innerText).not.toHaveBeenCalled();
  });

  it('actively closes the page and context when its AbortSignal fires', async () => {
    let rejectNavigation: ((error: Error) => void) | undefined;
    const page: TestPage = {
      goto: vi.fn(async () => await new Promise<never>((_resolve, reject) => { rejectNavigation = reject; })),
      click: vi.fn(async () => undefined),
      fill: vi.fn(async () => undefined),
      url: () => 'about:blank',
      innerText: vi.fn(async () => ''),
      close: vi.fn(async () => { rejectNavigation?.(new Error('Page closed.')); }),
    };
    const harness = createHarness(page);
    const controller = new AbortController();
    const pending = harness.driver.perform({
      type: 'browser.navigate', origin: 'https://example.com', url: 'https://example.com/slow', timeoutMs: 1000,
    }, { signal: controller.signal });
    await vi.waitFor(() => expect(page.goto).toHaveBeenCalledOnce());

    controller.abort();
    const result = await pending;

    expect(result).toMatchObject({ status: 'failed', errorCode: 'cancelled' });
    expect(page.close).toHaveBeenCalled();
    expect(harness.contextClose).toHaveBeenCalledOnce();
  });

  it('serializes actions that share the persistent context', async () => {
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let currentUrl = 'about:blank';
    const page: TestPage = {
      goto: vi.fn(async (url: string) => {
        if (url.endsWith('/first')) await first;
        currentUrl = url;
      }),
      click: vi.fn(async () => undefined),
      fill: vi.fn(async () => undefined),
      url: () => currentUrl,
      innerText: vi.fn(async () => ''),
      close: vi.fn(async () => undefined),
    };
    const driver = createDriver(page);
    const firstAction = driver.perform({
      type: 'browser.navigate', origin: 'https://example.com', url: 'https://example.com/first', timeoutMs: 1000,
    });
    const secondAction = driver.perform({
      type: 'browser.navigate', origin: 'https://example.com', url: 'https://example.com/second', timeoutMs: 1000,
    });
    await vi.waitFor(() => expect(page.goto).toHaveBeenCalledOnce());
    expect(page.goto).toHaveBeenCalledTimes(1);

    releaseFirst();
    await expect(Promise.all([firstAction, secondAction])).resolves.toEqual([
      expect.objectContaining({ status: 'succeeded' }),
      expect.objectContaining({ status: 'succeeded' }),
    ]);
    expect(page.goto).toHaveBeenCalledTimes(2);
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

import { existsSync } from 'node:fs';
import {
  claimCapabilityDispatchAuthorization,
  type CapabilityDispatchAuthorization,
} from '../../capabilities/dispatch';
import type { ActionIntent, BrowserAction } from '../../capabilities/types';

/**
 * The write-capable browser worker. Unlike the read-only web-inspect worker,
 * it can change page state (navigate, click) through a real browser engine,
 * driving a persistent context so a logged-in session survives across runs.
 *
 * Every action still flows through the kernel's ActionIntent -> policy ->
 * grant -> observation -> ledger pipeline; this module only performs the
 * mechanical action and returns the resulting page text as untrusted content.
 * Text entry (browser.type) resolves its payload from the hash-addressed
 * artifact store: the value typed must match the artifact whose hash the intent
 * declares, so untrusted page content can never inject keystrokes. Downloads
 * remain out of scope.
 */

export interface BrowserActionRequest {
  type: 'browser.navigate' | 'browser.click' | 'browser.type';
  origin: string;
  url: string;
  selector?: string;
  text?: string;
  timeoutMs: number;
}

/** Resolves a staged payload by artifact id, returning its content + hash. */
export type ArtifactResolver = (id: string) => Promise<{ content: string; contentHash: string } | undefined>;

export interface BrowserActionResult {
  status: 'succeeded' | 'failed' | 'uncertain';
  finalUrl: string;
  content: string;
  errorCode?: string;
}

export interface BrowserDriver {
  /** Resolves true only when a real browser engine can be launched. */
  isAvailable(): Promise<boolean>;
  perform(request: BrowserActionRequest, options?: { signal?: AbortSignal }): Promise<BrowserActionResult>;
  close(): Promise<void>;
}

export interface BrowserWorkerResult {
  status: 'succeeded' | 'failed' | 'uncertain';
  summary: string;
  sourceRef: string;
  content?: string;
  errorCode?: string;
}

const MAX_CONTENT_CHARS = 64 * 1024;
const MAX_TYPED_PAYLOAD_CHARS = 64 * 1024;

type WriteAction = Extract<BrowserAction, { type: 'browser.navigate' | 'browser.click' | 'browser.type' }>;

const isWriteAction = (action: BrowserAction): action is WriteAction => (
  action.type === 'browser.navigate' || action.type === 'browser.click' || action.type === 'browser.type'
);

const fail = (summary: string, sourceRef: string, errorCode: string): BrowserWorkerResult => ({
  status: 'failed', summary, sourceRef, errorCode,
});

const uncertain = (summary: string, sourceRef: string): BrowserWorkerResult => ({
  status: 'uncertain',
  summary,
  sourceRef,
  errorCode: 'browser_outcome_uncertain',
});

export const createBrowserWorker = (driver: BrowserDriver, artifactResolver?: ArtifactResolver) => ({
  execute: async (
    intent: ActionIntent,
    options: {
      timeoutMs: number;
      authorization?: CapabilityDispatchAuthorization;
      signal?: AbortSignal;
    },
  ): Promise<BrowserWorkerResult> => {
    const authorization = claimCapabilityDispatchAuthorization(
      options.authorization,
      intent,
      intent.workerId,
    );
    if (!authorization.allowed) {
      return fail(authorization.reason, 'about:invalid', authorization.reasonCode ?? 'authorization_invalid');
    }

    const action = intent.action as BrowserAction;
    if (!isWriteAction(action)) {
      return fail('Browser worker performs only navigate, click, and type actions.', 'about:invalid', 'unsupported_action');
    }

    // Defense in depth: the URL must belong to the intent origin. The kernel
    // scope check already enforces this, but the worker re-verifies.
    try {
      if (new URL(action.url).origin !== action.origin) {
        return fail('Requested URL is outside the intent origin.', action.url, 'origin_mismatch');
      }
    } catch {
      return fail('Requested URL could not be parsed.', action.url, 'origin_mismatch');
    }

    // Text entry resolves its value from the hash-addressed artifact store; the
    // typed value must match the hash the intent declares.
    let text: string | undefined;
    if (action.type === 'browser.type') {
      if (!artifactResolver) return fail('No artifact store is configured for text entry.', action.url, 'no_artifact_store');
      const resolved = await artifactResolver(action.payloadArtifactId);
      if (!resolved) return fail('Typed-payload artifact was not found.', action.url, 'artifact_not_found');
      if (resolved.content.length > MAX_TYPED_PAYLOAD_CHARS) {
        return fail('Typed-payload artifact exceeds the browser entry limit.', action.url, 'payload_too_large');
      }
      if (resolved.contentHash !== action.payloadHash) {
        return fail('Typed-payload hash does not match the artifact.', action.url, 'payload_hash_mismatch');
      }
      text = resolved.content;
    }

    let result: BrowserActionResult;
    try {
      result = await driver.perform(
        {
          type: action.type,
          origin: action.origin,
          url: action.url,
          selector: action.type === 'browser.navigate' ? undefined : action.selector,
          text,
          timeoutMs: Math.min(options.timeoutMs, 30_000),
        },
        { signal: options.signal },
      );
    } catch {
      return uncertain(
        'Browser dispatch lost its result after authorization; its side effect may have completed and must not be retried automatically.',
        action.url,
      );
    }

    try {
      if (new URL(result.finalUrl).origin !== action.origin) {
        return uncertain(
          'Browser origin drifted after dispatch; its side effect may have completed and must not be retried automatically.',
          result.finalUrl,
        );
      }
    } catch {
      return uncertain(
        'Browser returned an invalid final URL after dispatch; its side effect may have completed and must not be retried automatically.',
        result.finalUrl || action.url,
      );
    }

    // The typed value itself is never echoed into the summary (it may be
    // sensitive); only its length is recorded.
    const detail = action.type === 'browser.type' && text !== undefined
      ? ` (${text.length} chars entered into ${action.selector})`
      : ` (${result.content.length} chars observed)`;
    return {
      status: result.status,
      summary: result.status === 'succeeded'
        ? `${action.type} on ${action.origin} succeeded${detail}.`
        : result.status === 'uncertain'
          ? `${action.type} on ${action.origin} has an uncertain outcome and must not be retried automatically.`
          : `${action.type} on ${action.origin} failed before a side effect was dispatched.`,
      sourceRef: result.finalUrl || action.url,
      content: result.status === 'succeeded'
        ? result.content.slice(0, MAX_CONTENT_CHARS)
        : undefined,
      errorCode: result.status === 'uncertain' ? 'browser_outcome_uncertain' : result.errorCode,
    };
  },
});

// --- Real Playwright-backed driver (gated; activates only when installed) ---

interface PlaywrightPage {
  goto(url: string, options: { timeout: number; waitUntil: string }): Promise<unknown>;
  click(selector: string, options: { timeout: number }): Promise<void>;
  fill(selector: string, value: string, options: { timeout: number }): Promise<void>;
  on(event: 'download', listener: (download: PlaywrightDownload) => void): void;
  url(): string;
  innerText(selector: string, options: { timeout: number }): Promise<string>;
  close(): Promise<void>;
}

interface PlaywrightDownload {
  cancel(): Promise<void>;
  delete(): Promise<void>;
}

interface PlaywrightFrame {
  parentFrame(): PlaywrightFrame | null;
  page(): PlaywrightPage;
}

interface PlaywrightRequest {
  url(): string;
  isNavigationRequest(): boolean;
  resourceType(): string;
  frame(): PlaywrightFrame;
}

interface PlaywrightRoute {
  abort(errorCode?: string): Promise<void>;
  continue(): Promise<void>;
}

interface PlaywrightContext {
  pages(): PlaywrightPage[];
  newPage(): Promise<PlaywrightPage>;
  route(
    url: string,
    handler: (route: PlaywrightRoute, request: PlaywrightRequest) => Promise<void>,
  ): Promise<void>;
  on(event: 'page', listener: (page: PlaywrightPage) => void): void;
  close(): Promise<void>;
}

interface PlaywrightChromium {
  launchPersistentContext(
    userDataDir: string,
    options: { headless: boolean; serviceWorkers: 'block'; acceptDownloads: false },
  ): Promise<PlaywrightContext>;
  executablePath(): string;
}

interface PlaywrightModule {
  chromium: PlaywrightChromium;
}

// Indirect import keeps esbuild's CJS bundle from requiring an optional,
// possibly-absent ESM dependency at build time (same pattern as the core model).
const importPlaywright = new Function(
  'return import("playwright-core")',
) as () => Promise<PlaywrightModule>;

export interface PlaywrightDriverOptions {
  userDataDir: string;
  headless?: boolean;
  moduleLoader?: () => Promise<PlaywrightModule>;
}

class OriginDriftError extends Error {
  constructor(readonly finalUrl: string) {
    super('Browser navigated outside the authorized origin.');
    this.name = 'OriginDriftError';
  }
}

class BrowserAbortError extends Error {
  constructor() {
    super('Browser action was cancelled.');
    this.name = 'AbortError';
  }
}

class UnscopedDownloadError extends Error {
  constructor() {
    super('Browser write action attempted an unauthorized download.');
    this.name = 'UnscopedDownloadError';
  }
}

const hasOrigin = (url: string, expectedOrigin: string): boolean => {
  try {
    return new URL(url).origin === expectedOrigin;
  } catch {
    return false;
  }
};

const isRecoverableBlankPage = (page: PlaywrightPage): boolean => page.url() === 'about:blank';

const requirePageOrigin = (page: PlaywrightPage, expectedOrigin: string): void => {
  const finalUrl = page.url();
  try {
    if (new URL(finalUrl).origin !== expectedOrigin) throw new OriginDriftError(finalUrl);
  } catch (error) {
    if (error instanceof OriginDriftError) throw error;
    throw new OriginDriftError(finalUrl);
  }
};

export const createPlaywrightDriver = (options: PlaywrightDriverOptions): BrowserDriver => {
  let contextPromise: Promise<PlaywrightContext> | undefined;
  let actionQueue: Promise<void> = Promise.resolve();
  let expectedOrigin: string | undefined;
  let creatingControlledPage = false;
  const downloadGuardedPages = new WeakSet<PlaywrightPage>();
  const loadModule = options.moduleLoader ?? importPlaywright;

  interface ActiveOriginPolicy {
    expectedOrigin: string;
    page?: PlaywrightPage;
    blockedUrl?: string;
    downloadAttempted: boolean;
    aborted: boolean;
    cleanup: Promise<void>[];
  }

  let activePolicy: ActiveOriginPolicy | undefined;

  const trackClose = (page: PlaywrightPage, policy = activePolicy): Promise<void> => {
    const closing = page.close().catch(() => undefined);
    policy?.cleanup.push(closing);
    return closing;
  };

  const rejectUnexpectedDownload = (download: PlaywrightDownload): void => {
    const policy = activePolicy;
    if (policy) policy.downloadAttempted = true;
    const cleanup = (async () => {
      await download.cancel().catch(() => undefined);
      await download.delete().catch(() => undefined);
    })();
    if (policy) policy.cleanup.push(cleanup);
    else void cleanup;
  };

  const guardPageDownloads = (page: PlaywrightPage): void => {
    if (downloadGuardedPages.has(page)) return;
    downloadGuardedPages.add(page);
    page.on('download', rejectUnexpectedDownload);
  };

  const rejectOffOriginNavigation = async (
    route: PlaywrightRoute,
    request: PlaywrightRequest,
  ): Promise<void> => {
    if (
      !request.isNavigationRequest() || request.resourceType() !== 'document' ||
      request.frame().parentFrame() !== null
    ) {
      await route.continue();
      return;
    }

    const requestUrl = request.url();
    if (expectedOrigin && hasOrigin(requestUrl, expectedOrigin)) {
      await route.continue();
      return;
    }

    if (activePolicy && !activePolicy.blockedUrl) activePolicy.blockedUrl = requestUrl;
    await route.abort('blockedbyclient');
    const requestPage = request.frame().page();
    if (!activePolicy || requestPage !== activePolicy.page) await trackClose(requestPage);
  };

  const rejectUnexpectedPage = (page: PlaywrightPage): void => {
    guardPageDownloads(page);
    if (creatingControlledPage) return;
    const pageUrl = page.url();
    if (
      activePolicy && pageUrl !== 'about:blank' &&
      !hasOrigin(pageUrl, activePolicy.expectedOrigin) && !activePolicy.blockedUrl
    ) {
      activePolicy.blockedUrl = pageUrl;
    }
    void trackClose(page);
  };

  const getContext = async (): Promise<PlaywrightContext> => {
    if (!contextPromise) {
      const launched = loadModule().then(async (mod) => {
        const context = await mod.chromium.launchPersistentContext(options.userDataDir, {
          headless: options.headless ?? true,
          // This write-only driver never owns browser.download grants. A future
          // download worker must provide its own destination-scoped authority.
          acceptDownloads: false,
          // BrowserContext routing cannot reliably intercept requests already
          // claimed by a service worker, so confinement requires them disabled.
          serviceWorkers: 'block',
        });
        await context.route('**/*', rejectOffOriginNavigation);
        context.pages().forEach(guardPageDownloads);
        context.on('page', rejectUnexpectedPage);
        return context;
      });
      contextPromise = launched;
      launched.catch(() => {
        if (contextPromise === launched) contextPromise = undefined;
      });
    }
    return contextPromise;
  };

  const closeContextAndPages = async (): Promise<void> => {
    const pendingContext = contextPromise;
    contextPromise = undefined;
    if (!pendingContext) return;
    const context = await pendingContext.catch(() => undefined);
    if (!context) return;
    await Promise.allSettled(context.pages().map((page) => page.close()));
    await context.close().catch(() => undefined);
  };

  const getPage = async (context: PlaywrightContext, policy: ActiveOriginPolicy): Promise<PlaywrightPage> => {
    const pages = context.pages();
    const page = pages.find((candidate) => (
      isRecoverableBlankPage(candidate) || hasOrigin(candidate.url(), policy.expectedOrigin)
    ));
    await Promise.allSettled(pages.filter((candidate) => candidate !== page).map((candidate) => trackClose(candidate, policy)));
    if (page) {
      guardPageDownloads(page);
      return page;
    }

    creatingControlledPage = true;
    try {
      const created = await context.newPage();
      guardPageDownloads(created);
      return created;
    } finally {
      creatingControlledPage = false;
    }
  };

  const closeUnexpectedPages = async (
    context: PlaywrightContext,
    policy: ActiveOriginPolicy,
  ): Promise<void> => {
    for (const candidate of context.pages()) {
      if (candidate === policy.page) continue;
      const candidateUrl = candidate.url();
      if (
        candidateUrl !== 'about:blank' && !hasOrigin(candidateUrl, policy.expectedOrigin) &&
        !policy.blockedUrl
      ) {
        policy.blockedUrl = candidateUrl;
      }
      await trackClose(candidate, policy);
    }
  };

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = actionQueue.then(operation, operation);
    actionQueue = result.then(() => undefined, () => undefined);
    return result;
  };

  const perform = async (
    request: BrowserActionRequest,
    driverOptions?: { signal?: AbortSignal },
  ): Promise<BrowserActionResult> => {
    const signal = driverOptions?.signal;
    if (signal?.aborted) {
      return { status: 'failed', finalUrl: request.url, content: '', errorCode: 'cancelled' };
    }

    const policy: ActiveOriginPolicy = {
      expectedOrigin: request.origin,
      downloadAttempted: false,
      aborted: false,
      cleanup: [],
    };
    activePolicy = policy;
    expectedOrigin = request.origin;
    let mutationDispatched = false;
    let abortCleanup: Promise<void> | undefined;
    const onAbort = () => {
      policy.aborted = true;
      abortCleanup = closeContextAndPages();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      if (signal?.aborted) throw new BrowserAbortError();
      const context = await getContext();
      if (signal?.aborted) throw new BrowserAbortError();
      const page = await getPage(context, policy);
      policy.page = page;
      if (signal?.aborted) throw new BrowserAbortError();

      if (request.type === 'browser.navigate') {
        mutationDispatched = true;
        await page.goto(request.url, { timeout: request.timeoutMs, waitUntil: 'domcontentloaded' });
      } else {
        if (page.url() !== request.url) {
          mutationDispatched = true;
          await page.goto(request.url, { timeout: request.timeoutMs, waitUntil: 'domcontentloaded' });
        }
        if (policy.blockedUrl) throw new OriginDriftError(policy.blockedUrl);
        requirePageOrigin(page, request.origin);
        if (request.type === 'browser.type') {
          mutationDispatched = true;
          await page.fill(request.selector ?? '', request.text ?? '', { timeout: request.timeoutMs });
        } else {
          mutationDispatched = true;
          await page.click(request.selector ?? '', { timeout: request.timeoutMs });
        }
      }

      await closeUnexpectedPages(context, policy);
      await Promise.allSettled(policy.cleanup);
      if (policy.downloadAttempted) throw new UnscopedDownloadError();
      if (policy.blockedUrl) throw new OriginDriftError(policy.blockedUrl);
      requirePageOrigin(page, request.origin);
      if (signal?.aborted) throw new BrowserAbortError();
      const content = await page.innerText('body', { timeout: request.timeoutMs }).catch(() => '');
      if (signal?.aborted) throw new BrowserAbortError();
      return { status: 'succeeded', finalUrl: page.url(), content };
    } catch (error) {
      if (abortCleanup) await abortCleanup;
      if (policy.downloadAttempted) {
        await Promise.allSettled(policy.cleanup);
        await closeContextAndPages();
        error = new UnscopedDownloadError();
      }
      if (policy.blockedUrl) error = new OriginDriftError(policy.blockedUrl);
      if (error instanceof OriginDriftError && policy.page) await trackClose(policy.page, policy);
      await Promise.allSettled(policy.cleanup);
      if (mutationDispatched) await closeContextAndPages();
      return {
        status: mutationDispatched ? 'uncertain' : 'failed',
        finalUrl: error instanceof OriginDriftError ? error.finalUrl : request.url,
        content: '',
        errorCode: mutationDispatched
          ? 'browser_outcome_uncertain'
          : policy.aborted || error instanceof BrowserAbortError
            ? 'cancelled'
            : error instanceof OriginDriftError
              ? 'origin_drift'
              : error instanceof UnscopedDownloadError
                ? 'download_blocked'
                : error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'transport',
      };
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (activePolicy === policy) activePolicy = undefined;
    }
  };

  return {
    isAvailable: async () => {
      try {
        const mod = await loadModule();
        // executablePath() returns the expected path even when the browser is
        // not downloaded, so confirm the binary actually exists on disk.
        const executable = mod.chromium.executablePath();
        return typeof executable === 'string' && existsSync(executable);
      } catch {
        return false;
      }
    },
    perform: (request, driverOptions) => enqueue(() => perform(request, driverOptions)),
    close: async () => {
      await closeContextAndPages();
    },
  };
};

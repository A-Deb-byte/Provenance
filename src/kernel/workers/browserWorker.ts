import { existsSync } from 'node:fs';
import type { ActionIntent, BrowserAction } from '../../capabilities/types';

/**
 * The write-capable browser worker. Unlike the read-only web-inspect worker,
 * it can change page state (navigate, click) through a real browser engine,
 * driving a persistent context so a logged-in session survives across runs.
 *
 * Every action still flows through the kernel's ActionIntent -> policy ->
 * grant -> observation -> ledger pipeline; this module only performs the
 * mechanical action and returns the resulting page text as untrusted content.
 * Text entry and downloads are intentionally out of scope until an artifact
 * store exists to hold typed payloads (so untrusted content cannot inject
 * keystrokes).
 */

export interface BrowserActionRequest {
  type: 'browser.navigate' | 'browser.click';
  origin: string;
  url: string;
  selector?: string;
  timeoutMs: number;
}

export interface BrowserActionResult {
  status: 'succeeded' | 'failed';
  finalUrl: string;
  content: string;
  errorCode?: string;
}

export interface BrowserDriver {
  /** Resolves true only when a real browser engine can be launched. */
  isAvailable(): Promise<boolean>;
  perform(request: BrowserActionRequest): Promise<BrowserActionResult>;
  close(): Promise<void>;
}

export interface BrowserWorkerResult {
  status: 'succeeded' | 'failed';
  summary: string;
  sourceRef: string;
  content?: string;
  errorCode?: string;
}

const MAX_CONTENT_CHARS = 64 * 1024;

const isSupportedAction = (action: BrowserAction): action is Extract<BrowserAction, { type: 'browser.navigate' | 'browser.click' }> => (
  action.type === 'browser.navigate' || action.type === 'browser.click'
);

export const createBrowserWorker = (driver: BrowserDriver) => ({
  execute: async (
    intent: ActionIntent,
    options: { timeoutMs: number },
  ): Promise<BrowserWorkerResult> => {
    const action = intent.action;
    if (!isSupportedAction(action as BrowserAction)) {
      return {
        status: 'failed',
        summary: 'Browser worker performs only navigate and click actions.',
        sourceRef: 'about:invalid',
        errorCode: 'unsupported_action',
      };
    }
    const browserAction = action as Extract<BrowserAction, { type: 'browser.navigate' | 'browser.click' }>;

    // Defense in depth: the URL must belong to the intent origin. The kernel
    // scope check already enforces this, but the worker re-verifies.
    try {
      if (new URL(browserAction.url).origin !== browserAction.origin) {
        return {
          status: 'failed',
          summary: 'Requested URL is outside the intent origin.',
          sourceRef: browserAction.url,
          errorCode: 'origin_mismatch',
        };
      }
    } catch {
      return {
        status: 'failed',
        summary: 'Requested URL could not be parsed.',
        sourceRef: browserAction.url,
        errorCode: 'origin_mismatch',
      };
    }

    const result = await driver.perform({
      type: browserAction.type,
      origin: browserAction.origin,
      url: browserAction.url,
      selector: browserAction.type === 'browser.click' ? browserAction.selector : undefined,
      timeoutMs: Math.min(options.timeoutMs, 30_000),
    });

    return {
      status: result.status,
      summary: result.status === 'succeeded'
        ? `${browserAction.type} on ${browserAction.origin} succeeded (${result.content.length} chars observed).`
        : `${browserAction.type} on ${browserAction.origin} failed.`,
      sourceRef: result.finalUrl || browserAction.url,
      content: result.content.slice(0, MAX_CONTENT_CHARS),
      errorCode: result.errorCode,
    };
  },
});

// --- Real Playwright-backed driver (gated; activates only when installed) ---

interface PlaywrightPage {
  goto(url: string, options: { timeout: number; waitUntil: string }): Promise<unknown>;
  click(selector: string, options: { timeout: number }): Promise<void>;
  url(): string;
  innerText(selector: string, options: { timeout: number }): Promise<string>;
}

interface PlaywrightContext {
  pages(): PlaywrightPage[];
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
}

interface PlaywrightChromium {
  launchPersistentContext(userDataDir: string, options: { headless: boolean }): Promise<PlaywrightContext>;
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
}

export const createPlaywrightDriver = (options: PlaywrightDriverOptions): BrowserDriver => {
  let contextPromise: Promise<PlaywrightContext> | undefined;

  const getPage = async (): Promise<PlaywrightPage> => {
    if (!contextPromise) {
      contextPromise = importPlaywright().then((mod) => mod.chromium.launchPersistentContext(options.userDataDir, {
        headless: options.headless ?? true,
      }));
    }
    const context = await contextPromise;
    const pages = context.pages();
    return pages.length > 0 ? pages[0] : context.newPage();
  };

  return {
    isAvailable: async () => {
      try {
        const mod = await importPlaywright();
        // executablePath() returns the expected path even when the browser is
        // not downloaded, so confirm the binary actually exists on disk.
        const executable = mod.chromium.executablePath();
        return typeof executable === 'string' && existsSync(executable);
      } catch {
        return false;
      }
    },
    perform: async (request) => {
      try {
        const page = await getPage();
        if (request.type === 'browser.navigate') {
          await page.goto(request.url, { timeout: request.timeoutMs, waitUntil: 'domcontentloaded' });
        } else {
          if (page.url() !== request.url) {
            await page.goto(request.url, { timeout: request.timeoutMs, waitUntil: 'domcontentloaded' });
          }
          await page.click(request.selector ?? '', { timeout: request.timeoutMs });
        }
        const content = await page.innerText('body', { timeout: request.timeoutMs }).catch(() => '');
        return { status: 'succeeded', finalUrl: page.url(), content };
      } catch (error) {
        return {
          status: 'failed',
          finalUrl: request.url,
          content: '',
          errorCode: error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'transport',
        };
      }
    },
    close: async () => {
      if (contextPromise) {
        const context = await contextPromise.catch(() => undefined);
        await context?.close().catch(() => undefined);
        contextPromise = undefined;
      }
    },
  };
};

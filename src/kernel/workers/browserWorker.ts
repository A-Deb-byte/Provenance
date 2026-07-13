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

type WriteAction = Extract<BrowserAction, { type: 'browser.navigate' | 'browser.click' | 'browser.type' }>;

const isWriteAction = (action: BrowserAction): action is WriteAction => (
  action.type === 'browser.navigate' || action.type === 'browser.click' || action.type === 'browser.type'
);

const fail = (summary: string, sourceRef: string, errorCode: string): BrowserWorkerResult => ({
  status: 'failed', summary, sourceRef, errorCode,
});

export const createBrowserWorker = (driver: BrowserDriver, artifactResolver?: ArtifactResolver) => ({
  execute: async (
    intent: ActionIntent,
    options: { timeoutMs: number },
  ): Promise<BrowserWorkerResult> => {
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
      if (resolved.contentHash !== action.payloadHash) {
        return fail('Typed-payload hash does not match the artifact.', action.url, 'payload_hash_mismatch');
      }
      text = resolved.content;
    }

    const result = await driver.perform({
      type: action.type,
      origin: action.origin,
      url: action.url,
      selector: action.type === 'browser.navigate' ? undefined : action.selector,
      text,
      timeoutMs: Math.min(options.timeoutMs, 30_000),
    });

    // The typed value itself is never echoed into the summary (it may be
    // sensitive); only its length is recorded.
    const detail = action.type === 'browser.type' && text !== undefined
      ? ` (${text.length} chars entered into ${action.selector})`
      : ` (${result.content.length} chars observed)`;
    return {
      status: result.status,
      summary: result.status === 'succeeded'
        ? `${action.type} on ${action.origin} succeeded${detail}.`
        : `${action.type} on ${action.origin} failed.`,
      sourceRef: result.finalUrl || action.url,
      content: result.content.slice(0, MAX_CONTENT_CHARS),
      errorCode: result.errorCode,
    };
  },
});

// --- Real Playwright-backed driver (gated; activates only when installed) ---

interface PlaywrightPage {
  goto(url: string, options: { timeout: number; waitUntil: string }): Promise<unknown>;
  click(selector: string, options: { timeout: number }): Promise<void>;
  fill(selector: string, value: string, options: { timeout: number }): Promise<void>;
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
          if (request.type === 'browser.type') {
            await page.fill(request.selector ?? '', request.text ?? '', { timeout: request.timeoutMs });
          } else {
            await page.click(request.selector ?? '', { timeout: request.timeoutMs });
          }
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

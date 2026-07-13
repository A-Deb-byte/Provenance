import type { ActionIntent } from '../../capabilities/types';

export type FetchLike = (input: string, init?: {
  redirect?: 'manual';
  signal?: AbortSignal;
  headers?: Record<string, string>;
}) => Promise<{
  status: number;
  url: string;
  text(): Promise<string>;
}>;

export interface WebInspectDispatchResult {
  status: 'succeeded' | 'failed';
  summary: string;
  sourceRef: string;
  content?: string;
  httpStatus?: number;
  errorCode?: 'not_inspect' | 'origin_mismatch' | 'redirect_blocked' | 'http_error' | 'timeout' | 'transport';
}

export interface WebInspectWorkerOptions {
  fetch?: FetchLike;
  maxContentChars?: number;
}

const DEFAULT_MAX_CONTENT_CHARS = 64 * 1024;

const stripHtml = (html: string): string => html
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * The only worker runtime that ships with this repository: a read-only
 * (L0) page inspection over plain HTTP fetch. It never clicks, types,
 * downloads, follows cross-origin redirects, or sends a request body, and
 * everything it returns is untrusted observation content.
 */
export const createWebInspectWorker = (options: WebInspectWorkerOptions = {}) => {
  const fetchImpl: FetchLike = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const maxContentChars = options.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS;

  const execute = async (
    intent: ActionIntent,
    executeOptions: { timeoutMs: number },
  ): Promise<WebInspectDispatchResult> => {
    if (intent.action.type !== 'browser.inspect') {
      return {
        status: 'failed',
        summary: 'Web inspect worker only performs browser.inspect actions.',
        sourceRef: 'about:invalid',
        errorCode: 'not_inspect',
      };
    }
    const { origin, url } = intent.action;
    try {
      if (new URL(url).origin !== origin) {
        return {
          status: 'failed',
          summary: 'Requested URL is outside the intent origin.',
          sourceRef: url,
          errorCode: 'origin_mismatch',
        };
      }
    } catch {
      return {
        status: 'failed',
        summary: 'Requested URL could not be parsed.',
        sourceRef: url,
        errorCode: 'origin_mismatch',
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1000, executeOptions.timeoutMs));
    try {
      const response = await fetchImpl(url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': 'agent-kernel-web-inspect/1.0 (read-only)' },
      });
      if (response.status >= 300 && response.status < 400) {
        return {
          status: 'failed',
          summary: 'Redirects are blocked for scoped web inspection.',
          sourceRef: url,
          httpStatus: response.status,
          errorCode: 'redirect_blocked',
        };
      }
      const body = await response.text();
      const content = stripHtml(body).slice(0, maxContentChars);
      if (response.status >= 400) {
        return {
          status: 'failed',
          summary: `Page responded with HTTP ${response.status}.`,
          sourceRef: response.url || url,
          httpStatus: response.status,
          content,
          errorCode: 'http_error',
        };
      }
      return {
        status: 'succeeded',
        summary: `Inspected ${url} (HTTP ${response.status}, ${content.length} chars of text).`,
        sourceRef: response.url || url,
        httpStatus: response.status,
        content,
      };
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      return {
        status: 'failed',
        summary: aborted ? 'Web inspection timed out.' : 'Web inspection transport failed.',
        sourceRef: url,
        errorCode: aborted ? 'timeout' : 'transport',
      };
    } finally {
      clearTimeout(timeout);
    }
  };

  return { execute };
};

export type WebInspectWorker = ReturnType<typeof createWebInspectWorker>;

import type { ActionIntent } from '../../capabilities/types';

interface FetchHeadersLike {
  get(name: string): string | null;
}

interface FetchBodyReaderLike {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel?(reason?: unknown): Promise<void>;
  releaseLock?(): void;
}

interface FetchBodyLike {
  getReader?(): FetchBodyReaderLike;
}

interface FetchResponseLike {
  status: number;
  url: string;
  headers?: FetchHeadersLike;
  body?: FetchBodyLike | null;
  text(): Promise<string>;
}

export type FetchLike = (input: string, init?: {
  redirect?: 'manual';
  signal?: AbortSignal;
  headers?: Record<string, string>;
}) => Promise<FetchResponseLike>;

export interface WebInspectDispatchResult {
  status: 'succeeded' | 'failed';
  summary: string;
  sourceRef: string;
  content?: string;
  httpStatus?: number;
  errorCode?:
    | 'not_inspect'
    | 'origin_mismatch'
    | 'redirect_blocked'
    | 'unsupported_content_type'
    | 'response_too_large'
    | 'http_error'
    | 'cancelled'
    | 'timeout'
    | 'transport';
}

export interface WebInspectWorkerOptions {
  fetch?: FetchLike;
  maxContentChars?: number;
  maxResponseBytes?: number;
}

const DEFAULT_MAX_CONTENT_CHARS = 64 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 4 * DEFAULT_MAX_CONTENT_CHARS;
const MAX_CONFIGURED_RESPONSE_BYTES = 16 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES = new Set([
  'text/html',
  'text/plain',
  'application/xhtml+xml',
]);

class ResponseTooLargeError extends Error {
  constructor() {
    super('Response body exceeded the configured inspection limit.');
    this.name = 'ResponseTooLargeError';
  }
}

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

const throwIfAborted = (signal: AbortSignal): void => {
  if (!signal.aborted) return;
  const error = new Error('Web inspection was aborted.');
  error.name = 'AbortError';
  throw error;
};

const parseContentLength = (headers: FetchHeadersLike | undefined): number | undefined => {
  const raw = headers?.get('content-length')?.trim();
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
};

const responseContentType = (headers: FetchHeadersLike | undefined): string | undefined => {
  const raw = headers?.get('content-type');
  return raw?.split(';', 1)[0]?.trim().toLowerCase() || undefined;
};

const readBoundedResponseBody = async (
  response: FetchResponseLike,
  maxResponseBytes: number,
  signal: AbortSignal,
): Promise<string> => {
  const declaredLength = parseContentLength(response.headers);
  if (declaredLength !== undefined && declaredLength > maxResponseBytes) {
    throw new ResponseTooLargeError();
  }

  const reader = response.body?.getReader?.();
  if (!reader) {
    throwIfAborted(signal);
    const text = await response.text();
    throwIfAborted(signal);
    if (Buffer.byteLength(text, 'utf8') > maxResponseBytes) throw new ResponseTooLargeError();
    return text;
  }

  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let receivedBytes = 0;
  try {
    while (true) {
      throwIfAborted(signal);
      const chunk = await reader.read();
      throwIfAborted(signal);
      if (chunk.done) break;
      if (!chunk.value) continue;
      receivedBytes += chunk.value.byteLength;
      if (receivedBytes > maxResponseBytes) {
        await reader.cancel?.('Response body exceeded the configured inspection limit.').catch(() => undefined);
        throw new ResponseTooLargeError();
      }
      chunks.push(decoder.decode(chunk.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } finally {
    reader.releaseLock?.();
  }
};

const isSameOriginResponse = (responseUrl: string, expectedOrigin: string): boolean => {
  try {
    const parsed = new URL(responseUrl);
    return parsed.origin === expectedOrigin && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
};

/**
 * The only worker runtime that ships with this repository: a read-only
 * (L0) page inspection over plain HTTP fetch. It never clicks, types,
 * downloads, follows cross-origin redirects, or sends a request body, and
 * everything it returns is untrusted observation content.
 */
export const createWebInspectWorker = (options: WebInspectWorkerOptions = {}) => {
  const fetchImpl: FetchLike = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const maxContentChars = options.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > MAX_CONFIGURED_RESPONSE_BYTES) {
    throw new Error(`Web response limit must be between 1 and ${MAX_CONFIGURED_RESPONSE_BYTES} bytes.`);
  }

  const execute = async (
    intent: ActionIntent,
    executeOptions: { timeoutMs: number; signal?: AbortSignal },
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
    let timedOut = false;
    let externallyCancelled = false;
    const forwardExternalAbort = () => {
      externallyCancelled = true;
      controller.abort(executeOptions.signal?.reason);
    };
    if (executeOptions.signal?.aborted) {
      forwardExternalAbort();
    } else {
      executeOptions.signal?.addEventListener('abort', forwardExternalAbort, { once: true });
    }
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, Math.max(1000, executeOptions.timeoutMs));

    try {
      throwIfAborted(controller.signal);
      const response = await fetchImpl(url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': 'agent-kernel-web-inspect/1.0 (read-only)' },
      });
      throwIfAborted(controller.signal);
      if (response.status >= 300 && response.status < 400) {
        return {
          status: 'failed',
          summary: 'Redirects are blocked for scoped web inspection.',
          sourceRef: url,
          httpStatus: response.status,
          errorCode: 'redirect_blocked',
        };
      }

      const finalUrl = response.url || url;
      if (!isSameOriginResponse(finalUrl, origin)) {
        return {
          status: 'failed',
          summary: 'Response URL is outside the authorized origin.',
          sourceRef: finalUrl,
          httpStatus: response.status,
          errorCode: 'origin_mismatch',
        };
      }

      const contentType = responseContentType(response.headers);
      if (!contentType || !ALLOWED_CONTENT_TYPES.has(contentType)) {
        return {
          status: 'failed',
          summary: contentType
            ? `Response content type ${contentType} is not permitted for web inspection.`
            : 'Response content type is missing and cannot be inspected safely.',
          sourceRef: finalUrl,
          httpStatus: response.status,
          errorCode: 'unsupported_content_type',
        };
      }

      const body = await readBoundedResponseBody(response, maxResponseBytes, controller.signal);
      const content = stripHtml(body).slice(0, maxContentChars);
      if (response.status >= 400) {
        return {
          status: 'failed',
          summary: `Page responded with HTTP ${response.status}.`,
          sourceRef: finalUrl,
          httpStatus: response.status,
          content,
          errorCode: 'http_error',
        };
      }
      return {
        status: 'succeeded',
        summary: `Inspected ${url} (HTTP ${response.status}, ${content.length} chars of text).`,
        sourceRef: finalUrl,
        httpStatus: response.status,
        content,
      };
    } catch (error) {
      if (error instanceof ResponseTooLargeError) {
        return {
          status: 'failed',
          summary: `Response body exceeds the ${maxResponseBytes}-byte web inspection limit.`,
          sourceRef: url,
          errorCode: 'response_too_large',
        };
      }
      const aborted = controller.signal.aborted || (error instanceof Error && error.name === 'AbortError');
      return {
        status: 'failed',
        summary: aborted
          ? externallyCancelled && !timedOut ? 'Web inspection was cancelled.' : 'Web inspection timed out.'
          : 'Web inspection transport failed.',
        sourceRef: url,
        errorCode: aborted
          ? externallyCancelled && !timedOut ? 'cancelled' : 'timeout'
          : 'transport',
      };
    } finally {
      clearTimeout(timeout);
      executeOptions.signal?.removeEventListener('abort', forwardExternalAbort);
    }
  };

  return { execute };
};

export type WebInspectWorker = ReturnType<typeof createWebInspectWorker>;

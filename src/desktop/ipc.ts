import crypto from 'node:crypto';
import type { DesktopAction } from '../capabilities/types';

const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_REQUEST_TTL_MS = 15_000;

export interface DesktopBridgeHealth {
  schemaVersion: 1;
  status: 'ok';
  hostInstanceId: string;
  platform: 'windows';
  capabilities: string[];
  allowedAppIds: string[];
}

export interface DesktopBridgeActionResult {
  schemaVersion: 1;
  status: 'succeeded' | 'failed' | 'uncertain';
  sourceRef: string;
  summary: string;
  content?: string;
  errorCode?: string;
}

export interface DesktopBridgeClient {
  health(signal?: AbortSignal): Promise<DesktopBridgeHealth>;
  perform(
    action: DesktopAction,
    options: { timeoutMs: number; payloadText?: string; signal?: AbortSignal },
  ): Promise<DesktopBridgeActionResult>;
}

export interface DesktopBridgeClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  randomId?: () => string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

export const isLoopbackDesktopBridgeUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' &&
      (parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]') &&
      Boolean(parsed.port) &&
      !parsed.username && !parsed.password &&
      parsed.pathname === '/' && !parsed.search && !parsed.hash;
  } catch {
    return false;
  }
};

const sha256 = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');

export const signDesktopBridgeRequest = (
  token: string,
  input: {
    method: 'GET' | 'POST';
    path: '/v1/health' | '/v1/actions';
    requestId: string;
    issuedAt: number;
    expiresAt: number;
    contentHash: string;
  },
): string => crypto.createHmac('sha256', token).update([
  input.method,
  input.path,
  input.requestId,
  String(input.issuedAt),
  String(input.expiresAt),
  input.contentHash,
].join('\n')).digest('hex');

export const signDesktopBridgeResponse = (
  token: string,
  requestId: string,
  status: number,
  contentHash: string,
): string => crypto.createHmac('sha256', token)
  .update(['RESPONSE', requestId, String(status), contentHash].join('\n'))
  .digest('hex');

const isHealth = (value: unknown): value is DesktopBridgeHealth => isRecord(value) &&
  value.schemaVersion === 1 && value.status === 'ok' && value.platform === 'windows' &&
  isText(value.hostInstanceId) && Array.isArray(value.capabilities) && value.capabilities.every(isText) &&
  Array.isArray(value.allowedAppIds) && value.allowedAppIds.every(isText);

const isActionResult = (value: unknown): value is DesktopBridgeActionResult => isRecord(value) &&
  value.schemaVersion === 1 &&
  (value.status === 'succeeded' || value.status === 'failed' || value.status === 'uncertain') &&
  isText(value.sourceRef) && isText(value.summary) &&
  (value.content === undefined || typeof value.content === 'string') &&
  (value.errorCode === undefined || isText(value.errorCode));

const combineAbortSignals = (timeoutMs: number, upstream?: AbortSignal): {
  signal: AbortSignal;
  dispose: () => void;
} => {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, Math.max(1, Math.min(timeoutMs, 30_000)));
  if (upstream?.aborted) abort();
  else upstream?.addEventListener('abort', abort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      upstream?.removeEventListener('abort', abort);
    },
  };
};

const toDesktopWireAction = (action: DesktopAction): Record<string, unknown> => {
  switch (action.type) {
    case 'desktop.discover':
      return { type: action.type, appId: action.appId };
    case 'desktop.inspect':
      return {
        type: action.type, appId: action.appId, windowId: action.windowId,
        treeRevision: action.treeRevision,
      };
    case 'desktop.click':
      return {
        type: action.type, appId: action.appId, windowId: action.windowId,
        treeRevision: action.treeRevision, nodeId: action.nodeId,
      };
    case 'desktop.type':
      return {
        type: action.type, appId: action.appId, windowId: action.windowId,
        treeRevision: action.treeRevision, nodeId: action.nodeId,
        payloadHash: action.payloadHash,
      };
    default:
      throw new Error('Desktop action is not supported by the native v1 bridge.');
  }
};

export const createDesktopBridgeClient = (options: DesktopBridgeClientOptions): DesktopBridgeClient => {
  if (!isLoopbackDesktopBridgeUrl(options.baseUrl)) {
    throw new Error('Desktop bridge URL must be an explicit loopback HTTP origin with a port.');
  }
  if (options.token.trim().length < 32) {
    throw new Error('Desktop bridge token must contain at least 32 characters.');
  }
  const baseUrl = options.baseUrl.replace(/\/$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const randomId = options.randomId ?? (() => crypto.randomUUID());

  const request = async <T>(input: {
    method: 'GET' | 'POST';
    path: '/v1/health' | '/v1/actions';
    body?: unknown;
    timeoutMs: number;
    signal?: AbortSignal;
    validate(value: unknown): value is T;
  }): Promise<T> => {
    const body = input.body === undefined ? '' : JSON.stringify(input.body);
    const requestId = randomId();
    const issuedAt = now();
    const expiresAt = issuedAt + Math.min(input.timeoutMs, DEFAULT_REQUEST_TTL_MS);
    const contentHash = sha256(body);
    const signature = signDesktopBridgeRequest(options.token, {
      method: input.method,
      path: input.path,
      requestId,
      issuedAt,
      expiresAt,
      contentHash,
    });
    const abort = combineAbortSignals(input.timeoutMs, input.signal);
    try {
      const response = await fetchImpl(`${baseUrl}${input.path}`, {
        method: input.method,
        headers: {
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
          'x-provenance-request-id': requestId,
          'x-provenance-issued-at': String(issuedAt),
          'x-provenance-expires-at': String(expiresAt),
          'x-provenance-content-sha256': contentHash,
          'x-provenance-signature': signature,
        },
        ...(body ? { body } : {}),
        signal: abort.signal,
      });
      const responseBody = await response.text();
      if (Buffer.byteLength(responseBody, 'utf8') > MAX_RESPONSE_BYTES) {
        throw new Error('Desktop bridge response exceeded the size limit.');
      }
      const responseHash = sha256(responseBody);
      const suppliedHash = response.headers.get('x-provenance-response-sha256') ?? '';
      const suppliedSignature = response.headers.get('x-provenance-response-signature') ?? '';
      const expectedSignature = signDesktopBridgeResponse(options.token, requestId, response.status, responseHash);
      const signatureMatches = suppliedSignature.length === expectedSignature.length &&
        crypto.timingSafeEqual(Buffer.from(suppliedSignature), Buffer.from(expectedSignature));
      if (suppliedHash !== responseHash || !signatureMatches) {
        throw new Error('Desktop bridge response authentication failed.');
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(responseBody);
      } catch {
        throw new Error('Desktop bridge returned invalid JSON.');
      }
      if (!response.ok) {
        // Native execution failures (for example stale_tree) are signed,
        // schema-valid worker results even when their HTTP status is 4xx.
        if (input.path === '/v1/actions' && input.validate(parsed)) return parsed;
        const message = isRecord(parsed) && typeof parsed.error === 'string'
          ? parsed.error : `Desktop bridge request failed with status ${response.status}.`;
        throw new Error(message);
      }
      if (!input.validate(parsed)) throw new Error('Desktop bridge response schema is invalid.');
      return parsed;
    } finally {
      abort.dispose();
    }
  };

  return {
    health: (signal) => request({
      method: 'GET',
      path: '/v1/health',
      timeoutMs: 2_000,
      signal,
      validate: isHealth,
    }),
    perform: (action, performOptions) => request({
      method: 'POST',
      path: '/v1/actions',
      body: {
        schemaVersion: 1,
        action: toDesktopWireAction(action),
        ...(performOptions.payloadText === undefined ? {} : { payloadText: performOptions.payloadText }),
      },
      timeoutMs: performOptions.timeoutMs,
      signal: performOptions.signal,
      validate: isActionResult,
    }),
  };
};

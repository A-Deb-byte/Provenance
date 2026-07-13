import { ProviderExecutionError, ProviderId } from './types';

export type ProviderErrorCode =
  | 'not_configured'
  | 'unsupported_capability'
  | 'invalid_model'
  | 'invalid_request'
  | 'authentication'
  | 'rate_limited'
  | 'timeout'
  | 'aborted'
  | 'unavailable'
  | 'invalid_response'
  | 'transport'
  | 'ensemble_limit';

export interface ProviderErrorOptions {
  readonly provider?: ProviderId;
  readonly retryable?: boolean;
  readonly status?: number;
  readonly cause?: unknown;
}

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly provider?: ProviderId;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(code: ProviderErrorCode, message: string, options: ProviderErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProviderError';
    this.code = code;
    this.provider = options.provider;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
  }

  toJSON(): ProviderExecutionError {
    return {
      provider: this.provider ?? 'gemini',
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      status: this.status,
    };
  }
}

export const providerHttpError = (provider: ProviderId, status: number): ProviderError => {
  if (status === 401 || status === 403) {
    return new ProviderError('authentication', 'Provider authentication failed.', { provider, status });
  }
  if (status === 429) {
    return new ProviderError('rate_limited', 'Provider rate limit exceeded.', {
      provider, status, retryable: true,
    });
  }
  if (status === 408 || status === 504) {
    return new ProviderError('timeout', 'Provider request timed out.', {
      provider, status, retryable: true,
    });
  }
  if (status >= 500) {
    return new ProviderError('unavailable', 'Provider service is unavailable.', {
      provider, status, retryable: true,
    });
  }
  return new ProviderError('invalid_request', 'Provider rejected the request.', { provider, status });
};

export const normalizeProviderError = (error: unknown, provider: ProviderId): ProviderError => {
  if (error instanceof ProviderError) return error;
  if (
    (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  ) {
    return new ProviderError('aborted', 'Provider request was aborted.', { provider, cause: error });
  }
  return new ProviderError('transport', 'Provider transport failed.', {
    provider, retryable: true, cause: error,
  });
};

export const serializeProviderError = (error: unknown, provider: ProviderId): ProviderExecutionError => {
  return normalizeProviderError(error, provider).toJSON();
};

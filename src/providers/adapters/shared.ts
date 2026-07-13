import { ProviderError } from '../errors';
import { assertValidStructuredOutput } from '../schema';
import {
  ProviderCapability,
  ProviderFinishReason,
  ProviderId,
  ProviderRequest,
  ProviderResponseFormat,
  ProviderToolCall,
  ProviderUsage,
} from '../types';

export const emptyUsage = (): ProviderUsage => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });

export const requiredCapabilitiesForRequest = (request: ProviderRequest): readonly ProviderCapability[] => {
  const required = new Set<ProviderCapability>(['text', ...request.requiredCapabilities]);
  if (request.responseFormat.type === 'json_object') required.add('json_object');
  if (request.responseFormat.type === 'json_schema') required.add('json_schema');
  if (request.tools?.length) required.add('tools');
  return [...required];
};

export const resolveModel = (
  provider: ProviderId,
  allowedModels: readonly string[],
  defaultModel: string,
  requestedModel?: string,
): string => {
  const model = requestedModel || defaultModel;
  if (!allowedModels.includes(model)) {
    throw new ProviderError('invalid_model', 'Requested model is not in the provider allowlist.', { provider });
  }
  return model;
};

export const assertCapabilities = (
  provider: ProviderId,
  supported: readonly ProviderCapability[],
  request: ProviderRequest,
): void => {
  const missing = requiredCapabilitiesForRequest(request).filter((capability) => !supported.includes(capability));
  if (missing.length) {
    throw new ProviderError(
      'unsupported_capability',
      'Provider does not satisfy the required capabilities.',
      { provider },
    );
  }
};

export const normalizeFinishReason = (reason: unknown): ProviderFinishReason => {
  if (reason === 'stop' || reason === 'STOP' || reason === 'end_turn' || reason === 'completed') return 'stop';
  if (reason === 'length' || reason === 'MAX_TOKENS' || reason === 'max_tokens') return 'length';
  if (reason === 'tool_calls' || reason === 'TOOL_USE' || reason === 'tool_use') return 'tool_calls';
  if (reason === 'content_filter' || reason === 'SAFETY' || reason === 'guardrail_intervened') return 'content_filter';
  if (reason === 'error' || reason === 'failed') return 'error';
  return 'unknown';
};

export const normalizeUsage = (usage: Partial<ProviderUsage> | undefined): ProviderUsage => {
  const inputTokens = Number.isFinite(usage?.inputTokens) ? Math.max(0, usage!.inputTokens!) : 0;
  const outputTokens = Number.isFinite(usage?.outputTokens) ? Math.max(0, usage!.outputTokens!) : 0;
  const suppliedTotal = Number.isFinite(usage?.totalTokens) ? Math.max(0, usage!.totalTokens!) : undefined;
  return { inputTokens, outputTokens, totalTokens: suppliedTotal ?? inputTokens + outputTokens };
};

export const parseStructuredText = (
  text: string,
  format: ProviderResponseFormat,
  provider: ProviderId,
): unknown => {
  if (format.type === 'text') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ProviderError('invalid_response', 'Provider returned invalid JSON output.', { provider, cause: error });
  }
  if (format.type === 'json_schema') assertValidStructuredOutput(parsed, format.schema, provider);
  return parsed;
};

export const parseToolArguments = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

export const normalizeToolCalls = (calls: unknown): ProviderToolCall[] => {
  if (!Array.isArray(calls)) return [];
  return calls.flatMap((call): ProviderToolCall[] => {
    if (!call || typeof call !== 'object') return [];
    const record = call as Record<string, unknown>;
    const fn = record.function && typeof record.function === 'object'
      ? record.function as Record<string, unknown>
      : record;
    const id = typeof record.id === 'string' ? record.id
      : typeof record.call_id === 'string' ? record.call_id : '';
    const name = typeof fn.name === 'string' ? fn.name : '';
    if (!id || !name) return [];
    return [{ id, name, arguments: parseToolArguments(fn.arguments ?? record.arguments) }];
  });
};

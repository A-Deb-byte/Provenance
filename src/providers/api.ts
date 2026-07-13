import express from 'express';
import { ProviderError } from './errors';
import {
  PROVIDER_IDS,
  ProviderId,
  ProviderPublicStatus,
  ProviderRequest,
  ProviderRoutePlan,
  ProviderRoutingPolicy,
} from './types';

export interface ProviderApiRuntime {
  readonly statuses: readonly ProviderPublicStatus[];
  plan(request: ProviderRequest, policy: ProviderRoutingPolicy): ProviderRoutePlan;
}

const providerIds = new Set<string>(PROVIDER_IDS);
const messageRoles = new Set(['system', 'user', 'assistant', 'tool']);
const capabilities = new Set(['text', 'streaming', 'json_object', 'json_schema', 'tools']);
const allowedRequestKeys = new Set([
  'id',
  'model',
  'messages',
  'requiredCapabilities',
  'responseFormat',
  'tools',
  'maxOutputTokens',
  'temperature',
  'metadata',
]);

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const isProviderMessage = (value: unknown): boolean => (
  isRecord(value) &&
  Object.keys(value).every((key) => key === 'role' || key === 'content' || key === 'toolCallId') &&
  typeof value.role === 'string' &&
  messageRoles.has(value.role) &&
  typeof value.content === 'string' &&
  (value.toolCallId === undefined || typeof value.toolCallId === 'string')
);

const isResponseFormat = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  if (value.type === 'text' || value.type === 'json_object') {
    return Object.keys(value).length === 1;
  }
  return (
    value.type === 'json_schema' &&
    typeof value.name === 'string' &&
    isRecord(value.schema)
  );
};

const validatePlanRequest = (value: unknown): string | null => {
  if (!isRecord(value)) return 'Provider request must be an object.';
  const unexpectedKey = Object.keys(value).find((key) => !allowedRequestKeys.has(key));
  if (unexpectedKey) return `Provider request field is not allowed: ${unexpectedKey}.`;
  if (typeof value.id !== 'string' || !value.id.trim()) return 'Provider request id is required.';
  if (!Array.isArray(value.messages) || value.messages.length === 0 || !value.messages.every(isProviderMessage)) {
    return 'Provider request messages are invalid.';
  }
  if (
    !Array.isArray(value.requiredCapabilities) ||
    !value.requiredCapabilities.every((item) => typeof item === 'string' && capabilities.has(item))
  ) {
    return 'Provider request capabilities are invalid.';
  }
  if (!isResponseFormat(value.responseFormat)) return 'Provider request response format is invalid.';
  if (value.model !== undefined && typeof value.model !== 'string') return 'Provider request model is invalid.';
  if (value.maxOutputTokens !== undefined && !Number.isSafeInteger(value.maxOutputTokens)) {
    return 'Provider request maxOutputTokens is invalid.';
  }
  if (value.temperature !== undefined && typeof value.temperature !== 'number') {
    return 'Provider request temperature is invalid.';
  }
  return null;
};

const validateRoutingPolicy = (value: unknown): string | null => {
  if (!isRecord(value)) return 'Routing policy must be an object.';
  if (value.mode === 'automatic') return null;
  if (value.mode === 'pinned') {
    if (typeof value.provider !== 'string' || !providerIds.has(value.provider)) {
      return 'Pinned routing requires a known provider id.';
    }
    if (value.model !== undefined && typeof value.model !== 'string') return 'Pinned model is invalid.';
    return null;
  }
  if (value.mode === 'ensemble') {
    if (!Number.isSafeInteger(value.maxProviders) || (value.maxProviders as number) < 1) {
      return 'Ensemble routing requires a positive maxProviders.';
    }
    if (
      value.providers !== undefined &&
      (!Array.isArray(value.providers) || !value.providers.every((item) => typeof item === 'string' && providerIds.has(item)))
    ) {
      return 'Ensemble provider filter is invalid.';
    }
    return null;
  }
  return 'Routing policy mode must be automatic, pinned, or ensemble.';
};

const planErrorStatus = (error: unknown): number => {
  if (!(error instanceof ProviderError)) return 400;
  if (error.code === 'not_configured' || error.code === 'unavailable') return 503;
  return 409;
};

export const createProviderApi = (runtime: ProviderApiRuntime) => {
  const router = express.Router();

  router.get('/status', (_req, res) => {
    res.json({ providers: runtime.statuses });
  });

  router.post('/plan', (req, res) => {
    const request = req.body?.request as unknown;
    const policy = req.body?.policy as unknown;
    const requestError = validatePlanRequest(request);
    if (requestError) {
      res.status(400).json({ error: requestError });
      return;
    }
    const policyError = validateRoutingPolicy(policy);
    if (policyError) {
      res.status(400).json({ error: policyError });
      return;
    }

    try {
      const plan = runtime.plan(
        request as ProviderRequest,
        policy as ProviderRoutingPolicy & { provider?: ProviderId },
      );
      res.json({ plan });
    } catch (error) {
      res.status(planErrorStatus(error)).json({
        error: error instanceof Error ? error.message : 'Routing plan failed.',
      });
    }
  });

  return router;
};

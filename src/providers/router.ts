import { ProviderError, serializeProviderError } from './errors';
import { requiredCapabilitiesForRequest } from './adapters/shared';
import { ProviderTelemetryStore } from './telemetry';
import {
  ProviderAdapter,
  ProviderEvent,
  ProviderExecution,
  ProviderId,
  ProviderRequest,
  ProviderRoutePlan,
  ProviderRouteSelection,
  ProviderRoutingPolicy,
} from './types';

export interface ProviderRouterOptions {
  readonly maxEnsembleProviders?: number;
}

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
};

const comparableOutput = (result: ProviderExecution['results'][number]): string => {
  return result.structured === undefined
    ? result.text.trim()
    : JSON.stringify(stableValue(result.structured));
};

export class ProviderRouter {
  private readonly adapters: ReadonlyMap<ProviderId, ProviderAdapter>;
  private readonly telemetry: ProviderTelemetryStore;
  private readonly maxEnsembleProviders: number;

  constructor(
    adapters: readonly ProviderAdapter[],
    telemetry = new ProviderTelemetryStore(),
    options: ProviderRouterOptions = {},
  ) {
    const adapterMap = new Map<ProviderId, ProviderAdapter>();
    for (const adapter of adapters) {
      if (adapterMap.has(adapter.id)) throw new Error(`Duplicate provider adapter: ${adapter.id}.`);
      adapterMap.set(adapter.id, adapter);
    }
    this.adapters = adapterMap;
    this.telemetry = telemetry;
    const configuredLimit = options.maxEnsembleProviders ?? 3;
    if (!Number.isSafeInteger(configuredLimit) || configuredLimit < 1) {
      throw new Error('Ensemble provider limit must be a positive safe integer.');
    }
    this.maxEnsembleProviders = configuredLimit;
  }

  private supports(adapter: ProviderAdapter, request: ProviderRequest): boolean {
    return requiredCapabilitiesForRequest(request)
      .every((capability) => adapter.status.capabilities.includes(capability));
  }

  private rankedEligible(request: ProviderRequest, permitted?: readonly ProviderId[]): ProviderAdapter[] {
    const allowed = permitted ? new Set(permitted) : undefined;
    return [...this.adapters.values()]
      .filter((adapter) => (!allowed || allowed.has(adapter.id)) && adapter.status.configured && this.supports(adapter, request))
      .sort((left, right) => {
        const leftTelemetry = this.telemetry.snapshot(left.id);
        const rightTelemetry = this.telemetry.snapshot(right.id);
        const leftReliability = leftTelemetry.calls ? leftTelemetry.successes / leftTelemetry.calls : 0.5;
        const rightReliability = rightTelemetry.calls ? rightTelemetry.successes / rightTelemetry.calls : 0.5;
        if (leftReliability !== rightReliability) return rightReliability - leftReliability;
        const leftVerified = leftTelemetry.verifiedSuccesses;
        const rightVerified = rightTelemetry.verifiedSuccesses;
        if (leftVerified !== rightVerified) return rightVerified - leftVerified;
        const leftLatency = leftTelemetry.averageLatencyMs ?? Number.POSITIVE_INFINITY;
        const rightLatency = rightTelemetry.averageLatencyMs ?? Number.POSITIVE_INFINITY;
        if (leftLatency !== rightLatency) return leftLatency - rightLatency;
        if (left.status.routingPriority !== right.status.routingPriority) {
          return left.status.routingPriority - right.status.routingPriority;
        }
        return left.id.localeCompare(right.id);
      });
  }

  private selection(adapter: ProviderAdapter, requestedModel?: string): ProviderRouteSelection {
    const model = requestedModel || adapter.status.defaultModel;
    if (!adapter.status.allowedModels.includes(model)) {
      throw new ProviderError('invalid_model', 'Requested model is not in the provider allowlist.', {
        provider: adapter.id,
      });
    }
    return { provider: adapter.id, model };
  }

  plan(request: ProviderRequest, policy: ProviderRoutingPolicy): ProviderRoutePlan {
    if (policy.mode === 'pinned') {
      const adapter = this.adapters.get(policy.provider);
      if (!adapter || !adapter.status.configured) {
        throw new ProviderError('not_configured', 'Pinned provider is not configured.', { provider: policy.provider });
      }
      if (!this.supports(adapter, request)) {
        throw new ProviderError('unsupported_capability', 'Pinned provider does not satisfy required capabilities.', {
          provider: policy.provider,
        });
      }
      return {
        mode: policy.mode,
        selections: [this.selection(adapter, policy.model)],
        reason: 'Provider and model were pinned by routing policy.',
      };
    }

    const eligible = this.rankedEligible(request, policy.mode === 'ensemble' ? policy.providers : undefined);
    if (!eligible.length) {
      throw new ProviderError(
        'unsupported_capability',
        'No configured provider satisfies the request capabilities.',
      );
    }
    if (policy.mode === 'automatic') {
      return {
        mode: policy.mode,
        selections: [this.selection(eligible[0])],
        reason: 'Selected deterministically from configured capabilities and operational telemetry.',
      };
    }
    if (!Number.isSafeInteger(policy.maxProviders) || policy.maxProviders < 1) {
      throw new ProviderError('ensemble_limit', 'Ensemble size must be a positive safe integer.');
    }
    const limit = Math.min(policy.maxProviders, this.maxEnsembleProviders);
    return {
      mode: policy.mode,
      selections: eligible.slice(0, limit).map((adapter) => this.selection(adapter)),
      reason: `Selected up to ${limit} providers under the bounded ensemble policy.`,
    };
  }

  async execute(request: ProviderRequest, plan: ProviderRoutePlan, signal: AbortSignal): Promise<ProviderExecution> {
    const outcomes = await Promise.all(plan.selections.map(async (selection) => {
      const adapter = this.adapters.get(selection.provider);
      if (!adapter) {
        return { selection, error: new ProviderError('not_configured', 'Routed provider adapter is unavailable.', {
          provider: selection.provider,
        }) };
      }
      const startedAt = Date.now();
      try {
        const result = await adapter.generate({ ...request, model: selection.model }, signal);
        this.telemetry.record({
          provider: selection.provider,
          succeeded: true,
          latencyMs: result.latencyMs,
          usage: result.usage,
        });
        return { selection, result };
      } catch (error) {
        this.telemetry.record({
          provider: selection.provider,
          succeeded: false,
          latencyMs: Math.max(0, Date.now() - startedAt),
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        });
        return { selection, error };
      }
    }));
    const results = outcomes.flatMap((outcome) => outcome.result ? [outcome.result] : []);
    const errors = outcomes.flatMap((outcome) => outcome.error
      ? [serializeProviderError(outcome.error, outcome.selection.provider)] : []);
    if (!results.length) {
      throw new ProviderError('unavailable', 'All routed provider calls failed.', { retryable: errors.some((error) => error.retryable) });
    }
    return {
      plan,
      results,
      errors,
      disagreement: new Set(results.map(comparableOutput)).size > 1,
    };
  }

  async *stream(request: ProviderRequest, plan: ProviderRoutePlan, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    if (plan.selections.length !== 1) {
      throw new ProviderError('ensemble_limit', 'Streaming requires exactly one routed provider.');
    }
    const selection = plan.selections[0];
    const adapter = this.adapters.get(selection.provider);
    if (!adapter) throw new ProviderError('not_configured', 'Routed provider adapter is unavailable.', {
      provider: selection.provider,
    });
    yield* adapter.stream({ ...request, model: selection.model }, signal);
  }
}

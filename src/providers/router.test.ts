import { describe, expect, it } from 'vitest';
import { ProviderError } from './errors';
import { ProviderRouter } from './router';
import { ProviderTelemetryStore } from './telemetry';
import {
  ProviderAdapter,
  ProviderCapability,
  ProviderEvent,
  ProviderId,
  ProviderRequest,
  ProviderResult,
} from './types';

const request: ProviderRequest = {
  id: 'route_request',
  messages: [{ role: 'user', content: 'Answer' }],
  requiredCapabilities: ['text'],
  responseFormat: { type: 'text' },
};

const adapter = (
  id: ProviderId,
  capabilities: ProviderCapability[],
  text: string = id,
  configured = true,
): ProviderAdapter => ({
  id,
  status: {
    id,
    configured,
    credentialSource: id === 'aws' ? 'aws_default_chain' : 'server_env',
    endpoint: `fixed://${id}`,
    defaultModel: `${id}-model`,
    allowedModels: [`${id}-model`],
    capabilities,
    routingPriority: 10,
    unavailableReason: configured ? undefined : 'Credentials are not configured.',
  },
  async generate(): Promise<ProviderResult> {
    return {
      requestId: request.id,
      providerRequestId: `${id}_response`,
      provider: id,
      model: `${id}-model`,
      text,
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finishReason: 'stop',
      latencyMs: id === 'gemini' ? 20 : 10,
    };
  },
  async *stream(): AsyncIterable<ProviderEvent> {
    yield { type: 'text_delta', text };
    yield { type: 'completed', finishReason: 'stop' };
  },
});

describe('provider telemetry and routing', () => {
  it('orders automatic routes deterministically using stable telemetry and tie-breaks', () => {
    const telemetry = new ProviderTelemetryStore();
    telemetry.record({ provider: 'gemini', succeeded: false, latencyMs: 20, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
    telemetry.record({ provider: 'openai', succeeded: true, latencyMs: 50, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
    const router = new ProviderRouter([
      adapter('gemini', ['text']),
      adapter('openai', ['text']),
      adapter('deepseek', ['text']),
    ], telemetry);

    expect(router.plan(request, { mode: 'automatic' }).selections[0].provider).toBe('openai');
    expect(telemetry.snapshot('openai')).toMatchObject({ calls: 1, successes: 1, averageLatencyMs: 50 });
  });

  it('enforces pinned provider availability, model allowlists, and capabilities', () => {
    const router = new ProviderRouter([
      adapter('openai', ['text'], 'openai', false),
      adapter('deepseek', ['text', 'json_object']),
    ]);

    expect(() => router.plan(request, { mode: 'pinned', provider: 'openai' })).toThrow(ProviderError);
    expect(() => router.plan(request, { mode: 'pinned', provider: 'deepseek', model: 'unknown' })).toThrow('allowlist');
    expect(() => router.plan({ ...request, requiredCapabilities: ['json_schema'] }, {
      mode: 'pinned', provider: 'deepseek',
    })).toThrow('capabilities');
  });

  it('bounds ensembles and preserves disagreement as evidence', async () => {
    const router = new ProviderRouter([
      adapter('gemini', ['text'], 'same'),
      adapter('openai', ['text'], 'different'),
      adapter('openrouter', ['text'], 'third'),
    ], undefined, { maxEnsembleProviders: 2 });
    const plan = router.plan(request, { mode: 'ensemble', maxProviders: 3 });

    expect(plan.selections).toHaveLength(2);
    const execution = await router.execute(request, plan, new AbortController().signal);
    expect(execution.results).toHaveLength(2);
    expect(execution.disagreement).toBe(true);
    expect(execution.errors).toEqual([]);
  });

  it('fails when no configured provider satisfies the request', () => {
    const router = new ProviderRouter([adapter('deepseek', ['text'])]);

    expect(() => router.plan({ ...request, requiredCapabilities: ['json_schema'] }, { mode: 'automatic' }))
      .toThrow('No configured provider satisfies');
  });

  it('reports sanitized provider failure codes when every route fails', async () => {
    const failing = adapter('openrouter', ['text']);
    const router = new ProviderRouter([{
      ...failing,
      generate: async () => {
        throw new ProviderError('rate_limited', 'Provider rate limit exceeded.', {
          provider: 'openrouter', status: 429, retryable: true,
        });
      },
    }]);
    const plan = router.plan(request, { mode: 'pinned', provider: 'openrouter' });

    await expect(router.execute(request, plan, new AbortController().signal))
      .rejects.toThrow('openrouter:rate_limited(429)');
  });
});

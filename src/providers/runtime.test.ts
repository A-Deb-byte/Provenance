import { describe, expect, it, vi } from 'vitest';
import { BedrockConverseTransport } from './adapters/bedrock';
import { revealServerSecret } from './secrets';
import { createProviderRuntime, GeminiSdkClient } from './runtime';
import { ProviderRequest } from './types';

const previewRequest: ProviderRequest = {
  id: 'preview_1',
  messages: [{ role: 'user', content: 'Preview routing.' }],
  requiredCapabilities: ['text'],
  responseFormat: { type: 'text' },
};

const fakeGeminiClient = (): GeminiSdkClient => ({
  models: {
    generateContent: vi.fn(async () => ({
      responseId: 'gemini_response',
      modelVersion: 'gemini-3.5-flash',
      text: 'hello',
      functionCalls: [],
      candidates: [{ finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 },
    })),
    generateContentStream: vi.fn(async () => (async function* () {
      yield {
        modelVersion: 'gemini-3.5-flash',
        text: 'hello',
        candidates: [{ finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 },
      };
    })()),
  },
});

describe('provider runtime', () => {
  it('builds configured adapters from server environment without serializing secrets', () => {
    const client = fakeGeminiClient();
    const geminiClientFactory = vi.fn((secret) => {
      expect(revealServerSecret(secret)).toBe('gemini-private');
      return client;
    });
    const runtime = createProviderRuntime({
      env: {
        GEMINI_API_KEY: 'gemini-private',
        OPENAI_API_KEY: 'openai-private',
        AWS_PROFILE: 'dev',
        AWS_REGION: 'us-east-1',
      },
      fetch: vi.fn(),
      geminiClientFactory,
    });

    expect(geminiClientFactory).toHaveBeenCalledOnce();
    expect(runtime.statuses.find((status) => status.id === 'gemini')?.configured).toBe(true);
    expect(runtime.statuses.find((status) => status.id === 'openai')?.configured).toBe(true);
    expect(runtime.statuses.find((status) => status.id === 'aws')).toMatchObject({
      configured: false,
      unavailableReason: 'AWS Bedrock transport is not installed.',
    });
    expect(runtime.plan(previewRequest, { mode: 'pinned', provider: 'openai' }).selections[0])
      .toEqual({ provider: 'openai', model: 'gpt-5.6' });
    expect(JSON.stringify(runtime)).not.toContain('gemini-private');
    expect(JSON.stringify(runtime)).not.toContain('openai-private');
  });

  it('constructs the real Gemini SDK client by default without making a network call', () => {
    expect(() => createProviderRuntime({
      env: { GEMINI_API_KEY: 'server-key' },
      fetch: vi.fn(),
    })).not.toThrow();
  });

  it('enables AWS only when credentials, region, and an injected transport exist', () => {
    const bedrockTransport: BedrockConverseTransport = {
      converse: vi.fn(),
      converseStream: vi.fn(),
    };
    const runtime = createProviderRuntime({
      env: { AWS_PROFILE: 'dev', AWS_REGION: 'us-east-1' },
      fetch: vi.fn(),
      bedrockTransport,
    });

    expect(runtime.statuses.find((status) => status.id === 'aws')?.configured).toBe(true);
    expect(runtime.plan(previewRequest, { mode: 'pinned', provider: 'aws' }).selections[0])
      .toEqual({ provider: 'aws', model: 'amazon.nova-lite-v1:0' });
  });
});

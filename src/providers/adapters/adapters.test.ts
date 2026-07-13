import { describe, expect, it, vi } from 'vitest';
import { getProviderConfig, loadProviderConfigs } from '../config';
import { createServerSecret } from '../secrets';
import { ProviderRequest } from '../types';
import { BedrockAdapter, BedrockConverseTransport } from './bedrock';
import { GeminiAdapter, GeminiTransport } from './gemini';
import { FetchLike, OpenAICompatibleAdapter } from './openaiCompatible';

const structuredRequest: ProviderRequest = {
  id: 'request_1',
  messages: [{ role: 'user', content: 'Return an answer.' }],
  requiredCapabilities: ['json_schema'],
  responseFormat: {
    type: 'json_schema',
    name: 'answer',
    schema: {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
      additionalProperties: false,
    },
  },
};

const textRequest: ProviderRequest = {
  id: 'request_2',
  messages: [{ role: 'user', content: 'Hello' }],
  requiredCapabilities: ['text'],
  responseFormat: { type: 'text' },
};

describe('provider adapters', () => {
  it('normalizes OpenAI Responses output and never uses a client endpoint', async () => {
    const config = getProviderConfig(loadProviderConfigs({ OPENAI_API_KEY: 'secret' }), 'openai');
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify({
      id: 'resp_1',
      model: 'gpt-5.6',
      output_text: '{"answer":"ok"}',
      usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
      status: 'completed',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const adapter = new OpenAICompatibleAdapter({
      config,
      secret: createServerSecret('openai', 'secret'),
      fetch,
    });

    const result = await adapter.generate(structuredRequest, new AbortController().signal);

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toBe('https://api.openai.com/v1/responses');
    const body = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(body.text.format).toMatchObject({ type: 'json_schema', name: 'answer', strict: true });
    expect(result).toMatchObject({
      provider: 'openai',
      model: 'gpt-5.6',
      text: '{"answer":"ok"}',
      structured: { answer: 'ok' },
      usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 },
      finishReason: 'stop',
    });
  });

  it('normalizes OpenAI-compatible chat output for DeepSeek', async () => {
    const config = getProviderConfig(loadProviderConfigs({ DEEPSEEK_API_KEY: 'secret' }), 'deepseek');
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify({
      id: 'chat_1',
      model: 'deepseek-v4-flash',
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'hello' } }],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    }), { status: 200 }));
    const adapter = new OpenAICompatibleAdapter({
      config,
      secret: createServerSecret('deepseek', 'secret'),
      fetch,
    });

    const result = await adapter.generate(textRequest, new AbortController().signal);

    expect(fetch.mock.calls[0][0]).toBe('https://api.deepseek.com/chat/completions');
    expect(result).toMatchObject({
      provider: 'deepseek',
      text: 'hello',
      usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
    });
  });

  it('normalizes SSE text and usage events', async () => {
    const config = getProviderConfig(loadProviderConfigs({ OPENROUTER_API_KEY: 'secret' }), 'openrouter');
    const stream = [
      'data: {"id":"chunk_1","model":"openai/gpt-5.6","choices":[{"delta":{"content":"hel"}}]}',
      '',
      'data: {"id":"chunk_1","model":"openai/gpt-5.6","choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const adapter = new OpenAICompatibleAdapter({
      config,
      secret: createServerSecret('openrouter', 'secret'),
      fetch: async () => new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    });
    const events = [];

    for await (const event of adapter.stream(textRequest, new AbortController().signal)) events.push(event);

    expect(events).toEqual([
      { type: 'text_delta', text: 'hel' },
      { type: 'text_delta', text: 'lo' },
      { type: 'usage', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } },
      { type: 'completed', finishReason: 'stop' },
    ]);
  });

  it('normalizes an injected Gemini transport without importing credentials', async () => {
    const transport: GeminiTransport = {
      generate: vi.fn(async () => ({
        id: 'gemini_1', model: 'gemini-3.5-flash', text: '{"answer":"gemini"}',
        usage: { inputTokens: 7, outputTokens: 4, totalTokens: 11 }, finishReason: 'STOP',
      })),
      stream: async function* () { yield { type: 'text', text: 'ok' }; },
    };
    const config = getProviderConfig(loadProviderConfigs({ GEMINI_API_KEY: 'secret' }), 'gemini');
    const adapter = new GeminiAdapter({ config, transport });

    const result = await adapter.generate(structuredRequest, new AbortController().signal);

    expect(transport.generate).toHaveBeenCalledOnce();
    expect(result.structured).toEqual({ answer: 'gemini' });
    expect(result.usage.totalTokens).toBe(11);
  });

  it('normalizes injected Bedrock Converse output and streaming events', async () => {
    const transport: BedrockConverseTransport = {
      converse: vi.fn(async () => ({
        requestId: 'aws_1', model: 'amazon.nova-lite-v1:0', text: 'bedrock',
        usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 }, stopReason: 'end_turn',
      })),
      converseStream: async function* () {
        yield { type: 'text', text: 'bed' };
        yield { type: 'text', text: 'rock' };
        yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } };
        yield { type: 'done', stopReason: 'end_turn' };
      },
    };
    const config = getProviderConfig(loadProviderConfigs({ AWS_PROFILE: 'dev', AWS_REGION: 'us-east-1' }), 'aws');
    const adapter = new BedrockAdapter({ config, transport });

    const result = await adapter.generate(textRequest, new AbortController().signal);
    const events = [];
    for await (const event of adapter.stream(textRequest, new AbortController().signal)) events.push(event);

    expect(result).toMatchObject({ provider: 'aws', text: 'bedrock', finishReason: 'stop' });
    expect(events.at(-1)).toEqual({ type: 'completed', finishReason: 'stop' });
  });

  it('maps provider HTTP failures to sanitized normalized errors', async () => {
    const config = getProviderConfig(loadProviderConfigs({ OPENAI_API_KEY: 'top-secret' }), 'openai');
    const adapter = new OpenAICompatibleAdapter({
      config,
      secret: createServerSecret('openai', 'top-secret'),
      fetch: async () => new Response('top-secret internal upstream body', { status: 429 }),
    });

    await expect(adapter.generate(textRequest, new AbortController().signal)).rejects.toMatchObject({
      code: 'rate_limited', provider: 'openai', retryable: true, status: 429,
    });
    await expect(adapter.generate(textRequest, new AbortController().signal)).rejects.not.toThrow('top-secret');
  });
});

import { providerHttpError, normalizeProviderError, ProviderError } from '../errors';
import { revealServerSecret, ServerSecret } from '../secrets';
import {
  ProviderAdapter,
  ProviderEvent,
  ProviderRequest,
  ProviderResult,
  ProviderRuntimeConfig,
  ProviderUsage,
} from '../types';
import { toConfiguredProviderStatus } from '../config';
import {
  assertCapabilities,
  emptyUsage,
  normalizeFinishReason,
  normalizeToolCalls,
  normalizeUsage,
  parseStructuredText,
  resolveModel,
} from './shared';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface OpenAICompatibleAdapterOptions {
  readonly config: ProviderRuntimeConfig;
  readonly secret: ServerSecret;
  readonly fetch: FetchLike;
  readonly now?: () => number;
}

const buildResponseFormat = (request: ProviderRequest, responsesProtocol: boolean): unknown => {
  if (request.responseFormat.type === 'text') return undefined;
  if (responsesProtocol) {
    if (request.responseFormat.type === 'json_object') return { type: 'json_object' };
    return {
      type: 'json_schema',
      name: request.responseFormat.name,
      strict: true,
      schema: request.responseFormat.schema,
    };
  }
  if (request.responseFormat.type === 'json_object') return { type: 'json_object' };
  return {
    type: 'json_schema',
    json_schema: {
      name: request.responseFormat.name,
      strict: true,
      schema: request.responseFormat.schema,
    },
  };
};

const buildTools = (request: ProviderRequest, responsesProtocol: boolean): unknown => {
  if (!request.tools?.length) return undefined;
  return request.tools.map((tool) => responsesProtocol ? {
    type: 'function', name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: true,
  } : {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: true },
  });
};

const extractResponsesText = (payload: Record<string, unknown>): string => {
  if (typeof payload.output_text === 'string') return payload.output_text;
  if (!Array.isArray(payload.output)) return '';
  return payload.output.flatMap((item): string[] => {
    if (!item || typeof item !== 'object') return [];
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) return [];
    return content.flatMap((part): string[] => {
      if (!part || typeof part !== 'object') return [];
      const text = (part as Record<string, unknown>).text;
      return typeof text === 'string' ? [text] : [];
    });
  }).join('');
};

const responsesToolCalls = (payload: Record<string, unknown>) => {
  if (!Array.isArray(payload.output)) return [];
  return normalizeToolCalls(payload.output.filter((item) => (
    item && typeof item === 'object' && (item as Record<string, unknown>).type === 'function_call'
  )));
};

const readJson = async (response: Response, provider: ProviderRuntimeConfig['id']): Promise<Record<string, unknown>> => {
  try {
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Unexpected payload shape.');
    return payload as Record<string, unknown>;
  } catch (error) {
    throw new ProviderError('invalid_response', 'Provider returned an invalid response payload.', {
      provider, cause: error,
    });
  }
};

async function* readSseData(response: Response, provider: ProviderRuntimeConfig['id']): AsyncIterable<string> {
  if (!response.body) throw new ProviderError('invalid_response', 'Provider stream did not include a response body.', { provider });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block.split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data) yield data;
        boundary = buffer.indexOf('\n\n');
      }
      if (done) break;
    }
    const trailing = buffer.trim();
    if (trailing.startsWith('data:')) yield trailing.slice(5).trimStart();
  } finally {
    reader.releaseLock();
  }
}

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly id: ProviderRuntimeConfig['id'];
  readonly status;
  private readonly config: ProviderRuntimeConfig;
  private readonly secret: ServerSecret;
  private readonly fetch: FetchLike;
  private readonly now: () => number;

  constructor(options: OpenAICompatibleAdapterOptions) {
    if (options.config.protocol !== 'openai_responses' && options.config.protocol !== 'openai_chat') {
      throw new Error('OpenAI-compatible adapter requires an OpenAI protocol configuration.');
    }
    this.config = options.config;
    this.id = options.config.id;
    this.status = toConfiguredProviderStatus(options.config);
    this.secret = options.secret;
    this.fetch = options.fetch;
    this.now = options.now ?? Date.now;
  }

  private requestDetails(request: ProviderRequest, stream: boolean) {
    assertCapabilities(this.id, this.config.capabilities, request);
    const model = resolveModel(this.id, this.config.allowedModels, this.config.defaultModel, request.model);
    const responsesProtocol = this.config.protocol === 'openai_responses';
    const responseFormat = buildResponseFormat(request, responsesProtocol);
    const tools = buildTools(request, responsesProtocol);
    const body: Record<string, unknown> = responsesProtocol ? {
      model,
      input: request.messages,
      stream,
      max_output_tokens: request.maxOutputTokens,
      temperature: request.temperature,
      text: responseFormat ? { format: responseFormat } : undefined,
      tools,
    } : {
      model,
      messages: request.messages,
      stream,
      stream_options: stream ? { include_usage: true } : undefined,
      max_tokens: request.maxOutputTokens,
      temperature: request.temperature,
      response_format: responseFormat,
      tools,
    };
    const endpoint = `${this.config.endpoint}/${responsesProtocol ? 'responses' : 'chat/completions'}`;
    return { model, responsesProtocol, endpoint, body };
  }

  private async send(request: ProviderRequest, signal: AbortSignal, stream: boolean) {
    const details = this.requestDetails(request, stream);
    let response: Response;
    try {
      response = await this.fetch(details.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${revealServerSecret(this.secret)}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(details.body),
        signal,
      });
    } catch (error) {
      throw normalizeProviderError(error, this.id);
    }
    if (!response.ok) throw providerHttpError(this.id, response.status);
    return { ...details, response };
  }

  async generate(request: ProviderRequest, signal: AbortSignal): Promise<ProviderResult> {
    const startedAt = this.now();
    const { model, responsesProtocol, response } = await this.send(request, signal, false);
    const payload = await readJson(response, this.id);
    let text = '';
    let toolCalls = [];
    let usage: ProviderUsage = emptyUsage();
    let finishReason = normalizeFinishReason(payload.status);
    let providerRequestId = typeof payload.id === 'string' ? payload.id : undefined;
    let resolvedModel = typeof payload.model === 'string' ? payload.model : model;

    if (responsesProtocol) {
      text = extractResponsesText(payload);
      toolCalls = responsesToolCalls(payload);
      const rawUsage = payload.usage as Record<string, unknown> | undefined;
      usage = normalizeUsage({
        inputTokens: Number(rawUsage?.input_tokens),
        outputTokens: Number(rawUsage?.output_tokens),
        totalTokens: Number(rawUsage?.total_tokens),
      });
      if (finishReason === 'unknown' && payload.status === 'completed') finishReason = 'stop';
    } else {
      const firstChoice = Array.isArray(payload.choices) && payload.choices[0] && typeof payload.choices[0] === 'object'
        ? payload.choices[0] as Record<string, unknown> : {};
      const message = firstChoice.message && typeof firstChoice.message === 'object'
        ? firstChoice.message as Record<string, unknown> : {};
      text = typeof message.content === 'string' ? message.content : '';
      toolCalls = normalizeToolCalls(message.tool_calls);
      const rawUsage = payload.usage as Record<string, unknown> | undefined;
      usage = normalizeUsage({
        inputTokens: Number(rawUsage?.prompt_tokens),
        outputTokens: Number(rawUsage?.completion_tokens),
        totalTokens: Number(rawUsage?.total_tokens),
      });
      finishReason = normalizeFinishReason(firstChoice.finish_reason);
    }
    if (!text && !toolCalls.length) {
      throw new ProviderError('invalid_response', 'Provider response contained no text or tool calls.', { provider: this.id });
    }
    const structured = text ? parseStructuredText(text, request.responseFormat, this.id) : undefined;
    return {
      requestId: request.id,
      providerRequestId,
      provider: this.id,
      model: resolvedModel,
      text,
      structured,
      toolCalls,
      usage,
      finishReason,
      latencyMs: Math.max(0, this.now() - startedAt),
    };
  }

  async *stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    const { responsesProtocol, response } = await this.send(request, signal, true);
    for await (const data of readSseData(response, this.id)) {
      if (data === '[DONE]') continue;
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(data) as Record<string, unknown>;
      } catch (error) {
        throw new ProviderError('invalid_response', 'Provider stream contained invalid JSON.', {
          provider: this.id, cause: error,
        });
      }
      if (responsesProtocol) {
        if (payload.type === 'response.output_text.delta' && typeof payload.delta === 'string') {
          yield { type: 'text_delta', text: payload.delta };
        } else if (payload.type === 'response.completed') {
          const completed = payload.response && typeof payload.response === 'object'
            ? payload.response as Record<string, unknown> : {};
          const rawUsage = completed.usage && typeof completed.usage === 'object'
            ? completed.usage as Record<string, unknown> : {};
          yield { type: 'usage', usage: normalizeUsage({
            inputTokens: Number(rawUsage.input_tokens),
            outputTokens: Number(rawUsage.output_tokens),
            totalTokens: Number(rawUsage.total_tokens),
          }) };
          yield { type: 'completed', finishReason: normalizeFinishReason(completed.status) };
        } else if (payload.type === 'response.failed' || payload.type === 'error') {
          throw new ProviderError('unavailable', 'Provider stream failed.', { provider: this.id, retryable: true });
        }
      } else {
        const choice = Array.isArray(payload.choices) && payload.choices[0] && typeof payload.choices[0] === 'object'
          ? payload.choices[0] as Record<string, unknown> : undefined;
        const delta = choice?.delta && typeof choice.delta === 'object'
          ? choice.delta as Record<string, unknown> : undefined;
        if (typeof delta?.content === 'string' && delta.content) yield { type: 'text_delta', text: delta.content };
        const rawUsage = payload.usage && typeof payload.usage === 'object'
          ? payload.usage as Record<string, unknown> : undefined;
        if (rawUsage) yield { type: 'usage', usage: normalizeUsage({
          inputTokens: Number(rawUsage.prompt_tokens),
          outputTokens: Number(rawUsage.completion_tokens),
          totalTokens: Number(rawUsage.total_tokens),
        }) };
        if (choice?.finish_reason) yield { type: 'completed', finishReason: normalizeFinishReason(choice.finish_reason) };
      }
    }
  }
}

import { toConfiguredProviderStatus } from '../config';
import { normalizeProviderError, ProviderError } from '../errors';
import {
  ProviderAdapter,
  ProviderEvent,
  ProviderRequest,
  ProviderResult,
  ProviderRuntimeConfig,
  ProviderToolCall,
  ProviderUsage,
} from '../types';
import {
  assertCapabilities,
  emptyUsage,
  normalizeFinishReason,
  normalizeUsage,
  parseStructuredText,
  resolveModel,
} from './shared';

export interface GeminiTransportRequest {
  readonly model: string;
  readonly systemInstruction?: string;
  readonly messages: readonly { readonly role: 'user' | 'model'; readonly text: string }[];
  readonly responseFormat: ProviderRequest['responseFormat'];
  readonly tools?: ProviderRequest['tools'];
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
}

export interface GeminiTransportResponse {
  readonly id?: string;
  readonly model: string;
  readonly text: string;
  readonly toolCalls?: readonly ProviderToolCall[];
  readonly usage?: ProviderUsage;
  readonly finishReason?: string;
}

export type GeminiTransportEvent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool_call'; readonly id: string; readonly name: string; readonly argumentsDelta: string }
  | { readonly type: 'usage'; readonly usage: ProviderUsage }
  | { readonly type: 'done'; readonly finishReason?: string };

export interface GeminiTransport {
  generate(request: GeminiTransportRequest, signal: AbortSignal): Promise<GeminiTransportResponse>;
  stream(request: GeminiTransportRequest, signal: AbortSignal): AsyncIterable<GeminiTransportEvent>;
}

export interface GeminiAdapterOptions {
  readonly config: ProviderRuntimeConfig;
  readonly transport: GeminiTransport;
  readonly now?: () => number;
}

export class GeminiAdapter implements ProviderAdapter {
  readonly id = 'gemini' as const;
  readonly status;
  private readonly config: ProviderRuntimeConfig;
  private readonly transport: GeminiTransport;
  private readonly now: () => number;

  constructor(options: GeminiAdapterOptions) {
    if (options.config.id !== 'gemini' || options.config.protocol !== 'gemini') {
      throw new Error('Gemini adapter requires Gemini configuration.');
    }
    this.config = options.config;
    this.status = toConfiguredProviderStatus(options.config);
    this.transport = options.transport;
    this.now = options.now ?? Date.now;
  }

  private mapRequest(request: ProviderRequest): GeminiTransportRequest {
    assertCapabilities(this.id, this.config.capabilities, request);
    const model = resolveModel(this.id, this.config.allowedModels, this.config.defaultModel, request.model);
    const systemInstruction = request.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n') || undefined;
    const messages = request.messages
      .filter((message) => message.role !== 'system' && message.role !== 'tool')
      .map((message) => ({ role: message.role === 'assistant' ? 'model' as const : 'user' as const, text: message.content }));
    return {
      model,
      systemInstruction,
      messages,
      responseFormat: request.responseFormat,
      tools: request.tools,
      maxOutputTokens: request.maxOutputTokens,
      temperature: request.temperature,
    };
  }

  async generate(request: ProviderRequest, signal: AbortSignal): Promise<ProviderResult> {
    const startedAt = this.now();
    let response: GeminiTransportResponse;
    try {
      response = await this.transport.generate(this.mapRequest(request), signal);
    } catch (error) {
      throw normalizeProviderError(error, this.id);
    }
    if (!response.text && !response.toolCalls?.length) {
      throw new ProviderError('invalid_response', 'Provider response contained no text or tool calls.', { provider: this.id });
    }
    return {
      requestId: request.id,
      providerRequestId: response.id,
      provider: this.id,
      model: response.model,
      text: response.text,
      structured: response.text ? parseStructuredText(response.text, request.responseFormat, this.id) : undefined,
      toolCalls: response.toolCalls ?? [],
      usage: response.usage ? normalizeUsage(response.usage) : emptyUsage(),
      finishReason: normalizeFinishReason(response.finishReason),
      latencyMs: Math.max(0, this.now() - startedAt),
    };
  }

  async *stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    let events: AsyncIterable<GeminiTransportEvent>;
    try {
      events = this.transport.stream(this.mapRequest(request), signal);
      for await (const event of events) {
        if (event.type === 'text') yield { type: 'text_delta', text: event.text };
        else if (event.type === 'tool_call') yield {
          type: 'tool_call_delta', id: event.id, name: event.name, argumentsDelta: event.argumentsDelta,
        };
        else if (event.type === 'usage') yield { type: 'usage', usage: normalizeUsage(event.usage) };
        else yield { type: 'completed', finishReason: normalizeFinishReason(event.finishReason) };
      }
    } catch (error) {
      throw normalizeProviderError(error, this.id);
    }
  }
}

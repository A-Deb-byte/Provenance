import { toConfiguredProviderStatus } from '../config';
import { normalizeProviderError, ProviderError } from '../errors';
import {
  ProviderAdapter,
  ProviderEvent,
  ProviderMessage,
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
  resolveModel,
} from './shared';

export interface BedrockConverseRequest {
  readonly model: string;
  readonly region: string;
  readonly system: readonly string[];
  readonly messages: readonly ProviderMessage[];
  readonly tools?: ProviderRequest['tools'];
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
}

export interface BedrockConverseResponse {
  readonly requestId?: string;
  readonly model: string;
  readonly text: string;
  readonly toolCalls?: readonly ProviderToolCall[];
  readonly usage?: ProviderUsage;
  readonly stopReason?: string;
}

export type BedrockConverseEvent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool_call'; readonly id: string; readonly name?: string; readonly argumentsDelta: string }
  | { readonly type: 'usage'; readonly usage: ProviderUsage }
  | { readonly type: 'done'; readonly stopReason?: string };

export interface BedrockConverseTransport {
  converse(request: BedrockConverseRequest, signal: AbortSignal): Promise<BedrockConverseResponse>;
  converseStream(request: BedrockConverseRequest, signal: AbortSignal): AsyncIterable<BedrockConverseEvent>;
}

export interface BedrockAdapterOptions {
  readonly config: ProviderRuntimeConfig;
  readonly transport: BedrockConverseTransport;
  readonly now?: () => number;
}

export class BedrockAdapter implements ProviderAdapter {
  readonly id = 'aws' as const;
  readonly status;
  private readonly config: ProviderRuntimeConfig;
  private readonly transport: BedrockConverseTransport;
  private readonly now: () => number;

  constructor(options: BedrockAdapterOptions) {
    if (options.config.id !== 'aws' || options.config.protocol !== 'bedrock_converse') {
      throw new Error('Bedrock adapter requires AWS Bedrock configuration.');
    }
    this.config = options.config;
    this.status = toConfiguredProviderStatus(options.config);
    this.transport = options.transport;
    this.now = options.now ?? Date.now;
  }

  private mapRequest(request: ProviderRequest): BedrockConverseRequest {
    assertCapabilities(this.id, this.config.capabilities, request);
    const model = resolveModel(this.id, this.config.allowedModels, this.config.defaultModel, request.model);
    if (!this.config.region) throw new ProviderError('not_configured', 'AWS region is not configured.', { provider: this.id });
    return {
      model,
      region: this.config.region,
      system: request.messages.filter((message) => message.role === 'system').map((message) => message.content),
      messages: request.messages.filter((message) => message.role !== 'system'),
      tools: request.tools,
      maxOutputTokens: request.maxOutputTokens,
      temperature: request.temperature,
    };
  }

  async generate(request: ProviderRequest, signal: AbortSignal): Promise<ProviderResult> {
    const startedAt = this.now();
    let response: BedrockConverseResponse;
    try {
      response = await this.transport.converse(this.mapRequest(request), signal);
    } catch (error) {
      throw normalizeProviderError(error, this.id);
    }
    if (!response.text && !response.toolCalls?.length) {
      throw new ProviderError('invalid_response', 'Provider response contained no text or tool calls.', { provider: this.id });
    }
    return {
      requestId: request.id,
      providerRequestId: response.requestId,
      provider: this.id,
      model: response.model,
      text: response.text,
      toolCalls: response.toolCalls ?? [],
      usage: response.usage ? normalizeUsage(response.usage) : emptyUsage(),
      finishReason: normalizeFinishReason(response.stopReason),
      latencyMs: Math.max(0, this.now() - startedAt),
    };
  }

  async *stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    try {
      for await (const event of this.transport.converseStream(this.mapRequest(request), signal)) {
        if (event.type === 'text') yield { type: 'text_delta', text: event.text };
        else if (event.type === 'tool_call') yield {
          type: 'tool_call_delta', id: event.id, name: event.name, argumentsDelta: event.argumentsDelta,
        };
        else if (event.type === 'usage') yield { type: 'usage', usage: normalizeUsage(event.usage) };
        else yield { type: 'completed', finishReason: normalizeFinishReason(event.stopReason) };
      }
    } catch (error) {
      throw normalizeProviderError(error, this.id);
    }
  }
}

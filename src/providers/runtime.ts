import { GenerateContentParameters, GoogleGenAI } from '@google/genai';
import { BedrockAdapter, BedrockConverseTransport } from './adapters/bedrock';
import {
  GeminiAdapter,
  GeminiTransport,
  GeminiTransportEvent,
  GeminiTransportRequest,
  GeminiTransportResponse,
} from './adapters/gemini';
import { FetchLike, OpenAICompatibleAdapter } from './adapters/openaiCompatible';
import { getProviderConfig, loadProviderConfigs, toProviderPublicStatuses } from './config';
import { ProviderRouter, ProviderRouterOptions } from './router';
import {
  EnvironmentSecretResolver,
  ProviderSecretResolver,
  revealServerSecret,
  ServerSecret,
} from './secrets';
import { ProviderTelemetryStore } from './telemetry';
import {
  ProviderAdapter,
  ProviderEnvironment,
  ProviderPublicStatus,
  ProviderRequest,
  ProviderRoutePlan,
  ProviderRoutingPolicy,
  ProviderToolCall,
  ProviderUsage,
} from './types';

export interface GeminiSdkResponse {
  readonly responseId?: string;
  readonly modelVersion?: string;
  readonly text?: string;
  readonly functionCalls?: readonly {
    readonly id?: string;
    readonly name?: string;
    readonly args?: Record<string, unknown>;
  }[];
  readonly candidates?: readonly { readonly finishReason?: string }[];
  readonly usageMetadata?: {
    readonly promptTokenCount?: number;
    readonly candidatesTokenCount?: number;
    readonly totalTokenCount?: number;
  };
}

export interface GeminiSdkClient {
  readonly models: {
    generateContent(params: GenerateContentParameters): Promise<GeminiSdkResponse>;
    generateContentStream(params: GenerateContentParameters): Promise<AsyncIterable<GeminiSdkResponse>>;
  };
}

export type GeminiClientFactory = (secret: ServerSecret) => GeminiSdkClient;

export interface CreateProviderRuntimeOptions extends ProviderRouterOptions {
  readonly env?: ProviderEnvironment;
  readonly fetch?: FetchLike;
  readonly secretResolver?: ProviderSecretResolver;
  readonly geminiClientFactory?: GeminiClientFactory;
  readonly bedrockTransport?: BedrockConverseTransport;
}

export interface ProviderRuntime {
  readonly statuses: readonly ProviderPublicStatus[];
  readonly router: ProviderRouter;
  readonly telemetry: ProviderTelemetryStore;
  plan(request: ProviderRequest, policy: ProviderRoutingPolicy): ProviderRoutePlan;
  toJSON(): { readonly providers: readonly ProviderPublicStatus[] };
}

const asUsage = (response: GeminiSdkResponse): ProviderUsage => ({
  inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
  outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
  totalTokens: response.usageMetadata?.totalTokenCount ?? (
    (response.usageMetadata?.promptTokenCount ?? 0) +
    (response.usageMetadata?.candidatesTokenCount ?? 0)
  ),
});

const asToolCalls = (response: GeminiSdkResponse): ProviderToolCall[] => (
  response.functionCalls ?? []
).flatMap((call, index): ProviderToolCall[] => {
  if (!call.name) return [];
  return [{
    id: call.id || `gemini_call_${index + 1}`,
    name: call.name,
    arguments: call.args ?? {},
  }];
});

const toGeminiParameters = (request: GeminiTransportRequest): GenerateContentParameters => ({
  model: request.model,
  contents: request.messages.map((message) => ({
    role: message.role,
    parts: [{ text: message.text }],
  })),
  config: {
    systemInstruction: request.systemInstruction,
    maxOutputTokens: request.maxOutputTokens,
    temperature: request.temperature,
    responseMimeType: request.responseFormat.type === 'text' ? undefined : 'application/json',
    responseJsonSchema: request.responseFormat.type === 'json_schema'
      ? request.responseFormat.schema
      : undefined,
    tools: request.tools?.length ? [{
      functionDeclarations: request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parametersJsonSchema: tool.inputSchema,
      })),
    }] : undefined,
  },
});

const toGeminiTransportResponse = (response: GeminiSdkResponse, requestedModel: string): GeminiTransportResponse => ({
  id: response.responseId,
  model: response.modelVersion || requestedModel,
  text: response.text ?? '',
  toolCalls: asToolCalls(response),
  usage: asUsage(response),
  finishReason: response.candidates?.[0]?.finishReason,
});

class GoogleGeminiTransport implements GeminiTransport {
  constructor(private readonly client: GeminiSdkClient) {}

  async generate(request: GeminiTransportRequest, _signal: AbortSignal): Promise<GeminiTransportResponse> {
    const response = await this.client.models.generateContent(toGeminiParameters(request));
    return toGeminiTransportResponse(response, request.model);
  }

  async *stream(request: GeminiTransportRequest, _signal: AbortSignal): AsyncIterable<GeminiTransportEvent> {
    const stream = await this.client.models.generateContentStream(toGeminiParameters(request));
    for await (const response of stream) {
      if (response.text) yield { type: 'text', text: response.text };
      for (const toolCall of asToolCalls(response)) {
        yield {
          type: 'tool_call',
          id: toolCall.id,
          name: toolCall.name,
          argumentsDelta: JSON.stringify(toolCall.arguments),
        };
      }
      if (response.usageMetadata) yield { type: 'usage', usage: asUsage(response) };
      const finishReason = response.candidates?.[0]?.finishReason;
      if (finishReason) yield { type: 'done', finishReason };
    }
  }
}

const createRealGeminiClient: GeminiClientFactory = (secret) => {
  const client = new GoogleGenAI({ apiKey: revealServerSecret(secret) });
  return {
    models: {
      generateContent: (params) => client.models.generateContent(params),
      generateContentStream: async (params) => client.models.generateContentStream(params),
    },
  };
};

const withoutMissingBedrockTransport = (
  statuses: readonly ProviderPublicStatus[],
  bedrockTransport: BedrockConverseTransport | undefined,
): readonly ProviderPublicStatus[] => statuses.map((status) => {
  if (status.id !== 'aws' || bedrockTransport || !status.configured) return status;
  return Object.freeze({
    ...status,
    configured: false,
    unavailableReason: 'AWS Bedrock transport is not installed.',
  });
});

export const createProviderRuntime = (options: CreateProviderRuntimeOptions = {}): ProviderRuntime => {
  const env = options.env ?? process.env;
  const configs = loadProviderConfigs(env);
  const secrets = options.secretResolver ?? new EnvironmentSecretResolver(env);
  const statuses = Object.freeze([
    ...withoutMissingBedrockTransport(
      toProviderPublicStatuses(configs, secrets),
      options.bedrockTransport,
    ),
  ]);
  const fetchTransport: FetchLike = options.fetch ?? globalThis.fetch.bind(globalThis);
  const adapters: ProviderAdapter[] = [];

  for (const status of statuses) {
    if (!status.configured) continue;
    const config = getProviderConfig(configs, status.id);
    if (status.id === 'gemini') {
      const secret = secrets.resolve(status.id);
      if (!secret) continue;
      const client = (options.geminiClientFactory ?? createRealGeminiClient)(secret);
      adapters.push(new GeminiAdapter({ config, transport: new GoogleGeminiTransport(client) }));
    } else if (status.id === 'aws') {
      if (options.bedrockTransport) {
        adapters.push(new BedrockAdapter({ config, transport: options.bedrockTransport }));
      }
    } else {
      const secret = secrets.resolve(status.id);
      if (!secret) continue;
      adapters.push(new OpenAICompatibleAdapter({ config, secret, fetch: fetchTransport }));
    }
  }

  const telemetry = new ProviderTelemetryStore();
  const router = new ProviderRouter(adapters, telemetry, {
    maxEnsembleProviders: options.maxEnsembleProviders,
  });
  return Object.freeze({
    statuses,
    router,
    telemetry,
    plan: (request: ProviderRequest, policy: ProviderRoutingPolicy) => router.plan(request, policy),
    toJSON: () => ({ providers: statuses }),
  });
};

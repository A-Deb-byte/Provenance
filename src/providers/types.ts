export const PROVIDER_IDS = ['gemini', 'openai', 'openrouter', 'deepseek', 'glm', 'aws'] as const;

export type ProviderId = typeof PROVIDER_IDS[number];
export type ProviderProtocol = 'gemini' | 'openai_responses' | 'openai_chat' | 'bedrock_converse';
export type ProviderCapability = 'text' | 'streaming' | 'json_object' | 'json_schema' | 'tools';
export type ProviderCredentialSource = 'server_env' | 'aws_default_chain';
export type ProviderFinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error' | 'unknown';

export interface JsonSchema {
  readonly type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly items?: JsonSchema;
  readonly additionalProperties?: boolean;
  readonly enum?: readonly unknown[];
}

export interface ProviderMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly toolCallId?: string;
}

export interface ProviderToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

export interface ProviderToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
}

export type ProviderResponseFormat =
  | { readonly type: 'text' }
  | { readonly type: 'json_object' }
  | {
    readonly type: 'json_schema';
    readonly name: string;
    readonly schema: JsonSchema;
  };

export interface ProviderRequest {
  readonly id: string;
  readonly model?: string;
  readonly messages: readonly ProviderMessage[];
  readonly requiredCapabilities: readonly ProviderCapability[];
  readonly responseFormat: ProviderResponseFormat;
  readonly tools?: readonly ProviderToolDefinition[];
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface ProviderUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface ProviderResult {
  readonly requestId: string;
  readonly providerRequestId?: string;
  readonly provider: ProviderId;
  readonly model: string;
  readonly text: string;
  readonly structured?: unknown;
  readonly toolCalls: readonly ProviderToolCall[];
  readonly usage: ProviderUsage;
  readonly finishReason: ProviderFinishReason;
  readonly latencyMs: number;
}

export type ProviderEvent =
  | { readonly type: 'text_delta'; readonly text: string }
  | { readonly type: 'tool_call_delta'; readonly id: string; readonly name?: string; readonly argumentsDelta: string }
  | { readonly type: 'usage'; readonly usage: ProviderUsage }
  | { readonly type: 'completed'; readonly finishReason: ProviderFinishReason };

export interface ProviderRuntimeConfig {
  readonly id: ProviderId;
  readonly protocol: ProviderProtocol;
  readonly endpoint: string;
  readonly defaultModel: string;
  readonly allowedModels: readonly string[];
  readonly capabilities: readonly ProviderCapability[];
  readonly credentialSource: ProviderCredentialSource;
  readonly credentialEnvironmentVariable?: string;
  readonly routingPriority: number;
  readonly region?: string;
  readonly configurationError?: string;
}

export interface ProviderPublicStatus {
  readonly id: ProviderId;
  readonly configured: boolean;
  readonly credentialSource: ProviderCredentialSource;
  readonly endpoint: string;
  readonly defaultModel: string;
  readonly allowedModels: readonly string[];
  readonly capabilities: readonly ProviderCapability[];
  readonly routingPriority: number;
  readonly region?: string;
  readonly unavailableReason?: string;
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly status: ProviderPublicStatus;
  generate(request: ProviderRequest, signal: AbortSignal): Promise<ProviderResult>;
  stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>;
}

export type ProviderRoutingPolicy =
  | { readonly mode: 'automatic' }
  | { readonly mode: 'pinned'; readonly provider: ProviderId; readonly model?: string }
  | { readonly mode: 'ensemble'; readonly maxProviders: number; readonly providers?: readonly ProviderId[] };

export interface ProviderRouteSelection {
  readonly provider: ProviderId;
  readonly model: string;
}

export interface ProviderRoutePlan {
  readonly mode: ProviderRoutingPolicy['mode'];
  readonly selections: readonly ProviderRouteSelection[];
  readonly reason: string;
}

export interface ProviderExecutionError {
  readonly provider: ProviderId;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly status?: number;
}

export interface ProviderExecution {
  readonly plan: ProviderRoutePlan;
  readonly results: readonly ProviderResult[];
  readonly errors: readonly ProviderExecutionError[];
  readonly disagreement: boolean;
}

export type ProviderEnvironment = Readonly<Record<string, string | undefined>>;

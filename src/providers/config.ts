import {
  ProviderCapability,
  ProviderEnvironment,
  ProviderId,
  ProviderPublicStatus,
  ProviderRuntimeConfig,
} from './types';
import { ProviderSecretResolver } from './secrets';

interface ProviderDefinition {
  readonly id: ProviderId;
  readonly protocol: ProviderRuntimeConfig['protocol'];
  readonly endpoint: string;
  readonly defaultModels: readonly string[];
  readonly modelEnvironmentVariable: string;
  readonly modelsEnvironmentVariable: string;
  readonly capabilities: readonly ProviderCapability[];
  readonly credentialSource: ProviderRuntimeConfig['credentialSource'];
  readonly credentialEnvironmentVariable?: string;
  readonly routingPriority: number;
}

const definitions: readonly ProviderDefinition[] = Object.freeze([
  {
    id: 'gemini', protocol: 'gemini', endpoint: 'https://generativelanguage.googleapis.com',
    defaultModels: ['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'],
    modelEnvironmentVariable: 'GEMINI_MODEL', modelsEnvironmentVariable: 'GEMINI_MODELS',
    capabilities: ['text', 'streaming', 'json_object', 'json_schema', 'tools'],
    credentialSource: 'server_env', credentialEnvironmentVariable: 'GEMINI_API_KEY', routingPriority: 10,
  },
  {
    id: 'openai', protocol: 'openai_responses', endpoint: 'https://api.openai.com/v1',
    defaultModels: ['gpt-5.6', 'gpt-5.6-terra', 'gpt-5.6-luna'],
    modelEnvironmentVariable: 'OPENAI_MODEL', modelsEnvironmentVariable: 'OPENAI_MODELS',
    capabilities: ['text', 'streaming', 'json_object', 'json_schema', 'tools'],
    credentialSource: 'server_env', credentialEnvironmentVariable: 'OPENAI_API_KEY', routingPriority: 20,
  },
  {
    id: 'openrouter', protocol: 'openai_chat', endpoint: 'https://openrouter.ai/api/v1',
    defaultModels: ['openrouter/free', 'openai/gpt-5.6', 'google/gemini-3.5-flash', 'deepseek/deepseek-v4-pro'],
    modelEnvironmentVariable: 'OPENROUTER_MODEL', modelsEnvironmentVariable: 'OPENROUTER_MODELS',
    capabilities: ['text', 'streaming', 'json_object', 'json_schema', 'tools'],
    credentialSource: 'server_env', credentialEnvironmentVariable: 'OPENROUTER_API_KEY', routingPriority: 30,
  },
  {
    id: 'deepseek', protocol: 'openai_chat', endpoint: 'https://api.deepseek.com',
    defaultModels: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    modelEnvironmentVariable: 'DEEPSEEK_MODEL', modelsEnvironmentVariable: 'DEEPSEEK_MODELS',
    capabilities: ['text', 'streaming', 'json_object', 'tools'],
    credentialSource: 'server_env', credentialEnvironmentVariable: 'DEEPSEEK_API_KEY', routingPriority: 40,
  },
  {
    id: 'glm', protocol: 'openai_chat', endpoint: 'https://api.z.ai/api/paas/v4',
    defaultModels: ['glm-5.1', 'glm-5', 'glm-4.7'],
    modelEnvironmentVariable: 'ZAI_MODEL', modelsEnvironmentVariable: 'ZAI_MODELS',
    capabilities: ['text', 'streaming', 'json_object', 'tools'],
    credentialSource: 'server_env', credentialEnvironmentVariable: 'ZAI_API_KEY', routingPriority: 50,
  },
  {
    id: 'aws', protocol: 'bedrock_converse', endpoint: 'aws-bedrock://converse',
    defaultModels: ['amazon.nova-lite-v1:0', 'amazon.nova-pro-v1:0'],
    modelEnvironmentVariable: 'AWS_BEDROCK_MODEL', modelsEnvironmentVariable: 'AWS_BEDROCK_MODELS',
    capabilities: ['text', 'streaming', 'tools'],
    credentialSource: 'aws_default_chain', routingPriority: 60,
  },
]);

const parseModels = (raw: string | undefined, fallback: readonly string[]): readonly string[] => {
  if (!raw?.trim()) return [...fallback];
  return [...new Set(raw.split(',').map((model) => model.trim()).filter(Boolean))];
};

export const loadProviderConfigs = (env: ProviderEnvironment = process.env): readonly ProviderRuntimeConfig[] => {
  return definitions.map((definition) => {
    const allowedModels = parseModels(env[definition.modelsEnvironmentVariable], definition.defaultModels);
    const defaultModel = env[definition.modelEnvironmentVariable]?.trim() || allowedModels[0] || '';
    const region = definition.id === 'aws'
      ? env.AWS_REGION?.trim() || env.AWS_DEFAULT_REGION?.trim()
      : undefined;
    let configurationError: string | undefined;
    if (!allowedModels.length) configurationError = 'Provider model allowlist is empty.';
    else if (!allowedModels.includes(defaultModel)) configurationError = 'Default model is not in the provider allowlist.';
    else if (definition.id === 'aws' && !region) configurationError = 'AWS region is not configured.';

    return Object.freeze({
      id: definition.id,
      protocol: definition.protocol,
      endpoint: definition.endpoint,
      defaultModel,
      allowedModels: Object.freeze([...allowedModels]),
      capabilities: Object.freeze([...definition.capabilities]),
      credentialSource: definition.credentialSource,
      credentialEnvironmentVariable: definition.credentialEnvironmentVariable,
      routingPriority: definition.routingPriority,
      region,
      configurationError,
    });
  });
};

export const getProviderConfig = (
  configs: readonly ProviderRuntimeConfig[],
  provider: ProviderId,
): ProviderRuntimeConfig => {
  const config = configs.find((candidate) => candidate.id === provider);
  if (!config) throw new Error(`Missing provider configuration for ${provider}.`);
  return config;
};

export const toProviderPublicStatuses = (
  configs: readonly ProviderRuntimeConfig[],
  secrets: ProviderSecretResolver,
): readonly ProviderPublicStatus[] => configs.map((config) => {
  const hasCredentials = secrets.hasCredentials(config.id);
  const configured = hasCredentials && !config.configurationError;
  const unavailableReason = config.configurationError ?? (
    hasCredentials ? undefined : config.id === 'aws'
      ? 'AWS default credential chain is not configured.'
      : 'Provider credentials are not configured.'
  );
  return Object.freeze({
    id: config.id,
    configured,
    credentialSource: config.credentialSource,
    endpoint: config.endpoint,
    defaultModel: config.defaultModel,
    allowedModels: Object.freeze([...config.allowedModels]),
    capabilities: Object.freeze([...config.capabilities]),
    routingPriority: config.routingPriority,
    region: config.region,
    unavailableReason,
  });
});

export const toConfiguredProviderStatus = (config: ProviderRuntimeConfig): ProviderPublicStatus => Object.freeze({
  id: config.id,
  configured: !config.configurationError,
  credentialSource: config.credentialSource,
  endpoint: config.endpoint,
  defaultModel: config.defaultModel,
  allowedModels: Object.freeze([...config.allowedModels]),
  capabilities: Object.freeze([...config.capabilities]),
  routingPriority: config.routingPriority,
  region: config.region,
  unavailableReason: config.configurationError,
});

import { describe, expect, it } from 'vitest';
import { getProviderConfig, loadProviderConfigs, toProviderPublicStatuses } from './config';
import { EnvironmentSecretResolver } from './secrets';

describe('provider configuration', () => {
  it('uses fixed server-owned endpoints and validates model allowlists', () => {
    const configs = loadProviderConfigs({
      OPENAI_API_KEY: 'server-secret',
      OPENAI_BASE_URL: 'https://attacker.invalid/v1',
      OPENAI_MODELS: 'gpt-5.6,gpt-5.6-terra',
      OPENAI_MODEL: 'gpt-5.6-terra',
    });
    const openai = getProviderConfig(configs, 'openai');

    expect(openai.endpoint).toBe('https://api.openai.com/v1');
    expect(openai.defaultModel).toBe('gpt-5.6-terra');
    expect(openai.allowedModels).toEqual(['gpt-5.6', 'gpt-5.6-terra']);
    expect(openai.allowedModels).not.toContain('https://attacker.invalid/v1');
  });

  it('marks invalid defaults unavailable without exposing configuration secrets', () => {
    const env = {
      GEMINI_API_KEY: 'gemini-secret-value',
      GEMINI_MODELS: 'gemini-3.5-flash',
      GEMINI_MODEL: 'unknown-model',
    };
    const configs = loadProviderConfigs(env);
    const statuses = toProviderPublicStatuses(configs, new EnvironmentSecretResolver(env));
    const gemini = statuses.find((status) => status.id === 'gemini');

    expect(gemini).toMatchObject({ configured: false, credentialSource: 'server_env' });
    expect(gemini?.unavailableReason).toContain('allowlist');
    expect(JSON.stringify(statuses)).not.toContain('gemini-secret-value');
  });

  it('publishes a sanitized status for every supported provider', () => {
    const env = {
      GEMINI_API_KEY: 'g',
      OPENAI_API_KEY: 'o',
      OPENROUTER_API_KEY: 'r',
      DEEPSEEK_API_KEY: 'd',
      ZAI_API_KEY: 'z',
      AWS_PROFILE: 'dev',
      AWS_REGION: 'us-east-1',
    };
    const statuses = toProviderPublicStatuses(
      loadProviderConfigs(env),
      new EnvironmentSecretResolver(env),
    );

    expect(statuses.map((status) => status.id)).toEqual([
      'gemini', 'openai', 'openrouter', 'deepseek', 'glm', 'aws',
    ]);
    expect(statuses.every((status) => status.configured)).toBe(true);
    expect(statuses.find((status) => status.id === 'aws')?.credentialSource).toBe('aws_default_chain');
  });
});

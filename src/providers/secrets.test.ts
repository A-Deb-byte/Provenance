import { describe, expect, it } from 'vitest';
import {
  createServerSecret,
  EnvironmentSecretResolver,
  revealServerSecret,
} from './secrets';

describe('provider secrets', () => {
  it('keeps values server-only and redacts JSON serialization', () => {
    const secret = createServerSecret('openai', 'sk-private-value');

    expect(revealServerSecret(secret)).toBe('sk-private-value');
    expect(JSON.stringify(secret)).toBe('"[REDACTED]"');
    expect(Object.keys(secret)).toEqual([]);
  });

  it('resolves only known provider environment variables', () => {
    const resolver = new EnvironmentSecretResolver({
      OPENAI_API_KEY: 'openai-secret',
      RANDOM_API_KEY: 'must-not-be-resolved',
    });

    expect(revealServerSecret(resolver.resolve('openai')!)).toBe('openai-secret');
    expect(resolver.resolve('gemini')).toBeUndefined();
    expect(resolver.hasCredentials('aws')).toBe(false);
    expect(JSON.stringify(resolver)).not.toContain('openai-secret');
  });

  it('detects AWS default-chain hints without materializing AWS credentials', () => {
    const resolver = new EnvironmentSecretResolver({
      AWS_PROFILE: 'local-development',
      AWS_REGION: 'us-east-1',
    });

    expect(resolver.hasCredentials('aws')).toBe(true);
    expect(resolver.resolve('aws')).toBeUndefined();
  });
});

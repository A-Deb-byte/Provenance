import { ProviderEnvironment, ProviderId } from './types';

const secretValues = new WeakMap<ServerSecret, string>();

export class ServerSecret {
  private constructor(value: string) {
    secretValues.set(this, value);
  }

  static create(value: string): ServerSecret {
    return new ServerSecret(value);
  }

  toJSON(): string {
    return '[REDACTED]';
  }
}

export const createServerSecret = (_provider: ProviderId, value: string): ServerSecret => {
  return ServerSecret.create(value);
};

export const revealServerSecret = (secret: ServerSecret): string => {
  const value = secretValues.get(secret);
  if (value === undefined) throw new Error('Unknown server secret handle.');
  return value;
};

const keyEnvironmentVariables: Readonly<Partial<Record<ProviderId, string>>> = Object.freeze({
  gemini: 'GEMINI_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  glm: 'ZAI_API_KEY',
});

const hasAwsCredentialHint = (env: ProviderEnvironment): boolean => {
  const hasStaticPair = Boolean(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY);
  return hasStaticPair || Boolean(
    env.AWS_PROFILE ||
    env.AWS_WEB_IDENTITY_TOKEN_FILE ||
    env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ||
    env.AWS_CONTAINER_CREDENTIALS_FULL_URI,
  );
};

export interface ProviderSecretResolver {
  hasCredentials(provider: ProviderId): boolean;
  resolve(provider: ProviderId): ServerSecret | undefined;
}

export class EnvironmentSecretResolver implements ProviderSecretResolver {
  readonly #env: ProviderEnvironment;

  constructor(env: ProviderEnvironment = process.env) {
    this.#env = { ...env };
  }

  hasCredentials(provider: ProviderId): boolean {
    if (provider === 'aws') return hasAwsCredentialHint(this.#env);
    const variable = keyEnvironmentVariables[provider];
    return Boolean(variable && this.#env[variable]?.trim());
  }

  resolve(provider: ProviderId): ServerSecret | undefined {
    if (provider === 'aws') return undefined;
    const variable = keyEnvironmentVariables[provider];
    const value = variable ? this.#env[variable]?.trim() : undefined;
    return value ? createServerSecret(provider, value) : undefined;
  }
}

import { createDpapiVault, injectVaultSecretsIntoEnvironment, SecretVault } from './dpapi';
import { createKeychainVault } from './keychain';
import { createSecretServiceVault } from './secretService';

export type { SecretVault, SecretVaultStatus, SecretVaultBackend } from './dpapi';
export { injectVaultSecretsIntoEnvironment };

export interface PlatformVaultOptions {
  vaultDir: string;
  platform?: NodeJS.Platform;
}

/**
 * Selects the platform-native secret vault: Windows DPAPI, macOS Keychain, or
 * Linux Secret Service. On any other platform the returned vault reports
 * unavailable (via its own platform gate) rather than substituting a weaker
 * file-based scheme.
 */
export const createPlatformVault = (options: PlatformVaultOptions): SecretVault => {
  const platform = options.platform ?? process.platform;
  if (platform === 'darwin') return createKeychainVault(options);
  if (platform === 'linux') return createSecretServiceVault(options);
  // Windows and everything else fall through to DPAPI, which itself reports
  // unavailable when not on win32.
  return createDpapiVault(options);
};

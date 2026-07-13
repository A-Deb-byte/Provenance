import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnVaultRunner, VaultCommandRunner } from './commandRunner';
import type { SecretVault } from './dpapi';

const SERVICE = 'provenance-vault';
const SECRET_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const MARKER_SUFFIX = '.keychain';
const MAX_SECRET_CHARS = 8 * 1024;

export interface KeychainVaultOptions {
  vaultDir: string;
  platform?: NodeJS.Platform;
  runner?: VaultCommandRunner;
}

const requireValidName = (name: string): string => {
  if (!SECRET_NAME_PATTERN.test(name)) {
    throw new Error('Secret names must be 1-64 characters of letters, digits, dot, dash, or underscore.');
  }
  return name;
};

/**
 * macOS Keychain adapter backed by the `security` CLI. A per-name marker file
 * in vaultDir provides an index for list() without dumping the whole keychain;
 * the secret values live only in the OS keychain.
 *
 * Caveat: `security add-generic-password -w <value>` places the value in the
 * argument vector briefly (a known `security` limitation). Documented in the
 * runtime status. Untestable on non-macOS hosts, so this reports unavailable
 * off-platform.
 */
export const createKeychainVault = (options: KeychainVaultOptions): SecretVault => {
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? spawnVaultRunner;
  const vaultDir = path.resolve(options.vaultDir);
  let probeResult: Promise<string | null> | undefined;

  const markerPath = (name: string) => path.join(vaultDir, `${requireValidName(name)}${MARKER_SUFFIX}`);

  const probe = (): Promise<string | null> => {
    probeResult ??= (async () => {
      if (platform !== 'darwin') {
        return 'The Keychain vault backend requires macOS.';
      }
      try {
        const result = await runner('security', ['list-keychains']);
        return result.code === 0 ? null : 'The macOS `security` tool is not usable in this environment.';
      } catch (error) {
        return `macOS Keychain probe failed: ${error instanceof Error ? error.message : 'unknown error'}`;
      }
    })();
    return probeResult;
  };

  const requireAvailable = async (): Promise<void> => {
    const failure = await probe();
    if (failure) throw new Error(`Secret vault is unavailable. ${failure}`);
  };

  const list = async (): Promise<string[]> => {
    try {
      const entries = await readdir(vaultDir);
      return entries
        .filter((entry) => entry.endsWith(MARKER_SUFFIX))
        .map((entry) => entry.slice(0, -MARKER_SUFFIX.length))
        .filter((name) => SECRET_NAME_PATTERN.test(name))
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  };

  return {
    getStatus: async () => {
      const failure = await probe();
      return failure
        ? { status: 'unavailable', reason: failure, backend: 'none', secretNames: [] }
        : {
          status: 'available',
          reason: 'Secrets are protected at rest by the macOS Keychain (security).',
          backend: 'macos_keychain',
          secretNames: await list(),
        };
    },
    store: async (name, value) => {
      if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SECRET_CHARS) {
        throw new Error(`Secret values must be 1-${MAX_SECRET_CHARS} characters.`);
      }
      await requireAvailable();
      const validName = requireValidName(name);
      const result = await runner('security', [
        'add-generic-password', '-a', validName, '-s', SERVICE, '-U', '-w', value,
      ]);
      if (result.code !== 0) throw new Error(`Keychain store failed: ${result.stderr.trim() || 'unknown error'}`);
      await mkdir(vaultDir, { recursive: true });
      await writeFile(markerPath(validName), '', 'utf8');
    },
    retrieve: async (name) => {
      await requireAvailable();
      const validName = requireValidName(name);
      const result = await runner('security', ['find-generic-password', '-a', validName, '-s', SERVICE, '-w']);
      if (result.code !== 0) return undefined;
      return result.stdout.replace(/\n$/, '');
    },
    remove: async (name) => {
      const validName = requireValidName(name);
      const result = await runner('security', ['delete-generic-password', '-a', validName, '-s', SERVICE]);
      await rm(markerPath(validName), { force: true });
      return result.code === 0;
    },
    list,
  };
};

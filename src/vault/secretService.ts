import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnVaultRunner, VaultCommandRunner } from './commandRunner';
import type { SecretVault } from './dpapi';

const SERVICE = 'provenance-vault';
const SECRET_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const MARKER_SUFFIX = '.secret-service';
const MAX_SECRET_CHARS = 8 * 1024;

export interface SecretServiceVaultOptions {
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
 * Linux Secret Service adapter backed by `secret-tool` (libsecret). The secret
 * value is fed on stdin, so it never appears in the argument vector. A per-name
 * marker file in vaultDir indexes list(). Requires a running Secret Service
 * (GNOME Keyring / KWallet) over D-Bus; reports unavailable off-platform or
 * when the daemon is unreachable.
 */
export const createSecretServiceVault = (options: SecretServiceVaultOptions): SecretVault => {
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? spawnVaultRunner;
  const vaultDir = path.resolve(options.vaultDir);
  let probeResult: Promise<string | null> | undefined;

  const markerPath = (name: string) => path.join(vaultDir, `${requireValidName(name)}${MARKER_SUFFIX}`);
  const attributes = (name: string) => ['service', SERVICE, 'account', name];

  const probe = (): Promise<string | null> => {
    probeResult ??= (async () => {
      if (platform !== 'linux') {
        return 'The Secret Service vault backend requires Linux.';
      }
      try {
        // A lookup of a probe key runs the tool and touches the daemon without
        // storing anything. Any completed exit means the tool + service work.
        await runner('secret-tool', ['lookup', ...attributes('__provenance_probe__')]);
        return null;
      } catch (error) {
        return `Linux Secret Service probe failed (secret-tool/daemon unavailable): ${error instanceof Error ? error.message : 'unknown error'}`;
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
          reason: 'Secrets are protected at rest by the Linux Secret Service (libsecret).',
          backend: 'linux_secret_service',
          secretNames: await list(),
        };
    },
    store: async (name, value) => {
      if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SECRET_CHARS) {
        throw new Error(`Secret values must be 1-${MAX_SECRET_CHARS} characters.`);
      }
      await requireAvailable();
      const validName = requireValidName(name);
      const result = await runner(
        'secret-tool',
        ['store', '--label', `${SERVICE}:${validName}`, ...attributes(validName)],
        value,
      );
      if (result.code !== 0) throw new Error(`Secret Service store failed: ${result.stderr.trim() || 'unknown error'}`);
      await mkdir(vaultDir, { recursive: true });
      await writeFile(markerPath(validName), '', 'utf8');
    },
    retrieve: async (name) => {
      await requireAvailable();
      const validName = requireValidName(name);
      const result = await runner('secret-tool', ['lookup', ...attributes(validName)]);
      if (result.code !== 0) return undefined;
      return result.stdout.replace(/\n$/, '');
    },
    remove: async (name) => {
      const validName = requireValidName(name);
      const result = await runner('secret-tool', ['clear', ...attributes(validName)]);
      await rm(markerPath(validName), { force: true });
      return result.code === 0;
    },
    list,
  };
};

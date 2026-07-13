import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface SecretVaultStatus {
  status: 'available' | 'unavailable';
  reason: string;
  backend: 'windows_dpapi' | 'none';
  secretNames: string[];
}

export interface SecretVault {
  getStatus(): Promise<SecretVaultStatus>;
  store(name: string, value: string): Promise<void>;
  retrieve(name: string): Promise<string | undefined>;
  remove(name: string): Promise<boolean>;
  list(): Promise<string[]>;
}

export interface DpapiVaultOptions {
  vaultDir: string;
  platform?: NodeJS.Platform;
}

const SECRET_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const SECRET_FILE_SUFFIX = '.dpapi';
const MAX_SECRET_CHARS = 8 * 1024;

/**
 * Runs a DPAPI operation through Windows PowerShell. The payload travels via
 * an environment variable, never the command line, so it does not appear in
 * process listings. DataProtectionScope.CurrentUser means the operating
 * system's user-scoped DPAPI master key protects the data at rest — this is
 * platform-native protection, not an application-managed encryption key.
 */
const runDpapi = async (operation: 'Protect' | 'Unprotect', base64Payload: string): Promise<string> => {
  const script = [
    'Add-Type -AssemblyName System.Security;',
    '$data = [Convert]::FromBase64String($env:AGENT_VAULT_DATA);',
    `$result = [System.Security.Cryptography.ProtectedData]::${operation}($data, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser);`,
    '[Console]::Out.Write([Convert]::ToBase64String($result))',
  ].join(' ');
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ], {
    env: { ...process.env, AGENT_VAULT_DATA: base64Payload },
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  const result = stdout.trim();
  if (!result) throw new Error(`DPAPI ${operation} produced no output.`);
  return result;
};

const requireValidName = (name: string): string => {
  if (!SECRET_NAME_PATTERN.test(name)) {
    throw new Error('Secret names must be 1-64 characters of letters, digits, dot, dash, or underscore.');
  }
  return name;
};

export const createDpapiVault = (options: DpapiVaultOptions): SecretVault => {
  const platform = options.platform ?? process.platform;
  const vaultDir = path.resolve(options.vaultDir);
  let probeResult: Promise<string | null> | undefined;

  const secretPath = (name: string) => path.join(vaultDir, `${requireValidName(name)}${SECRET_FILE_SUFFIX}`);

  /** Returns null when DPAPI works, otherwise the failure reason. */
  const probe = (): Promise<string | null> => {
    probeResult ??= (async () => {
      if (platform !== 'win32') {
        return 'The DPAPI vault backend requires Windows; no platform vault adapter exists for this operating system.';
      }
      try {
        const plaintext = Buffer.from('vault-probe', 'utf8').toString('base64');
        const protectedValue = await runDpapi('Protect', plaintext);
        const roundTrip = await runDpapi('Unprotect', protectedValue);
        return roundTrip === plaintext ? null : 'DPAPI probe round-trip returned unexpected data.';
      } catch (error) {
        return `DPAPI probe failed: ${error instanceof Error ? error.message : 'unknown error'}`;
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
        .filter((entry) => entry.endsWith(SECRET_FILE_SUFFIX))
        .map((entry) => entry.slice(0, -SECRET_FILE_SUFFIX.length))
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
          reason: 'Secrets are protected at rest by Windows DPAPI (CurrentUser scope).',
          backend: 'windows_dpapi',
          secretNames: await list(),
        };
    },
    store: async (name, value) => {
      if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SECRET_CHARS) {
        throw new Error(`Secret values must be 1-${MAX_SECRET_CHARS} characters.`);
      }
      await requireAvailable();
      const target = secretPath(name);
      await mkdir(vaultDir, { recursive: true });
      const ciphertext = await runDpapi('Protect', Buffer.from(value, 'utf8').toString('base64'));
      await writeFile(target, ciphertext, 'utf8');
    },
    retrieve: async (name) => {
      await requireAvailable();
      const target = secretPath(name);
      try {
        const ciphertext = await readFile(target, 'utf8');
        const plaintext = await runDpapi('Unprotect', ciphertext.trim());
        return Buffer.from(plaintext, 'base64').toString('utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    },
    remove: async (name) => {
      const target = secretPath(name);
      try {
        await rm(target);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    },
    list,
  };
};

/**
 * Loads allowlisted secrets from the vault into the process environment at
 * boot so provider and signing configuration can come from OS-protected
 * storage instead of plaintext .env files. Environment values that are
 * already set always win; the vault only fills gaps.
 */
export const injectVaultSecretsIntoEnvironment = async (
  vault: SecretVault,
  names: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> => {
  const status = await vault.getStatus();
  if (status.status !== 'available') return [];
  const injected: string[] = [];
  for (const name of names) {
    if (env[name]?.trim()) continue;
    if (!status.secretNames.includes(name)) continue;
    const value = await vault.retrieve(name);
    if (value) {
      env[name] = value;
      injected.push(name);
    }
  }
  return injected;
};

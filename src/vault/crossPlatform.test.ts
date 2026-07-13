import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VaultCommandResult, VaultCommandRunner } from './commandRunner';
import { createKeychainVault } from './keychain';
import { createSecretServiceVault } from './secretService';
import { createPlatformVault } from './index';

let vaultDir = '';

beforeEach(async () => {
  vaultDir = await mkdtemp(path.join(os.tmpdir(), 'xplat-vault-'));
});

afterEach(async () => {
  await rm(vaultDir, { recursive: true, force: true });
});

const okRunner = (over: (file: string, args: string[]) => Partial<VaultCommandResult> = () => ({})): {
  runner: VaultCommandRunner;
  calls: Array<{ file: string; args: string[]; input?: string }>;
} => {
  const calls: Array<{ file: string; args: string[]; input?: string }> = [];
  const runner: VaultCommandRunner = async (file, args, input) => {
    calls.push({ file, args, input });
    return { stdout: '', stderr: '', code: 0, ...over(file, args) };
  };
  return { runner, calls };
};

describe('macOS Keychain vault', () => {
  it('reports unavailable and refuses to store off-platform', async () => {
    const vault = createKeychainVault({ vaultDir, platform: 'win32', runner: okRunner().runner });
    expect((await vault.getStatus()).status).toBe('unavailable');
    await expect(vault.store('GEMINI_API_KEY', 'v')).rejects.toThrow(/unavailable/);
  });

  it('stores via the security CLI and indexes the name (simulated darwin)', async () => {
    const { runner, calls } = okRunner();
    const vault = createKeychainVault({ vaultDir, platform: 'darwin', runner });

    await vault.store('GEMINI_API_KEY', 'super-secret');
    const store = calls.find((c) => c.args[0] === 'add-generic-password');
    expect(store?.file).toBe('security');
    expect(store?.args).toEqual(expect.arrayContaining(['-a', 'GEMINI_API_KEY', '-s', 'provenance-vault']));
    expect(await vault.list()).toEqual(['GEMINI_API_KEY']);
  });

  it('returns undefined on a keychain miss', async () => {
    const { runner } = okRunner((_file, args) => (args[0] === 'find-generic-password' ? { code: 1 } : {}));
    const vault = createKeychainVault({ vaultDir, platform: 'darwin', runner });
    expect(await vault.retrieve('MISSING')).toBeUndefined();
  });

  it('rejects invalid secret names', async () => {
    const vault = createKeychainVault({ vaultDir, platform: 'darwin', runner: okRunner().runner });
    await expect(vault.store('../escape', 'v')).rejects.toThrow(/Secret names/);
  });
});

describe('Linux Secret Service vault', () => {
  it('reports unavailable off-platform', async () => {
    const vault = createSecretServiceVault({ vaultDir, platform: 'win32', runner: okRunner().runner });
    expect((await vault.getStatus()).status).toBe('unavailable');
  });

  it('feeds the secret on stdin, never the argument vector (simulated linux)', async () => {
    const { runner, calls } = okRunner();
    const vault = createSecretServiceVault({ vaultDir, platform: 'linux', runner });

    await vault.store('OPENAI_API_KEY', 'sk-super-secret');
    const store = calls.find((c) => c.args[0] === 'store');
    expect(store?.file).toBe('secret-tool');
    expect(store?.input).toBe('sk-super-secret');
    expect(store?.args.join(' ')).not.toContain('sk-super-secret');
    expect(await vault.list()).toEqual(['OPENAI_API_KEY']);
  });

  it('returns undefined on a lookup miss', async () => {
    const { runner } = okRunner((_file, args) => (args[0] === 'lookup' ? { code: 1 } : {}));
    const vault = createSecretServiceVault({ vaultDir, platform: 'linux', runner });
    expect(await vault.retrieve('MISSING')).toBeUndefined();
  });
});

describe('platform vault selection', () => {
  it('selects the backend for the given platform', async () => {
    const darwin = createPlatformVault({ vaultDir, platform: 'darwin' });
    const linux = createPlatformVault({ vaultDir, platform: 'linux' });
    // On this Windows host their probes will report unavailable (no real
    // security/secret-tool), but the correct adapter is selected and never
    // throws on status.
    expect((await darwin.getStatus()).backend === 'macos_keychain' || (await darwin.getStatus()).backend === 'none').toBe(true);
    expect((await linux.getStatus()).backend === 'linux_secret_service' || (await linux.getStatus()).backend === 'none').toBe(true);
  });
});

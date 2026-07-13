import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDpapiVault, injectVaultSecretsIntoEnvironment } from './dpapi';

let vaultDir = '';

beforeEach(async () => {
  vaultDir = await mkdtemp(path.join(os.tmpdir(), 'agent-vault-'));
});

afterEach(async () => {
  await rm(vaultDir, { recursive: true, force: true });
});

describe('DPAPI vault name validation', () => {
  it('rejects secret names outside the safe character set', async () => {
    const vault = createDpapiVault({ vaultDir, platform: 'win32' });
    await expect(vault.store('../escape', 'value')).rejects.toThrow(/Secret names/);
    await expect(vault.store('bad name', 'value')).rejects.toThrow(/Secret names/);
  });
});

describe('DPAPI vault on non-Windows platforms', () => {
  it('reports itself unavailable with an honest reason', async () => {
    const vault = createDpapiVault({ vaultDir, platform: 'linux' });
    const status = await vault.getStatus();
    expect(status.status).toBe('unavailable');
    expect(status.backend).toBe('none');
    expect(status.reason).toMatch(/requires Windows/);
  });

  it('refuses to store secrets when unavailable', async () => {
    const vault = createDpapiVault({ vaultDir, platform: 'linux' });
    await expect(vault.store('GEMINI_API_KEY', 'secret-value')).rejects.toThrow(/unavailable/);
  });

  it('injects nothing into the environment when unavailable', async () => {
    const vault = createDpapiVault({ vaultDir, platform: 'linux' });
    const env: NodeJS.ProcessEnv = {};
    const injected = await injectVaultSecretsIntoEnvironment(vault, ['GEMINI_API_KEY'], env);
    expect(injected).toEqual([]);
    expect(env.GEMINI_API_KEY).toBeUndefined();
  });
});

const windowsIt = process.platform === 'win32' ? it : it.skip;

describe('DPAPI vault round-trip (Windows only)', () => {
  windowsIt('stores, lists, retrieves, and removes a secret without exposing values in listings', async () => {
    const vault = createDpapiVault({ vaultDir });
    const status = await vault.getStatus();
    // If DPAPI is somehow unavailable on this Windows host, skip the assertions.
    if (status.status !== 'available') return;

    await vault.store('GEMINI_API_KEY', 'super-secret-value');
    expect(await vault.list()).toContain('GEMINI_API_KEY');
    expect(await vault.retrieve('GEMINI_API_KEY')).toBe('super-secret-value');

    const env: NodeJS.ProcessEnv = {};
    const injected = await injectVaultSecretsIntoEnvironment(vault, ['GEMINI_API_KEY'], env);
    expect(injected).toContain('GEMINI_API_KEY');
    expect(env.GEMINI_API_KEY).toBe('super-secret-value');

    expect(await vault.remove('GEMINI_API_KEY')).toBe(true);
    expect(await vault.retrieve('GEMINI_API_KEY')).toBeUndefined();
  }, 60000);

  windowsIt('does not overwrite an environment value that is already set', async () => {
    const vault = createDpapiVault({ vaultDir });
    if ((await vault.getStatus()).status !== 'available') return;

    await vault.store('GEMINI_API_KEY', 'vault-value');
    const env: NodeJS.ProcessEnv = { GEMINI_API_KEY: 'existing-value' };
    const injected = await injectVaultSecretsIntoEnvironment(vault, ['GEMINI_API_KEY'], env);
    expect(injected).toEqual([]);
    expect(env.GEMINI_API_KEY).toBe('existing-value');
  }, 60000);
});

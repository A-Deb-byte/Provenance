import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const script = path.join(process.cwd(), 'scripts', 'generate-rust-third-party-notices.mjs');
const roots: string[] = [];

const cleanEnvironment = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  delete env.PROVENANCE_CARGO_ABOUT;
  delete env.PROVENANCE_CARGO_ABOUT_SHA256;
  delete env.PROVENANCE_CARGO_ABOUT_VERSION;
  return env;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('native third-party notice generator', () => {
  it('requires an explicit absolute cargo-about binary', async () => {
    await expect(execFileAsync(process.execPath, [script], { env: cleanEnvironment() }))
      .rejects.toMatchObject({ stderr: expect.stringContaining('PROVENANCE_CARGO_ABOUT') });
  });

  it('rejects a cargo-about executable whose bytes do not match the pin', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cargo-about-policy-'));
    roots.push(root);
    const executable = path.join(root, 'cargo-about.exe');
    await copyFile(process.execPath, executable);
    const env = {
      ...cleanEnvironment(),
      PROVENANCE_CARGO_ABOUT: executable,
      PROVENANCE_CARGO_ABOUT_SHA256: 'f'.repeat(64),
      PROVENANCE_CARGO_ABOUT_VERSION: '0.9.1',
    };
    await expect(execFileAsync(process.execPath, [script], { env }))
      .rejects.toMatchObject({ stderr: expect.stringContaining('hash does not match') });
  });

  it('rejects an executable that does not report the pinned cargo-about version', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cargo-about-policy-'));
    roots.push(root);
    const executable = path.join(root, 'cargo-about.exe');
    await copyFile(process.execPath, executable);
    const bytes = await readFile(executable);
    const env = {
      ...cleanEnvironment(),
      PROVENANCE_CARGO_ABOUT: executable,
      PROVENANCE_CARGO_ABOUT_SHA256: crypto.createHash('sha256').update(bytes).digest('hex'),
      PROVENANCE_CARGO_ABOUT_VERSION: '0.9.1',
    };
    await expect(execFileAsync(process.execPath, [script], { env }))
      .rejects.toMatchObject({ stderr: expect.stringContaining('version does not match') });
  });
});

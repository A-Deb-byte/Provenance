import crypto from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const verifierPath = path.resolve(process.cwd(), 'scripts', 'verify-ledger.mjs');
const temporaryDirectories: string[] = [];

const makeRuntimeDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'provenance-ledger-verifier-'));
  temporaryDirectories.push(directory);
  return directory;
};

const runVerifier = (runtimeDirectory: string, requireEvents = false) =>
  spawnSync(
    process.execPath,
    [verifierPath, ...(requireEvents ? ['--require-events'] : []), runtimeDirectory],
    { encoding: 'utf8' },
  );

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('standalone ledger verifier strict mode', () => {
  it('preserves the default success result when no ledger exists', async () => {
    const runtimeDirectory = await makeRuntimeDirectory();

    const result = runVerifier(runtimeDirectory);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No ledger found; nothing to verify (0 events).');
  });

  it('rejects a missing ledger when events are required', async () => {
    const runtimeDirectory = await makeRuntimeDirectory();

    const result = runVerifier(runtimeDirectory, true);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('required ledger events.jsonl was not found');
  });

  it('rejects an empty ledger when events are required', async () => {
    const runtimeDirectory = await makeRuntimeDirectory();
    await writeFile(path.join(runtimeDirectory, 'events.jsonl'), '\n', 'utf8');

    const result = runVerifier(runtimeDirectory, true);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('required ledger contains no events');
  });

  it('accepts a non-empty valid ledger when events are required', async () => {
    const runtimeDirectory = await makeRuntimeDirectory();
    const eventWithoutHash = {
      id: 'event-1',
      type: 'verification.test',
      timestamp: '2026-07-22T00:00:00.000Z',
      previousHash: null,
      payload: { result: 'valid' },
    };
    const hash = crypto
      .createHash('sha256')
      .update(JSON.stringify(eventWithoutHash))
      .digest('hex');
    await writeFile(
      path.join(runtimeDirectory, 'events.jsonl'),
      `${JSON.stringify({ ...eventWithoutHash, hash })}\n`,
      'utf8',
    );
    await writeFile(
      path.join(runtimeDirectory, 'state.json'),
      JSON.stringify({ lastEventHash: hash }),
      'utf8',
    );

    const result = runVerifier(runtimeDirectory, true);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Ledger verified: 1 hash-chained events');
  });
});

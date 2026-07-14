import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyReleaseSignature } from '../src/kernel/autonomy';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('release signing CLI', () => {
  it('signs the same canonical authorization document verified by the kernel', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'release-signing-'));
    roots.push(root);
    const keyFile = path.join(root, 'release-private.pem');
    const proposalFile = path.join(root, 'proposal.json');
    const proposal = {
      targetVersion: '1.2.3',
      contentHash: 'a'.repeat(64),
      evaluationEventIds: ['event_z', 'event_a'],
      rollbackInstructions: 'Restore the previous supervised release.',
    };
    await writeFile(proposalFile, JSON.stringify(proposal), 'utf8');

    const generated = await execFileAsync(process.execPath, [
      path.join(process.cwd(), 'scripts', 'release-signing.mjs'), 'generate', keyFile,
    ]);
    const publicKey = generated.stdout.trim().split(/\r?\n/).at(-1)!;
    const signed = await execFileAsync(process.execPath, [
      path.join(process.cwd(), 'scripts', 'release-signing.mjs'), 'sign', keyFile, proposalFile,
    ]);
    const signature = signed.stdout.trim();

    expect(verifyReleaseSignature(publicKey, proposal, signature)).toBe(true);
    expect(verifyReleaseSignature(publicKey, {
      ...proposal,
      evaluationEventIds: ['event_a', 'event_other'],
    }, signature)).toBe(false);
  });
});

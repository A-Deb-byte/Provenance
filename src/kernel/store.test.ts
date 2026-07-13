import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readKernelState, writeKernelState } from './store';

let tempDir = '';

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'kernel-store-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('kernel store', () => {
  it('falls back to empty state when no snapshot exists', async () => {
    const state = await readKernelState(tempDir);
    expect(state.goals).toEqual([]);
    expect(state.lastEventHash).toBeNull();
  });

  it('round trips state snapshots', async () => {
    const state = await readKernelState(tempDir);
    await writeKernelState(tempDir, { ...state, lastEventHash: 'hash_1' });
    expect((await readKernelState(tempDir)).lastEventHash).toBe('hash_1');
  });

  it('migrates a Phase 1 snapshot with empty Phase 2 collections', async () => {
    await writeFile(path.join(tempDir, 'state.json'), JSON.stringify({
      goals: [],
      tasks: [],
      approvals: [],
      lastEventHash: null,
    }), 'utf8');

    const state = await readKernelState(tempDir);
    expect(state.memories).toEqual([]);
    expect(state.skillPackages).toEqual([]);
    expect(state.skillEvaluations).toEqual([]);
    expect(state.skillActivations).toEqual([]);
  });
});

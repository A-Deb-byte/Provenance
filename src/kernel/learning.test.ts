import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createKernelService } from './kernel';
import { SkillManifest } from './types';

let runtimeDir = '';
let workspaceRoot = '';

beforeEach(async () => {
  runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'kernel-learning-'));
  workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'kernel-learning-workspace-'));
});

afterEach(async () => {
  await Promise.all([
    rm(runtimeDir, { recursive: true, force: true }),
    rm(workspaceRoot, { recursive: true, force: true }),
  ]);
});

describe('kernel learning service', () => {
  it('persists evidence-backed memory promotion without writing raw content to the ledger', async () => {
    const kernel = createKernelService({ runtimeDir, allowedWorkspaceRoot: workspaceRoot });
    const content = 'Use the verified lint command before release builds.';
    const candidate = await kernel.createMemoryCandidate({
      kind: 'procedural',
      content,
      confidence: 0.9,
      scope: { kind: 'workspace', id: workspaceRoot },
      sensitivity: 'internal',
      retention: { kind: 'durable' },
      provenance: {
        sourceType: 'user',
        sourceId: 'user_input_1',
        actor: 'user',
        observedAt: '2026-07-12T00:00:00.000Z',
      },
      contradictionIds: [],
      supersedesIds: [],
    });

    expect(candidate.status).toBe('candidate');
    expect(candidate.evidenceRefs).toHaveLength(1);
    const promoted = await kernel.promoteMemory(candidate.id, 'User confirmed this workspace procedure.');
    expect(promoted.status).toBe('promoted');

    const restarted = createKernelService({ runtimeDir, allowedWorkspaceRoot: workspaceRoot });
    expect((await restarted.getState()).memories[0].status).toBe('promoted');
    expect(JSON.stringify(await restarted.getEvents())).not.toContain(content);
  });

  it('revokes memory without deleting its audit record', async () => {
    const kernel = createKernelService({ runtimeDir, allowedWorkspaceRoot: workspaceRoot });
    const candidate = await kernel.createMemoryCandidate({
      kind: 'intent',
      content: 'Prefer concise status updates.',
      confidence: 1,
      scope: { kind: 'global' },
      sensitivity: 'internal',
      retention: { kind: 'durable' },
      provenance: {
        sourceType: 'user',
        sourceId: 'user_input_2',
        actor: 'user',
        observedAt: '2026-07-12T00:00:00.000Z',
      },
      contradictionIds: [],
      supersedesIds: [],
    });
    await kernel.promoteMemory(candidate.id, 'Explicit user preference.');
    const revoked = await kernel.revokeMemory(candidate.id, 'User withdrew the preference.');

    expect(revoked.status).toBe('revoked');
    expect((await kernel.getState()).memories).toHaveLength(1);
    expect((await kernel.getEvents()).map((event) => event.type)).toContain('memory.revoked');
  });

  it('synthesizes, evaluates, canaries, promotes, and invokes a bounded pure skill', async () => {
    const kernel = createKernelService({ runtimeDir, allowedWorkspaceRoot: workspaceRoot });
    const manifest: SkillManifest = {
      schemaVersion: 1,
      name: 'TrimReleaseInput',
      version: '1.0.0',
      description: 'Trims repeated release workflow input.',
      runtime: 'pure-transform-v1',
      inputType: 'text',
      outputType: 'text',
      permissionScopes: [],
      dependencyLock: 'builtin:pure-transform-v1',
      supportedPlatforms: ['any'],
      rateLimitPerMinute: 10,
      maxInputChars: 1024,
      maxSteps: 2,
      sideEffects: 'none',
      expectedArtifacts: ['normalized_text'],
      rollbackInstructions: 'Deactivate this version.',
      provenance: {
        sourceType: 'user',
        sourceId: 'skill_gap_1',
        actor: 'user',
        observedAt: '2026-07-12T00:00:00.000Z',
      },
    };

    const skill = await kernel.synthesizeSkill({
      manifest,
      trainingCases: [
        { id: 'train_1', input: ' A ', expectedOutput: 'A', kind: 'train' },
        { id: 'train_2', input: ' B ', expectedOutput: 'B', kind: 'train' },
      ],
      replayCases: [
        { id: 'replay_1', input: ' C ', expectedOutput: 'C', kind: 'replay' },
      ],
    });
    expect(skill.status).toBe('candidate');
    expect(skill.program.steps).toEqual([{ operation: 'trim' }]);

    const evaluation = await kernel.evaluateSkill(skill.id);
    expect(evaluation.eligibleForCanary).toBe(true);
    const activation = await kernel.startSkillCanary(skill.id, 1);
    expect(activation.status).toBe('canary');
    const run = await kernel.runSkillCanary(skill.id, ' D ', 'D');
    expect(run.passed).toBe(true);
    const promoted = await kernel.promoteSkillPackage(skill.id);
    expect(promoted.status).toBe('promoted');
    expect(await kernel.invokeSkill(skill.id, ' E ')).toBe('E');

    const ledger = JSON.stringify(await kernel.getEvents());
    expect(ledger).not.toContain(' D ');
    expect(ledger).not.toContain(' E ');
  });
});

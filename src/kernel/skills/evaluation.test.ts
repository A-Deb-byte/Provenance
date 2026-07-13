import { describe, expect, it } from 'vitest';
import {
  MemoryProvenance,
  PureTransformProgram,
  SkillCase,
  SkillManifest,
  SkillPackage,
} from '../types';
import {
  computeSkillContentHash,
  evaluateSkillPackage,
  getSkillEvaluationLedgerMetadata,
} from './evaluation';
import { HARD_MAX_OUTPUT_CHARS } from './runtime';

const provenance: MemoryProvenance = {
  sourceType: 'user',
  sourceId: 'user_skill_request',
  actor: 'user',
  observedAt: '2026-07-12T00:00:00.000Z',
};

const manifest = (permissionScopes: string[] = []): SkillManifest => ({
  schemaVersion: 1,
  name: 'NormalizeText',
  version: '1.0.0',
  description: 'Normalizes repeated text input.',
  runtime: 'pure-transform-v1',
  inputType: 'text',
  outputType: 'text',
  permissionScopes,
  dependencyLock: 'builtin:pure-transform-v1',
  supportedPlatforms: ['any'],
  rateLimitPerMinute: 10,
  maxInputChars: 4096,
  maxSteps: 4,
  sideEffects: 'none',
  expectedArtifacts: ['normalized_text'],
  rollbackInstructions: 'Deactivate this version and restore the prior promoted version.',
  provenance,
});

const replayCase = (id: string, input: string, expectedOutput: string): SkillCase => ({
  id,
  input,
  expectedOutput,
  kind: 'replay',
  sourceEventId: `event_${id}`,
});

const skillPackage = (
  replayCases: SkillCase[],
  permissionScopes: string[] = [],
  program: PureTransformProgram = {
    runtime: 'pure-transform-v1',
    steps: [{ operation: 'trim' }, { operation: 'lowercase' }],
  },
): SkillPackage => {
  const draft = {
    id: 'skill_normalize',
    manifest: manifest(permissionScopes),
    program,
    trainingCases: [{
      id: 'train_1',
      input: ' X ',
      expectedOutput: 'x',
      kind: 'train' as const,
    }],
    replayCases,
    status: 'candidate' as const,
    contentHash: '',
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  };
  return { ...draft, contentHash: computeSkillContentHash(draft) };
};

describe('skill replay evaluation', () => {
  it('marks a full held-out improvement with no permission delta as canary eligible', () => {
    const skill = skillPackage([
      replayCase('replay_b', ' B ', 'b'),
      replayCase('replay_a', ' A ', 'a'),
    ]);

    const result = evaluateSkillPackage(skill, {
      evaluationId: 'eval_1',
      createdAt: '2026-07-12T01:00:00.000Z',
    });

    expect(result.candidateScore).toBe(1);
    expect(result.baselineScore).toBe(0);
    expect(result.permissionDelta).toEqual([]);
    expect(result.eligibleForCanary).toBe(true);
    expect(result.caseResults.map((item) => item.caseId)).toEqual(['replay_a', 'replay_b']);
  });

  it('blocks canary eligibility when permissions expand', () => {
    const skill = skillPackage(
      [replayCase('replay_1', ' A ', 'a')],
      ['filesystem.read', 'filesystem.read', 'network.fetch'],
    );
    const result = evaluateSkillPackage(skill, {
      evaluationId: 'eval_1',
      createdAt: '2026-07-12T01:00:00.000Z',
      baselinePermissionScopes: ['filesystem.read'],
    });

    expect(result.permissionDelta).toEqual(['network.fetch']);
    expect(result.eligibleForCanary).toBe(false);
  });

  it('requires all replay cases to pass even when the candidate beats baseline', () => {
    const skill = skillPackage([
      replayCase('replay_1', ' A ', 'a'),
      replayCase('replay_2', ' B ', 'unexpected'),
    ]);
    const result = evaluateSkillPackage(skill, {
      evaluationId: 'eval_1',
      createdAt: '2026-07-12T01:00:00.000Z',
    });

    expect(result.candidateScore).toBe(0.5);
    expect(result.baselineScore).toBe(0);
    expect(result.eligibleForCanary).toBe(false);
  });

  it('produces stable content and suite hashes independent of set-like array and case order', () => {
    const cases = [
      replayCase('replay_a', ' A ', 'a'),
      replayCase('replay_b', ' B ', 'b'),
    ];
    const first = skillPackage(cases, ['z.scope', 'a.scope']);
    const secondDraft = skillPackage([...cases].reverse(), ['a.scope', 'z.scope']);
    const second = { ...secondDraft, contentHash: computeSkillContentHash(secondDraft) };
    const options = { evaluationId: 'eval_1', createdAt: '2026-07-12T01:00:00.000Z' };

    expect(first.contentHash).toBe(second.contentHash);
    expect(evaluateSkillPackage(first, options).suiteHash)
      .toBe(evaluateSkillPackage(second, options).suiteHash);
  });

  it('refuses evaluation when package content was changed after hashing', () => {
    const skill = skillPackage([replayCase('replay_1', ' A ', 'a')]);
    const tampered = { ...skill, program: { ...skill.program, steps: [] } };

    expect(() => evaluateSkillPackage(tampered, {
      evaluationId: 'eval_1',
      createdAt: '2026-07-12T01:00:00.000Z',
    })).toThrow('content hash');
  });

  it('bounds expected replay output even for a directly constructed package', () => {
    const skill = skillPackage([
      replayCase('replay_1', ' A ', 'x'.repeat(HARD_MAX_OUTPUT_CHARS + 1)),
    ]);

    expect(() => evaluateSkillPackage(skill, {
      evaluationId: 'eval_1',
      createdAt: '2026-07-12T01:00:00.000Z',
    })).toThrow('content exceeds');
  });

  it('projects evaluation metadata without replay outputs', () => {
    const skill = skillPackage([replayCase('replay_1', ' A ', 'a')]);
    const evaluation = evaluateSkillPackage(skill, {
      evaluationId: 'eval_1',
      createdAt: '2026-07-12T01:00:00.000Z',
    });
    const metadata = getSkillEvaluationLedgerMetadata(evaluation);

    expect(metadata).toMatchObject({ evaluationId: 'eval_1', caseCount: 1, passedCaseCount: 1 });
    expect(metadata).not.toHaveProperty('caseResults');
    expect(JSON.stringify(metadata)).not.toContain('actualOutput');
  });
});

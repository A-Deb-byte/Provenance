import { describe, expect, it } from 'vitest';
import { MemoryProvenance, SkillManifest } from '../types';
import { evaluateSkillPackage } from './evaluation';
import { createSkillEvaluationSource, createSkillEvaluationSuite } from './evaluationSuite';
import {
  activateSkillCanary,
  applySkillEvaluation,
  createSkillCandidate,
  getSkillActivationLedgerMetadata,
  getSkillPackageLedgerMetadata,
  promoteSkill,
  recordCanaryRun,
  rollbackSkill,
} from './foundry';

const provenance: MemoryProvenance = {
  sourceType: 'user',
  sourceId: 'gap_1',
  actor: 'user',
  observedAt: '2026-07-12T00:00:00.000Z',
};

const manifest: SkillManifest = {
  schemaVersion: 1,
  name: 'TrimInput',
  version: '1.0.0',
  description: 'Trims repeated text inputs.',
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
  expectedArtifacts: ['trimmed_text'],
  rollbackInstructions: 'Deactivate this version.',
  provenance,
};

const evaluationSuite = createSkillEvaluationSuite({
  id: 'suite_trim_v1',
  source: createSkillEvaluationSource({
    evaluatorId: 'evaluator:quality-team',
    sourceId: 'evaluation-source:trim-v1',
    cases: [
      { id: 'oracle_1', input: ' B ', expectedOutput: 'B', sourceRef: 'fixture:oracle_1' },
      { id: 'oracle_2', input: ' C ', expectedOutput: 'C', sourceRef: 'fixture:oracle_2' },
    ],
    observedAt: '2026-07-11T23:59:00.000Z',
  }),
  sourceEventId: 'evt_evaluation_source_attested',
  createdAt: '2026-07-12T00:00:00.000Z',
});

const candidate = () => createSkillCandidate({
  id: 'skill_1',
  manifest,
  program: { runtime: 'pure-transform-v1', steps: [{ operation: 'trim' }] },
  trainingCases: [{ id: 'train_1', input: ' A ', expectedOutput: 'A', kind: 'train' }],
  author: {
    authorityType: 'authenticated-principal-v1',
    principalId: 'user:skill-author',
  },
  evaluationSuite,
  createdAt: '2026-07-12T00:01:00.000Z',
});

describe('skill foundry lifecycle', () => {
  it('creates a canonical candidate with a ledger-safe content hash', () => {
    const skill = candidate();

    expect(skill.status).toBe('candidate');
    expect(skill.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(skill.trainingCases).toHaveLength(1);
    expect(skill.evaluationSuiteId).toBe(evaluationSuite.id);
    expect(skill).not.toHaveProperty('replayCases');
  });

  it('moves an eligible candidate through evaluated and canary states', () => {
    const skill = candidate();
    const evaluation = evaluateSkillPackage(skill, evaluationSuite, {
      evaluationId: 'eval_1',
      createdAt: '2026-07-12T01:00:00.000Z',
    });
    const evaluated = applySkillEvaluation(skill, evaluation, '2026-07-12T01:01:00.000Z');
    const canary = activateSkillCanary(evaluated, evaluation, evaluationSuite, {
      activationId: 'activation_1',
      maxRuns: 2,
      createdAt: '2026-07-12T01:02:00.000Z',
    });

    expect(evaluated.status).toBe('evaluated');
    expect(canary.skill.status).toBe('canary');
    expect(canary.activation).toMatchObject({ status: 'canary', maxRuns: 2, usedRuns: 0 });
  });

  it('rejects an ineligible evaluation instead of making it canary-ready', () => {
    const skill = candidate();
    const evaluation = {
      ...evaluateSkillPackage(skill, evaluationSuite, {
        evaluationId: 'eval_1',
        createdAt: '2026-07-12T01:00:00.000Z',
      }),
      eligibleForCanary: false,
    };
    const rejected = applySkillEvaluation(skill, evaluation, '2026-07-12T01:01:00.000Z');

    expect(rejected.status).toBe('rejected');
    expect(() => activateSkillCanary(rejected, evaluation, evaluationSuite, {
      activationId: 'activation_1',
      maxRuns: 1,
      createdAt: '2026-07-12T01:02:00.000Z',
    })).toThrow('evaluated');
  });

  it('requires the full successful canary budget before promotion', () => {
    const skill = candidate();
    const evaluation = evaluateSkillPackage(skill, evaluationSuite, {
      evaluationId: 'eval_1',
      createdAt: '2026-07-12T01:00:00.000Z',
    });
    const evaluated = applySkillEvaluation(skill, evaluation, '2026-07-12T01:01:00.000Z');
    const canary = activateSkillCanary(evaluated, evaluation, evaluationSuite, {
      activationId: 'activation_1',
      maxRuns: 2,
      createdAt: '2026-07-12T01:02:00.000Z',
    });
    const afterOne = recordCanaryRun(canary.skill, canary.activation, {
      passed: true,
      updatedAt: '2026-07-12T01:03:00.000Z',
    });
    expect(() => promoteSkill(canary.skill, afterOne, '2026-07-12T01:04:00.000Z'))
      .toThrow('all canary runs');

    const afterTwo = recordCanaryRun(canary.skill, afterOne, {
      passed: true,
      updatedAt: '2026-07-12T01:04:00.000Z',
    });
    const promoted = promoteSkill(canary.skill, afterTwo, '2026-07-12T01:05:00.000Z');

    expect(promoted.skill.status).toBe('promoted');
    expect(promoted.activation.status).toBe('active');
  });

  it('blocks further canary work after failure and supports explicit rollback', () => {
    const skill = candidate();
    const evaluation = evaluateSkillPackage(skill, evaluationSuite, {
      evaluationId: 'eval_1',
      createdAt: '2026-07-12T01:00:00.000Z',
    });
    const evaluated = applySkillEvaluation(skill, evaluation, '2026-07-12T01:01:00.000Z');
    const canary = activateSkillCanary(evaluated, evaluation, evaluationSuite, {
      activationId: 'activation_1',
      maxRuns: 2,
      createdAt: '2026-07-12T01:02:00.000Z',
    });
    const failed = recordCanaryRun(canary.skill, canary.activation, {
      passed: false,
      updatedAt: '2026-07-12T01:03:00.000Z',
    });

    expect(failed.status).toBe('failed');
    expect(() => recordCanaryRun(canary.skill, failed, {
      passed: true,
      updatedAt: '2026-07-12T01:04:00.000Z',
    })).toThrow('not accepting');

    const rolledBack = rollbackSkill(
      canary.skill,
      failed,
      'Held-out canary output failed verification.',
      '2026-07-12T01:05:00.000Z',
    );
    expect(rolledBack.skill.status).toBe('rolled_back');
    expect(rolledBack.activation).toMatchObject({
      status: 'rolled_back',
      rollbackReason: 'Held-out canary output failed verification.',
    });
  });

  it('does not mutate the supplied package or activation records', () => {
    const skill = candidate();
    const evaluation = evaluateSkillPackage(skill, evaluationSuite, {
      evaluationId: 'eval_1',
      createdAt: '2026-07-12T01:00:00.000Z',
    });
    const evaluated = applySkillEvaluation(skill, evaluation, '2026-07-12T01:01:00.000Z');

    expect(skill.status).toBe('candidate');
    expect(evaluated).not.toBe(skill);
  });

  it('refuses lifecycle transitions after candidate content tampering', () => {
    const skill = candidate();
    const evaluation = evaluateSkillPackage(skill, evaluationSuite, {
      evaluationId: 'eval_1',
      createdAt: '2026-07-12T01:00:00.000Z',
    });
    const tampered = { ...skill, program: { ...skill.program, steps: [] } };

    expect(() => applySkillEvaluation(tampered, evaluation, '2026-07-12T01:01:00.000Z'))
      .toThrow('content hash');
  });

  it('projects lifecycle metadata without programs or case content', () => {
    const skill = candidate();
    const evaluation = evaluateSkillPackage(skill, evaluationSuite, {
      evaluationId: 'eval_1',
      createdAt: '2026-07-12T01:00:00.000Z',
    });
    const evaluated = applySkillEvaluation(skill, evaluation, '2026-07-12T01:01:00.000Z');
    const canary = activateSkillCanary(evaluated, evaluation, evaluationSuite, {
      activationId: 'activation_1',
      maxRuns: 1,
      createdAt: '2026-07-12T01:02:00.000Z',
    });
    const packageMetadata = getSkillPackageLedgerMetadata(canary.skill);
    const activationMetadata = getSkillActivationLedgerMetadata(canary.activation);

    expect(packageMetadata).not.toHaveProperty('program');
    expect(packageMetadata).not.toHaveProperty('trainingCases');
    expect(activationMetadata).not.toHaveProperty('input');
    expect(activationMetadata).not.toHaveProperty('output');
  });
});

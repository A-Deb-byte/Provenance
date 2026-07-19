import { describe, expect, it } from 'vitest';
import {
  MemoryProvenance,
  PureTransformProgram,
  SkillEvaluationSuite,
  SkillManifest,
  SkillOracleCase,
  SkillPackage,
} from '../types';
import {
  computeSkillContentHash,
  evaluateSkillPackage,
  getSkillEvaluationLedgerMetadata,
} from './evaluation';
import {
  computeSkillEvaluationSuiteHash,
  createSkillEvaluationSource,
  createSkillEvaluationSuite,
} from './evaluationSuite';

const provenance: MemoryProvenance = {
  sourceType: 'user',
  sourceId: 'user_skill_oracle',
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

const oracleCase = (id: string, input: string, expectedOutput: string): SkillOracleCase => ({
  id,
  input,
  expectedOutput,
  sourceRef: `fixture:${id}`,
});

const oracleSuite = (
  cases: SkillOracleCase[],
  createdAt = '2026-07-12T00:01:00.000Z',
): SkillEvaluationSuite => createSkillEvaluationSuite({
  id: 'suite_normalize_v1',
  source: createSkillEvaluationSource({
    evaluatorId: 'evaluator:quality-team',
    sourceId: 'evaluation-source:normalize-v1',
    cases,
    observedAt: '2026-07-12T00:00:30.000Z',
  }),
  sourceEventId: 'evt_evaluation_source_attested',
  createdAt,
});

const skillPackage = (
  suite: SkillEvaluationSuite,
  permissionScopes: string[] = [],
  program: PureTransformProgram = {
    runtime: 'pure-transform-v1',
    steps: [{ operation: 'trim' }, { operation: 'lowercase' }],
  },
  createdAt = '2026-07-12T00:02:00.000Z',
): SkillPackage => {
  const draft: SkillPackage = {
    id: 'skill_normalize',
    manifest: manifest(permissionScopes),
    program,
    trainingCases: [{
      id: 'train_1',
      input: ' X ',
      expectedOutput: 'x',
      kind: 'train',
    }],
    author: {
      authorityType: 'authenticated-principal-v1',
      principalId: 'user:skill-author',
    },
    evaluationSuiteId: suite.id,
    evaluationSuiteHash: suite.suiteHash,
    status: 'candidate',
    contentHash: '',
    createdAt,
    updatedAt: createdAt,
  };
  return { ...draft, contentHash: computeSkillContentHash(draft) };
};

const evaluationOptions = {
  evaluationId: 'eval_1',
  createdAt: '2026-07-12T01:00:00.000Z',
};

describe('sealed skill evaluation suites', () => {
  it('accepts an honest candidate against a presealed independent oracle', () => {
    const suite = oracleSuite([
      oracleCase('oracle_b', ' B ', 'b'),
      oracleCase('oracle_a', ' A ', 'a'),
    ]);
    const result = evaluateSkillPackage(skillPackage(suite), suite, evaluationOptions);

    expect(result).toMatchObject({
      candidateScore: 1,
      baselineScore: 0,
      permissionDelta: [],
      eligibleForCanary: true,
      suiteId: suite.id,
      suiteHash: suite.suiteHash,
    });
    expect(result.caseResults.map((item) => item.caseId)).toEqual(['oracle_b', 'oracle_a']);
  });

  it('keeps caller-crafted expectations out of the oracle decision', () => {
    const suite = oracleSuite([oracleCase('oracle_1', ' Mixed ', 'mixed')]);
    const wrongProgram: PureTransformProgram = {
      runtime: 'pure-transform-v1',
      steps: [{ operation: 'trim' }, { operation: 'uppercase' }],
    };
    const skill = skillPackage(suite, [], wrongProgram);

    const result = evaluateSkillPackage(skill, suite, evaluationOptions);
    expect(result.caseResults).toEqual([{ caseId: 'oracle_1', actualOutput: 'MIXED', passed: false }]);
    expect(result.eligibleForCanary).toBe(false);
  });

  it('rejects a candidate authored by the same principal as the evaluator', () => {
    const suite = oracleSuite([oracleCase('oracle_1', ' A ', 'a')]);
    const selfEvaluated = {
      ...skillPackage(suite),
      author: {
        authorityType: 'authenticated-principal-v1' as const,
        principalId: suite.authority.evaluatorId,
      },
    };
    selfEvaluated.contentHash = computeSkillContentHash(selfEvaluated);

    expect(() => evaluateSkillPackage(selfEvaluated, suite, evaluationOptions))
      .toThrow('author cannot be the held-out suite evaluator');
  });

  it('rejects training input reuse even when case ids and outputs differ', () => {
    const suite = oracleSuite([oracleCase('oracle_1', ' Held Out ', 'held out')]);
    const overlapping = skillPackage(suite);
    overlapping.trainingCases = [{
      id: 'different_train_id',
      input: ' Held Out ',
      expectedOutput: 'attacker-selected',
      kind: 'train',
    }];
    overlapping.contentHash = computeSkillContentHash(overlapping);

    expect(() => evaluateSkillPackage(overlapping, suite, evaluationOptions))
      .toThrow('overlap the held-out evaluator suite');
  });

  it('fails closed for legacy caller-authored suites', () => {
    const suite = oracleSuite([oracleCase('oracle_1', ' A ', 'a')]);
    const legacy = {
      ...suite,
      schemaVersion: 1,
      authority: undefined,
      provenance,
    } as unknown as SkillEvaluationSuite;

    expect(() => evaluateSkillPackage(skillPackage(suite), legacy, evaluationOptions))
      .toThrow('evaluator authority or seal is invalid');
  });

  it('rejects a suite sealed after candidate creation even when the candidate is rehashed to name it', () => {
    const lateSuite = oracleSuite(
      [oracleCase('oracle_1', ' A ', 'a')],
      '2026-07-12T00:03:00.000Z',
    );
    const rebound = skillPackage(lateSuite, [], undefined, '2026-07-12T00:02:00.000Z');

    expect(() => evaluateSkillPackage(rebound, lateSuite, evaluationOptions))
      .toThrow('sealed before candidate creation');
  });

  it('rejects suite tampering after the seal', () => {
    const suite = oracleSuite([oracleCase('oracle_1', ' A ', 'a')]);
    const tampered = {
      ...suite,
      cases: [{ ...suite.cases[0], expectedOutput: 'attacker-selected' }],
    };

    expect(() => evaluateSkillPackage(skillPackage(suite), tampered, evaluationOptions))
      .toThrow('evaluation source hash');
  });

  it('fails a candidate mutation against the same fixed oracle', () => {
    const suite = oracleSuite([oracleCase('oracle_1', ' A ', 'a')]);
    const original = skillPackage(suite);
    const changedDraft = {
      ...original,
      program: { runtime: 'pure-transform-v1' as const, steps: [{ operation: 'uppercase' as const }] },
    };
    const changed = { ...changedDraft, contentHash: computeSkillContentHash(changedDraft) };

    expect(evaluateSkillPackage(changed, suite, evaluationOptions).eligibleForCanary).toBe(false);
  });

  it('binds suite provenance and case order into the seal', () => {
    const cases = [
      oracleCase('oracle_a', ' A ', 'a'),
      oracleCase('oracle_b', ' B ', 'b'),
    ];
    const first = oracleSuite(cases);
    const reorderedDraft = { ...first, cases: [...first.cases].reverse(), suiteHash: '' };
    const reordered = {
      ...reorderedDraft,
      suiteHash: computeSkillEvaluationSuiteHash(reorderedDraft),
    };
    const provenanceDraft = {
      ...first,
      provenance: { ...first.provenance, sourceId: 'different_source' },
      suiteHash: '',
    };
    const reprovenanced = {
      ...provenanceDraft,
      suiteHash: computeSkillEvaluationSuiteHash(provenanceDraft),
    };

    expect(reordered.suiteHash).not.toBe(first.suiteHash);
    expect(reprovenanced.suiteHash).not.toBe(first.suiteHash);
  });

  it('blocks canary eligibility when permissions expand', () => {
    const suite = oracleSuite([oracleCase('oracle_1', ' A ', 'a')]);
    const result = evaluateSkillPackage(
      skillPackage(suite, ['filesystem.read', 'filesystem.read', 'network.fetch']),
      suite,
      { ...evaluationOptions, baselinePermissionScopes: ['filesystem.read'] },
    );

    expect(result.permissionDelta).toEqual(['network.fetch']);
    expect(result.eligibleForCanary).toBe(false);
  });

  it('refuses candidate content changed without a new package hash', () => {
    const suite = oracleSuite([oracleCase('oracle_1', ' A ', 'a')]);
    const skill = skillPackage(suite);
    const tampered = { ...skill, program: { ...skill.program, steps: [] } };

    expect(() => evaluateSkillPackage(tampered, suite, evaluationOptions)).toThrow('content hash');
  });

  it('projects evaluation metadata without oracle outputs', () => {
    const suite = oracleSuite([oracleCase('oracle_1', ' A ', 'a')]);
    const evaluation = evaluateSkillPackage(skillPackage(suite), suite, evaluationOptions);
    const metadata = getSkillEvaluationLedgerMetadata(evaluation);

    expect(metadata).toMatchObject({
      evaluationId: 'eval_1',
      suiteId: suite.id,
      caseCount: 1,
      passedCaseCount: 1,
    });
    expect(metadata).not.toHaveProperty('caseResults');
    expect(JSON.stringify(metadata)).not.toContain('actualOutput');
  });
});

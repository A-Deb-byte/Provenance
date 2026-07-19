import {
  PureTransformProgram,
  SkillCase,
  SkillCaseResult,
  SkillEvaluation,
  SkillEvaluationSuite,
  SkillOracleCase,
  SkillPackage,
} from '../types';
import { HARD_MAX_OUTPUT_CHARS, runPureTransform, stableHash } from './runtime';
import {
  assertIndependentSkillEvaluation,
  assertSkillEvaluationSuiteIntegrity,
} from './evaluationSuite';

export interface SkillEvaluationOptions {
  evaluationId: string;
  createdAt: string;
  baselineProgram?: PureTransformProgram;
  baselinePermissionScopes?: string[];
}

export interface SkillEvaluationLedgerMetadata {
  evaluationId: string;
  skillId: string;
  candidateContentHash: string;
  suiteId: string;
  suiteHash: string;
  candidateScore: number;
  baselineScore: number;
  permissionDelta: string[];
  eligibleForCanary: boolean;
  caseCount: number;
  passedCaseCount: number;
}

const compareText = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const normalizeStringSet = (values: string[]): string[] => {
  return [...new Set(values)].sort(compareText);
};

const sortCases = (cases: SkillCase[]): SkillCase[] => {
  return [...cases].sort((left, right) => compareText(left.id, right.id));
};

const normalizedHashContent = (
  skill: Pick<
  SkillPackage,
  | 'id'
  | 'manifest'
  | 'program'
  | 'trainingCases'
  | 'author'
  | 'evaluationSuiteId'
  | 'evaluationSuiteHash'
  | 'previousVersionId'
  | 'createdAt'
  >,
) => ({
  id: skill.id,
  manifest: {
    ...skill.manifest,
    permissionScopes: normalizeStringSet(skill.manifest.permissionScopes),
    supportedPlatforms: normalizeStringSet(skill.manifest.supportedPlatforms),
    expectedArtifacts: normalizeStringSet(skill.manifest.expectedArtifacts),
  },
  program: skill.program,
  trainingCases: sortCases(skill.trainingCases),
  author: { ...skill.author },
  evaluationSuiteId: skill.evaluationSuiteId,
  evaluationSuiteHash: skill.evaluationSuiteHash,
  previousVersionId: skill.previousVersionId,
  createdAt: skill.createdAt,
});

export const computeSkillContentHash = (
  skill: Pick<
  SkillPackage,
  | 'id'
  | 'manifest'
  | 'program'
  | 'trainingCases'
  | 'author'
  | 'evaluationSuiteId'
  | 'evaluationSuiteHash'
  | 'previousVersionId'
  | 'createdAt'
  >,
): string => stableHash(normalizedHashContent(skill));

const validateEvaluationSuite = (
  skill: SkillPackage,
  suite: SkillEvaluationSuite,
): SkillOracleCase[] => {
  assertSkillEvaluationSuiteIntegrity(suite);
  assertIndependentSkillEvaluation(skill.trainingCases, skill.author, suite);
  if (
    skill.evaluationSuiteId !== suite.id ||
    skill.evaluationSuiteHash !== suite.suiteHash
  ) {
    throw new Error('Skill candidate is not bound to this sealed evaluation suite.');
  }
  if (Date.parse(suite.sealedAt) > Date.parse(skill.createdAt)) {
    throw new Error('Skill evaluation suite must be sealed before candidate creation.');
  }
  if (suite.cases.some((item) => (
    item.input.length > skill.manifest.maxInputChars ||
    item.expectedOutput.length > HARD_MAX_OUTPUT_CHARS
  ))) {
    throw new Error('Skill evaluation suite content exceeds the package limits.');
  }
  return suite.cases.map((item) => ({ ...item }));
};

const evaluateProgram = (
  program: PureTransformProgram,
  cases: SkillOracleCase[],
  skill: SkillPackage,
): { score: number; results: SkillCaseResult[] } => {
  let passCount = 0;
  const results = cases.map((item) => {
    const actualOutput = runPureTransform(program, item.input, {
      maxInputChars: skill.manifest.maxInputChars,
      maxSteps: skill.manifest.maxSteps,
    });
    const passed = actualOutput === item.expectedOutput;
    if (passed) passCount += 1;
    return { caseId: item.id, actualOutput, passed };
  });
  return { score: passCount / cases.length, results };
};

export const evaluateSkillPackage = (
  skill: SkillPackage,
  suite: SkillEvaluationSuite,
  options: SkillEvaluationOptions,
): SkillEvaluation => {
  if (!options.evaluationId.trim()) throw new Error('Skill evaluation id is required.');
  if (
    skill.author?.authorityType !== 'authenticated-principal-v1' ||
    typeof skill.author.principalId !== 'string' ||
    !skill.author.principalId.trim()
  ) {
    throw new Error('Legacy skill package lacks authenticated author authority.');
  }
  if (computeSkillContentHash(skill) !== skill.contentHash) {
    throw new Error('Skill package content hash does not match its content.');
  }

  const oracleCases = validateEvaluationSuite(skill, suite);
  const baselineProgram = options.baselineProgram ?? {
    runtime: 'pure-transform-v1' as const,
    steps: [],
  };
  const candidate = evaluateProgram(skill.program, oracleCases, skill);
  const baseline = evaluateProgram(baselineProgram, oracleCases, skill);
  const baselinePermissions = new Set(normalizeStringSet(options.baselinePermissionScopes ?? []));
  const permissionDelta = normalizeStringSet(skill.manifest.permissionScopes)
    .filter((scope) => !baselinePermissions.has(scope));
  const eligibleForCanary = (
    candidate.score === 1 &&
    candidate.score > baseline.score &&
    permissionDelta.length === 0
  );

  return {
    id: options.evaluationId,
    skillId: skill.id,
    candidateContentHash: skill.contentHash,
    suiteId: suite.id,
    suiteHash: suite.suiteHash,
    candidateScore: candidate.score,
    baselineScore: baseline.score,
    permissionDelta,
    eligibleForCanary,
    caseResults: candidate.results,
    createdAt: options.createdAt,
  };
};

export const getSkillEvaluationLedgerMetadata = (
  evaluation: SkillEvaluation,
): SkillEvaluationLedgerMetadata => ({
  evaluationId: evaluation.id,
  skillId: evaluation.skillId,
  candidateContentHash: evaluation.candidateContentHash,
  suiteId: evaluation.suiteId,
  suiteHash: evaluation.suiteHash,
  candidateScore: evaluation.candidateScore,
  baselineScore: evaluation.baselineScore,
  permissionDelta: [...evaluation.permissionDelta],
  eligibleForCanary: evaluation.eligibleForCanary,
  caseCount: evaluation.caseResults.length,
  passedCaseCount: evaluation.caseResults.filter((item) => item.passed).length,
});

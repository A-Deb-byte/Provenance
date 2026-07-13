import {
  PureTransformProgram,
  SkillCase,
  SkillCaseResult,
  SkillEvaluation,
  SkillPackage,
} from '../types';
import { HARD_MAX_OUTPUT_CHARS, runPureTransform, stableHash } from './runtime';

export interface SkillEvaluationOptions {
  evaluationId: string;
  createdAt: string;
  baselineProgram?: PureTransformProgram;
  baselinePermissionScopes?: string[];
}

export interface SkillEvaluationLedgerMetadata {
  evaluationId: string;
  skillId: string;
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
  skill: Pick<SkillPackage, 'manifest' | 'program' | 'trainingCases' | 'replayCases'>,
) => ({
  manifest: {
    ...skill.manifest,
    permissionScopes: normalizeStringSet(skill.manifest.permissionScopes),
    supportedPlatforms: normalizeStringSet(skill.manifest.supportedPlatforms),
    expectedArtifacts: normalizeStringSet(skill.manifest.expectedArtifacts),
  },
  program: skill.program,
  trainingCases: sortCases(skill.trainingCases),
  replayCases: sortCases(skill.replayCases),
});

export const computeSkillContentHash = (
  skill: Pick<SkillPackage, 'manifest' | 'program' | 'trainingCases' | 'replayCases'>,
): string => stableHash(normalizedHashContent(skill));

const validateReplayCases = (skill: SkillPackage): SkillCase[] => {
  if (skill.replayCases.length === 0) {
    throw new Error('Skill evaluation requires at least one held-out replay case.');
  }
  if (skill.replayCases.some((item) => item.kind !== 'replay')) {
    throw new Error('Skill evaluation accepts replay cases only.');
  }
  const ids = new Set(skill.replayCases.map((item) => item.id));
  if (ids.size !== skill.replayCases.length) {
    throw new Error('Replay case ids must be unique.');
  }
  if (skill.replayCases.some((item) => (
    item.input.length > skill.manifest.maxInputChars ||
    item.expectedOutput.length > HARD_MAX_OUTPUT_CHARS
  ))) {
    throw new Error('Replay case content exceeds the package limits.');
  }
  return sortCases(skill.replayCases);
};

const evaluateProgram = (
  program: PureTransformProgram,
  cases: SkillCase[],
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
  options: SkillEvaluationOptions,
): SkillEvaluation => {
  if (!options.evaluationId.trim()) throw new Error('Skill evaluation id is required.');
  if (computeSkillContentHash(skill) !== skill.contentHash) {
    throw new Error('Skill package content hash does not match its content.');
  }

  const replayCases = validateReplayCases(skill);
  const baselineProgram = options.baselineProgram ?? {
    runtime: 'pure-transform-v1' as const,
    steps: [],
  };
  const candidate = evaluateProgram(skill.program, replayCases, skill);
  const baseline = evaluateProgram(baselineProgram, replayCases, skill);
  const baselinePermissions = new Set(normalizeStringSet(options.baselinePermissionScopes ?? []));
  const permissionDelta = normalizeStringSet(skill.manifest.permissionScopes)
    .filter((scope) => !baselinePermissions.has(scope));
  const eligibleForCanary = (
    candidate.score === 1 &&
    candidate.score > baseline.score &&
    permissionDelta.length === 0
  );
  const suiteHash = stableHash({
    skillId: skill.id,
    skillContentHash: skill.contentHash,
    replayCases,
    baselineProgram,
    baselinePermissionScopes: [...baselinePermissions].sort(compareText),
  });

  return {
    id: options.evaluationId,
    skillId: skill.id,
    suiteHash,
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
  suiteHash: evaluation.suiteHash,
  candidateScore: evaluation.candidateScore,
  baselineScore: evaluation.baselineScore,
  permissionDelta: [...evaluation.permissionDelta],
  eligibleForCanary: evaluation.eligibleForCanary,
  caseCount: evaluation.caseResults.length,
  passedCaseCount: evaluation.caseResults.filter((item) => item.passed).length,
});

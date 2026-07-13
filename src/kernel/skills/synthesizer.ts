import {
  PureTransformOperation,
  PureTransformProgram,
  SkillCase,
  SkillCaseResult,
} from '../types';
import {
  HARD_MAX_INPUT_CHARS,
  HARD_MAX_STEPS,
  PURE_TRANSFORM_OPERATIONS,
  runPureTransform,
} from './runtime';

export const MAX_SKILL_CASES = 32;
export const DEFAULT_SYNTHESIS_MAX_INPUT_CHARS = 8 * 1024;

export interface SkillSynthesisOptions {
  maxSteps?: number;
  maxInputChars?: number;
}

export interface SkillSynthesisResult {
  program: PureTransformProgram;
  candidateScore: number;
  baselineScore: number;
  improvesBaseline: boolean;
  trainingResults: SkillCaseResult[];
  programsEvaluated: number;
}

const identityProgram = (): PureTransformProgram => ({
  runtime: 'pure-transform-v1',
  steps: [],
});

const compareCases = (left: SkillCase, right: SkillCase): number => {
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
};

const validateCases = (cases: SkillCase[], maxInputChars: number): SkillCase[] => {
  if (cases.length === 0) throw new Error('At least one training case is required.');
  if (cases.length > MAX_SKILL_CASES) {
    throw new Error(`Skill synthesis accepts at most ${MAX_SKILL_CASES} training cases.`);
  }
  if (cases.some((item) => item.kind !== 'train')) {
    throw new Error('Skill synthesis accepts training cases only.');
  }
  const ids = new Set(cases.map((item) => item.id));
  if (ids.size !== cases.length) throw new Error('Skill case ids must be unique.');
  for (const item of cases) {
    if (!item.id.trim()) throw new Error('Skill case ids must not be empty.');
    if (item.input.length > maxInputChars || item.expectedOutput.length > HARD_MAX_INPUT_CHARS) {
      throw new Error('Skill case content exceeds the configured character limit.');
    }
  }
  return [...cases].sort(compareCases);
};

const scoreProgram = (
  program: PureTransformProgram,
  cases: SkillCase[],
  maxInputChars: number,
): { score: number; results: SkillCaseResult[] } => {
  let passed = 0;
  const results = cases.map((item) => {
    const actualOutput = runPureTransform(program, item.input, {
      maxInputChars,
      maxSteps: HARD_MAX_STEPS,
    });
    const didPass = actualOutput === item.expectedOutput;
    if (didPass) passed += 1;
    return { caseId: item.id, actualOutput, passed: didPass };
  });
  return { score: passed / cases.length, results };
};

const programKey = (program: PureTransformProgram): string => {
  return program.steps
    .map((step) => PURE_TRANSFORM_OPERATIONS.indexOf(step.operation).toString().padStart(2, '0'))
    .join('.');
};

const isPreferred = (
  score: number,
  program: PureTransformProgram,
  bestScore: number,
  bestProgram: PureTransformProgram,
): boolean => {
  if (score !== bestScore) return score > bestScore;
  if (program.steps.length !== bestProgram.steps.length) {
    return program.steps.length < bestProgram.steps.length;
  }
  return programKey(program) < programKey(bestProgram);
};

const enumeratePrograms = function* (
  length: number,
  prefix: PureTransformOperation[] = [],
): Generator<PureTransformProgram> {
  if (prefix.length === length) {
    yield {
      runtime: 'pure-transform-v1',
      steps: prefix.map((operation) => ({ operation })),
    };
    return;
  }
  for (const operation of PURE_TRANSFORM_OPERATIONS) {
    if (prefix.at(-1) === operation) continue;
    yield* enumeratePrograms(length, [...prefix, operation]);
  }
};

export const synthesizePureTransform = (
  cases: SkillCase[],
  options: SkillSynthesisOptions = {},
): SkillSynthesisResult => {
  const maxSteps = options.maxSteps ?? HARD_MAX_STEPS;
  const maxInputChars = options.maxInputChars ?? DEFAULT_SYNTHESIS_MAX_INPUT_CHARS;
  if (!Number.isInteger(maxSteps) || maxSteps < 0 || maxSteps > HARD_MAX_STEPS) {
    throw new Error(`Synthesis maxSteps must be between 0 and ${HARD_MAX_STEPS}.`);
  }
  if (
    !Number.isInteger(maxInputChars) ||
    maxInputChars < 1 ||
    maxInputChars > HARD_MAX_INPUT_CHARS
  ) {
    throw new Error(`Synthesis maxInputChars must be between 1 and ${HARD_MAX_INPUT_CHARS}.`);
  }

  const sortedCases = validateCases(cases, maxInputChars);
  const baseline = identityProgram();
  const baselineEvaluation = scoreProgram(baseline, sortedCases, maxInputChars);
  let bestProgram = baseline;
  let bestEvaluation = baselineEvaluation;
  let programsEvaluated = 1;

  for (let length = 1; length <= maxSteps; length += 1) {
    for (const program of enumeratePrograms(length)) {
      const evaluation = scoreProgram(program, sortedCases, maxInputChars);
      programsEvaluated += 1;
      if (isPreferred(evaluation.score, program, bestEvaluation.score, bestProgram)) {
        bestProgram = program;
        bestEvaluation = evaluation;
      }
    }
  }

  return {
    program: bestProgram,
    candidateScore: bestEvaluation.score,
    baselineScore: baselineEvaluation.score,
    improvesBaseline: bestEvaluation.score > baselineEvaluation.score,
    trainingResults: bestEvaluation.results,
    programsEvaluated,
  };
};

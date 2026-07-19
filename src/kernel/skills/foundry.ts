import {
  PureTransformProgram,
  SkillActivation,
  SkillCandidateAuthor,
  SkillCase,
  SkillEvaluation,
  SkillEvaluationSuite,
  SkillManifest,
  SkillPackage,
} from '../types';
import { computeSkillContentHash } from './evaluation';
import {
  assertIndependentSkillEvaluation,
  assertSkillEvaluationSuiteIntegrity,
  getSkillOracleCase,
} from './evaluationSuite';
import {
  HARD_MAX_INPUT_CHARS,
  HARD_MAX_OUTPUT_CHARS,
  HARD_MAX_STEPS,
  runPureTransform,
} from './runtime';
import { MAX_SKILL_CASES } from './synthesizer';

export interface CreateSkillCandidateInput {
  id: string;
  manifest: SkillManifest;
  program: PureTransformProgram;
  trainingCases: SkillCase[];
  author: SkillCandidateAuthor;
  evaluationSuite: SkillEvaluationSuite;
  previousVersionId?: string;
  createdAt: string;
}

export interface ActivateSkillCanaryInput {
  activationId: string;
  maxRuns: number;
  createdAt: string;
}

export interface CanaryRunInput {
  passed: boolean;
  updatedAt: string;
}

export interface SkillAndActivation {
  skill: SkillPackage;
  activation: SkillActivation;
}

export interface SkillPackageLedgerMetadata {
  skillId: string;
  name: string;
  version: string;
  runtime: SkillManifest['runtime'];
  status: SkillPackage['status'];
  contentHash: string;
  evaluationSuiteId: string;
  evaluationSuiteHash: string;
  authorPrincipalId: string;
  permissionScopes: string[];
  trainingCaseCount: number;
  previousVersionId?: string;
}

export interface SkillActivationLedgerMetadata {
  activationId: string;
  skillId: string;
  evaluationId: string;
  candidateContentHash: string;
  suiteId: string;
  suiteHash: string;
  replayCaseIds: string[];
  status: SkillActivation['status'];
  maxRuns: number;
  usedRuns: number;
  passedRuns: number;
  failedRuns: number;
  rollbackReason?: string;
}

const compareText = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const normalizeStringSet = <T extends string>(values: T[]): T[] => {
  return [...new Set(values)].sort(compareText);
};

const sortCases = (cases: SkillCase[]): SkillCase[] => {
  return [...cases]
    .map((item) => ({ ...item }))
    .sort((left, right) => compareText(left.id, right.id));
};

const normalizeManifest = (manifest: SkillManifest): SkillManifest => ({
  ...manifest,
  permissionScopes: normalizeStringSet(manifest.permissionScopes),
  supportedPlatforms: normalizeStringSet(manifest.supportedPlatforms),
  expectedArtifacts: normalizeStringSet(manifest.expectedArtifacts),
  provenance: { ...manifest.provenance },
});

const validateManifest = (manifest: SkillManifest): void => {
  if (
    manifest.schemaVersion !== 1 ||
    manifest.runtime !== 'pure-transform-v1' ||
    manifest.inputType !== 'text' ||
    manifest.outputType !== 'text' ||
    manifest.dependencyLock !== 'builtin:pure-transform-v1' ||
    manifest.sideEffects !== 'none'
  ) {
    throw new Error('Skill manifest is incompatible with the pure transform runtime.');
  }
  if (!manifest.name.trim() || !manifest.version.trim() || !manifest.description.trim()) {
    throw new Error('Skill manifest name, version, and description are required.');
  }
  if (!manifest.rollbackInstructions.trim()) {
    throw new Error('Skill rollback instructions are required.');
  }
  if (
    !Number.isInteger(manifest.maxInputChars) ||
    manifest.maxInputChars < 1 ||
    manifest.maxInputChars > HARD_MAX_INPUT_CHARS
  ) {
    throw new Error(`Skill maxInputChars must be between 1 and ${HARD_MAX_INPUT_CHARS}.`);
  }
  if (
    !Number.isInteger(manifest.maxSteps) ||
    manifest.maxSteps < 0 ||
    manifest.maxSteps > HARD_MAX_STEPS
  ) {
    throw new Error(`Skill maxSteps must be between 0 and ${HARD_MAX_STEPS}.`);
  }
  if (
    !Number.isInteger(manifest.rateLimitPerMinute) ||
    manifest.rateLimitPerMinute < 1 ||
    manifest.rateLimitPerMinute > 600
  ) {
    throw new Error('Skill rateLimitPerMinute must be between 1 and 600.');
  }
  if (manifest.supportedPlatforms.length === 0) {
    throw new Error('Skill manifest must declare at least one supported platform.');
  }
  if (manifest.permissionScopes.some((scope) => !scope.trim())) {
    throw new Error('Skill permission scopes must not be empty.');
  }
};

const validateCases = (
  trainingCases: SkillCase[],
  maxInputChars: number,
): void => {
  if (trainingCases.length === 0) {
    throw new Error('A skill candidate requires training cases.');
  }
  if (trainingCases.length > MAX_SKILL_CASES) {
    throw new Error(`A skill candidate accepts at most ${MAX_SKILL_CASES} training cases.`);
  }
  if (trainingCases.some((item) => item.kind !== 'train')) {
    throw new Error('Training suites may contain training cases only.');
  }
  const ids = new Set(trainingCases.map((item) => item.id));
  if (ids.size !== trainingCases.length || trainingCases.some((item) => !item.id.trim())) {
    throw new Error('Skill training case ids must be non-empty and unique.');
  }
  for (const item of trainingCases) {
    if (item.input.length > maxInputChars || item.expectedOutput.length > HARD_MAX_OUTPUT_CHARS) {
      throw new Error('Skill case content exceeds the package limits.');
    }
  }
};

const assertSkillContentIntegrity = (skill: SkillPackage): void => {
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
};

export const createSkillCandidate = (input: CreateSkillCandidateInput): SkillPackage => {
  if (!input.id.trim()) throw new Error('Skill id is required.');
  if (!Number.isFinite(Date.parse(input.createdAt))) {
    throw new Error('Skill candidate creation timestamp is invalid.');
  }
  const manifest = normalizeManifest(input.manifest);
  const trainingCases = sortCases(input.trainingCases);
  assertSkillEvaluationSuiteIntegrity(input.evaluationSuite);
  if (Date.parse(input.evaluationSuite.sealedAt) > Date.parse(input.createdAt)) {
    throw new Error('Skill evaluation suite must be sealed before candidate creation.');
  }
  const program: PureTransformProgram = {
    runtime: input.program.runtime,
    steps: input.program.steps.map((step) => ({ ...step })),
  };
  validateManifest(manifest);
  validateCases(trainingCases, manifest.maxInputChars);
  assertIndependentSkillEvaluation(trainingCases, input.author, input.evaluationSuite);
  if (input.evaluationSuite.cases.some((item) => item.input.length > manifest.maxInputChars)) {
    throw new Error('Skill evaluation suite input exceeds the candidate package limit.');
  }
  runPureTransform(program, '', {
    maxInputChars: manifest.maxInputChars,
    maxSteps: manifest.maxSteps,
  });

  const draft: SkillPackage = {
    id: input.id,
    manifest,
    program,
    trainingCases,
    author: { ...input.author },
    evaluationSuiteId: input.evaluationSuite.id,
    evaluationSuiteHash: input.evaluationSuite.suiteHash,
    status: 'candidate',
    contentHash: '',
    previousVersionId: input.previousVersionId,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
  return { ...draft, contentHash: computeSkillContentHash(draft) };
};

export const applySkillEvaluation = (
  skill: SkillPackage,
  evaluation: SkillEvaluation,
  updatedAt: string,
): SkillPackage => {
  assertSkillContentIntegrity(skill);
  if (skill.status !== 'candidate') {
    throw new Error('Only a candidate skill can receive its first evaluation.');
  }
  if (evaluation.skillId !== skill.id) {
    throw new Error('Skill evaluation does not belong to this package.');
  }
  if (
    evaluation.candidateContentHash !== skill.contentHash ||
    evaluation.suiteId !== skill.evaluationSuiteId ||
    evaluation.suiteHash !== skill.evaluationSuiteHash
  ) {
    throw new Error('Skill evaluation does not match the candidate and sealed oracle binding.');
  }
  return {
    ...skill,
    status: evaluation.eligibleForCanary ? 'evaluated' : 'rejected',
    updatedAt,
  };
};

export const activateSkillCanary = (
  skill: SkillPackage,
  evaluation: SkillEvaluation,
  suite: SkillEvaluationSuite,
  input: ActivateSkillCanaryInput,
): SkillAndActivation => {
  assertSkillContentIntegrity(skill);
  assertSkillEvaluationSuiteIntegrity(suite);
  if (skill.status !== 'evaluated' || !evaluation.eligibleForCanary) {
    throw new Error('Only an evaluated, eligible skill can enter canary activation.');
  }
  if (evaluation.skillId !== skill.id) {
    throw new Error('Skill evaluation does not belong to this package.');
  }
  if (
    skill.evaluationSuiteId !== suite.id ||
    skill.evaluationSuiteHash !== suite.suiteHash ||
    evaluation.candidateContentHash !== skill.contentHash ||
    evaluation.suiteId !== suite.id ||
    evaluation.suiteHash !== suite.suiteHash
  ) {
    throw new Error('Canary activation does not match the candidate and sealed oracle binding.');
  }
  if (!input.activationId.trim()) throw new Error('Skill activation id is required.');
  if (!Number.isInteger(input.maxRuns) || input.maxRuns < 1 || input.maxRuns > 100) {
    throw new Error('Canary maxRuns must be between 1 and 100.');
  }
  if (input.maxRuns > suite.cases.length) {
    throw new Error('Canary maxRuns exceeds the sealed oracle case count.');
  }
  if (evaluation.caseResults.length === 0 || evaluation.caseResults.some((result) => !result.passed)) {
    throw new Error('Canary activation requires a successful held-out evaluation suite.');
  }
  if (
    evaluation.caseResults.length !== suite.cases.length ||
    evaluation.caseResults.some((result, index) => result.caseId !== suite.cases[index].id)
  ) {
    throw new Error('Canary activation evaluation order does not match the sealed oracle suite.');
  }
  const replayCaseIds = Array.from(
    { length: input.maxRuns },
    (_, index) => getSkillOracleCase(suite, index).id,
  );

  return {
    skill: { ...skill, status: 'canary', updatedAt: input.createdAt },
    activation: {
      id: input.activationId,
      skillId: skill.id,
      evaluationId: evaluation.id,
      candidateContentHash: skill.contentHash,
      suiteId: suite.id,
      suiteHash: suite.suiteHash,
      replayCaseIds,
      status: 'canary',
      maxRuns: input.maxRuns,
      usedRuns: 0,
      passedRuns: 0,
      failedRuns: 0,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    },
  };
};

export const recordCanaryRun = (
  skill: SkillPackage,
  activation: SkillActivation,
  input: CanaryRunInput,
): SkillActivation => {
  assertSkillContentIntegrity(skill);
  if (skill.status !== 'canary' || activation.skillId !== skill.id) {
    throw new Error('Canary activation does not belong to an active canary skill.');
  }
  if (
    activation.candidateContentHash !== skill.contentHash ||
    activation.suiteId !== skill.evaluationSuiteId ||
    activation.suiteHash !== skill.evaluationSuiteHash
  ) {
    throw new Error('Canary activation does not match the candidate and sealed oracle binding.');
  }
  if (activation.status !== 'canary' || activation.usedRuns >= activation.maxRuns) {
    throw new Error('Canary activation is not accepting additional runs.');
  }
  return {
    ...activation,
    status: input.passed ? 'canary' : 'failed',
    usedRuns: activation.usedRuns + 1,
    passedRuns: activation.passedRuns + (input.passed ? 1 : 0),
    failedRuns: activation.failedRuns + (input.passed ? 0 : 1),
    updatedAt: input.updatedAt,
  };
};

export const promoteSkill = (
  skill: SkillPackage,
  activation: SkillActivation,
  updatedAt: string,
): SkillAndActivation => {
  assertSkillContentIntegrity(skill);
  if (skill.status !== 'canary' || activation.skillId !== skill.id || activation.status !== 'canary') {
    throw new Error('Only an active canary skill can be promoted.');
  }
  if (
    activation.candidateContentHash !== skill.contentHash ||
    activation.suiteId !== skill.evaluationSuiteId ||
    activation.suiteHash !== skill.evaluationSuiteHash
  ) {
    throw new Error('Skill promotion oracle binding does not match the candidate.');
  }
  if (
    activation.usedRuns !== activation.maxRuns ||
    activation.passedRuns !== activation.maxRuns ||
    activation.failedRuns !== 0
  ) {
    throw new Error('Skill promotion requires all canary runs to pass.');
  }
  return {
    skill: { ...skill, status: 'promoted', updatedAt },
    activation: { ...activation, status: 'active', updatedAt },
  };
};

export const rollbackSkill = (
  skill: SkillPackage,
  activation: SkillActivation,
  reason: string,
  updatedAt: string,
): SkillAndActivation => {
  assertSkillContentIntegrity(skill);
  if (skill.status !== 'canary' && skill.status !== 'promoted') {
    throw new Error('Only canary or promoted skills can be rolled back.');
  }
  if (activation.skillId !== skill.id || activation.status === 'rolled_back') {
    throw new Error('Skill activation cannot be rolled back from its current state.');
  }
  if (!reason.trim()) throw new Error('Skill rollback reason is required.');
  return {
    skill: { ...skill, status: 'rolled_back', updatedAt },
    activation: {
      ...activation,
      status: 'rolled_back',
      updatedAt,
      rollbackReason: reason.trim(),
    },
  };
};

export const getSkillPackageLedgerMetadata = (
  skill: SkillPackage,
): SkillPackageLedgerMetadata => ({
  skillId: skill.id,
  name: skill.manifest.name,
  version: skill.manifest.version,
  runtime: skill.manifest.runtime,
  status: skill.status,
  contentHash: skill.contentHash,
  evaluationSuiteId: skill.evaluationSuiteId,
  evaluationSuiteHash: skill.evaluationSuiteHash,
  authorPrincipalId: skill.author.principalId,
  permissionScopes: [...skill.manifest.permissionScopes],
  trainingCaseCount: skill.trainingCases.length,
  previousVersionId: skill.previousVersionId,
});

export const getSkillActivationLedgerMetadata = (
  activation: SkillActivation,
): SkillActivationLedgerMetadata => ({
  activationId: activation.id,
  skillId: activation.skillId,
  evaluationId: activation.evaluationId,
  candidateContentHash: activation.candidateContentHash,
  suiteId: activation.suiteId,
  suiteHash: activation.suiteHash,
  replayCaseIds: [...activation.replayCaseIds],
  status: activation.status,
  maxRuns: activation.maxRuns,
  usedRuns: activation.usedRuns,
  passedRuns: activation.passedRuns,
  failedRuns: activation.failedRuns,
  rollbackReason: activation.rollbackReason,
});

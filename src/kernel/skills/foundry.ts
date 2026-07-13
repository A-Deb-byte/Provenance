import {
  PureTransformProgram,
  SkillActivation,
  SkillCase,
  SkillEvaluation,
  SkillManifest,
  SkillPackage,
} from '../types';
import { computeSkillContentHash } from './evaluation';
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
  replayCases: SkillCase[];
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
  permissionScopes: string[];
  trainingCaseCount: number;
  replayCaseCount: number;
  previousVersionId?: string;
}

export interface SkillActivationLedgerMetadata {
  activationId: string;
  skillId: string;
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
  replayCases: SkillCase[],
  maxInputChars: number,
): void => {
  if (trainingCases.length === 0 || replayCases.length === 0) {
    throw new Error('A skill candidate requires training and held-out replay cases.');
  }
  if (trainingCases.length > MAX_SKILL_CASES || replayCases.length > MAX_SKILL_CASES) {
    throw new Error(`A skill candidate accepts at most ${MAX_SKILL_CASES} cases per suite.`);
  }
  if (trainingCases.some((item) => item.kind !== 'train')) {
    throw new Error('Training suites may contain training cases only.');
  }
  if (replayCases.some((item) => item.kind !== 'replay')) {
    throw new Error('Replay suites may contain replay cases only.');
  }
  const allCases = [...trainingCases, ...replayCases];
  const ids = new Set(allCases.map((item) => item.id));
  if (ids.size !== allCases.length || allCases.some((item) => !item.id.trim())) {
    throw new Error('Skill case ids must be non-empty and unique across suites.');
  }
  for (const item of allCases) {
    if (item.input.length > maxInputChars || item.expectedOutput.length > HARD_MAX_OUTPUT_CHARS) {
      throw new Error('Skill case content exceeds the package limits.');
    }
  }
};

const assertSkillContentIntegrity = (skill: SkillPackage): void => {
  if (computeSkillContentHash(skill) !== skill.contentHash) {
    throw new Error('Skill package content hash does not match its content.');
  }
};

export const createSkillCandidate = (input: CreateSkillCandidateInput): SkillPackage => {
  if (!input.id.trim()) throw new Error('Skill id is required.');
  const manifest = normalizeManifest(input.manifest);
  const trainingCases = sortCases(input.trainingCases);
  const replayCases = sortCases(input.replayCases);
  const program: PureTransformProgram = {
    runtime: input.program.runtime,
    steps: input.program.steps.map((step) => ({ ...step })),
  };
  validateManifest(manifest);
  validateCases(trainingCases, replayCases, manifest.maxInputChars);
  runPureTransform(program, '', {
    maxInputChars: manifest.maxInputChars,
    maxSteps: manifest.maxSteps,
  });

  const draft: SkillPackage = {
    id: input.id,
    manifest,
    program,
    trainingCases,
    replayCases,
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
  return {
    ...skill,
    status: evaluation.eligibleForCanary ? 'evaluated' : 'rejected',
    updatedAt,
  };
};

export const activateSkillCanary = (
  skill: SkillPackage,
  evaluation: SkillEvaluation,
  input: ActivateSkillCanaryInput,
): SkillAndActivation => {
  assertSkillContentIntegrity(skill);
  if (skill.status !== 'evaluated' || !evaluation.eligibleForCanary) {
    throw new Error('Only an evaluated, eligible skill can enter canary activation.');
  }
  if (evaluation.skillId !== skill.id) {
    throw new Error('Skill evaluation does not belong to this package.');
  }
  if (!input.activationId.trim()) throw new Error('Skill activation id is required.');
  if (!Number.isInteger(input.maxRuns) || input.maxRuns < 1 || input.maxRuns > 100) {
    throw new Error('Canary maxRuns must be between 1 and 100.');
  }

  return {
    skill: { ...skill, status: 'canary', updatedAt: input.createdAt },
    activation: {
      id: input.activationId,
      skillId: skill.id,
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
  permissionScopes: [...skill.manifest.permissionScopes],
  trainingCaseCount: skill.trainingCases.length,
  replayCaseCount: skill.replayCases.length,
  previousVersionId: skill.previousVersionId,
});

export const getSkillActivationLedgerMetadata = (
  activation: SkillActivation,
): SkillActivationLedgerMetadata => ({
  activationId: activation.id,
  skillId: activation.skillId,
  status: activation.status,
  maxRuns: activation.maxRuns,
  usedRuns: activation.usedRuns,
  passedRuns: activation.passedRuns,
  failedRuns: activation.failedRuns,
  rollbackReason: activation.rollbackReason,
});

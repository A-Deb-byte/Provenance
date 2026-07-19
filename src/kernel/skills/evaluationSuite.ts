import {
  SkillCandidateAuthor,
  SkillCase,
  SkillEvaluationSource,
  SkillEvaluationSuite,
  SkillOracleCase,
} from '../types';
import {
  HARD_MAX_INPUT_CHARS,
  HARD_MAX_OUTPUT_CHARS,
  stableHash,
} from './runtime';
import { MAX_SKILL_CASES } from './synthesizer';

export const SKILL_EVALUATOR_AUTHORITY_TYPE = 'kernel-attested-evaluator-v1' as const;
export const SKILL_CANDIDATE_AUTHOR_AUTHORITY_TYPE = 'authenticated-principal-v1' as const;

export interface CreateSkillEvaluationSourceInput {
  evaluatorId: string;
  sourceId: string;
  cases: SkillOracleCase[];
  observedAt: string;
}

export interface CreateSkillEvaluationSuiteInput {
  id: string;
  source: SkillEvaluationSource;
  sourceEventId: string;
  createdAt: string;
}

export type SkillEvaluationSourceResolver = (
  sourceId: string,
) => Promise<SkillEvaluationSource | undefined>;

export interface SkillEvaluationSourceLedgerMetadata {
  authorityType: typeof SKILL_EVALUATOR_AUTHORITY_TYPE;
  evaluatorId: string;
  sourceId: string;
  sourceContentHash: string;
  caseCount: number;
  observedAt: string;
}

export interface SkillEvaluationSuiteLedgerMetadata {
  suiteId: string;
  suiteHash: string;
  caseCount: number;
  authorityType: typeof SKILL_EVALUATOR_AUTHORITY_TYPE;
  evaluatorId: string;
  sourceId: string;
  sourceContentHash: string;
  sourceEventId: string;
  createdAt: string;
  sealedAt: string;
}

const isTimestamp = (value: unknown): value is string => (
  typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Date.parse(value))
);

const cloneCases = (cases: SkillOracleCase[]): SkillOracleCase[] => cases.map((item) => ({
  id: item.id,
  input: item.input,
  expectedOutput: item.expectedOutput,
  sourceRef: item.sourceRef,
}));

export const computeSkillCaseInputFingerprint = (input: string): string => stableHash({
  schemaVersion: 1,
  input,
});

const validateCases = (cases: SkillOracleCase[]): void => {
  if (cases.length === 0 || cases.length > MAX_SKILL_CASES) {
    throw new Error(`A skill evaluation suite requires between 1 and ${MAX_SKILL_CASES} oracle cases.`);
  }
  const ids = new Set<string>();
  const inputFingerprints = new Set<string>();
  for (const item of cases) {
    if (
      typeof item.id !== 'string' ||
      !item.id.trim() ||
      ids.has(item.id) ||
      typeof item.input !== 'string' ||
      typeof item.expectedOutput !== 'string' ||
      typeof item.sourceRef !== 'string' ||
      !item.sourceRef.trim()
    ) {
      throw new Error('Skill evaluation suite cases require unique ids and source provenance.');
    }
    if (
      item.input.length > HARD_MAX_INPUT_CHARS ||
      item.expectedOutput.length > HARD_MAX_OUTPUT_CHARS
    ) {
      throw new Error('Skill evaluation suite case content exceeds the hard runtime limits.');
    }
    const inputFingerprint = computeSkillCaseInputFingerprint(item.input);
    if (inputFingerprints.has(inputFingerprint)) {
      throw new Error('Skill evaluation suite held-out inputs must be unique.');
    }
    ids.add(item.id);
    inputFingerprints.add(inputFingerprint);
  }
};

const evaluationSourceHashContent = (
  source: Pick<
  SkillEvaluationSource,
  'schemaVersion' | 'authorityType' | 'evaluatorId' | 'sourceId' | 'cases' | 'observedAt'
  >,
) => ({
  schemaVersion: source.schemaVersion,
  authorityType: source.authorityType,
  evaluatorId: source.evaluatorId,
  sourceId: source.sourceId,
  // Order is part of the evaluator seal and the later canary sequence.
  cases: cloneCases(source.cases),
  observedAt: source.observedAt,
});

export const computeSkillEvaluationSourceHash = (
  source: Pick<
  SkillEvaluationSource,
  'schemaVersion' | 'authorityType' | 'evaluatorId' | 'sourceId' | 'cases' | 'observedAt'
  >,
): string => stableHash(evaluationSourceHashContent(source));

export const assertSkillEvaluationSourceIntegrity = (source: SkillEvaluationSource): void => {
  if (
    source.schemaVersion !== 1 ||
    source.authorityType !== SKILL_EVALUATOR_AUTHORITY_TYPE ||
    typeof source.evaluatorId !== 'string' ||
    !source.evaluatorId.trim() ||
    typeof source.sourceId !== 'string' ||
    !source.sourceId.trim() ||
    !Array.isArray(source.cases) ||
    !isTimestamp(source.observedAt)
  ) {
    throw new Error('Skill evaluation source authority is invalid.');
  }
  validateCases(source.cases);
  if (computeSkillEvaluationSourceHash(source) !== source.contentHash) {
    throw new Error('Skill evaluation source hash does not match its evaluator content.');
  }
};

export const createSkillEvaluationSource = (
  input: CreateSkillEvaluationSourceInput,
): SkillEvaluationSource => {
  const draft: SkillEvaluationSource = {
    schemaVersion: 1,
    authorityType: SKILL_EVALUATOR_AUTHORITY_TYPE,
    evaluatorId: input.evaluatorId,
    sourceId: input.sourceId,
    cases: cloneCases(input.cases),
    observedAt: input.observedAt,
    contentHash: '',
  };
  assertSkillEvaluationSourceIntegrity({
    ...draft,
    contentHash: computeSkillEvaluationSourceHash(draft),
  });
  return { ...draft, contentHash: computeSkillEvaluationSourceHash(draft) };
};

export const getSkillEvaluationSourceLedgerMetadata = (
  source: SkillEvaluationSource,
): SkillEvaluationSourceLedgerMetadata => {
  assertSkillEvaluationSourceIntegrity(source);
  return {
    authorityType: source.authorityType,
    evaluatorId: source.evaluatorId,
    sourceId: source.sourceId,
    sourceContentHash: source.contentHash,
    caseCount: source.cases.length,
    observedAt: source.observedAt,
  };
};

const suiteHashContent = (
  suite: Pick<
  SkillEvaluationSuite,
  'schemaVersion' | 'id' | 'cases' | 'authority' | 'provenance' | 'status' | 'createdAt' | 'sealedAt'
  >,
) => ({
  schemaVersion: suite.schemaVersion,
  id: suite.id,
  cases: cloneCases(suite.cases),
  authority: { ...suite.authority },
  provenance: { ...suite.provenance },
  status: suite.status,
  createdAt: suite.createdAt,
  sealedAt: suite.sealedAt,
});

export const computeSkillEvaluationSuiteHash = (
  suite: Pick<
  SkillEvaluationSuite,
  'schemaVersion' | 'id' | 'cases' | 'authority' | 'provenance' | 'status' | 'createdAt' | 'sealedAt'
  >,
): string => stableHash(suiteHashContent(suite));

export const assertSkillEvaluationSuiteIntegrity = (suite: SkillEvaluationSuite): void => {
  if (
    suite.schemaVersion !== 2 ||
    suite.status !== 'sealed' ||
    typeof suite.id !== 'string' ||
    !suite.id.trim() ||
    !Array.isArray(suite.cases) ||
    !isTimestamp(suite.createdAt) ||
    !isTimestamp(suite.sealedAt) ||
    Date.parse(suite.createdAt) > Date.parse(suite.sealedAt) ||
    suite.authority?.authorityType !== SKILL_EVALUATOR_AUTHORITY_TYPE ||
    typeof suite.authority.evaluatorId !== 'string' ||
    !suite.authority.evaluatorId.trim() ||
    typeof suite.authority.sourceId !== 'string' ||
    !suite.authority.sourceId.trim() ||
    typeof suite.authority.sourceContentHash !== 'string' ||
    !suite.authority.sourceContentHash.trim() ||
    typeof suite.authority.sourceEventId !== 'string' ||
    !suite.authority.sourceEventId.trim() ||
    !isTimestamp(suite.authority.observedAt) ||
    Date.parse(suite.authority.observedAt) > Date.parse(suite.createdAt) ||
    suite.provenance?.sourceType !== 'kernel_event' ||
    suite.provenance.sourceId !== suite.authority.sourceEventId ||
    suite.provenance.actor !== 'kernel' ||
    suite.provenance.observedAt !== suite.createdAt ||
    suite.provenance.excerptHash !== suite.authority.sourceContentHash
  ) {
    throw new Error('Skill evaluation suite evaluator authority or seal is invalid.');
  }
  validateCases(suite.cases);
  const reconstructedSource: SkillEvaluationSource = {
    schemaVersion: 1,
    authorityType: suite.authority.authorityType,
    evaluatorId: suite.authority.evaluatorId,
    sourceId: suite.authority.sourceId,
    cases: suite.cases,
    observedAt: suite.authority.observedAt,
    contentHash: suite.authority.sourceContentHash,
  };
  assertSkillEvaluationSourceIntegrity(reconstructedSource);
  if (computeSkillEvaluationSuiteHash(suite) !== suite.suiteHash) {
    throw new Error('Skill evaluation suite hash does not match its sealed content.');
  }
};

export const createSkillEvaluationSuite = (
  input: CreateSkillEvaluationSuiteInput,
): SkillEvaluationSuite => {
  if (typeof input.id !== 'string' || !input.id.trim()) {
    throw new Error('Skill evaluation suite id is required.');
  }
  if (!isTimestamp(input.createdAt)) {
    throw new Error('Skill evaluation suite creation timestamp is invalid.');
  }
  if (typeof input.sourceEventId !== 'string' || !input.sourceEventId.trim()) {
    throw new Error('Skill evaluation suite requires a kernel source-attestation event.');
  }
  assertSkillEvaluationSourceIntegrity(input.source);
  if (Date.parse(input.source.observedAt) > Date.parse(input.createdAt)) {
    throw new Error('Skill evaluation source cannot postdate its kernel attestation.');
  }
  const authority = {
    authorityType: input.source.authorityType,
    evaluatorId: input.source.evaluatorId,
    sourceId: input.source.sourceId,
    sourceContentHash: input.source.contentHash,
    sourceEventId: input.sourceEventId,
    observedAt: input.source.observedAt,
  };
  const draft: SkillEvaluationSuite = {
    schemaVersion: 2,
    id: input.id,
    cases: cloneCases(input.source.cases),
    authority,
    provenance: {
      sourceType: 'kernel_event',
      sourceId: input.sourceEventId,
      actor: 'kernel',
      observedAt: input.createdAt,
      excerptHash: input.source.contentHash,
    },
    status: 'sealed',
    suiteHash: '',
    createdAt: input.createdAt,
    sealedAt: input.createdAt,
  };
  return { ...draft, suiteHash: computeSkillEvaluationSuiteHash(draft) };
};

export const assertIndependentSkillEvaluation = (
  trainingCases: SkillCase[],
  author: SkillCandidateAuthor,
  suite: SkillEvaluationSuite,
): void => {
  assertSkillEvaluationSuiteIntegrity(suite);
  if (
    author?.authorityType !== SKILL_CANDIDATE_AUTHOR_AUTHORITY_TYPE ||
    typeof author.principalId !== 'string' ||
    !author.principalId.trim()
  ) {
    throw new Error('Skill candidate requires authenticated author authority.');
  }
  if (author.principalId === suite.authority.evaluatorId) {
    throw new Error('Skill candidate author cannot be the held-out suite evaluator.');
  }
  const oracleIds = new Set(suite.cases.map((item) => item.id));
  const oracleInputFingerprints = new Set(
    suite.cases.map((item) => computeSkillCaseInputFingerprint(item.input)),
  );
  if (trainingCases.some((item) => (
    oracleIds.has(item.id) ||
    oracleInputFingerprints.has(computeSkillCaseInputFingerprint(item.input)) ||
    item.sourceEventId === suite.authority.sourceEventId
  ))) {
    throw new Error('Skill training cases overlap the held-out evaluator suite.');
  }
};

export const getSkillEvaluationSuiteLedgerMetadata = (
  suite: SkillEvaluationSuite,
): SkillEvaluationSuiteLedgerMetadata => {
  assertSkillEvaluationSuiteIntegrity(suite);
  return {
    suiteId: suite.id,
    suiteHash: suite.suiteHash,
    caseCount: suite.cases.length,
    authorityType: suite.authority.authorityType,
    evaluatorId: suite.authority.evaluatorId,
    sourceId: suite.authority.sourceId,
    sourceContentHash: suite.authority.sourceContentHash,
    sourceEventId: suite.authority.sourceEventId,
    createdAt: suite.createdAt,
    sealedAt: suite.sealedAt,
  };
};

export const getSkillOracleCase = (
  suite: SkillEvaluationSuite,
  runIndex: number,
): SkillOracleCase => {
  assertSkillEvaluationSuiteIntegrity(suite);
  if (!Number.isSafeInteger(runIndex) || runIndex < 0 || runIndex >= suite.cases.length) {
    throw new Error('Skill canary oracle case index is outside the sealed suite.');
  }
  return { ...suite.cases[runIndex] };
};

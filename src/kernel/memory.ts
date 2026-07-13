import crypto from 'node:crypto';
import { createKernelId } from './ids';
import type {
  KernelActor,
  KernelMemoryRecord,
  MemoryEvidenceRef,
  MemoryKind,
  MemoryProvenance,
  MemoryRetention,
  MemoryScope,
  MemorySensitivity,
} from './types';

export interface CreateMemoryCandidateInput {
  kind: MemoryKind;
  content: string;
  confidence: number;
  scope: MemoryScope;
  sensitivity: MemorySensitivity;
  retention: MemoryRetention;
  provenance: MemoryProvenance;
  evidenceRefs: MemoryEvidenceRef[];
  contradictionIds?: string[];
  supersedesIds?: string[];
}

export interface MemoryTransitionResult {
  record: KernelMemoryRecord;
  records: KernelMemoryRecord[];
}

const memoryKinds = new Set<MemoryKind>(['working', 'episodic', 'semantic', 'procedural', 'intent']);
const memorySensitivities = new Set<MemorySensitivity>(['public', 'internal', 'confidential', 'secret']);
const sourceTypes = new Set<MemoryProvenance['sourceType']>(['user', 'kernel_event', 'provider_candidate', 'import']);
const kernelActors = new Set<KernelActor>(['user', 'kernel', 'worker', 'provider', 'system']);

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const hasOnlyKeys = (value: Record<string, unknown>, allowedKeys: readonly string[]): boolean => {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
};

const isNonEmptyString = (value: unknown): value is string => (
  typeof value === 'string' && value.trim().length > 0
);

const isIsoTimestamp = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
};

const isUniqueStringArray = (value: unknown): value is string[] => {
  return Array.isArray(value) &&
    value.every(isNonEmptyString) &&
    new Set(value).size === value.length;
};

const isMemoryScope = (value: unknown): value is MemoryScope => {
  if (!isRecord(value) || !hasOnlyKeys(value, ['kind', 'id'])) return false;
  if (value.kind === 'global') return value.id === undefined;
  if (value.kind === 'workspace' || value.kind === 'goal') return isNonEmptyString(value.id);
  return false;
};

const isMemoryRetention = (value: unknown): value is MemoryRetention => {
  if (!isRecord(value) || !hasOnlyKeys(value, ['kind', 'expiresAt'])) return false;
  if (value.kind === 'until') return isIsoTimestamp(value.expiresAt);
  if (value.kind === 'session' || value.kind === 'durable') return value.expiresAt === undefined;
  return false;
};

const isMemoryProvenance = (value: unknown): value is MemoryProvenance => {
  if (!isRecord(value) || !hasOnlyKeys(value, ['sourceType', 'sourceId', 'actor', 'observedAt', 'excerptHash'])) {
    return false;
  }
  return (
    typeof value.sourceType === 'string' &&
    sourceTypes.has(value.sourceType as MemoryProvenance['sourceType']) &&
    isNonEmptyString(value.sourceId) &&
    typeof value.actor === 'string' &&
    kernelActors.has(value.actor as KernelActor) &&
    isIsoTimestamp(value.observedAt) &&
    (value.excerptHash === undefined || (typeof value.excerptHash === 'string' && /^[a-f0-9]{64}$/i.test(value.excerptHash)))
  );
};

const isMemoryEvidenceRef = (value: unknown): value is MemoryEvidenceRef => {
  if (!isRecord(value) || !hasOnlyKeys(value, ['eventId', 'artifactId'])) return false;
  return isNonEmptyString(value.eventId) && (value.artifactId === undefined || isNonEmptyString(value.artifactId));
};

const isMemoryEvidenceRefArray = (value: unknown): value is MemoryEvidenceRef[] => {
  if (!Array.isArray(value) || !value.every(isMemoryEvidenceRef)) return false;
  const keys = value.map((reference) => `${reference.eventId}\u0000${reference.artifactId ?? ''}`);
  return new Set(keys).size === keys.length;
};

export const isMemoryCandidateInput = (value: unknown): value is CreateMemoryCandidateInput => {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'kind',
    'content',
    'confidence',
    'scope',
    'sensitivity',
    'retention',
    'provenance',
    'evidenceRefs',
    'contradictionIds',
    'supersedesIds',
  ])) return false;

  return (
    typeof value.kind === 'string' &&
    memoryKinds.has(value.kind as MemoryKind) &&
    isNonEmptyString(value.content) &&
    typeof value.confidence === 'number' &&
    Number.isFinite(value.confidence) &&
    value.confidence >= 0 &&
    value.confidence <= 1 &&
    isMemoryScope(value.scope) &&
    typeof value.sensitivity === 'string' &&
    memorySensitivities.has(value.sensitivity as MemorySensitivity) &&
    isMemoryRetention(value.retention) &&
    isMemoryProvenance(value.provenance) &&
    isMemoryEvidenceRefArray(value.evidenceRefs) &&
    (value.contradictionIds === undefined || isUniqueStringArray(value.contradictionIds)) &&
    (value.supersedesIds === undefined || isUniqueStringArray(value.supersedesIds))
  );
};

const requireTimestamp = (value: string): void => {
  if (!isIsoTimestamp(value)) throw new Error('Memory lifecycle timestamp must be a canonical ISO timestamp.');
};

const requireReason = (reason: string): string => {
  const normalized = reason.trim();
  if (!normalized) throw new Error('Memory lifecycle reason is required.');
  return normalized;
};

const requireUniqueRecordIds = (records: readonly KernelMemoryRecord[]): void => {
  if (new Set(records.map((record) => record.id)).size !== records.length) {
    throw new Error('Memory records contain duplicate ids.');
  }
};

export const hashMemoryContent = (content: string): string => {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
};

export const createMemoryCandidate = (
  value: unknown,
  now = new Date().toISOString(),
): KernelMemoryRecord => {
  if (!isMemoryCandidateInput(value)) throw new Error('Invalid memory candidate input.');
  if (value.sensitivity === 'confidential' || value.sensitivity === 'secret') {
    throw new Error('Memory sensitivity is not supported without protected storage.');
  }
  requireTimestamp(now);

  const content = value.content.trim();
  return {
    id: createKernelId('mem'),
    kind: value.kind,
    status: 'candidate',
    content,
    contentHash: hashMemoryContent(content),
    confidence: value.confidence,
    scope: { ...value.scope },
    sensitivity: value.sensitivity,
    retention: { ...value.retention },
    provenance: { ...value.provenance },
    evidenceRefs: value.evidenceRefs.map((reference) => ({ ...reference })),
    contradictionIds: [...(value.contradictionIds ?? [])],
    supersedesIds: [...(value.supersedesIds ?? [])],
    createdAt: now,
    updatedAt: now,
  };
};

export const createMemoryLedgerPayload = (record: KernelMemoryRecord): Record<string, unknown> => ({
  memoryId: record.id,
  kind: record.kind,
  status: record.status,
  contentHash: record.contentHash,
  confidence: record.confidence,
  scope: { ...record.scope },
  sensitivity: record.sensitivity,
  retention: { ...record.retention },
  provenance: { ...record.provenance },
  evidenceRefs: record.evidenceRefs.map((reference) => ({ ...reference })),
  contradictionIds: [...record.contradictionIds],
  supersedesIds: [...record.supersedesIds],
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  promotedAt: record.promotedAt,
  revokedAt: record.revokedAt,
  lifecycleReason: record.lifecycleReason,
});

export const promoteMemoryRecord = (
  records: readonly KernelMemoryRecord[],
  memoryId: string,
  reason: string,
  now = new Date().toISOString(),
): MemoryTransitionResult => {
  requireUniqueRecordIds(records);
  const lifecycleReason = requireReason(reason);
  requireTimestamp(now);
  const candidate = records.find((record) => record.id === memoryId);
  if (!candidate) throw new Error('Memory record not found.');
  if (candidate.status !== 'candidate') throw new Error('Only candidate memory can be promoted.');
  if (!isMemoryEvidenceRefArray(candidate.evidenceRefs) || candidate.evidenceRefs.length === 0) {
    throw new Error('Memory promotion requires at least one valid evidence reference.');
  }

  const supersedes = new Set(candidate.supersedesIds);
  for (const supersededId of supersedes) {
    const prior = records.find((record) => record.id === supersededId);
    if (!prior) throw new Error(`Superseded memory record ${supersededId} was not found.`);
    if (prior.status !== 'promoted') {
      throw new Error(`Only promoted memory can be superseded: ${supersededId}.`);
    }
  }

  const unresolvedContradiction = records.find((record) => (
    record.id !== candidate.id &&
    record.status === 'promoted' &&
    (candidate.contradictionIds.includes(record.id) || record.contradictionIds.includes(candidate.id)) &&
    !supersedes.has(record.id)
  ));
  if (unresolvedContradiction) {
    throw new Error(`Memory promotion is blocked by unresolved promoted contradiction ${unresolvedContradiction.id}.`);
  }

  const updatedRecords = records.map((record): KernelMemoryRecord => {
    if (record.id === candidate.id) {
      return {
        ...record,
        status: 'promoted',
        promotedAt: now,
        updatedAt: now,
        lifecycleReason,
      };
    }
    if (supersedes.has(record.id)) {
      return {
        ...record,
        status: 'superseded',
        updatedAt: now,
        lifecycleReason: `Superseded by ${candidate.id}: ${lifecycleReason}`,
      };
    }
    return record;
  });
  const promoted = updatedRecords.find((record) => record.id === candidate.id);
  if (!promoted) throw new Error('Promoted memory record was not retained.');
  return { record: promoted, records: updatedRecords };
};

export const revokeMemoryRecord = (
  records: readonly KernelMemoryRecord[],
  memoryId: string,
  reason: string,
  now = new Date().toISOString(),
): MemoryTransitionResult => {
  requireUniqueRecordIds(records);
  const lifecycleReason = requireReason(reason);
  requireTimestamp(now);
  const target = records.find((record) => record.id === memoryId);
  if (!target) throw new Error('Memory record not found.');
  if (target.status === 'revoked') throw new Error('Memory record is already revoked.');

  const updatedRecords = records.map((record): KernelMemoryRecord => record.id === memoryId
    ? {
      ...record,
      status: 'revoked',
      revokedAt: now,
      updatedAt: now,
      lifecycleReason,
    }
    : record);
  const revoked = updatedRecords.find((record) => record.id === memoryId);
  if (!revoked) throw new Error('Revoked memory record was not retained.');
  return { record: revoked, records: updatedRecords };
};

export const listActiveMemories = (
  records: readonly KernelMemoryRecord[],
  now = new Date().toISOString(),
): KernelMemoryRecord[] => {
  requireTimestamp(now);
  const nowTime = Date.parse(now);
  return records.filter((record) => {
    if (record.status === 'revoked' || record.status === 'superseded') return false;
    if (record.retention.kind !== 'until') return true;
    if (!isIsoTimestamp(record.retention.expiresAt)) return false;
    return Date.parse(record.retention.expiresAt) > nowTime;
  });
};

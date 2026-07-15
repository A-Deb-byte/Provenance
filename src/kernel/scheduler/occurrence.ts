import type {
  RecurringResearchDueDecision,
  RecurringResearchEvidenceRef,
  RecurringResearchOccurrence,
  RecurringResearchOccurrenceStatus,
  RecurringResearchSchedule,
} from './types';
import { RECURRING_RESEARCH_SCHEMA_VERSION } from './types';
import { createRecurringResearchOccurrenceId } from './schedule';

const terminalStatuses = new Set<RecurringResearchOccurrenceStatus>([
  'completed', 'failed', 'blocked', 'uncertain', 'skipped',
]);

const canonicalTimestamp = (value: string, field: string): string => {
  let canonical: string;
  try {
    canonical = new Date(value).toISOString();
  } catch {
    throw new Error(`${field} must be a canonical ISO timestamp.`);
  }
  if (!value.trim() || canonical !== value) {
    throw new Error(`${field} must be a canonical ISO timestamp.`);
  }
  return value;
};

const nonEmpty = (value: string, field: string, max = 512): string => {
  if (!value.trim() || value.trim().length > max) throw new Error(`${field} must contain 1-${max} characters.`);
  return value.trim();
};

const immutable = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) immutable(child);
    Object.freeze(value);
  }
  return value;
};

const normalizeEvidenceRefs = (
  existing: readonly RecurringResearchEvidenceRef[],
  additions: readonly RecurringResearchEvidenceRef[],
): RecurringResearchEvidenceRef[] => {
  const output = existing.map((reference) => ({ ...reference }));
  const identities = new Set(output.map((reference) => `${reference.eventId}\0${reference.artifactId ?? ''}\0${reference.contentHash ?? ''}`));
  for (const reference of additions) {
    const normalized = {
      eventId: nonEmpty(reference.eventId, 'evidenceRef.eventId', 256),
      ...(reference.artifactId === undefined
        ? {}
        : { artifactId: nonEmpty(reference.artifactId, 'evidenceRef.artifactId', 256) }),
      ...(reference.contentHash === undefined
        ? {}
        : { contentHash: nonEmpty(reference.contentHash, 'evidenceRef.contentHash', 256) }),
    };
    const identity = `${normalized.eventId}\0${normalized.artifactId ?? ''}\0${normalized.contentHash ?? ''}`;
    if (!identities.has(identity)) {
      output.push(normalized);
      identities.add(identity);
    }
  }
  return output;
};

export const createDueResearchOccurrence = (
  schedule: RecurringResearchSchedule,
  decision: RecurringResearchDueDecision,
  now: string,
): RecurringResearchOccurrence => {
  if (!schedule.enabled) throw new Error('Disabled schedules cannot create due occurrences.');
  if (!decision.due) throw new Error('A not-due decision cannot create an occurrence.');
  const timestamp = canonicalTimestamp(now, 'now');
  const scheduledForMs = Date.parse(canonicalTimestamp(decision.scheduledFor, 'decision.scheduledFor'));
  const startsAtMs = Date.parse(schedule.trigger.startsAt);
  if (
    scheduledForMs < startsAtMs ||
    (scheduledForMs - startsAtMs) % schedule.trigger.everyMs !== 0 ||
    scheduledForMs > Date.parse(timestamp)
  ) {
    throw new Error('decision.scheduledFor must be a due interval boundary.');
  }
  if (
    !Number.isSafeInteger(decision.skippedIntervals) ||
    decision.skippedIntervals < 0 ||
    decision.catchUpApplied !== (decision.skippedIntervals > 0) ||
    Date.parse(decision.nextDueAt) !== scheduledForMs + schedule.trigger.everyMs
  ) {
    throw new Error('Due decision catch-up metadata is inconsistent.');
  }
  return immutable({
    schemaVersion: RECURRING_RESEARCH_SCHEMA_VERSION,
    id: createRecurringResearchOccurrenceId(schedule.id, schedule.version, decision.scheduledFor),
    scheduleId: schedule.id,
    scheduleVersion: schedule.version,
    scheduledFor: decision.scheduledFor,
    status: 'due',
    catchUpApplied: decision.catchUpApplied,
    skippedIntervals: decision.skippedIntervals,
    evidenceRefs: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  });
};

export const claimResearchOccurrence = (
  occurrence: RecurringResearchOccurrence,
  input: { owner: string; claimedAt: string; expiresAt: string },
): RecurringResearchOccurrence => {
  if (occurrence.status !== 'due') throw new Error('Only due occurrences can be claimed.');
  const claimedAt = canonicalTimestamp(input.claimedAt, 'lease.claimedAt');
  const expiresAt = canonicalTimestamp(input.expiresAt, 'lease.expiresAt');
  if (Date.parse(claimedAt) < Date.parse(occurrence.updatedAt)) {
    throw new Error('Occurrence transitions cannot move backward in time.');
  }
  if (Date.parse(expiresAt) <= Date.parse(claimedAt)) throw new Error('A lease must expire after it is claimed.');
  return immutable({
    ...occurrence,
    status: 'claimed',
    lease: { owner: nonEmpty(input.owner, 'lease.owner', 128), claimedAt, expiresAt },
    updatedAt: claimedAt,
  });
};

export const startResearchOccurrence = (
  occurrence: RecurringResearchOccurrence,
  owner: string,
  now: string,
): RecurringResearchOccurrence => {
  if (occurrence.status !== 'claimed' || !occurrence.lease) {
    throw new Error('Only a claimed occurrence with a lease can start.');
  }
  const timestamp = canonicalTimestamp(now, 'now');
  if (Date.parse(timestamp) < Date.parse(occurrence.updatedAt)) {
    throw new Error('Occurrence transitions cannot move backward in time.');
  }
  if (occurrence.lease.owner !== nonEmpty(owner, 'lease.owner', 128)) throw new Error('Only the lease owner can start an occurrence.');
  if (Date.parse(timestamp) >= Date.parse(occurrence.lease.expiresAt)) throw new Error('The occurrence lease has expired.');
  return immutable({ ...occurrence, status: 'running', updatedAt: timestamp });
};

export const resumeResearchOccurrence = (
  occurrence: RecurringResearchOccurrence,
  input: { owner: string; claimedAt: string; expiresAt: string },
): RecurringResearchOccurrence => {
  if (occurrence.status !== 'blocked' && occurrence.status !== 'uncertain') {
    throw new Error('Only blocked or uncertain occurrences can be explicitly resumed.');
  }
  const claimedAt = canonicalTimestamp(input.claimedAt, 'lease.claimedAt');
  const expiresAt = canonicalTimestamp(input.expiresAt, 'lease.expiresAt');
  if (Date.parse(claimedAt) < Date.parse(occurrence.updatedAt)) {
    throw new Error('Occurrence transitions cannot move backward in time.');
  }
  if (Date.parse(expiresAt) <= Date.parse(claimedAt)) throw new Error('A lease must expire after it is claimed.');
  const { statusReason: _statusReason, ...resumable } = occurrence;
  return immutable({
    ...resumable,
    status: 'claimed',
    lease: { owner: nonEmpty(input.owner, 'lease.owner', 128), claimedAt, expiresAt },
    updatedAt: claimedAt,
  });
};

export const skipResearchOccurrence = (
  occurrence: RecurringResearchOccurrence,
  reason: string,
  now: string,
): RecurringResearchOccurrence => {
  if (occurrence.status !== 'blocked' && occurrence.status !== 'uncertain') {
    throw new Error('Only blocked or uncertain occurrences can be explicitly skipped.');
  }
  const timestamp = canonicalTimestamp(now, 'now');
  if (Date.parse(timestamp) < Date.parse(occurrence.updatedAt)) {
    throw new Error('Occurrence transitions cannot move backward in time.');
  }
  return immutable({
    ...occurrence,
    status: 'skipped',
    statusReason: nonEmpty(reason, 'reason', 1_000),
    updatedAt: timestamp,
  });
};

export const finishResearchOccurrence = (
  occurrence: RecurringResearchOccurrence,
  input: {
    status: Extract<RecurringResearchOccurrenceStatus, 'completed' | 'failed' | 'blocked' | 'uncertain' | 'skipped'>;
    now: string;
    evidenceRefs?: readonly RecurringResearchEvidenceRef[];
    reason?: string;
  },
): RecurringResearchOccurrence => {
  const allowed = occurrence.status === 'running'
    ? new Set(['completed', 'failed', 'blocked', 'uncertain'])
    : occurrence.status === 'claimed'
      ? new Set(['blocked', 'uncertain'])
      : occurrence.status === 'due'
        ? new Set(['blocked', 'skipped'])
        : new Set<string>();
  if (!allowed.has(input.status)) throw new Error(`Occurrence cannot transition from ${occurrence.status} to ${input.status}.`);
  const timestamp = canonicalTimestamp(input.now, 'now');
  if (Date.parse(timestamp) < Date.parse(occurrence.updatedAt)) throw new Error('Occurrence transitions cannot move backward in time.');
  if (occurrence.lease && Date.parse(timestamp) >= Date.parse(occurrence.lease.expiresAt)) {
    throw new Error('The occurrence lease has expired; worker completion is no longer authoritative.');
  }
  const reason = input.status === 'completed'
    ? undefined
    : nonEmpty(input.reason ?? '', 'reason', 1_000);
  const finished = {
    ...occurrence,
    status: input.status,
    evidenceRefs: normalizeEvidenceRefs(occurrence.evidenceRefs, input.evidenceRefs ?? []),
    ...(reason === undefined ? {} : { statusReason: reason }),
    updatedAt: timestamp,
  } satisfies RecurringResearchOccurrence;
  return immutable(finished);
};

export const isTerminalResearchOccurrence = (occurrence: RecurringResearchOccurrence): boolean => (
  terminalStatuses.has(occurrence.status)
);

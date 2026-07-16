import { stableSha256 } from '../../capabilities/hash';
import type {
  RecurringResearchAuthority,
  RecurringResearchBudget,
  RecurringResearchDueDecision,
  RecurringResearchSchedule,
  RecurringResearchScheduleInput,
  RecurringResearchScheduleUpdate,
  RecurringResearchTrigger,
} from './types';
import {
  MAX_RESEARCH_INTERVAL_MS,
  MAX_RESEARCH_OBJECTIVE_CHARS,
  MAX_RESEARCH_SCHEDULE_SOURCES,
  MIN_RESEARCH_INTERVAL_MS,
  RECURRING_RESEARCH_SCHEMA_VERSION,
  RESEARCH_BUDGET_LIMITS,
} from './types';

const allowedInputKeys = new Set(['id', 'enabled', 'objective', 'sourceUrls', 'trigger', 'budget', 'authority']);
const allowedUpdateKeys = new Set(['enabled', 'objective', 'sourceUrls', 'trigger', 'budget', 'authority']);
const allowedScheduleKeys = new Set([
  'schemaVersion', 'kind', 'id', 'version', 'enabled', 'objective', 'sourceUrls',
  'trigger', 'budget', 'authority', 'createdAt', 'updatedAt',
]);
const requiredOperations = Object.freeze(['browser.inspect', 'provider.call'] as const);

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const assertOnlyKeys = (value: Record<string, unknown>, allowed: ReadonlySet<string>, field: string): void => {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${field} contains unsupported fields: ${unknown.sort().join(', ')}.`);
};

const immutable = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) immutable(child);
    Object.freeze(value);
  }
  return value;
};

const canonicalTimestamp = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a canonical ISO timestamp.`);
  let timestamp: string;
  try {
    timestamp = new Date(value).toISOString();
  } catch {
    throw new Error(`${field} must be a canonical ISO timestamp.`);
  }
  if (timestamp !== value) throw new Error(`${field} must be a canonical ISO timestamp.`);
  return timestamp;
};

const boundedInteger = (
  value: unknown,
  field: string,
  limits: { min: number; max: number },
): number => {
  if (!Number.isSafeInteger(value) || (value as number) < limits.min || (value as number) > limits.max) {
    throw new Error(`${field} must be an integer between ${limits.min} and ${limits.max}.`);
  }
  return value as number;
};

const normalizeId = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) {
    throw new Error('id must contain 1-128 URL-safe identity characters.');
  }
  return value;
};

const normalizeObjective = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > MAX_RESEARCH_OBJECTIVE_CHARS) {
    throw new Error(`objective must contain 1-${MAX_RESEARCH_OBJECTIVE_CHARS} characters.`);
  }
  return value.trim();
};

export const canonicalizeResearchSourceUrls = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_RESEARCH_SCHEDULE_SOURCES) {
    throw new Error(`sourceUrls must contain 1-${MAX_RESEARCH_SCHEDULE_SOURCES} URLs.`);
  }
  const sourceUrls = value.map((candidate, index) => {
    if (typeof candidate !== 'string' || !candidate.trim() || candidate.trim().length > 2_048) {
      throw new Error(`sourceUrls[${index}] is invalid.`);
    }
    let parsed: URL;
    try {
      parsed = new URL(candidate.trim());
    } catch {
      throw new Error(`sourceUrls[${index}] is not a valid URL.`);
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
      throw new Error(`sourceUrls[${index}] must be HTTPS without credentials or a fragment.`);
    }
    return parsed.toString();
  });
  if (new Set(sourceUrls).size !== sourceUrls.length) {
    throw new Error('sourceUrls must be unique after canonicalization.');
  }
  return sourceUrls;
};

const normalizeTrigger = (value: unknown): RecurringResearchTrigger => {
  if (!isRecord(value)) throw new Error('trigger must be an interval configuration.');
  if (value.type !== 'interval') throw new Error('Only interval triggers are supported; cron is forbidden.');
  assertOnlyKeys(value, new Set(['type', 'everyMs', 'startsAt', 'catchUp']), 'trigger');
  if (value.catchUp !== 'latest_once') throw new Error('trigger.catchUp must be latest_once.');
  return {
    type: 'interval',
    everyMs: boundedInteger(value.everyMs, 'trigger.everyMs', {
      min: MIN_RESEARCH_INTERVAL_MS,
      max: MAX_RESEARCH_INTERVAL_MS,
    }),
    startsAt: canonicalTimestamp(value.startsAt, 'trigger.startsAt'),
    catchUp: 'latest_once',
  };
};

const normalizeBudget = (value: unknown, sourceCount: number): RecurringResearchBudget => {
  if (!isRecord(value)) throw new Error('budget must be an object.');
  assertOnlyKeys(value, new Set(Object.keys(RESEARCH_BUDGET_LIMITS)), 'budget');
  const budget = {
    maxRuntimeMs: boundedInteger(value.maxRuntimeMs, 'budget.maxRuntimeMs', RESEARCH_BUDGET_LIMITS.maxRuntimeMs),
    maxProviderCalls: boundedInteger(
      value.maxProviderCalls,
      'budget.maxProviderCalls',
      RESEARCH_BUDGET_LIMITS.maxProviderCalls,
    ),
    maxSourceFetches: boundedInteger(
      value.maxSourceFetches,
      'budget.maxSourceFetches',
      RESEARCH_BUDGET_LIMITS.maxSourceFetches,
    ),
    maxAttempts: boundedInteger(value.maxAttempts, 'budget.maxAttempts', RESEARCH_BUDGET_LIMITS.maxAttempts),
  };
  if (budget.maxSourceFetches < sourceCount) {
    throw new Error('budget.maxSourceFetches must cover every fixed source URL.');
  }
  return budget;
};

export const deriveRecurringResearchAuthority = (
  sourceUrls: readonly string[],
): RecurringResearchAuthority => ({
  riskCeiling: 'L1',
  sideEffects: 'none',
  operations: [...requiredOperations],
  allowedOrigins: [...new Set(sourceUrls.map((url) => new URL(url).origin))].sort(),
  allowedSourceUrls: [...sourceUrls],
});

export const validateRecurringResearchAuthority = (
  value: unknown,
  sourceUrls: readonly string[],
): RecurringResearchAuthority => {
  const expected = deriveRecurringResearchAuthority(sourceUrls);
  if (!isRecord(value)) throw new Error('authority must be an object when supplied.');
  assertOnlyKeys(value, new Set(['riskCeiling', 'sideEffects', 'operations', 'allowedOrigins', 'allowedSourceUrls']), 'authority');
  if (value.riskCeiling === 'L2' || value.riskCeiling === 'L3' || value.riskCeiling === 'L4') {
    throw new Error('L2, L3, and L4 authority is forbidden for recurring research.');
  }
  if (stableSha256(value) !== stableSha256(expected)) {
    throw new Error('authority must exactly match the read-only authority derived from the fixed source URLs.');
  }
  return expected;
};

const normalizeInput = (value: unknown): Omit<RecurringResearchSchedule, 'version' | 'createdAt' | 'updatedAt'> => {
  if (!isRecord(value)) throw new Error('Recurring research schedule input must be an object.');
  assertOnlyKeys(value, allowedInputKeys, 'schedule');
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    throw new Error('enabled must be a boolean.');
  }
  const sourceUrls = canonicalizeResearchSourceUrls(value.sourceUrls);
  const authority = value.authority === undefined
    ? deriveRecurringResearchAuthority(sourceUrls)
    : validateRecurringResearchAuthority(value.authority, sourceUrls);
  return {
    schemaVersion: RECURRING_RESEARCH_SCHEMA_VERSION,
    kind: 'recurring_research',
    id: normalizeId(value.id),
    enabled: value.enabled === true,
    objective: normalizeObjective(value.objective),
    sourceUrls,
    trigger: normalizeTrigger(value.trigger),
    budget: normalizeBudget(value.budget, sourceUrls.length),
    authority,
  };
};

export const createRecurringResearchSchedule = (
  input: RecurringResearchScheduleInput | unknown,
  now: string,
): RecurringResearchSchedule => {
  const timestamp = canonicalTimestamp(now, 'now');
  return immutable({
    ...normalizeInput(input),
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
};

export const validateRecurringResearchSchedule = (value: unknown): RecurringResearchSchedule => {
  if (!isRecord(value)) throw new Error('Recurring research schedule must be an object.');
  assertOnlyKeys(value, allowedScheduleKeys, 'schedule');
  if (value.schemaVersion !== RECURRING_RESEARCH_SCHEMA_VERSION || value.kind !== 'recurring_research') {
    throw new Error('Unsupported recurring research schedule schema.');
  }
  if (!Number.isSafeInteger(value.version) || (value.version as number) < 1) {
    throw new Error('version must be a positive integer.');
  }
  if (value.authority === undefined) throw new Error('Persisted schedules require an explicit derived authority.');
  const normalized = normalizeInput({
    id: value.id,
    enabled: value.enabled,
    objective: value.objective,
    sourceUrls: value.sourceUrls,
    trigger: value.trigger,
    budget: value.budget,
    authority: value.authority,
  });
  if (
    value.objective !== normalized.objective ||
    stableSha256(value.sourceUrls) !== stableSha256(normalized.sourceUrls) ||
    stableSha256(value.trigger) !== stableSha256(normalized.trigger) ||
    stableSha256(value.budget) !== stableSha256(normalized.budget)
  ) {
    throw new Error('Persisted schedule fields must already be canonical.');
  }
  const createdAt = canonicalTimestamp(value.createdAt, 'createdAt');
  const updatedAt = canonicalTimestamp(value.updatedAt, 'updatedAt');
  if (Date.parse(updatedAt) < Date.parse(createdAt)) throw new Error('updatedAt cannot precede createdAt.');
  return immutable({
    ...normalized,
    version: value.version as number,
    createdAt,
    updatedAt,
  });
};

export const updateRecurringResearchSchedule = (
  current: RecurringResearchSchedule,
  update: RecurringResearchScheduleUpdate | unknown,
  now: string,
): RecurringResearchSchedule => {
  const validatedCurrent = validateRecurringResearchSchedule(current);
  if (!isRecord(update)) throw new Error('Recurring research schedule update must be an object.');
  assertOnlyKeys(update, allowedUpdateKeys, 'schedule update');
  const timestamp = canonicalTimestamp(now, 'now');
  if (Date.parse(timestamp) < Date.parse(validatedCurrent.updatedAt)) throw new Error('Schedule updates cannot move backward in time.');

  const candidate = normalizeInput({
    id: validatedCurrent.id,
    enabled: update.enabled ?? validatedCurrent.enabled,
    objective: update.objective ?? validatedCurrent.objective,
    sourceUrls: update.sourceUrls ?? validatedCurrent.sourceUrls,
    trigger: update.trigger ?? validatedCurrent.trigger,
    budget: update.budget ?? validatedCurrent.budget,
    authority: update.authority,
  });

  if (candidate.objective !== validatedCurrent.objective) {
    throw new Error('A recurring schedule objective is fixed; create a new schedule for a different objective.');
  }
  const currentSources = new Set(validatedCurrent.sourceUrls);
  if (candidate.sourceUrls.some((url) => !currentSources.has(url))) {
    throw new Error('Schedule updates cannot add source URLs or expand network authority.');
  }
  if (
    candidate.trigger.startsAt !== validatedCurrent.trigger.startsAt ||
    candidate.trigger.catchUp !== validatedCurrent.trigger.catchUp
  ) {
    throw new Error('Schedule updates cannot move the anchor or change catch-up semantics.');
  }
  if (candidate.trigger.everyMs < validatedCurrent.trigger.everyMs) {
    throw new Error('Schedule updates cannot increase run frequency.');
  }
  for (const key of Object.keys(validatedCurrent.budget) as Array<keyof RecurringResearchBudget>) {
    if (candidate.budget[key] > validatedCurrent.budget[key]) {
      throw new Error(`Schedule updates cannot increase budget.${key}.`);
    }
  }

  const previousComparable = {
    enabled: validatedCurrent.enabled,
    objective: validatedCurrent.objective,
    sourceUrls: validatedCurrent.sourceUrls,
    trigger: validatedCurrent.trigger,
    budget: validatedCurrent.budget,
    authority: validatedCurrent.authority,
  };
  const candidateComparable = {
    enabled: candidate.enabled,
    objective: candidate.objective,
    sourceUrls: candidate.sourceUrls,
    trigger: candidate.trigger,
    budget: candidate.budget,
    authority: candidate.authority,
  };
  if (stableSha256(previousComparable) === stableSha256(candidateComparable)) {
    throw new Error('Schedule update does not change the contract.');
  }

  return immutable({
    ...candidate,
    version: validatedCurrent.version + 1,
    createdAt: validatedCurrent.createdAt,
    updatedAt: timestamp,
  });
};

const scheduleBoundaryIndex = (schedule: RecurringResearchSchedule, timestamp: string, field: string): number => {
  const value = Date.parse(canonicalTimestamp(timestamp, field));
  const anchor = Date.parse(schedule.trigger.startsAt);
  const delta = value - anchor;
  if (delta < 0 || delta % schedule.trigger.everyMs !== 0) {
    throw new Error(`${field} must be an interval boundary on or after trigger.startsAt.`);
  }
  return delta / schedule.trigger.everyMs;
};

const boundaryAt = (schedule: RecurringResearchSchedule, index: number): string => {
  const timestamp = Date.parse(schedule.trigger.startsAt) + index * schedule.trigger.everyMs;
  return new Date(timestamp).toISOString();
};

export const calculateNextResearchDue = (
  schedule: RecurringResearchSchedule,
  now: string,
  scheduledThrough?: string,
): RecurringResearchDueDecision => {
  const nowMs = Date.parse(canonicalTimestamp(now, 'now'));
  const anchorMs = Date.parse(schedule.trigger.startsAt);
  const nextIndex = scheduledThrough === undefined
    ? 0
    : scheduleBoundaryIndex(schedule, scheduledThrough, 'scheduledThrough') + 1;
  const latestDueIndex = nowMs < anchorMs ? -1 : Math.floor((nowMs - anchorMs) / schedule.trigger.everyMs);

  if (!schedule.enabled || nextIndex > latestDueIndex) {
    const futureIndex = schedule.enabled ? nextIndex : Math.max(nextIndex, latestDueIndex + 1);
    const scheduledFor = boundaryAt(schedule, futureIndex);
    return immutable({
      due: false,
      scheduledFor,
      nextDueAt: scheduledFor,
      catchUpApplied: false,
      skippedIntervals: 0,
    });
  }

  const skippedIntervals = latestDueIndex - nextIndex;
  return immutable({
    due: true,
    scheduledFor: boundaryAt(schedule, latestDueIndex),
    nextDueAt: boundaryAt(schedule, latestDueIndex + 1),
    catchUpApplied: skippedIntervals > 0,
    skippedIntervals,
  });
};

export const createRecurringResearchOccurrenceId = (
  scheduleId: string,
  scheduleVersion: number,
  scheduledFor: string,
): string => {
  const id = normalizeId(scheduleId);
  if (!Number.isSafeInteger(scheduleVersion) || scheduleVersion < 1) {
    throw new Error('scheduleVersion must be a positive integer.');
  }
  const timestamp = canonicalTimestamp(scheduledFor, 'scheduledFor');
  return `occurrence_${stableSha256({ scheduleId: id, scheduleVersion, scheduledFor: timestamp })}`;
};

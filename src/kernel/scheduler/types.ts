export const RECURRING_RESEARCH_SCHEMA_VERSION = 1 as const;

export const MIN_RESEARCH_INTERVAL_MS = 15 * 60 * 1_000;
export const MAX_RESEARCH_INTERVAL_MS = 365 * 24 * 60 * 60 * 1_000;
export const MAX_RESEARCH_OBJECTIVE_CHARS = 2_000;
export const MAX_RESEARCH_SCHEDULE_SOURCES = 5;

export const RESEARCH_BUDGET_LIMITS = Object.freeze({
  maxRuntimeMs: { min: 1_000, max: 15 * 60 * 1_000 },
  maxProviderCalls: { min: 1, max: 8 },
  maxSourceFetches: { min: 1, max: MAX_RESEARCH_SCHEDULE_SOURCES * 3 },
  maxAttempts: { min: 1, max: 3 },
});

export type RecurringResearchCatchUp = 'latest_once';

export interface RecurringResearchTrigger {
  readonly type: 'interval';
  readonly everyMs: number;
  readonly startsAt: string;
  readonly catchUp: RecurringResearchCatchUp;
}

export interface RecurringResearchBudget {
  readonly maxRuntimeMs: number;
  readonly maxProviderCalls: number;
  readonly maxSourceFetches: number;
  readonly maxAttempts: number;
}

export type RecurringResearchOperation = 'browser.inspect' | 'provider.call';

/**
 * Scheduled research is deliberately read-only. Provider calls are classified
 * at L1, while browser inspection is L0; neither can create external effects.
 */
export interface RecurringResearchAuthority {
  readonly riskCeiling: 'L1';
  readonly sideEffects: 'none';
  readonly operations: readonly RecurringResearchOperation[];
  readonly allowedOrigins: readonly string[];
  readonly allowedSourceUrls: readonly string[];
}

export interface RecurringResearchSchedule {
  readonly schemaVersion: typeof RECURRING_RESEARCH_SCHEMA_VERSION;
  readonly kind: 'recurring_research';
  readonly id: string;
  readonly version: number;
  readonly enabled: boolean;
  readonly objective: string;
  readonly sourceUrls: readonly string[];
  readonly trigger: RecurringResearchTrigger;
  readonly budget: RecurringResearchBudget;
  readonly authority: RecurringResearchAuthority;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RecurringResearchScheduleInput {
  readonly id: string;
  readonly enabled?: boolean;
  readonly objective: string;
  readonly sourceUrls: readonly string[];
  readonly trigger: RecurringResearchTrigger;
  readonly budget: RecurringResearchBudget;
  readonly authority?: unknown;
}

/** Updates create a new schedule version; omitted fields retain their value. */
export interface RecurringResearchScheduleUpdate {
  readonly enabled?: boolean;
  readonly objective?: string;
  readonly sourceUrls?: readonly string[];
  readonly trigger?: RecurringResearchTrigger;
  readonly budget?: RecurringResearchBudget;
  readonly authority?: unknown;
}

export interface RecurringResearchDueDecision {
  readonly due: boolean;
  /** The latest eligible boundary, or the next future boundary when not due. */
  readonly scheduledFor: string;
  readonly nextDueAt: string;
  readonly catchUpApplied: boolean;
  readonly skippedIntervals: number;
}

export type RecurringResearchOccurrenceStatus =
  | 'due'
  | 'claimed'
  | 'running'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'uncertain'
  | 'skipped';

export interface RecurringResearchLease {
  readonly owner: string;
  readonly claimedAt: string;
  readonly expiresAt: string;
}

export interface RecurringResearchEvidenceRef {
  readonly eventId: string;
  readonly artifactId?: string;
  readonly contentHash?: string;
}

export interface RecurringResearchOccurrence {
  readonly schemaVersion: typeof RECURRING_RESEARCH_SCHEMA_VERSION;
  readonly id: string;
  readonly scheduleId: string;
  readonly scheduleVersion: number;
  readonly scheduledFor: string;
  readonly status: RecurringResearchOccurrenceStatus;
  readonly catchUpApplied: boolean;
  readonly skippedIntervals: number;
  readonly lease?: RecurringResearchLease;
  readonly evidenceRefs: readonly RecurringResearchEvidenceRef[];
  readonly statusReason?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

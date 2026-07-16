import { describe, expect, it } from 'vitest';
import {
  MAX_RESEARCH_INTERVAL_MS,
  MIN_RESEARCH_INTERVAL_MS,
  calculateNextResearchDue,
  claimResearchOccurrence,
  createDueResearchOccurrence,
  createRecurringResearchOccurrenceId,
  createRecurringResearchSchedule,
  deriveRecurringResearchAuthority,
  finishResearchOccurrence,
  isTerminalResearchOccurrence,
  resumeResearchOccurrence,
  skipResearchOccurrence,
  startResearchOccurrence,
  updateRecurringResearchSchedule,
  validateRecurringResearchAuthority,
} from '.';

const start = '2026-07-14T00:00:00.000Z';
const createdAt = '2026-07-13T23:00:00.000Z';

const input = () => ({
  id: 'schedule_research_daily',
  enabled: true,
  objective: '  Track changes in the cited evidence.  ',
  sourceUrls: ['https://EXAMPLE.com', 'https://docs.example.org:443/research?q=1'],
  trigger: {
    type: 'interval' as const,
    everyMs: 60 * 60 * 1_000,
    startsAt: start,
    catchUp: 'latest_once' as const,
  },
  budget: {
    maxRuntimeMs: 120_000,
    maxProviderCalls: 4,
    maxSourceFetches: 2,
    maxAttempts: 2,
  },
});

describe('durable recurring research schedule contracts', () => {
  it('creates a canonical, immutable, read-only authority contract', () => {
    const schedule = createRecurringResearchSchedule(input(), createdAt);

    expect(schedule).toMatchObject({
      schemaVersion: 1,
      kind: 'recurring_research',
      id: 'schedule_research_daily',
      version: 1,
      enabled: true,
      objective: 'Track changes in the cited evidence.',
      sourceUrls: ['https://example.com/', 'https://docs.example.org/research?q=1'],
      createdAt,
      updatedAt: createdAt,
    });
    expect(schedule.authority).toEqual({
      riskCeiling: 'L1',
      sideEffects: 'none',
      operations: ['browser.inspect', 'provider.call'],
      allowedOrigins: ['https://docs.example.org', 'https://example.com'],
      allowedSourceUrls: ['https://example.com/', 'https://docs.example.org/research?q=1'],
    });
    expect(Object.isFrozen(schedule)).toBe(true);
    expect(Object.isFrozen(schedule.sourceUrls)).toBe(true);
    expect(Object.isFrozen(schedule.authority.operations)).toBe(true);
  });

  it.each([
    ['plain HTTP', ['http://example.com/']],
    ['credentials', ['https://user:secret@example.com/']],
    ['fragment', ['https://example.com/#section']],
    ['canonical duplicates', ['https://EXAMPLE.com', 'https://example.com/']],
  ])('rejects %s source scope', (_label, sourceUrls) => {
    expect(() => createRecurringResearchSchedule({ ...input(), sourceUrls }, createdAt)).toThrow();
  });

  it('requires one to five fixed source URLs', () => {
    expect(() => createRecurringResearchSchedule({ ...input(), sourceUrls: [] }, createdAt)).toThrow('1-5');
    expect(() => createRecurringResearchSchedule({
      ...input(),
      sourceUrls: Array.from({ length: 6 }, (_, index) => `https://source${index}.example/`),
    }, createdAt)).toThrow('1-5');
  });

  it('accepts only bounded intervals with explicit latest-once catch-up', () => {
    expect(createRecurringResearchSchedule({
      ...input(),
      trigger: { ...input().trigger, everyMs: MIN_RESEARCH_INTERVAL_MS },
    }, createdAt).trigger.everyMs).toBe(MIN_RESEARCH_INTERVAL_MS);
    expect(createRecurringResearchSchedule({
      ...input(),
      trigger: { ...input().trigger, everyMs: MAX_RESEARCH_INTERVAL_MS },
    }, createdAt).trigger.everyMs).toBe(MAX_RESEARCH_INTERVAL_MS);

    expect(() => createRecurringResearchSchedule({
      ...input(),
      trigger: { type: 'cron', cron: '0 * * * *', timezone: 'UTC' },
    }, createdAt)).toThrow('cron is forbidden');
    expect(() => createRecurringResearchSchedule({
      ...input(),
      trigger: { ...input().trigger, everyMs: MIN_RESEARCH_INTERVAL_MS - 1 },
    }, createdAt)).toThrow('trigger.everyMs');
    expect(() => createRecurringResearchSchedule({
      ...input(),
      trigger: { ...input().trigger, catchUp: 'all' },
    }, createdAt)).toThrow('latest_once');
  });

  it('bounds every per-occurrence budget and requires source coverage', () => {
    expect(() => createRecurringResearchSchedule({
      ...input(),
      budget: { ...input().budget, maxRuntimeMs: 15 * 60 * 1_000 + 1 },
    }, createdAt)).toThrow('budget.maxRuntimeMs');
    expect(() => createRecurringResearchSchedule({
      ...input(),
      budget: { ...input().budget, maxProviderCalls: 9 },
    }, createdAt)).toThrow('budget.maxProviderCalls');
    expect(() => createRecurringResearchSchedule({
      ...input(),
      budget: { ...input().budget, maxSourceFetches: 1 },
    }, createdAt)).toThrow('cover every fixed source');
    expect(() => createRecurringResearchSchedule({
      ...input(),
      budget: { ...input().budget, maxSourceFetches: 16 },
    }, createdAt)).toThrow('budget.maxSourceFetches');
    expect(() => createRecurringResearchSchedule({
      ...input(),
      budget: { ...input().budget, maxAttempts: 4 },
    }, createdAt)).toThrow('budget.maxAttempts');
  });

  it('rejects L2/L3 and any caller-supplied authority expansion', () => {
    const canonicalUrls = ['https://example.com/', 'https://docs.example.org/research?q=1'];
    const authority = deriveRecurringResearchAuthority(canonicalUrls);
    expect(validateRecurringResearchAuthority(authority, canonicalUrls)).toEqual(authority);

    expect(() => createRecurringResearchSchedule({
      ...input(),
      authority: { ...authority, riskCeiling: 'L2' },
    }, createdAt)).toThrow('L2, L3, and L4');
    expect(() => createRecurringResearchSchedule({
      ...input(),
      authority: { ...authority, operations: [...authority.operations, 'email.send'] },
    }, createdAt)).toThrow('exactly match');
    expect(() => createRecurringResearchSchedule({
      ...input(),
      authority: { ...authority, allowedOrigins: [...authority.allowedOrigins, 'https://other.example'] },
    }, createdAt)).toThrow('exactly match');
  });

  it('versions contractive updates without mutating the prior version', () => {
    const original = createRecurringResearchSchedule(input(), createdAt);
    const updated = updateRecurringResearchSchedule(original, {
      enabled: false,
      sourceUrls: ['https://example.com/'],
      trigger: { ...original.trigger, everyMs: 2 * 60 * 60 * 1_000 },
      budget: {
        maxRuntimeMs: 60_000,
        maxProviderCalls: 3,
        maxSourceFetches: 1,
        maxAttempts: 1,
      },
    }, '2026-07-14T01:00:00.000Z');

    expect(updated).toMatchObject({ version: 2, enabled: false, sourceUrls: ['https://example.com/'] });
    expect(updated.authority.allowedOrigins).toEqual(['https://example.com']);
    expect(original).toMatchObject({ version: 1, enabled: true });
    expect(original.sourceUrls).toHaveLength(2);
    expect(Object.isFrozen(updated)).toBe(true);
  });

  it.each([
    ['objective', { objective: 'Research something else.' }, 'objective is fixed'],
    ['source authority', { sourceUrls: ['https://example.com/', 'https://new.example/'] }, 'cannot add source'],
    ['frequency', { trigger: { ...input().trigger, everyMs: 30 * 60 * 1_000 } }, 'increase run frequency'],
    ['anchor', { trigger: { ...input().trigger, startsAt: '2026-07-15T00:00:00.000Z' } }, 'move the anchor'],
    ['budget', { budget: { ...input().budget, maxProviderCalls: 5 } }, 'cannot increase budget'],
  ])('rejects update-time %s expansion', (_label, update, message) => {
    const original = createRecurringResearchSchedule(input(), createdAt);
    expect(() => updateRecurringResearchSchedule(original, update, '2026-07-14T01:00:00.000Z')).toThrow(message);
  });

  it('rejects no-op updates and time reversal', () => {
    const original = createRecurringResearchSchedule(input(), createdAt);
    expect(() => updateRecurringResearchSchedule(original, {}, createdAt)).toThrow('does not change');
    expect(() => updateRecurringResearchSchedule(original, { enabled: false }, '2026-07-13T22:00:00.000Z'))
      .toThrow('backward');
  });
});

describe('latest-once recurrence math', () => {
  it('reports the first future boundary before the anchor', () => {
    const schedule = createRecurringResearchSchedule(input(), createdAt);
    expect(calculateNextResearchDue(schedule, '2026-07-13T23:30:00.000Z')).toEqual({
      due: false,
      scheduledFor: start,
      nextDueAt: start,
      catchUpApplied: false,
      skippedIntervals: 0,
    });
  });

  it('emits an exact boundary without catch-up', () => {
    const schedule = createRecurringResearchSchedule(input(), createdAt);
    expect(calculateNextResearchDue(schedule, start)).toEqual({
      due: true,
      scheduledFor: start,
      nextDueAt: '2026-07-14T01:00:00.000Z',
      catchUpApplied: false,
      skippedIntervals: 0,
    });
  });

  it('collapses an arbitrary backlog to the latest eligible occurrence', () => {
    const schedule = createRecurringResearchSchedule(input(), createdAt);
    expect(calculateNextResearchDue(schedule, '2026-07-14T03:37:00.000Z')).toEqual({
      due: true,
      scheduledFor: '2026-07-14T03:00:00.000Z',
      nextDueAt: '2026-07-14T04:00:00.000Z',
      catchUpApplied: true,
      skippedIntervals: 3,
    });
    expect(calculateNextResearchDue(
      schedule,
      '2026-07-14T03:37:00.000Z',
      '2026-07-14T01:00:00.000Z',
    ).skippedIntervals).toBe(1);
  });

  it('does not duplicate a boundary already covered by the durable cursor', () => {
    const schedule = createRecurringResearchSchedule(input(), createdAt);
    expect(calculateNextResearchDue(
      schedule,
      '2026-07-14T03:37:00.000Z',
      '2026-07-14T03:00:00.000Z',
    )).toEqual({
      due: false,
      scheduledFor: '2026-07-14T04:00:00.000Z',
      nextDueAt: '2026-07-14T04:00:00.000Z',
      catchUpApplied: false,
      skippedIntervals: 0,
    });
  });

  it('requires the durable cursor to be an aligned interval boundary', () => {
    const schedule = createRecurringResearchSchedule(input(), createdAt);
    expect(() => calculateNextResearchDue(schedule, '2026-07-14T03:00:00.000Z', '2026-07-14T01:30:00.000Z'))
      .toThrow('interval boundary');
  });
});

describe('recurring research occurrence lifecycle', () => {
  const dueOccurrence = () => {
    const schedule = createRecurringResearchSchedule(input(), createdAt);
    return createDueResearchOccurrence(schedule, calculateNextResearchDue(schedule, start), start);
  };

  it('derives occurrence identity only from schedule id, version, and boundary', () => {
    const first = createRecurringResearchOccurrenceId('schedule_a', 2, start);
    expect(first).toBe(createRecurringResearchOccurrenceId('schedule_a', 2, start));
    expect(first).not.toBe(createRecurringResearchOccurrenceId('schedule_a', 3, start));
    expect(first).not.toBe(createRecurringResearchOccurrenceId('schedule_b', 2, start));
    expect(first).not.toBe(createRecurringResearchOccurrenceId('schedule_a', 2, '2026-07-14T01:00:00.000Z'));
  });

  it('claims, starts, and completes under an unexpired owner-bound lease', () => {
    const due = dueOccurrence();
    const claimed = claimResearchOccurrence(due, {
      owner: 'scheduler-worker-1',
      claimedAt: '2026-07-14T00:00:01.000Z',
      expiresAt: '2026-07-14T00:01:01.000Z',
    });
    const running = startResearchOccurrence(claimed, 'scheduler-worker-1', '2026-07-14T00:00:02.000Z');
    const completed = finishResearchOccurrence(running, {
      status: 'completed',
      now: '2026-07-14T00:00:03.000Z',
      evidenceRefs: [
        { eventId: 'event_completed', artifactId: 'artifact_report', contentHash: 'a'.repeat(64) },
        { eventId: 'event_completed', artifactId: 'artifact_report', contentHash: 'a'.repeat(64) },
      ],
    });

    expect(completed.status).toBe('completed');
    expect(completed.lease?.owner).toBe('scheduler-worker-1');
    expect(completed.evidenceRefs).toHaveLength(1);
    expect(isTerminalResearchOccurrence(completed)).toBe(true);
    expect(Object.isFrozen(completed.evidenceRefs)).toBe(true);
  });

  it('rejects lease theft, expired starts, and illegal transitions', () => {
    const claimed = claimResearchOccurrence(dueOccurrence(), {
      owner: 'scheduler-worker-1',
      claimedAt: '2026-07-14T00:00:01.000Z',
      expiresAt: '2026-07-14T00:01:01.000Z',
    });
    expect(() => startResearchOccurrence(claimed, 'scheduler-worker-2', '2026-07-14T00:00:02.000Z'))
      .toThrow('lease owner');
    expect(() => startResearchOccurrence(claimed, 'scheduler-worker-1', '2026-07-14T00:01:01.000Z'))
      .toThrow('expired');
    expect(() => finishResearchOccurrence(claimed, {
      status: 'completed', now: '2026-07-14T00:00:02.000Z',
    })).toThrow('claimed to completed');

    const running = startResearchOccurrence(claimed, 'scheduler-worker-1', '2026-07-14T00:00:02.000Z');
    expect(() => finishResearchOccurrence(running, {
      status: 'completed', now: '2026-07-14T00:01:01.000Z',
    })).toThrow('lease has expired');
  });

  it('records explicit skipped, blocked, and uncertain terminal outcomes', () => {
    const skipped = finishResearchOccurrence(dueOccurrence(), {
      status: 'skipped', now: '2026-07-14T00:00:01.000Z', reason: 'Superseded by latest-once catch-up.',
    });
    const claimed = claimResearchOccurrence(dueOccurrence(), {
      owner: 'scheduler-worker-1',
      claimedAt: '2026-07-14T00:00:01.000Z',
      expiresAt: '2026-07-14T00:01:01.000Z',
    });
    const uncertain = finishResearchOccurrence(claimed, {
      status: 'uncertain', now: '2026-07-14T00:00:02.000Z', reason: 'Restart occurred after lease claim.',
      evidenceRefs: [{ eventId: 'event_recovery' }],
    });
    const blocked = finishResearchOccurrence(dueOccurrence(), {
      status: 'blocked', now: '2026-07-14T00:00:01.000Z', reason: 'Stop All is active.',
    });

    expect([skipped.status, uncertain.status, blocked.status]).toEqual(['skipped', 'uncertain', 'blocked']);
    expect([skipped, uncertain, blocked].every(isTerminalResearchOccurrence)).toBe(true);
  });

  it('explicitly resumes blocked and uncertain occurrences under a fresh immutable lease', () => {
    const blocked = finishResearchOccurrence(dueOccurrence(), {
      status: 'blocked',
      now: '2026-07-14T00:00:01.000Z',
      reason: 'Stop All is active.',
      evidenceRefs: [{ eventId: 'event_blocked' }],
    });
    const resumedBlocked = resumeResearchOccurrence(blocked, {
      owner: 'scheduler-worker-2',
      claimedAt: '2026-07-14T00:00:02.000Z',
      expiresAt: '2026-07-14T00:01:02.000Z',
    });

    expect(resumedBlocked).toMatchObject({
      status: 'claimed',
      lease: {
        owner: 'scheduler-worker-2',
        claimedAt: '2026-07-14T00:00:02.000Z',
        expiresAt: '2026-07-14T00:01:02.000Z',
      },
      evidenceRefs: [{ eventId: 'event_blocked' }],
    });
    expect(resumedBlocked.statusReason).toBeUndefined();
    expect(blocked).toMatchObject({ status: 'blocked', statusReason: 'Stop All is active.' });
    expect(Object.isFrozen(resumedBlocked.lease)).toBe(true);

    const firstClaim = claimResearchOccurrence(dueOccurrence(), {
      owner: 'scheduler-worker-1',
      claimedAt: '2026-07-14T00:00:01.000Z',
      expiresAt: '2026-07-14T00:01:01.000Z',
    });
    const uncertain = finishResearchOccurrence(firstClaim, {
      status: 'uncertain',
      now: '2026-07-14T00:00:02.000Z',
      reason: 'Restart interrupted dispatch.',
    });
    const resumedUncertain = resumeResearchOccurrence(uncertain, {
      owner: 'scheduler-worker-3',
      claimedAt: '2026-07-14T00:00:03.000Z',
      expiresAt: '2026-07-14T00:01:03.000Z',
    });

    expect(resumedUncertain.status).toBe('claimed');
    expect(resumedUncertain.lease?.owner).toBe('scheduler-worker-3');
    expect(resumedUncertain.statusReason).toBeUndefined();
  });

  it('rejects resume from invalid states and malformed fresh leases', () => {
    const due = dueOccurrence();
    expect(() => resumeResearchOccurrence(due, {
      owner: 'scheduler-worker-2',
      claimedAt: '2026-07-14T00:00:01.000Z',
      expiresAt: '2026-07-14T00:01:01.000Z',
    })).toThrow('Only blocked or uncertain');

    const blocked = finishResearchOccurrence(due, {
      status: 'blocked', now: '2026-07-14T00:00:01.000Z', reason: 'Paused by operator.',
    });
    expect(() => resumeResearchOccurrence(blocked, {
      owner: '   ',
      claimedAt: '2026-07-14T00:00:02.000Z',
      expiresAt: '2026-07-14T00:01:02.000Z',
    })).toThrow('lease.owner');
    expect(() => resumeResearchOccurrence(blocked, {
      owner: 'scheduler-worker-2',
      claimedAt: '2026-07-14T00:00:02.000Z',
      expiresAt: '2026-07-14T00:00:02.000Z',
    })).toThrow('expire after');
    expect(() => resumeResearchOccurrence(blocked, {
      owner: 'scheduler-worker-2',
      claimedAt: '2026-07-14T00:00:00.000Z',
      expiresAt: '2026-07-14T00:01:00.000Z',
    })).toThrow('backward');

  });

  it('explicitly skips a recovery record after its prior lease expires', () => {
    const firstClaim = claimResearchOccurrence(dueOccurrence(), {
      owner: 'scheduler-worker-1',
      claimedAt: '2026-07-14T00:00:01.000Z',
      expiresAt: '2026-07-14T00:01:01.000Z',
    });
    const uncertain = finishResearchOccurrence(firstClaim, {
      status: 'uncertain',
      now: '2026-07-14T00:00:02.000Z',
      reason: 'Restart interrupted dispatch.',
      evidenceRefs: [{ eventId: 'event_uncertain' }],
    });

    const skipped = skipResearchOccurrence(
      uncertain,
      'Operator chose not to replay uncertain work.',
      '2026-07-14T00:01:01.000Z',
    );
    expect(skipped).toMatchObject({
      status: 'skipped',
      statusReason: 'Operator chose not to replay uncertain work.',
      evidenceRefs: [{ eventId: 'event_uncertain' }],
      lease: { owner: 'scheduler-worker-1', expiresAt: '2026-07-14T00:01:01.000Z' },
    });
    expect(isTerminalResearchOccurrence(skipped)).toBe(true);
    expect(uncertain.status).toBe('uncertain');
  });

  it('rejects skip from invalid states, with empty reasons, or backward timestamps', () => {
    expect(() => skipResearchOccurrence(dueOccurrence(), 'No longer needed.', '2026-07-14T00:00:01.000Z'))
      .toThrow('Only blocked or uncertain');
    const blocked = finishResearchOccurrence(dueOccurrence(), {
      status: 'blocked', now: '2026-07-14T00:00:01.000Z', reason: 'Paused by operator.',
    });
    expect(() => skipResearchOccurrence(blocked, '   ', '2026-07-14T00:00:02.000Z')).toThrow('reason');
    expect(() => skipResearchOccurrence(blocked, 'No longer needed.', '2026-07-14T00:00:00.000Z'))
      .toThrow('backward');
  });
});

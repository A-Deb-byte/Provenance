import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAuthSession, setAuthSession } from '../lib/auth';
import { RecurringResearchPanel } from './RecurringResearchPanel';

const config = {
  available: true,
  reason: 'Durable interval scheduling is available.',
  schedulerEnabled: true,
  tickIntervalMs: 15_000,
  minIntervalMinutes: 15,
  maxIntervalMinutes: 525_600,
  allowedOrigins: ['https://example.com'],
  maxSources: 5,
};

const schedule = (overrides: Record<string, unknown> = {}) => ({
  contract: {
    schemaVersion: 1,
    kind: 'recurring_research',
    id: 'research_schedule_1',
    version: 1,
    enabled: false,
    objective: 'Track the fixed evidence source',
    sourceUrls: ['https://example.com/source'],
    trigger: {
      type: 'interval',
      everyMs: 60 * 60 * 1_000,
      startsAt: '2026-07-14T00:00:00.000Z',
      catchUp: 'latest_once',
    },
    budget: { maxRuntimeMs: 600_000, maxProviderCalls: 8, maxSourceFetches: 1, maxAttempts: 3 },
    authority: {
      riskCeiling: 'L1',
      sideEffects: 'none',
      operations: ['browser.inspect', 'provider.call'],
      allowedOrigins: ['https://example.com'],
      allowedSourceUrls: ['https://example.com/source'],
    },
    createdAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:00:00.000Z',
  },
  maxRuns: 100,
  maxConsecutiveFailures: 3,
  runsClaimed: 0,
  consecutiveFailures: 0,
  nextDueAt: '2026-07-14T01:00:00.000Z',
  ...overrides,
});

const occurrence = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  id: 'occurrence_1',
  scheduleId: 'research_schedule_1',
  scheduleVersion: 1,
  scheduledFor: '2026-07-14T01:00:00.000Z',
  status: 'blocked',
  catchUpApplied: true,
  skippedIntervals: 2,
  lease: {
    owner: 'scheduler-instance-1',
    claimedAt: '2026-07-14T01:00:01.000Z',
    expiresAt: '2026-07-14T01:11:01.000Z',
  },
  evidenceRefs: [{ eventId: 'event_blocked' }],
  statusReason: 'Provider request was interrupted.',
  createdAt: '2026-07-14T01:00:01.000Z',
  updatedAt: '2026-07-14T01:01:00.000Z',
  leaseId: 'schedule_lease_1',
  leaseFence: 1,
  deadlineAt: '2026-07-14T01:10:01.000Z',
  goalId: 'goal_1',
  missionId: 'mission_1',
  attempt: 1,
  reportArtifactId: 'artifact_1234567890abcdef',
  reportContentHash: 'a'.repeat(64),
  ...overrides,
});

const response = (payload: unknown, status = 200): Response => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
} as Response);

afterEach(() => {
  cleanup();
  clearAuthSession();
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe('RecurringResearchPanel', () => {
  it('renders server-backed empty state, validates source authority, and stores nothing locally', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/config')) return response(config);
      if (url === '/api/kernel/recurring-research') return response({ schedules: [] });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<RecurringResearchPanel />);

    expect(await screen.findByText('No recurring schedules yet.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Scheduled research objective'), 'Track evidence');
    await user.type(screen.getByLabelText('Scheduled HTTPS source URLs, one per line'), 'https://outside.example/source');
    await user.click(screen.getByRole('button', { name: 'Create schedule' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('outside the configured source origins');
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    expect(localStorage.length).toBe(0);
  });

  it('creates a disabled schedule with the exact authenticated contract and does not tick it', async () => {
    setAuthSession({ token: 'operator-secret', kind: 'operator', role: 'operator' });
    const createdSchedule = schedule();
    let created = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/config')) return response(config);
      if (url === '/api/kernel/recurring-research' && method === 'POST') {
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer operator-secret');
        expect(JSON.parse(String(init?.body))).toEqual({
          objective: 'Track evidence changes',
          sourceUrls: ['https://example.com/source'],
          intervalMinutes: 30,
          maxRuns: 12,
          maxConsecutiveFailures: 2,
          maxRuntimeMinutes: 5,
        });
        created = true;
        return response(createdSchedule, 201);
      }
      if (url === '/api/kernel/recurring-research') return response({ schedules: created ? [createdSchedule] : [] });
      if (url === '/api/kernel/recurring-research/research_schedule_1') {
        return response({ schedule: createdSchedule, occurrences: [] });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<RecurringResearchPanel />);

    await user.type(await screen.findByLabelText('Scheduled research objective'), 'Track evidence changes');
    await user.type(screen.getByLabelText('Scheduled HTTPS source URLs, one per line'), 'https://example.com/source');
    await user.clear(screen.getByLabelText('Interval minutes'));
    await user.type(screen.getByLabelText('Interval minutes'), '30');
    await user.clear(screen.getByLabelText('Maximum runs'));
    await user.type(screen.getByLabelText('Maximum runs'), '12');
    await user.clear(screen.getByLabelText('Maximum consecutive failures'));
    await user.type(screen.getByLabelText('Maximum consecutive failures'), '2');
    await user.clear(screen.getByLabelText('Maximum runtime minutes'));
    await user.type(screen.getByLabelText('Maximum runtime minutes'), '5');
    await user.click(screen.getByRole('button', { name: 'Create schedule' }));

    expect(await screen.findByTestId('recurring-schedule-research_schedule_1')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Schedule created disabled');
    const mutationUrls = fetchMock.mock.calls
      .filter(([, init]) => init?.method === 'POST')
      .map(([input]) => String(input));
    expect(mutationUrls).toEqual(['/api/kernel/recurring-research']);
    expect(localStorage.length).toBe(0);
  });

  it('requires a reason to enable a schedule and exposes ticking only by explicit action', async () => {
    let currentSchedule = schedule();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/config')) return response(config);
      if (url === '/api/kernel/recurring-research' && method === 'GET') return response({ schedules: [currentSchedule] });
      if (url === '/api/kernel/recurring-research/research_schedule_1' && method === 'GET') {
        return response({ schedule: currentSchedule, occurrences: [] });
      }
      if (url.endsWith('/enabled') && method === 'POST') {
        currentSchedule = schedule({ contract: { ...schedule().contract, enabled: true, version: 2 } });
        return response(currentSchedule);
      }
      if (url.endsWith('/tick') && method === 'POST') return response({ outcome: 'idle', reason: 'No schedule is due.' });
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<RecurringResearchPanel />);

    await user.click(await screen.findByRole('button', { name: 'Enable schedule' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('state change reason is required');
    await user.type(screen.getByLabelText('Schedule state change reason'), 'Enable the reviewed fixed schedule.');
    await user.click(screen.getByRole('button', { name: 'Enable schedule' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Disable schedule' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Tick now' }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/tick'))).toBe(true));
    const enabledCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/enabled'));
    expect(JSON.parse(String(enabledCall?.[1]?.body))).toEqual({
      enabled: true,
      reason: 'Enable the reviewed fixed schedule.',
    });
    const tickCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/tick'));
    expect(JSON.parse(String(tickCall?.[1]?.body))).toEqual({});
  });

  it('shows durable occurrence evidence and sends explicit resume and skip reasons', async () => {
    const activeOccurrence = occurrence();
    const activeSchedule = schedule({ activeOccurrenceId: activeOccurrence.id, haltedReason: 'Explicit resolution required.' });
    const onOpenMission = vi.fn();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/config')) return response(config);
      if (url === '/api/kernel/recurring-research') return response({ schedules: [activeSchedule] });
      if (url === '/api/kernel/recurring-research/research_schedule_1') {
        return response({ schedule: activeSchedule, occurrences: [activeOccurrence] });
      }
      if (url === '/api/kernel/research-missions/mission_1') {
        return response({ mission: { id: 'mission_1', status: 'blocked' } });
      }
      if (method === 'POST' && url.endsWith('/resume')) {
        return response({ outcome: 'blocked', schedule: activeSchedule, occurrence: activeOccurrence });
      }
      if (method === 'POST' && url.endsWith('/skip')) return response({ ...activeOccurrence, status: 'skipped' });
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<RecurringResearchPanel onOpenMission={onOpenMission} />);

    expect(await screen.findByText('Latest once')).toBeInTheDocument();
    expect(screen.getByText('scheduler-instance-1')).toBeInTheDocument();
    expect(screen.getAllByText('blocked', { exact: false }).length).toBeGreaterThan(0);
    expect(screen.getByTitle('a'.repeat(64))).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open mission cockpit' }));
    expect(onOpenMission).toHaveBeenCalledWith('mission_1');

    await user.click(screen.getByRole('button', { name: 'Resume occurrence' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('resolution reason is required');
    await user.type(screen.getByLabelText('Occurrence resolution reason'), 'Retry after inspecting the uncertain checkpoint.');
    await user.click(screen.getByRole('button', { name: 'Resume occurrence' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/resume'))).toBe(true));
    const resumeCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/resume'));
    expect(JSON.parse(String(resumeCall?.[1]?.body))).toEqual({ reason: 'Retry after inspecting the uncertain checkpoint.' });

    await user.type(screen.getByLabelText('Occurrence resolution reason'), 'Skip this occurrence with an audit reason.');
    await user.click(screen.getByRole('button', { name: 'Skip occurrence' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/skip'))).toBe(true));
    const skipCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/skip'));
    expect(JSON.parse(String(skipCall?.[1]?.body))).toEqual({ reason: 'Skip this occurrence with an audit reason.' });
  });

  it('keeps every mutation disabled for viewer sessions', async () => {
    setAuthSession({ token: 'viewer-token', kind: 'session', username: 'viewer', role: 'viewer' });
    const currentSchedule = schedule();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/config')) return response(config);
      if (url === '/api/kernel/recurring-research') return response({ schedules: [currentSchedule] });
      if (url.endsWith('/research_schedule_1')) return response({ schedule: currentSchedule, occurrences: [] });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<RecurringResearchPanel />);

    expect(await screen.findByText(/Viewer sessions can inspect schedules/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create schedule' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Tick now' })).toBeDisabled();
    expect(await screen.findByRole('button', { name: 'Enable schedule' })).toBeDisabled();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('forgets schedules, occurrences, and linked missions when the session logs out', async () => {
    setAuthSession({ token: 'operator-secret', kind: 'operator', role: 'operator' });
    const activeOccurrence = occurrence();
    const activeSchedule = schedule({ activeOccurrenceId: activeOccurrence.id });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const authorization = new Headers(init?.headers).get('authorization');
      if (authorization !== 'Bearer operator-secret') {
        return response({ error: 'Authentication required.' }, 401);
      }
      if (url.endsWith('/config')) return response(config);
      if (url === '/api/kernel/recurring-research') return response({ schedules: [activeSchedule] });
      if (url === '/api/kernel/recurring-research/research_schedule_1') {
        return response({ schedule: activeSchedule, occurrences: [activeOccurrence] });
      }
      if (url === '/api/kernel/research-missions/mission_1') {
        return response({ mission: { id: 'mission_1', status: 'blocked' } });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<RecurringResearchPanel />);

    expect(await screen.findByTestId('recurring-occurrence-occurrence_1')).toBeInTheDocument();
    expect(await screen.findByText('Latest once')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create schedule' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Tick now' })).toBeEnabled();

    await act(async () => clearAuthSession());

    expect(screen.queryByTestId('recurring-schedule-research_schedule_1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('recurring-occurrence-occurrence_1')).not.toBeInTheDocument();
    expect(screen.queryByText('mission_1')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create schedule' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Tick now' })).toBeDisabled();
  });

  it('clears protected scheduler state when an authenticated action returns 401', async () => {
    setAuthSession({ token: 'operator-secret', kind: 'operator', role: 'operator' });
    const currentSchedule = schedule();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const authorization = new Headers(init?.headers).get('authorization');
      if (authorization !== 'Bearer operator-secret') {
        return response({ error: 'Authentication required.' }, 401);
      }
      if (url.endsWith('/config')) return response(config);
      if (url === '/api/kernel/recurring-research' && method === 'GET') {
        return response({ schedules: [currentSchedule] });
      }
      if (url === '/api/kernel/recurring-research/research_schedule_1') {
        return response({ schedule: currentSchedule, occurrences: [] });
      }
      if (url.endsWith('/tick') && method === 'POST') {
        return response({ error: 'Session expired.' }, 401);
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<RecurringResearchPanel />);

    expect(await screen.findByTestId('recurring-schedule-research_schedule_1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Tick now' }));

    await waitFor(() => expect(screen.queryByTestId('recurring-schedule-research_schedule_1')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Create schedule' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Tick now' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Enable schedule' })).not.toBeInTheDocument();
  });
});

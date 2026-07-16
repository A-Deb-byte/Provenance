import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAuthSession, setAuthSession } from '../lib/auth';
import { ResearchMissionPanel } from './ResearchMissionPanel';

const config = {
  available: true,
  reason: 'Read-only research worker is available.',
  allowedOrigins: ['https://example.com'],
  maxSources: 5,
};

const mission = (overrides: Record<string, unknown> = {}) => ({
  id: 'mission_1',
  goalId: 'goal_1',
  objective: 'Compare the supplied evidence',
  status: 'planning',
  revision: 1,
  checkpoint: 0,
  taskIds: {
    plan: 'task_plan',
    collect: 'task_collect',
    synthesize: 'task_synthesize',
    verify: 'task_verify',
    publish: 'task_publish',
  },
  sources: [{
    id: 'S1',
    url: 'https://example.com/source',
    origin: 'https://example.com',
    status: 'pending',
    chunks: [],
    injectionSignalCodes: [],
  }],
  providerRuns: [],
  synthesisAttempts: 0,
  lastVerificationIssues: [],
  createdAt: '2026-07-14T00:00:00.000Z',
  updatedAt: '2026-07-14T00:00:00.000Z',
  ...overrides,
});

const goal = (researchMission = mission()) => ({
  id: researchMission.goalId,
  objective: researchMission.objective,
  status: researchMission.status === 'completed' ? 'completed' : 'active',
  kind: 'research_report',
  research: researchMission,
  successCriteria: ['Every claim cites authenticated evidence.'],
  constraints: ['Read only.'],
  autonomyLevel: 'supervised',
  workspaceRoot: 'C:\\workspace',
  verificationCommands: ['npm run lint'],
  budget: { maxOperations: 10, maxCommandRuntimeMs: 1, maxApprovals: 0, maxProviderCalls: 8 },
  usage: { operations: 1, commandRuntimeMs: 0, approvals: 0, providerCalls: 1 },
  createdAt: '2026-07-14T00:00:00.000Z',
  updatedAt: '2026-07-14T00:00:00.000Z',
});

const task = (researchMission = mission(), overrides: Record<string, unknown> = {}) => ({
  id: 'task_plan',
  goalId: researchMission.goalId,
  title: 'Plan the evidence-backed report',
  description: 'Create a bounded plan.',
  status: 'ready',
  riskLevel: 'L1',
  capabilityFamily: 'provider.call',
  dependsOn: [],
  expectedEvidence: 'A schema-valid plan is ledgered.',
  missionStep: 'planning',
  outputArtifactIds: [],
  evidenceEventIds: [],
  createdAt: '2026-07-14T00:00:00.000Z',
  updatedAt: '2026-07-14T00:00:00.000Z',
  ...overrides,
});

const detail = (researchMission = mission(), overrides: Record<string, unknown> = {}) => ({
  mission: researchMission,
  goal: goal(researchMission),
  tasks: [task(researchMission)],
  approvals: [],
  events: [],
  controls: { stopAll: false },
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
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe('ResearchMissionPanel', () => {
  it('renders the server-backed empty state and rejects sources outside configured origins', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/config')) return response(config);
      if (url === '/api/kernel/research-missions') return response({ missions: [] });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<ResearchMissionPanel />);

    expect(await screen.findByText('No research missions yet.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Research objective'), 'Investigate the supplied evidence');
    await user.type(screen.getByLabelText('HTTPS source URLs, one per line'), 'https://outside.example/source');
    await user.click(screen.getByRole('button', { name: 'Create mission' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('outside the configured source origins');
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    expect(localStorage.length).toBe(0);
  });

  it('creates a mission with the active bearer and exact source input without automatically running it', async () => {
    setAuthSession({ token: 'operator-secret', kind: 'operator', role: 'operator' });
    const createdMission = mission();
    let created = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/config')) return response(config);
      if (url === '/api/kernel/research-missions' && method === 'POST') {
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer operator-secret');
        expect(JSON.parse(String(init?.body))).toEqual({
          objective: 'Investigate the supplied evidence',
          sourceUrls: ['https://example.com/source'],
        });
        created = true;
        return response(createdMission, 201);
      }
      if (url === '/api/kernel/research-missions') {
        return response({ missions: created ? [createdMission] : [] });
      }
      if (url === '/api/kernel/research-missions/mission_1') return response(detail(createdMission));
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<ResearchMissionPanel />);

    await user.type(await screen.findByLabelText('Research objective'), 'Investigate the supplied evidence');
    await user.type(screen.getByLabelText('HTTPS source URLs, one per line'), 'https://example.com/source');
    await user.click(screen.getByRole('button', { name: 'Create mission' }));

    expect(await screen.findByTestId('research-mission-mission_1')).toBeInTheDocument();
    const mutationUrls = fetchMock.mock.calls
      .filter(([, init]) => init?.method === 'POST')
      .map(([input]) => String(input));
    expect(mutationUrls).toEqual(['/api/kernel/research-missions']);
  });

  it('runs the bounded loop and a single step only from explicit button presses', async () => {
    const activeMission = mission();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/config')) return response(config);
      if (url === '/api/kernel/research-missions') return response({ missions: [activeMission] });
      if (url === '/api/kernel/research-missions/mission_1') return response(detail(activeMission));
      if (method === 'POST' && (url.endsWith('/run') || url.endsWith('/step'))) {
        return response({ outcome: 'advanced', mission: activeMission });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<ResearchMissionPanel />);

    await user.click(await screen.findByRole('button', { name: 'Run bounded loop' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith('/run') && init?.method === 'POST')).toBe(true));
    await user.click(screen.getByRole('button', { name: 'Run one step' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith('/step') && init?.method === 'POST')).toBe(true));

    const actionBodies = fetchMock.mock.calls
      .filter(([, init]) => init?.method === 'POST')
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(actionBodies).toEqual([{}, {}]);
  });

  it('resumes a retryable blocked mission with a reason but does not auto-run it', async () => {
    const blockedMission = mission({
      status: 'blocked',
      retryable: true,
      resumeStage: 'collecting',
      lastError: 'Source capture was interrupted.',
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/config')) return response(config);
      if (url === '/api/kernel/research-missions') return response({ missions: [blockedMission] });
      if (url === '/api/kernel/research-missions/mission_1') return response(detail(blockedMission));
      if (method === 'POST' && url.endsWith('/resume')) return response(blockedMission);
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<ResearchMissionPanel />);

    await user.click(await screen.findByRole('button', { name: 'Resume mission' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Resume reason is required');
    await user.type(screen.getByLabelText('Resume reason'), 'Retry the interrupted source safely.');
    await user.click(screen.getByRole('button', { name: 'Resume mission' }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/resume'))).toBe(true));
    const resumeCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/resume'));
    expect(JSON.parse(String(resumeCall?.[1]?.body))).toEqual({ reason: 'Retry the interrupted source safely.' });
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/run'))).toBe(false);
  });

  it('renders a hash-bound verified report as inert selectable text', async () => {
    const reportContent = '# Verified report\n\n<script>alert("not executable")</script>';
    const completedMission = mission({
      status: 'completed',
      checkpoint: 5,
      sources: [{
        id: 'S1',
        url: 'https://example.com/source',
        origin: 'https://example.com',
        status: 'captured',
        artifactId: 'artifact_source',
        contentHash: 'a'.repeat(64),
        chunks: [{ id: 'S1-C1', charStart: 0, charEnd: 10, contentHash: 'b'.repeat(64) }],
        observationRisk: 'none',
        injectionSignalCodes: [],
      }],
      draft: {
        title: 'Verified report',
        executiveSummary: 'The supplied evidence was compared.',
        claims: [{
          id: 'C1',
          statement: 'The source supports the recorded claim.',
          confidence: 'high',
          evidence: [{ sourceId: 'S1', chunkId: 'S1-C1', quote: 'Recorded evidence' }],
        }],
        limitations: [],
      },
      verification: {
        status: 'passed',
        deterministicIssues: [],
        criticVerdict: 'pass',
        criticSummary: 'All grounded claims passed review.',
        criticIssues: [],
        verifiedAt: '2026-07-14T00:05:00.000Z',
      },
      reportArtifactId: 'artifact_report',
      reportContentHash: 'c'.repeat(64),
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/config')) return response(config);
      if (url === '/api/kernel/research-missions') return response({ missions: [completedMission] });
      if (url === '/api/kernel/research-missions/mission_1') {
        return response(detail(completedMission, {
          tasks: [task(completedMission, { status: 'passed', evidenceEventIds: ['event_1'] })],
          events: [{
            id: 'event_1', timestamp: '2026-07-14T00:05:00.000Z', actor: 'kernel',
            type: 'research.report.published', entityId: completedMission.id, entityType: 'artifact',
            payload: { summary: 'Verified report artifact published.' }, previousHash: null, hash: 'd'.repeat(64),
          }],
        }));
      }
      if (url.endsWith('/report')) return response({ content: reportContent, contentHash: 'c'.repeat(64) });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<ResearchMissionPanel />);

    expect(await screen.findByText('Verified report', { selector: 'span' })).toBeInTheDocument();
    const report = await screen.findByText((content, element) => element?.tagName === 'PRE' && content.includes('<script>'));
    expect(report).toHaveClass('select-text');
    expect(report).toHaveTextContent('<script>alert("not executable")</script>');
    expect(document.querySelector('script')).toBeNull();
    expect(screen.getByText('Verified report artifact published.')).toBeInTheDocument();
  });

  it('forgets protected mission projections and disables controls when the session logs out', async () => {
    setAuthSession({ token: 'operator-secret', kind: 'operator', role: 'operator' });
    const activeMission = mission();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const authorization = new Headers(init?.headers).get('authorization');
      if (authorization !== 'Bearer operator-secret') {
        return response({ error: 'Authentication required.' }, 401);
      }
      if (url.endsWith('/config')) return response(config);
      if (url === '/api/kernel/research-missions') return response({ missions: [activeMission] });
      if (url === '/api/kernel/research-missions/mission_1') return response(detail(activeMission));
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<ResearchMissionPanel />);

    expect(await screen.findByTestId('research-mission-mission_1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create mission' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Run bounded loop' })).toBeEnabled();

    await act(async () => clearAuthSession());

    expect(screen.queryByTestId('research-mission-mission_1')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run bounded loop' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create mission' })).toBeDisabled();
    expect(screen.getByText('0 recorded')).toBeInTheDocument();
  });

  it('clears protected mission state when an authenticated action returns 401', async () => {
    setAuthSession({ token: 'operator-secret', kind: 'operator', role: 'operator' });
    const activeMission = mission();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const authorization = new Headers(init?.headers).get('authorization');
      if (authorization !== 'Bearer operator-secret') {
        return response({ error: 'Authentication required.' }, 401);
      }
      if (url.endsWith('/config')) return response(config);
      if (url === '/api/kernel/research-missions') return response({ missions: [activeMission] });
      if (url === '/api/kernel/research-missions/mission_1') return response(detail(activeMission));
      if (method === 'POST' && url.endsWith('/run')) {
        return response({ error: 'Session expired.' }, 401);
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<ResearchMissionPanel />);

    await user.click(await screen.findByRole('button', { name: 'Run bounded loop' }));

    await waitFor(() => expect(screen.queryByTestId('research-mission-mission_1')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Run one step' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create mission' })).toBeDisabled();
    expect(screen.getByText('0 recorded')).toBeInTheDocument();
  });
});

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAuthSession, setAuthSession } from '../lib/auth';
import { DesktopPanel } from './DesktopPanel';

const HASH = 'a'.repeat(64);

const response = (payload: unknown, status = 200): Response => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
} as Response);

const worker = {
  id: 'worker.desktop.windows_uia',
  family: 'desktop',
  availability: 'available',
  supportedActions: ['desktop.discover', 'desktop.inspect', 'desktop.click', 'desktop.type'],
  configuredScopes: [{
    family: 'desktop',
    operations: ['desktop.discover', 'desktop.inspect', 'desktop.click', 'desktop.type'],
    appId: 'notepad.exe',
  }],
  registeredAt: '2026-07-15T00:00:00.000Z',
};

const goal = {
  id: 'goal_desktop',
  objective: 'Operate the allowlisted desktop fixture',
  status: 'active',
  budget: { maxOperations: 20, maxCommandRuntimeMs: 1, maxApprovals: 10, maxProviderCalls: 0 },
  usage: { operations: 0, commandRuntimeMs: 0, approvals: 0, providerCalls: 0 },
};

const runtime = {
  providers: { configured: [], unavailable: [] },
  workers: { available: [worker.id], configured: [], unavailable: [] },
  features: {
    desktopIpc: { status: 'available', reason: 'Authenticated native IPC is healthy.' },
    desktopAutomation: { status: 'available', reason: 'The Windows UI Automation worker is healthy.' },
  },
  generatedAt: '2026-07-15T00:00:00.000Z',
};

const windowsContent = JSON.stringify({
  schemaVersion: 1,
  kind: 'desktop.windows',
  appId: 'notepad.exe',
  windows: [{ windowId: 'window_1', title: 'Untitled - Notepad', treeRevision: 'tree_1' }],
});

const treeContent = JSON.stringify({
  schemaVersion: 1,
  kind: 'desktop.tree',
  appId: 'notepad.exe',
  windowId: 'window_1',
  treeRevision: 'tree_2',
  nodes: [{
    nodeId: 'node_editor',
    role: 'Edit',
    name: 'Text editor',
    enabled: true,
    focusable: true,
    focused: false,
    bounds: { x: 10, y: 20, width: 400, height: 250 },
  }],
});

interface FixtureState {
  automations: Array<Record<string, unknown>>;
  approvals: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  bodies: Array<{ url: string; body: Record<string, unknown> }>;
  runCounts: Record<string, number>;
  failProjectionRefresh: boolean;
}

const automationRecord = (
  id: string,
  body: Record<string, unknown>,
  enabled = false,
): Record<string, unknown> => ({
  schemaVersion: 1,
  id,
  name: body.name,
  enabled,
  goalId: body.goalId,
  workerId: body.workerId,
  riskLevel: body.riskLevel,
  action: body.action,
  scope: body.scope,
  trigger: body.trigger,
  approvalMode: body.approvalMode,
  budget: body.budget,
  createdAt: '2026-07-15T00:00:00.000Z',
  updatedAt: '2026-07-15T00:00:00.000Z',
});

const approvalRecord = (automationId: string, status: 'pending' | 'approved' | 'consumed' | 'denied' = 'pending') => ({
  id: `approval_${automationId}`,
  goalId: goal.id,
  taskId: `automation:${automationId}`,
  status,
  requestedAction: `automation-run:${automationId}:hash`,
  riskLevel: 'L2',
  reason: 'L2 actions require an explicit approval grant.',
  createdAt: '2026-07-15T00:01:00.000Z',
  updatedAt: '2026-07-15T00:01:00.000Z',
});

const createFixture = (options: {
  delayedAuthority?: boolean;
  invalidDiscovery?: boolean;
  runtimeConfigured?: boolean;
  uncertainMutation?: boolean;
  unauthorizedRun?: boolean;
} = {}) => {
  const state: FixtureState = {
    automations: [],
    approvals: [],
    events: [],
    bodies: [],
    runCounts: {},
    failProjectionRefresh: false,
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    const authorization = new Headers(init?.headers).get('authorization');
    if (url !== '/api/kernel/runtime-report' && !authorization) {
      return response({ error: 'Authentication required.' }, 401);
    }
    if (method !== 'GET') state.bodies.push({ url, body });

    if (method === 'GET' && url === '/api/kernel/workers') {
      if (options.delayedAuthority) await new Promise((resolve) => setTimeout(resolve, 25));
      return response({ workers: [worker], report: { available: [worker.id], configured: [], unavailable: [] } });
    }
    if (method === 'GET' && url === '/api/kernel/goals') return response({ goals: [goal] });
    if (method === 'GET' && url === '/api/kernel/automations') return response({ automations: state.automations });
    if (method === 'GET' && url === '/api/kernel/approvals') return response({ approvals: state.approvals });
    if (method === 'GET' && url === '/api/kernel/events') return response({ events: state.events });
    if (method === 'GET' && url === '/api/kernel/runtime-report') {
      if (state.failProjectionRefresh) {
        return response({ error: 'Projection refresh failed.' }, 503);
      }
      return response(options.runtimeConfigured
        ? {
          ...runtime,
          features: {
            ...runtime.features,
            desktopIpc: { status: 'configured', reason: 'Native bridge health check failed.' },
            desktopAutomation: { status: 'configured', reason: 'Native bridge health check failed.' },
          },
        }
        : runtime);
    }

    if (method === 'POST' && url === '/api/kernel/desktop/typed-payloads') {
      return response({ id: 'artifact_type-1', contentHash: HASH, byteLength: 12, createdAt: '2026-07-15T00:02:00.000Z' }, 201);
    }

    if (method === 'POST' && url === '/api/kernel/automations') {
      const action = body.action as { type: string };
      const id = `automation_${action.type.replace('desktop.', '')}_${state.automations.length + 1}`;
      const automation = automationRecord(id, body);
      state.automations.push(automation);
      return response(automation, 201);
    }

    const enabledMatch = /^\/api\/kernel\/automations\/([^/]+)\/enabled$/u.exec(url);
    if (method === 'POST' && enabledMatch) {
      const automation = state.automations.find((candidate) => candidate.id === enabledMatch[1])!;
      automation.enabled = true;
      return response({ ...automation, updatedAt: '2026-07-15T00:00:01.000Z' });
    }

    const runMatch = /^\/api\/kernel\/automations\/([^/]+)\/run$/u.exec(url);
    if (method === 'POST' && runMatch) {
      if (options.unauthorizedRun) return response({ error: 'Session expired.' }, 401);
      const automationId = runMatch[1];
      const automation = state.automations.find((candidate) => candidate.id === automationId)!;
      const action = automation.action as { type: string };
      state.runCounts[automationId] = (state.runCounts[automationId] ?? 0) + 1;
      if (action.type === 'desktop.discover') {
        return response({
          decision: { kind: 'allow' },
          dispatch: { status: 'succeeded', summary: 'Windows discovered.' },
          content: options.invalidDiscovery ? '{not-json' : windowsContent,
        });
      }
      if (action.type === 'desktop.inspect') {
        return response({
          decision: { kind: 'allow' },
          dispatch: { status: 'succeeded', summary: 'Controls inspected.' },
          content: treeContent,
        });
      }
      let approval = state.approvals.find((candidate) => candidate.taskId === `automation:${automationId}`);
      if (!approval) {
        approval = approvalRecord(automationId);
        state.approvals.push(approval);
        return response({ decision: { kind: 'approval_required', reason: 'Explicit approval required.' }, approvalId: approval.id });
      }
      if (approval.status === 'approved') {
        approval.status = 'consumed';
        return response({
          decision: { kind: 'allow' },
          approvalId: approval.id,
          dispatch: options.uncertainMutation
            ? {
              status: 'uncertain',
              summary: 'The native result was lost after dispatch.',
              errorCode: 'desktop_outcome_uncertain',
            }
            : { status: 'succeeded', summary: 'Desktop action completed.' },
        });
      }
      return response({ decision: { kind: 'approval_required' }, approvalId: approval.id });
    }

    const approvalMatch = /^\/api\/kernel\/approvals\/([^/]+)\/decision$/u.exec(url);
    if (method === 'POST' && approvalMatch) {
      const approval = state.approvals.find((candidate) => candidate.id === approvalMatch[1])!;
      approval.status = body.status;
      approval.decisionReason = body.reason;
      return response({ ...approval, updatedAt: '2026-07-15T00:03:00.000Z', decidedAt: '2026-07-15T00:03:00.000Z' });
    }

    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  return { state, fetchMock };
};

const enterDesktopActionReason = async (
  user: ReturnType<typeof userEvent.setup>,
  reason: string,
): Promise<HTMLElement> => {
  const input = await screen.findByLabelText('Desktop action reason');
  await waitFor(() => expect(input).toBeEnabled());
  await user.type(input, reason);
  expect(input).toHaveValue(reason);
  return input;
};

const discoverAndInspect = async (user: ReturnType<typeof userEvent.setup>) => {
  const reason = 'Inspect the operator-selected Notepad window.';
  const reasonInput = await enterDesktopActionReason(user, reason);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Discover windows' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: 'Discover windows' }));
  expect(await screen.findByTestId('desktop-window-window_1')).toHaveTextContent('Untitled - Notepad');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Discover windows' })).toBeEnabled());
  expect(reasonInput).toHaveValue(reason);
  const inspectButton = screen.getByRole('button', { name: 'Inspect controls' });
  await waitFor(() => expect(inspectButton).toBeEnabled());
  await user.click(inspectButton);
  expect(await screen.findByTestId('desktop-node-node_editor')).toHaveTextContent('Text editor');
};

afterEach(() => {
  cleanup();
  clearAuthSession();
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe('DesktopPanel', () => {
  it('discovers and inspects exact worker-scoped desktop state without browser persistence', async () => {
    setAuthSession({ token: 'operator-secret', kind: 'operator', role: 'operator' });
    const { state, fetchMock } = createFixture();
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<DesktopPanel />);

    await discoverAndInspect(user);

    const createBodies = state.bodies.filter(({ url }) => url === '/api/kernel/automations').map(({ body }) => body);
    expect(createBodies[0]).toMatchObject({
      goalId: goal.id,
      workerId: worker.id,
      riskLevel: 'L0',
      action: { type: 'desktop.discover', appId: 'notepad.exe' },
      scope: { family: 'desktop', operations: ['desktop.discover'], appId: 'notepad.exe' },
      trigger: { type: 'manual' },
      approvalMode: 'per_run',
    });
    expect(createBodies[1]).toMatchObject({
      riskLevel: 'L0',
      action: { type: 'desktop.inspect', appId: 'notepad.exe', windowId: 'window_1', treeRevision: 'tree_1' },
      scope: { family: 'desktop', operations: ['desktop.inspect'], appId: 'notepad.exe', windowId: 'window_1', treeRevision: 'tree_1' },
    });
    expect(screen.getByText(/tree revision tree_2/i)).toBeInTheDocument();
    expect(localStorage.length).toBe(0);
  });

  it('stops a click at L2 approval and executes only after a separate approved rerun', async () => {
    setAuthSession({ token: 'operator-secret', kind: 'operator', role: 'operator' });
    const { state, fetchMock } = createFixture();
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<DesktopPanel />);
    await discoverAndInspect(user);

    await user.click(screen.getByRole('button', { name: 'Request click approval' }));
    expect(await screen.findByText(/awaiting explicit approval/i)).toBeInTheDocument();

    const clickAutomation = state.automations.find((automation) => (automation.action as { type: string }).type === 'desktop.click')!;
    expect(clickAutomation).toMatchObject({
      riskLevel: 'L2',
      action: { type: 'desktop.click', appId: 'notepad.exe', windowId: 'window_1', treeRevision: 'tree_2', nodeId: 'node_editor' },
      scope: { family: 'desktop', operations: ['desktop.click'], appId: 'notepad.exe', windowId: 'window_1', treeRevision: 'tree_2' },
    });
    expect(state.runCounts[String(clickAutomation.id)]).toBe(1);

    await user.type(await screen.findByLabelText('Approval decision reason'), 'The exact control and revision are correct.');
    await user.click(screen.getByRole('button', { name: 'Approve action' }));
    expect(await screen.findByRole('button', { name: 'Execute approved action' })).toBeInTheDocument();
    expect(state.runCounts[String(clickAutomation.id)]).toBe(1);

    await user.click(screen.getByRole('button', { name: 'Execute approved action' }));
    expect(await screen.findByText(/Desktop action completed/i)).toBeInTheDocument();
    expect(state.runCounts[String(clickAutomation.id)]).toBe(2);
    expect(state.approvals[0].status).toBe('consumed');
    expect(screen.queryByTestId('desktop-window-window_1')).not.toBeInTheDocument();
    expect(screen.getByText('No window discovery result in this authenticated view.')).toBeInTheDocument();
  });

  it('treats an uncertain native mutation as non-retryable and discards stale observations', async () => {
    setAuthSession({ token: 'operator-secret', kind: 'operator', role: 'operator' });
    const { state, fetchMock } = createFixture({ uncertainMutation: true });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<DesktopPanel />);
    await discoverAndInspect(user);

    await user.click(screen.getByRole('button', { name: 'Request click approval' }));
    await user.type(
      await screen.findByLabelText('Approval decision reason'),
      'The exact control and revision are correct.',
    );
    await user.click(screen.getByRole('button', { name: 'Approve action' }));
    await user.click(await screen.findByRole('button', { name: 'Execute approved action' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/may have executed/i);
    expect(screen.getByRole('alert')).toHaveTextContent(/do not retry/i);
    expect(screen.queryByTestId('desktop-window-window_1')).not.toBeInTheDocument();
    expect(screen.getByText('No window discovery result in this authenticated view.')).toBeInTheDocument();
    expect(state.approvals[0].status).toBe('consumed');
  });

  it('discards stale observations and disables mutations when projection refresh fails', async () => {
    setAuthSession({ token: 'operator-secret', kind: 'operator', role: 'operator' });
    const { state, fetchMock } = createFixture();
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<DesktopPanel />);
    await discoverAndInspect(user);

    state.failProjectionRefresh = true;
    await user.click(screen.getByRole('button', { name: 'Request click approval' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Projection refresh failed.');
    expect(screen.queryByTestId('desktop-window-window_1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('desktop-node-node_editor')).not.toBeInTheDocument();
    expect(screen.getByText('No window discovery result in this authenticated view.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Discover windows' })).toBeDisabled();
    expect(screen.getByLabelText('Desktop action reason')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Request click approval' })).not.toBeInTheDocument();
  });

  it('stages typing in the desktop-only payload endpoint and never embeds raw text in the automation', async () => {
    setAuthSession({ token: 'operator-secret', kind: 'operator', role: 'operator' });
    const { state, fetchMock } = createFixture();
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<DesktopPanel />);
    await discoverAndInspect(user);

    await user.type(screen.getByLabelText('Desktop typing payload'), 'bounded text');
    await user.click(screen.getByRole('button', { name: 'Request type approval' }));
    expect(await screen.findByText(/Type request is awaiting explicit approval/i)).toBeInTheDocument();

    const payloadCall = state.bodies.find(({ url }) => url === '/api/kernel/desktop/typed-payloads');
    expect(payloadCall?.body).toEqual({ content: 'bounded text' });
    const typeCreate = state.bodies.find(({ url, body }) => (
      url === '/api/kernel/automations' && (body.action as { type?: string }).type === 'desktop.type'
    ));
    expect(typeCreate?.body).toMatchObject({
      riskLevel: 'L2',
      action: {
        type: 'desktop.type',
        appId: 'notepad.exe',
        windowId: 'window_1',
        treeRevision: 'tree_2',
        nodeId: 'node_editor',
        payloadArtifactId: 'artifact_type-1',
        payloadHash: HASH,
      },
    });
    expect(JSON.stringify(typeCreate?.body)).not.toContain('bounded text');
    expect(screen.getByLabelText('Desktop typing payload')).toHaveValue('');
  });

  it('keeps mutations disabled for viewers and purges protected projections and drafts on logout', async () => {
    setAuthSession({ token: 'viewer-token', kind: 'session', username: 'viewer', role: 'viewer', expiresAt: '2099-01-01T00:00:00.000Z' });
    const { state, fetchMock } = createFixture();
    vi.stubGlobal('fetch', fetchMock);
    render(<DesktopPanel />);

    expect(await screen.findByText(/Viewer sessions can inspect recorded desktop state/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Discover windows' })).toBeDisabled();
    expect(screen.getByLabelText('Desktop action reason')).toBeDisabled();
    expect(state.bodies).toEqual([]);

    await act(async () => clearAuthSession());
    expect(screen.getByRole('button', { name: 'Discover windows' })).toBeDisabled();
    expect(screen.getByLabelText('Allowed desktop application')).toHaveValue('');
    expect(screen.getByLabelText('Desktop goal')).toHaveValue('');
    expect(screen.getByText('No window discovery result in this authenticated view.')).toBeInTheDocument();
  });

  it('keeps actions disabled when a stale worker projection conflicts with configured runtime health', async () => {
    setAuthSession({ token: 'operator-secret', kind: 'operator', role: 'operator' });
    const { fetchMock } = createFixture({ runtimeConfigured: true });
    vi.stubGlobal('fetch', fetchMock);
    render(<DesktopPanel />);

    expect(await screen.findByText('Native bridge health check failed.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Discover windows' })).toBeDisabled();
    expect(screen.getByLabelText('Desktop action reason')).toBeDisabled();
  });

  it('rejects malformed worker content and clears every draft when an action returns 401', async () => {
    setAuthSession({ token: 'operator-secret', kind: 'operator', role: 'operator' });
    const invalid = createFixture({ delayedAuthority: true, invalidDiscovery: true });
    vi.stubGlobal('fetch', invalid.fetchMock);
    const user = userEvent.setup();
    const view = render(<DesktopPanel />);
    await enterDesktopActionReason(user, 'Parse only trusted worker schemas.');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Discover windows' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Discover windows' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('invalid JSON');
    expect(screen.getByText('No window discovery result in this authenticated view.')).toBeInTheDocument();

    view.unmount();
    cleanup();
    setAuthSession({ token: 'operator-secret', kind: 'operator', role: 'operator' });
    const unauthorized = createFixture({ delayedAuthority: true, unauthorizedRun: true });
    vi.stubGlobal('fetch', unauthorized.fetchMock);
    render(<DesktopPanel />);
    await enterDesktopActionReason(user, 'This draft must be purged.');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Discover windows' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Discover windows' }));

    await waitFor(() => expect(screen.getByLabelText('Desktop action reason')).toHaveValue(''));
    expect(screen.getByLabelText('Allowed desktop application')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Discover windows' })).toBeDisabled();
    expect(sessionStorage.length).toBe(0);
  });
});

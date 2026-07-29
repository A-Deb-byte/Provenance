import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ObservatorySnapshot } from '../kernel/observatory';
import { authenticatedFetch, getAuthSession, subscribeAuth } from '../lib/auth';
import { AgentObservatory } from './AgentObservatory';

vi.mock('../lib/auth', () => ({
  authenticatedFetch: vi.fn(),
  getAuthSession: vi.fn(() => ({ token: 'operator-token', kind: 'operator', role: 'operator' })),
  subscribeAuth: vi.fn(() => () => undefined),
}));

const snapshot: ObservatorySnapshot = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  ledgerHead: 'a'.repeat(64),
  controls: { stopAll: false },
  counts: {
    goals: 1,
    activeGoals: 1,
    tasks: 1,
    runningTasks: 1,
    pendingApprovals: 1,
    automations: 1,
    enabledAutomations: 1,
    recentEvents: 2,
  },
  truncated: {
    goals: false,
    tasks: false,
    approvals: false,
    currentWork: false,
    activities: false,
    workers: false,
    providers: false,
  },
  goals: [{
    id: 'goal_1',
    objective: 'Verify the account confirmation workflow',
    status: 'active',
    autonomyLevel: 'supervised',
    updatedAt: new Date().toISOString(),
    budget: {
      maxOperations: 10,
      maxCommandRuntimeMs: 60_000,
      maxApprovals: 3,
      maxProviderCalls: 4,
    },
    usage: {
      operations: 3,
      commandRuntimeMs: 5_000,
      approvals: 1,
      providerCalls: 2,
    },
    taskCounts: {
      running: 1,
    },
  }],
  tasks: [],
  approvals: [{
    id: 'approval_1',
    goalId: 'goal_1',
    taskId: 'automation:automation_1',
    status: 'pending',
    requestedAction: `automation-run:automation_1:${'b'.repeat(64)}`,
    riskLevel: 'L2',
    reason: 'A browser click changes external state.',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    actionSummary: 'Browser Click on https://example.com/account',
    surface: {
      kind: 'browser',
      action: 'browser.click',
      primary: 'https://example.com/account',
      secondary: '#confirm',
      url: 'https://example.com/account',
    },
  }],
  currentWork: [{
    id: 'intent_1',
    kind: 'automation',
    status: 'awaiting_approval',
    title: 'Confirm account',
    detail: 'Browser Click',
    goalId: 'goal_1',
    surface: {
      kind: 'browser',
      action: 'browser.click',
      primary: 'https://example.com/account',
      secondary: '#confirm',
      url: 'https://example.com/account',
    },
  }],
  activities: [
    {
      id: 'event_1',
      timestamp: new Date().toISOString(),
      type: 'automation.run_blocked',
      actor: 'kernel',
      entityId: 'automation_1',
      entityType: 'automation',
      status: 'blocked',
      summary: 'Browser click is waiting for approval.',
      automationId: 'automation_1',
      surface: {
        kind: 'browser',
        action: 'browser.click',
        primary: 'https://example.com/account',
        secondary: '#confirm',
        url: 'https://example.com/account',
      },
    },
    {
      id: 'event_2',
      timestamp: new Date(Date.now() - 1_000).toISOString(),
      type: 'automation.run_completed',
      actor: 'kernel',
      entityId: 'automation_2',
      entityType: 'automation',
      status: 'succeeded',
      summary: 'Connector read evidence was recorded.',
      automationId: 'automation_2',
      surface: {
        kind: 'connector',
        action: 'connector.read',
        primary: 'github',
        secondary: 'repository/provenance',
      },
    },
  ],
  workers: [{
    id: 'worker.browser.local',
    family: 'browser',
    availability: 'available',
    supportedActions: ['browser.click'],
  }],
  providers: [{
    id: 'openrouter',
    configured: true,
    defaultModel: 'openrouter/free',
    capabilities: ['text'],
  }],
};

const response = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.mocked(getAuthSession).mockReturnValue({ token: 'operator-token', kind: 'operator', role: 'operator' });
});

describe('AgentObservatory', () => {
  it('does not call a protected endpoint before access is available', () => {
    render(<AgentObservatory enabled={false} />);

    expect(screen.getByText('Sign-in required')).toBeInTheDocument();
    expect(screen.getByText('Authenticated activity is locked')).toBeInTheDocument();
    expect(screen.getByText(/Sign in from Overview to load kernel activity/)).toBeInTheDocument();
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });

  it('renders truthful recorded activity and does not imply a live video feed', async () => {
    vi.mocked(authenticatedFetch).mockImplementation(async () => response(snapshot));
    render(<AgentObservatory />);

    expect(await screen.findByText('Confirm account')).toBeInTheDocument();
    expect(screen.getByText('Verify the account confirmation workflow')).toBeInTheDocument();
    expect(screen.getByLabelText('Operations budget: 3 of 10')).toBeInTheDocument();
    expect(screen.getByLabelText('Command runtime budget: 5s of 1m')).toBeInTheDocument();
    expect(screen.getAllByText('https://example.com/account').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Last recorded evidence, not a live video feed')).toHaveLength(2);
    expect(screen.getByText(/No recorded desktop activity/)).toBeInTheDocument();
    expect(screen.getByText('github')).toBeInTheDocument();
    expect(screen.getByText('repository/provenance')).toBeInTheDocument();
    expect(screen.getByText(/No private model reasoning is shown/)).toBeInTheDocument();
  });

  it('records an approval decision without dispatching the automation', async () => {
    vi.mocked(authenticatedFetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (init?.method === 'POST' && url === '/api/kernel/approvals/approval_1/decision') {
        return response({ ...snapshot.approvals[0], status: 'approved' });
      }
      return response(snapshot);
    });
    const user = userEvent.setup();
    render(<AgentObservatory />);

    await screen.findByText('Browser Click on https://example.com/account');
    await user.type(screen.getByLabelText('Audit reason'), 'Confirmed exact target and scope.');
    await user.click(screen.getByRole('button', { name: 'Approve Browser Click on https://example.com/account' }));

    await waitFor(() => {
      expect(authenticatedFetch).toHaveBeenCalledWith(
        '/api/kernel/approvals/approval_1/decision',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ status: 'approved', reason: 'Confirmed exact target and scope.' }),
        }),
      );
    });
    expect(vi.mocked(authenticatedFetch).mock.calls.some(([url]) => String(url).includes('/automations/'))).toBe(false);
  });

  it('keeps an approved action visible until its separate execution is recorded', async () => {
    const approvedSnapshot: ObservatorySnapshot = {
      ...snapshot,
      approvals: [{
        ...snapshot.approvals[0],
        status: 'approved',
        decisionReason: 'Exact target and scope confirmed.',
      }],
      currentWork: [{
        ...snapshot.currentWork[0],
        status: 'approved_waiting_execution',
      }],
    };
    vi.mocked(authenticatedFetch).mockResolvedValue(response(approvedSnapshot));

    render(<AgentObservatory />);

    expect(await screen.findByText('Approved, not executed')).toBeInTheDocument();
    expect(screen.getByText(/Execution remains a separate kernel-governed action/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Audit reason')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Approve Browser Click/ })).not.toBeInTheDocument();
  });

  it('clears operator drafts and performs one fenced refresh when authentication changes', async () => {
    let notifyAuthChange: (() => void) | undefined;
    vi.mocked(subscribeAuth).mockImplementationOnce((listener) => {
      notifyAuthChange = listener;
      return () => undefined;
    });
    vi.mocked(authenticatedFetch).mockImplementation(async () => response(snapshot));
    const user = userEvent.setup();
    render(<AgentObservatory />);

    await screen.findByText('Confirm account');
    await user.type(screen.getByLabelText('Stop All audit reason'), 'Old principal control reason.');
    await user.type(screen.getByLabelText('Audit reason'), 'Old principal approval reason.');

    await act(async () => notifyAuthChange?.());

    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledTimes(2));
    expect(await screen.findByLabelText('Stop All audit reason')).toHaveValue('');
    expect(screen.getByLabelText('Audit reason')).toHaveValue('');
  });

  it('keeps emergency Stop All available while an approval decision is in flight', async () => {
    let finishApproval: ((value: Response) => void) | undefined;
    const pendingApproval = new Promise<Response>((resolve) => {
      finishApproval = resolve;
    });
    vi.mocked(authenticatedFetch).mockImplementation(async (input, init) => {
      if (init?.method !== 'POST') return response(snapshot);
      if (String(input).includes('/approvals/')) return pendingApproval;
      return response({ controls: { stopAll: true } });
    });
    const user = userEvent.setup();
    render(<AgentObservatory />);

    await screen.findByText('Confirm account');
    await user.type(screen.getByLabelText('Stop All audit reason'), 'Stop for an operator review.');
    await user.type(screen.getByLabelText('Audit reason'), 'Exact browser target confirmed.');

    fireEvent.click(screen.getByRole('button', { name: 'Approve Browser Click on https://example.com/account' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop All' }));

    await waitFor(() => {
      const mutationCalls = vi.mocked(authenticatedFetch).mock.calls.filter(([, init]) => init?.method === 'POST');
      expect(mutationCalls).toHaveLength(2);
      expect(mutationCalls.map(([url]) => String(url))).toContain('/api/kernel/controls/stop-all');
    });

    await act(async () => finishApproval?.(response({ status: 'approved' })));
  });

  it('clears a Stop All draft when the kernel state changes to stopped', async () => {
    const stoppedSnapshot: ObservatorySnapshot = {
      ...snapshot,
      generatedAt: new Date(Date.now() + 1_000).toISOString(),
      controls: {
        stopAll: true,
        stopAllReason: 'Another operator stopped dispatch.',
      },
    };
    let readCount = 0;
    vi.mocked(authenticatedFetch).mockImplementation(async (_input, init) => {
      if (init?.method === 'POST') return response({ controls: stoppedSnapshot.controls });
      readCount += 1;
      return response(readCount === 1 ? snapshot : stoppedSnapshot);
    });
    const user = userEvent.setup();
    render(<AgentObservatory />);

    await screen.findByText('Confirm account');
    await user.type(screen.getByLabelText('Stop All audit reason'), 'Stop because the target is unsafe.');
    await user.click(screen.getByRole('button', { name: 'Refresh agent activity' }));

    const resumeReason = await screen.findByLabelText('Resume audit reason');
    expect(resumeReason).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Resume' })).toBeDisabled();
    expect(vi.mocked(authenticatedFetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });

  it('does not let a stale 401 suspend the refresh for a newer authentication epoch', async () => {
    let notifyAuthChange: (() => void) | undefined;
    let finishStaleRequest: ((value: Response) => void) | undefined;
    const staleRequest = new Promise<Response>((resolve) => {
      finishStaleRequest = resolve;
    });
    let readCount = 0;
    vi.mocked(subscribeAuth).mockImplementationOnce((listener) => {
      notifyAuthChange = listener;
      return () => undefined;
    });
    vi.mocked(authenticatedFetch).mockImplementation(async () => {
      readCount += 1;
      return readCount === 1 ? staleRequest : response(snapshot);
    });
    render(<AgentObservatory />);

    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledTimes(1));
    await act(async () => notifyAuthChange?.());
    await act(async () => finishStaleRequest?.(response({ error: 'stale credential' }, 401)));

    expect(await screen.findByText('Confirm account')).toBeInTheDocument();
    expect(screen.queryByText(/Authentication is required/)).not.toBeInTheDocument();
    expect(authenticatedFetch).toHaveBeenCalledTimes(2);
  });

  it('expands only the work records already loaded in the bounded snapshot', async () => {
    const workItems = Array.from({ length: 10 }, (_, index) => ({
      ...snapshot.currentWork[0],
      id: `intent_${index + 1}`,
      title: `Bounded work item ${index + 1}`,
    }));
    vi.mocked(authenticatedFetch).mockResolvedValue(response({
      ...snapshot,
      currentWork: workItems,
    }));
    const user = userEvent.setup();
    render(<AgentObservatory />);

    expect(await screen.findByText('Bounded work item 1')).toBeInTheDocument();
    expect(screen.queryByText('Bounded work item 10')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show all 10 loaded work items' }));
    expect(screen.getByText('Bounded work item 10')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show first 8 work items' }));
    expect(screen.queryByText('Bounded work item 10')).not.toBeInTheDocument();
  });

  it('requires a reason and uses the server Stop All contract', async () => {
    vi.mocked(authenticatedFetch).mockImplementation(async (input, init) => {
      if (init?.method === 'POST' && String(input) === '/api/kernel/controls/stop-all') {
        return response({ controls: { stopAll: true, stopAllReason: 'Operator requested stop.' } });
      }
      return response(snapshot);
    });
    const user = userEvent.setup();
    render(<AgentObservatory />);

    const stopButton = await screen.findByRole('button', { name: 'Stop All' });
    expect(stopButton).toBeDisabled();
    await user.type(screen.getByLabelText('Stop All audit reason'), 'Operator requested stop.');
    expect(stopButton).toBeEnabled();
    await user.click(stopButton);

    await waitFor(() => {
      expect(authenticatedFetch).toHaveBeenCalledWith(
        '/api/kernel/controls/stop-all',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ reason: 'Operator requested stop.' }),
        }),
      );
    });
  });
});

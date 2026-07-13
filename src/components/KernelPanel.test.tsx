import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KernelPanel } from './KernelPanel';

interface KernelFetchPayloads {
  goals?: unknown[];
  approvals?: unknown[];
  events?: unknown[];
}

const mockKernelFetch = ({
  goals = [],
  approvals = [],
  events = [],
}: KernelFetchPayloads = {}) => {
  const payloads: Record<string, Record<string, unknown[]>> = {
    '/api/kernel/goals': { goals },
    '/api/kernel/approvals': { approvals },
    '/api/kernel/events': { events },
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => ({
    ok: true,
    status: 200,
    json: async () => payloads[String(input)],
  } as Response));

  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('KernelPanel', () => {
  it('renders kernel MVP state labels and empty states', async () => {
    mockKernelFetch();
    render(<KernelPanel />);

    expect(screen.getByText('Kernel MVP')).toBeInTheDocument();
    expect(screen.getByText('Goal Contracts')).toBeInTheDocument();
    expect(screen.getByText('Approval Broker')).toBeInTheDocument();
    expect(screen.getByText('Evidence Ledger')).toBeInTheDocument();
    expect(await screen.findByText('No goal contracts yet.')).toBeInTheDocument();
    expect(screen.getByText('No pending approvals.')).toBeInTheDocument();
    expect(screen.getByText('No evidence recorded yet.')).toBeInTheDocument();
  });

  it('renders live goals, pending approvals, and recent evidence', async () => {
    const fetchMock = mockKernelFetch({
      goals: [{
        id: 'goal_1',
        objective: 'Prepare release',
        status: 'active',
        verificationCommands: ['npm run lint', 'npm run build'],
        usage: { operations: 0 },
        updatedAt: '2026-07-11T10:00:00.000Z',
      }],
      approvals: [{
        id: 'approval_1',
        goalId: 'goal_1',
        taskId: 'task_1',
        status: 'pending',
        requestedAction: 'npm run build',
        riskLevel: 'L2',
        reason: 'Explicit confirmation required.',
        createdAt: '2026-07-11T10:01:00.000Z',
        updatedAt: '2026-07-11T10:01:00.000Z',
      }],
      events: [{
        id: 'event_1',
        type: 'task.passed',
        timestamp: '2026-07-11T10:02:00.000Z',
        actor: 'worker',
        payload: { evidence: { summary: 'Lint completed successfully.' } },
      }],
    });

    render(<KernelPanel />);

    expect(await screen.findByText('Prepare release')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.getByText('npm run lint')).toBeInTheDocument();
    expect(screen.getByText('npm run build')).toBeInTheDocument();
    expect(screen.getByText('Lint completed successfully.')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/kernel/goals');
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/kernel/approvals');
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/kernel/events');
  });

  it('shows loading state while kernel requests are pending', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));

    render(<KernelPanel />);

    expect(screen.getByRole('status')).toHaveTextContent('Loading kernel state...');
  });

  it('shows an error without hiding the kernel labels', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    } as Response)));

    render(<KernelPanel />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Kernel state unavailable');
    expect(screen.getByText('Goal Contracts')).toBeInTheDocument();
  });
});

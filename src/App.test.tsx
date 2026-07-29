import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { fetchAuthStatus, getAuthSession, type AuthStatus } from './lib/auth';
import { STORAGE_KEYS } from './lib/persistence';

const authHarness = vi.hoisted(() => ({
  listener: undefined as (() => void) | undefined,
}));

interface MutableMediaQuery {
  mediaQueryList: MediaQueryList;
  emit: (matches: boolean) => void;
}

const createMutableMediaQuery = (query: string): MutableMediaQuery => {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const mediaQueryList = {
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn((_type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.add(listener as (event: MediaQueryListEvent) => void);
    }),
    removeEventListener: vi.fn((_type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.delete(listener as (event: MediaQueryListEvent) => void);
    }),
    dispatchEvent: vi.fn(() => true),
  } as MediaQueryList;
  return {
    mediaQueryList,
    emit: (matches: boolean) => {
      Object.defineProperty(mediaQueryList, 'matches', { configurable: true, value: matches });
      const event = { matches, media: query } as MediaQueryListEvent;
      for (const listener of listeners) listener(event);
    },
  };
};

const jsonResponse = (payload: unknown, status = 200): Response => new Response(
  JSON.stringify(payload),
  { status, headers: { 'content-type': 'application/json' } },
);

const originalMatchMedia = window.matchMedia;

vi.mock('./components/AuthPanel', () => ({ AuthPanel: () => <div data-testid="auth-panel">Authentication</div> }));
vi.mock('./components/KernelPanel', () => ({ KernelPanel: () => <div data-testid="kernel-panel">Kernel</div> }));
vi.mock('./components/LearningPanel', () => ({ LearningPanel: () => <div>Learning</div> }));
vi.mock('./components/ProviderPanel', () => ({ ProviderPanel: () => <div>Providers</div> }));
vi.mock('./components/RuntimePanel', () => ({ RuntimePanel: () => <div>Runtime</div> }));
vi.mock('./components/DesktopPanel', () => ({ DesktopPanel: () => <div data-testid="desktop-panel">Desktop Cockpit</div> }));
vi.mock('./components/AgentObservatory', () => ({
  AgentObservatory: ({
    drawerOpen,
    onClose,
  }: {
    drawerOpen: boolean;
    onClose: () => void;
  }) => (
    <aside data-testid="agent-observatory" data-drawer-open={String(drawerOpen)}>
      Live Operations
      <button type="button" onClick={onClose}>Close live activity</button>
    </aside>
  ),
}));
vi.mock('./components/ResearchMissionPanel', () => ({
  ResearchMissionPanel: ({ initialMissionId }: { initialMissionId?: string | null }) => (
    <div data-testid="research-mission-panel">Research Mission Cockpit {initialMissionId ?? 'default'}</div>
  ),
}));
vi.mock('./components/RecurringResearchPanel', () => ({
  RecurringResearchPanel: ({ onOpenMission }: { onOpenMission?: (missionId: string) => void }) => (
    <div data-testid="recurring-research-panel">
      Recurring Research Cockpit
      <button type="button" onClick={() => onOpenMission?.('mission_linked')}>Open linked mission</button>
    </div>
  ),
}));
vi.mock('./components/MemoryDashboard', () => ({ default: () => <div>Memory Dashboard</div> }));
vi.mock('./lib/auth', () => ({
  authenticatedFetch: vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ memories: [] }),
  } as Response)),
  clearAuthSession: vi.fn(),
  fetchAuthStatus: vi.fn(async () => ({ mode: 'multi_user', userCount: 1 })),
  getAuthSession: vi.fn(() => ({ token: 'operator-token', kind: 'operator', role: 'operator' })),
  subscribeAuth: vi.fn((listener: () => void) => {
    authHarness.listener = listener;
    return () => {
      if (authHarness.listener === listener) authHarness.listener = undefined;
    };
  }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: originalMatchMedia,
  });
});

beforeEach(() => {
  authHarness.listener = undefined;
  localStorage.clear();
  vi.mocked(getAuthSession).mockReturnValue({ token: 'operator-token', kind: 'operator', role: 'operator' });
  vi.mocked(fetchAuthStatus).mockResolvedValue({ mode: 'multi_user', userCount: 1 });
});

describe('App mission workspace', () => {
  it('does not mount protected runtime panels before authentication is available', async () => {
    vi.mocked(getAuthSession).mockReturnValue(null);
    vi.mocked(fetchAuthStatus).mockResolvedValue({ mode: 'multi_user', userCount: 1 });

    render(<App />);

    expect(screen.getByTestId('auth-panel')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('Sign in to load protected runtime data')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('kernel-panel')).not.toBeInTheDocument();
  });

  it('opens the mission cockpit with authentication available in the same tab', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    const user = userEvent.setup();
    render(<App />);

    expect(screen.queryByTestId('research-mission-panel')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Missions' }));

    expect(screen.getByTestId('research-mission-panel')).toHaveTextContent('Research Mission Cockpit');
    expect(screen.getByTestId('auth-panel')).toHaveTextContent('Authentication');
    expect(screen.getByText('Mission Authority')).toBeInTheDocument();
    expect(screen.queryByTestId('kernel-panel')).not.toBeInTheDocument();
  });

  it('opens the durable schedule cockpit with authentication in the same tab', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    const user = userEvent.setup();
    render(<App />);

    expect(screen.queryByTestId('recurring-research-panel')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Schedules' }));

    expect(screen.getByTestId('recurring-research-panel')).toHaveTextContent('Recurring Research Cockpit');
    expect(screen.getByTestId('auth-panel')).toHaveTextContent('Authentication');
    expect(screen.getByText('Schedule Authority')).toBeInTheDocument();
    expect(screen.queryByTestId('research-mission-panel')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Open linked mission' }));
    expect(screen.getByTestId('research-mission-panel')).toHaveTextContent('mission_linked');
  });

  it('opens the native desktop cockpit with authentication in the same tab', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    const user = userEvent.setup();
    render(<App />);

    expect(screen.queryByTestId('desktop-panel')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Desktop' }));

    expect(screen.getByTestId('desktop-panel')).toHaveTextContent('Desktop Cockpit');
    expect(screen.getByTestId('auth-panel')).toHaveTextContent('Authentication');
    expect(screen.getByText('Desktop Authority')).toBeInTheDocument();
    expect(screen.getByText(/Approval-gated native worker/)).toBeInTheDocument();
    expect(screen.queryByTestId('kernel-panel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('research-mission-panel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('recurring-research-panel')).not.toBeInTheDocument();
  });

  it('closes protected readiness immediately and clears principal-bound presentation state on logout', async () => {
    let resolveStatus: ((status: AuthStatus) => void) | undefined;
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByTestId('kernel-panel')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'New Stream Tree' }));
    expect(screen.getByText('Research Stream 2')).toBeInTheDocument();

    vi.mocked(getAuthSession).mockReturnValue(null);
    vi.mocked(fetchAuthStatus).mockImplementation(() => new Promise((resolve) => {
      resolveStatus = resolve;
    }));
    act(() => authHarness.listener?.());

    expect(screen.queryByTestId('kernel-panel')).not.toBeInTheDocument();
    expect(screen.getByText('Sign in to load protected runtime data')).toBeInTheDocument();
    expect(screen.queryByText('Research Stream 2')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Overview' })).toBeInTheDocument();
    await act(async () => {
      resolveStatus?.({ mode: 'multi_user', userCount: 1 });
      await Promise.resolve();
    });
  });

  it('does not persist protected conversation or framework state', async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByTestId('kernel-panel')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'New Stream Tree' }));

    expect(localStorage.getItem(STORAGE_KEYS.sessions)).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.activeSessionId)).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.framework)).toBeNull();
  });

  it('pins and aborts an in-flight chat workflow when authentication changes', async () => {
    let requestSignal: AbortSignal | null = null;
    let resolveStatus: ((status: AuthStatus) => void) | undefined;
    const rawFetch = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => (
      new Promise<Response>((_resolve, reject) => {
        requestSignal = init?.signal ?? null;
        requestSignal?.addEventListener('abort', () => {
          reject(new DOMException('cancelled', 'AbortError'));
        });
      })
    ));
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Agent Chat' }));
    const input = await screen.findByPlaceholderText(/Interact with agent/);
    await user.type(input, 'principal-only prompt');
    await user.click(screen.getByRole('button', { name: 'SUBMIT' }));

    await waitFor(() => expect(requestSignal).not.toBeNull());
    const firstInit = rawFetch.mock.calls[0]?.[1];
    expect(new Headers(firstInit?.headers).get('authorization')).toBe('Bearer operator-token');
    expect(screen.getByText('principal-only prompt')).toBeInTheDocument();

    vi.mocked(getAuthSession).mockReturnValue(null);
    vi.mocked(fetchAuthStatus).mockImplementation(() => new Promise((resolve) => {
      resolveStatus = resolve;
    }));
    act(() => authHarness.listener?.());

    await waitFor(() => expect(requestSignal?.aborted).toBe(true));
    expect(screen.queryByText('principal-only prompt')).not.toBeInTheDocument();
    expect(rawFetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveStatus?.({ mode: 'multi_user', userCount: 1 });
      await Promise.resolve();
    });
  });

  it('auth-gates Research Lab and describes provider output as an unverified draft', async () => {
    vi.mocked(getAuthSession).mockReturnValue(null);
    vi.mocked(fetchAuthStatus).mockResolvedValue({ mode: 'multi_user', userCount: 1 });
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Research Lab' }));

    expect(await screen.findByText('Sign in to load protected runtime data')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'GENERATE PROVIDER DRAFT' })).toBeDisabled();
    expect(screen.getByPlaceholderText(/Non-Abelian Gauge theories/)).toBeDisabled();
    expect(screen.getByText(/not an independently verified calculation, proof, or research finding/i)).toBeInTheDocument();
  });

  it('clears a provider research draft when the authenticated principal changes', async () => {
    let candidateSignal: AbortSignal | null = null;
    const rawFetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ memories: [] }))
      .mockResolvedValueOnce(jsonResponse({
        title: 'Speculative lattice draft',
        novelInsight: 'A model-proposed conjecture.',
        mathematicalBounds: 'A model-proposed bound.',
        suggestedActionItems: ['Attempt a counterexample.'],
        evidenceEventId: 'ledger_event_research_123456789',
      }))
      .mockImplementationOnce((_input, init) => new Promise<Response>((_resolve, reject) => {
        candidateSignal = init?.signal ?? null;
        candidateSignal?.addEventListener('abort', () => {
          reject(new DOMException('cancelled', 'AbortError'));
        });
      }));
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Research Lab' }));
    const generate = screen.getByRole('button', { name: 'GENERATE PROVIDER DRAFT' });
    await waitFor(() => expect(generate).toBeEnabled());
    await user.click(generate);

    expect(await screen.findByText('MODEL-GENERATED CONJECTURE (UNVERIFIED)')).toBeInTheDocument();
    expect(screen.getByText(/not reverified in this browser view/i)).toBeInTheDocument();
    const submitCandidate = screen.getByRole('button', { name: 'Submit Review Candidate' });
    await user.click(submitCandidate);
    await user.click(submitCandidate);
    expect(screen.getByRole('button', { name: 'Submitting Candidate...' })).toBeDisabled();
    expect(rawFetch).toHaveBeenCalledTimes(3);
    for (const call of rawFetch.mock.calls) {
      expect(new Headers(call[1]?.headers).get('authorization')).toBe('Bearer operator-token');
    }

    vi.mocked(getAuthSession).mockReturnValue({
      token: 'second-principal-token',
      kind: 'operator',
      role: 'operator',
    });
    act(() => authHarness.listener?.());
    expect(candidateSignal?.aborted).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Research Lab' }));

    expect(screen.getByText('No provider draft yet')).toBeInTheDocument();
    expect(screen.queryByText('Speculative lattice draft')).not.toBeInTheDocument();
  });

  it('closes modal drawers when their persistent desktop breakpoints activate', async () => {
    const navigationMedia = createMutableMediaQuery('(min-width: 1024px)');
    const activityMedia = createMutableMediaQuery('(min-width: 1536px)');
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn((query: string) => (
        query === '(min-width: 1024px)'
          ? navigationMedia.mediaQueryList
          : activityMedia.mediaQueryList
      )),
    });
    const user = userEvent.setup();
    render(<App />);
    const workspace = screen.getByLabelText('Provenance workspace');

    await user.click(screen.getByRole('button', { name: 'Open conversation navigation' }));
    expect(screen.getByRole('dialog', { name: 'Conversation navigation' })).toBeInTheDocument();
    expect(workspace).toHaveAttribute('inert');

    act(() => navigationMedia.emit(true));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Conversation navigation' })).not.toBeInTheDocument());
    expect(workspace).not.toHaveAttribute('inert');

    await user.click(screen.getByRole('button', { name: 'Open live agent activity' }));
    expect(screen.getByTestId('agent-observatory')).toHaveAttribute('data-drawer-open', 'true');
    expect(workspace).toHaveAttribute('inert');

    act(() => activityMedia.emit(true));
    await waitFor(() => expect(screen.getByTestId('agent-observatory')).toHaveAttribute('data-drawer-open', 'false'));
    expect(workspace).not.toHaveAttribute('inert');
  });
});

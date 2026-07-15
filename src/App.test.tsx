import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App';

vi.mock('./components/AuthPanel', () => ({ AuthPanel: () => <div data-testid="auth-panel">Authentication</div> }));
vi.mock('./components/KernelPanel', () => ({ KernelPanel: () => <div data-testid="kernel-panel">Kernel</div> }));
vi.mock('./components/LearningPanel', () => ({ LearningPanel: () => <div>Learning</div> }));
vi.mock('./components/ProviderPanel', () => ({ ProviderPanel: () => <div>Providers</div> }));
vi.mock('./components/RuntimePanel', () => ({ RuntimePanel: () => <div>Runtime</div> }));
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
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('App mission workspace', () => {
  it('opens the mission cockpit with authentication available in the same tab', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    const user = userEvent.setup();
    render(<App />);

    expect(screen.queryByTestId('research-mission-panel')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Research Missions' }));

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
});

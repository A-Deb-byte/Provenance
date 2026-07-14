import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MemoryDashboard from './MemoryDashboard';

afterEach(cleanup);

const props = {
  memories: [{
    id: 'mem_1', content: 'Kernel-backed fact', category: 'technical' as const,
    source: 'user:evidence_1', createdAt: '2026-07-12T00:00:00.000Z', importance: 5,
  }],
  profile: { bio: 'Bundled prompt description.', extractedName: 'Local user' },
  isConsolidating: false,
  agentFramework: 'cartographer' as const,
  onSetAgentFramework: vi.fn(),
};

describe('MemoryDashboard', () => {
  it('projects promoted memory without editable or provider controls', () => {
    render(<MemoryDashboard {...props} />);
    expect(screen.getByText('Server authoritative')).toBeInTheDocument();
    expect(screen.getByText('Kernel-backed fact')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add|delete|edit|draft/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/provider configuration/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/draft skills registry/i)).not.toBeInTheDocument();
  });

  it('labels profile and framework as presentation-only and authority-free', async () => {
    const user = userEvent.setup();
    render(<MemoryDashboard {...props} />);

    await user.click(screen.getByRole('button', { name: 'Profile' }));
    expect(screen.getByText('Presentation only')).toBeInTheDocument();
    expect(screen.getByText('Bundled prompt description.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Chat lens' }));
    expect(screen.getByText('No authority')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /prover/i }));
    expect(props.onSetAgentFramework).toHaveBeenCalledWith('prover');
  });
});

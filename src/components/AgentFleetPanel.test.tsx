import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentFleetPanel } from './AgentFleetPanel';

const fleet = {
  schemaVersion: 1,
  definitions: [],
  spawns: [
    {
      schemaVersion: 1,
      id: 'spawn_pending',
      definitionId: 'agent_1',
      goalId: 'goal_1',
      depth: 0,
      tier: 'T1_operator',
      domain: 'web',
      requestedAuthority: 'autonomous',
      effectiveAuthority: 'autonomous',
      effectiveRiskCeiling: 'L2',
      status: 'approval_required',
      objective: 'Act without per-action prompts',
      budget: { maxOperations: 25, maxChildren: 4, maxDepth: 3, deadlineMs: 600000 },
      operationsUsed: 0,
      childCount: 0,
      approvalId: 'approval_1',
      createdAt: '2026-08-16T12:00:00.000Z',
      updatedAt: '2026-08-16T12:00:00.000Z',
    },
  ],
  proposals: [],
  execution: { enabled: false, reason: 'Agent execution is disabled.' },
};

const runningFleet = {
  ...fleet,
  execution: { enabled: true, reason: 'Agent execution is enabled for this deployment.' },
  spawns: [{ ...fleet.spawns[0], status: 'running' }],
};

const responses = new Map<string, unknown>();

vi.mock('../lib/auth', () => ({
  authenticatedFetch: vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url}`;
    const body = responses.get(key) ?? responses.get(url) ?? {};
    return { ok: true, status: 200, json: async () => body } as Response;
  }),
}));

beforeEach(() => {
  responses.clear();
  responses.set('/api/kernel/agents', fleet);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AgentFleetPanel', () => {
  it('states the oversight cost of each authority mode as it is selected', async () => {
    const user = userEvent.setup();
    render(<AgentFleetPanel goalId="goal_1" />);

    // The default must be the safe one.
    const authoritySelect = await screen.findByLabelText(/authority/i);
    expect(authoritySelect).toHaveValue('propose_only');
    expect(screen.getByTestId('authority-note')).toHaveTextContent(/You approve each one/i);

    // Selecting an elevated mode must say plainly that per-action review stops
    // and that the decision is attributed -- a trust-boundary UI must not
    // understate what the operator is giving up.
    await user.selectOptions(authoritySelect, 'autonomous');
    const note = screen.getByTestId('authority-note');
    expect(note).toHaveTextContent(/self-authorises/i);
    expect(note).toHaveTextContent(/No per-action approval/i);
    expect(note).toHaveTextContent(/recorded against your identity/i);

    await user.selectOptions(authoritySelect, 'envelope');
    expect(screen.getByTestId('authority-note')).toHaveTextContent(/bounded, expiring delegation/i);
  });

  it('shows the effective authority and ceiling actually in force, not what was requested', async () => {
    render(<AgentFleetPanel goalId="goal_1" />);

    await waitFor(() => expect(screen.getByText('Act without per-action prompts')).toBeInTheDocument());
    expect(screen.getByText('approval_required')).toBeInTheDocument();
    expect(screen.getByText('autonomous')).toBeInTheDocument();
    expect(screen.getByText('L2')).toBeInTheDocument();
  });

  it('offers authorization only while a spawn is awaiting it', async () => {
    render(<AgentFleetPanel goalId="goal_1" />);

    await waitFor(() => expect(screen.getByRole('button', { name: /authorize/i })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /revoke/i })).toBeInTheDocument();

    responses.set('/api/kernel/agents', {
      ...fleet,
      spawns: [{ ...fleet.spawns[0], status: 'running' }],
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /authorize/i }));

    await waitFor(() => expect(screen.queryByRole('button', { name: /authorize/i })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: /revoke/i })).toBeInTheDocument();
  });

  it('says plainly when execution is off, and offers no run control', async () => {
    render(<AgentFleetPanel goalId="goal_1" />);

    await waitFor(() => expect(screen.getByTestId('execution-status')).toHaveTextContent(/execution off/i));
    // The panel must not imply agents are working when the deployment has not
    // enabled execution.
    expect(screen.getByText(/will not run until this deployment sets/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /run step/i })).not.toBeInTheDocument();
  });

  it('offers a run control only for a running agent once execution is enabled', async () => {
    responses.set('/api/kernel/agents', runningFleet);
    render(<AgentFleetPanel goalId="goal_1" />);

    await waitFor(() => expect(screen.getByTestId('execution-status')).toHaveTextContent(/execution on/i));
    expect(screen.getByRole('button', { name: /run step/i })).toBeInTheDocument();
    expect(screen.queryByText(/will not run until this deployment sets/i)).not.toBeInTheDocument();
  });

  it('refuses to spawn without a selected goal', async () => {
    render(<AgentFleetPanel />);

    await waitFor(() => expect(screen.getByText(/Select a goal to spawn agents/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /spawn agent/i })).toBeDisabled();
  });
});

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimePanel } from './RuntimePanel';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const report = {
  providers: {
    configured: ['gemini'],
    unavailable: [{ id: 'openai', reason: 'OPENAI_API_KEY is not configured.' }],
  },
  workers: {
    available: [],
    configured: [],
    unavailable: [
      { id: 'worker.browser.placeholder', reason: 'No browser worker runtime is installed in this deployment.' },
      { id: 'worker.connector.placeholder', reason: 'No connector worker runtime is installed in this deployment.' },
      { id: 'worker.desktop.placeholder', reason: 'No desktop worker runtime is installed in this deployment.' },
    ],
  },
  features: {
    verificationCommands: {
      status: 'available',
      reason: 'Allowlisted npm verification commands run inside the configured workspace.',
    },
    secretVault: {
      status: 'unavailable',
      reason: 'No operating-system vault adapter is installed; credentials come from server environment variables.',
    },
  },
  generatedAt: '2026-07-12T00:00:00.000Z',
};

describe('RuntimePanel', () => {
  it('projects recorded feature availability without simulating anything', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => report,
    } as Response)));

    render(<RuntimePanel />);

    expect(screen.getByText('Capability Report')).toBeInTheDocument();
    expect(await screen.findByText('Verification commands')).toBeInTheDocument();
    expect(screen.getByText('available')).toBeInTheDocument();
    expect(screen.getByText('OS secret vault')).toBeInTheDocument();
    expect(screen.getByText('unavailable')).toBeInTheDocument();
    expect(screen.getByText(/No operating-system vault adapter/)).toBeInTheDocument();
    expect(screen.getByText('gemini')).toBeInTheDocument();
    expect(screen.getByText(/Unavailable: 3 worker families/)).toBeInTheDocument();
  });

  it('shows an honest unavailable state when the report cannot be loaded', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) } as Response)));

    render(<RuntimePanel />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Runtime report unavailable');
  });
});

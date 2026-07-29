import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimePanel } from './RuntimePanel';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
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
    desktopIpc: {
      status: 'unavailable',
      reason: 'This server was not launched by an authenticated native desktop host.',
      reasonCode: 'native_host_absent',
      remediation: 'Launch the native desktop application and complete its application allowlist and workspace setup.',
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
    expect(screen.getAllByText('unavailable')).toHaveLength(2);
    expect(screen.getByText(/No operating-system vault adapter/)).toBeInTheDocument();
    expect(screen.getByText('gemini')).toBeInTheDocument();
    expect(screen.getByText(/Unavailable: 3 worker families/)).toBeInTheDocument();
    expect(screen.getByText('Native host bridge')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Native desktop host required' })).toBeInTheDocument();
    expect(screen.getByText(/browser dashboard cannot establish Windows UI Automation/)).toBeInTheDocument();
    expect(screen.getByText(/Next step: Launch the native desktop application/)).toBeInTheDocument();
  });

  it('distinguishes a configured bridge health failure from an absent native host', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ...report,
        features: {
          ...report.features,
          desktopIpc: {
            status: 'configured',
            reason: 'Native desktop bridge settings are present, but the authenticated health check failed.',
            reasonCode: 'native_bridge_health_failed',
            remediation: 'Restart the native desktop application. If the issue persists, review its coded recovery state and support diagnostics.',
          },
        },
      }),
    } as Response)));

    render(<RuntimePanel />);

    expect(await screen.findByRole('heading', { name: 'Native bridge needs attention' })).toBeInTheDocument();
    expect(screen.getByText('native_bridge_health_failed')).toBeInTheDocument();
    expect(screen.getByText(/Next step: Restart the native desktop application/)).toBeInTheDocument();
  });

  it('surfaces a healthy bridge whose Windows UI Automation worker is missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ...report,
        features: {
          ...report.features,
          desktopIpc: {
            status: 'available',
            reason: 'The authenticated native bridge is healthy.',
            reasonCode: 'native_bridge_ready',
          },
          desktopAutomation: {
            status: 'unavailable',
            reason: 'The authenticated native bridge is healthy, but no executable Windows UI Automation worker is registered.',
            reasonCode: 'windows_uia_worker_missing',
            remediation: 'Restart the native desktop application and review support diagnostics.',
          },
        },
      }),
    } as Response)));

    render(<RuntimePanel />);

    expect(await screen.findByRole('heading', { name: 'Windows UI Automation worker unavailable' })).toBeInTheDocument();
    expect(screen.getByText('windows_uia_worker_missing')).toBeInTheDocument();
    expect(screen.getByText(/Next step: Restart the native desktop application/)).toBeInTheDocument();
  });

  it('shows an honest unavailable state when the report cannot be loaded', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) } as Response)));

    render(<RuntimePanel />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Runtime report unavailable');
  });

  it('does not overlap pending polls and aborts timed-out and unmounted requests', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    let abortedRequests = 0;
    let requestCount = 0;
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      signals.push(signal);
      requestCount += 1;
      if (requestCount === 1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => report,
        } as Response);
      }
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          abortedRequests += 1;
          reject(new DOMException('The runtime report request was aborted.', 'AbortError'));
        }, { once: true });
      });
    }));

    const { unmount } = render(<RuntimePanel />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(requestCount).toBe(1);
    act(() => vi.advanceTimersByTime(4_999));
    expect(requestCount).toBe(1);
    act(() => vi.advanceTimersByTime(1));
    expect(requestCount).toBe(2);
    expect(signals[1]?.aborted).toBe(false);

    act(() => vi.advanceTimersByTime(5_000));
    expect(requestCount).toBe(2);
    expect(signals[1]?.aborted).toBe(false);
    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    expect(requestCount).toBe(2);
    expect(signals[1]?.aborted).toBe(true);
    expect(abortedRequests).toBe(1);

    act(() => vi.advanceTimersByTime(5_000));
    expect(requestCount).toBe(3);
    expect(signals[2]?.aborted).toBe(false);

    unmount();
    expect(signals[2]?.aborted).toBe(true);
    expect(abortedRequests).toBe(2);
  });
});

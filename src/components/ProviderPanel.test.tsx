import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAuthSession, useOperatorToken } from '../lib/auth';
import { ProviderPanel } from './ProviderPanel';

afterEach(() => {
  cleanup();
  clearAuthSession();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

const statuses = [
  {
    id: 'gemini', configured: true, credentialSource: 'server_env',
    endpoint: 'https://generativelanguage.googleapis.com', defaultModel: 'gemini-3.5-flash',
    allowedModels: ['gemini-3.5-flash'], capabilities: ['text', 'streaming', 'json_schema'], routingPriority: 10,
  },
  {
    id: 'aws', configured: false, credentialSource: 'aws_default_chain', endpoint: 'aws-bedrock://converse',
    defaultModel: 'amazon.nova-lite-v1:0', allowedModels: ['amazon.nova-lite-v1:0'],
    capabilities: ['text', 'streaming'], routingPriority: 60,
    unavailableReason: 'AWS Bedrock transport is not installed.',
  },
];

describe('ProviderPanel', () => {
  it('shows sanitized provider status, capabilities, models, and routing preview', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/providers/status') {
        return { ok: true, status: 200, json: async () => ({ providers: statuses }) } as Response;
      }
      const payload = JSON.parse(String(init?.body));
      const provider = payload.policy.mode === 'pinned' ? payload.policy.provider : 'gemini';
      return {
        ok: true,
        status: 200,
        json: async () => ({
          plan: {
            mode: payload.policy.mode,
            selections: [{ provider, model: provider === 'aws' ? 'amazon.nova-lite-v1:0' : 'gemini-3.5-flash' }],
            reason: 'Preview only.',
          },
        }),
      } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ProviderPanel />);

    expect(screen.getByText('Provider Intelligence')).toBeInTheDocument();
    expect(await screen.findByText('gemini-3.5-flash')).toBeInTheDocument();
    expect(screen.getByText('Configured')).toBeInTheDocument();
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    expect(screen.getByText('json_schema')).toBeInTheDocument();
    expect(screen.getByText('AWS Bedrock transport is not installed.')).toBeInTheDocument();
    expect(await screen.findByText('gemini / gemini-3.5-flash')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByText(/API key/i)).not.toBeInTheDocument();
  });

  it('previews pinned routing without exposing provider configuration editing', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/status')) {
        return { ok: true, status: 200, json: async () => ({ providers: statuses }) } as Response;
      }
      const payload = JSON.parse(String(init?.body));
      return {
        ok: true,
        status: 200,
        json: async () => ({ plan: {
          mode: payload.policy.mode,
          selections: [{ provider: 'gemini', model: 'gemini-3.5-flash' }],
          reason: 'Pinned preview.',
        } }),
      } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<ProviderPanel />);
    await screen.findByText('gemini-3.5-flash');

    fireEvent.click(screen.getByRole('button', { name: 'Pinned' }));

    await waitFor(() => {
      const planCalls = fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/plan'));
      const lastBody = JSON.parse(String(planCalls.at(-1)?.[1]?.body));
      expect(lastBody.policy).toEqual({ mode: 'pinned', provider: 'gemini' });
    });
  });

  it('shows an honest unavailable state when status loading fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) } as Response)));
    render(<ProviderPanel />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Provider status unavailable');
  });

  it('retries the protected routing preview as soon as authentication changes', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/status')) {
        return { ok: true, status: 200, json: async () => ({ providers: statuses }) } as Response;
      }
      const authorization = new Headers(init?.headers).get('authorization');
      if (authorization !== 'Bearer operator-secret') {
        return { ok: false, status: 401, json: async () => ({ error: 'Authentication required.' }) } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ plan: {
          mode: 'automatic',
          selections: [{ provider: 'gemini', model: 'gemini-3.5-flash' }],
          reason: 'Authenticated preview.',
        } }),
      } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<ProviderPanel />);

    expect(await screen.findByText('Routing preview unavailable.')).toBeInTheDocument();
    await act(async () => { await useOperatorToken('operator-secret'); });

    expect(await screen.findByText('Authenticated preview.')).toBeInTheDocument();
    const planCalls = fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/plan'));
    expect(planCalls).toHaveLength(2);
  });
});

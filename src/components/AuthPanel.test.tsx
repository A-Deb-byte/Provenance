import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAuthSession } from '../lib/auth';
import { AuthPanel } from './AuthPanel';

afterEach(() => {
  cleanup();
  clearAuthSession();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe('AuthPanel', () => {
  it('bootstraps the first admin and exposes a working logout control', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/auth/status') {
        const bootstrapped = fetchMock.mock.calls.some(([called]) => String(called) === '/api/auth/users');
        return { ok: true, status: 200, json: async () => ({ mode: bootstrapped ? 'multi_user' : 'open', userCount: bootstrapped ? 1 : 0 }) } as Response;
      }
      if (url === '/api/auth/users') return { ok: true, status: 201, json: async () => ({ bootstrap: true }) } as Response;
      if (url === '/api/auth/login') return {
        ok: true, status: 200,
        json: async () => ({ token: 'session-token', username: 'admin1', role: 'admin', expiresAt: '2099-01-01T00:00:00.000Z' }),
      } as Response;
      return { ok: true, status: 204 } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<AuthPanel />);

    expect(await screen.findByRole('button', { name: 'Create admin' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Username'), 'admin1');
    await user.type(screen.getByLabelText('Password'), 'adminpassword');
    await user.click(screen.getByRole('button', { name: 'Create admin' }));

    expect(await screen.findByText('Signed in as admin1')).toBeInTheDocument();
    expect(screen.getByText('Multi-user')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Log out' }));
    await waitFor(() => expect(screen.queryByText('Signed in as admin1')).not.toBeInTheDocument());
  });

  it('accepts an operator token without rendering it back into the page', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ mode: 'operator_token', userCount: 0 }),
    } as Response)));
    const user = userEvent.setup();
    render(<AuthPanel />);

    const input = await screen.findByLabelText('Operator bearer token');
    await user.type(input, 'private-operator-token');
    await user.click(screen.getByRole('button', { name: 'Use token' }));

    expect(await screen.findByText('Operator token loaded')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('private-operator-token')).not.toBeInTheDocument();
    expect(screen.queryByText('private-operator-token')).not.toBeInTheDocument();
  });

  it('uses the loaded operator token to bootstrap the first administrator', async () => {
    let bootstrapped = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/auth/status') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ mode: bootstrapped ? 'multi_user' : 'operator_token', userCount: bootstrapped ? 1 : 0 }),
        } as Response;
      }
      if (url === '/api/auth/users') {
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer private-operator-token');
        bootstrapped = true;
        return { ok: true, status: 201, json: async () => ({ bootstrap: true }) } as Response;
      }
      if (url === '/api/auth/login') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            token: 'admin-session', username: 'admin1', role: 'admin', expiresAt: '2099-01-01T00:00:00.000Z',
          }),
        } as Response;
      }
      return { ok: true, status: 204 } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<AuthPanel />);

    await user.type(await screen.findByLabelText('Operator bearer token'), 'private-operator-token');
    await user.click(screen.getByRole('button', { name: 'Use token' }));
    expect(await screen.findByRole('button', { name: 'Create admin' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Username'), 'admin1');
    await user.type(screen.getByLabelText('Password'), 'adminpassword');
    await user.click(screen.getByRole('button', { name: 'Create admin' }));

    expect(await screen.findByText('Signed in as admin1')).toBeInTheDocument();
    expect(screen.getByText('Multi-user')).toBeInTheDocument();
  });

  it('rejects a stale persisted operator token during startup revalidation', async () => {
    sessionStorage.setItem('agent_kb_auth_session_v1', JSON.stringify({
      token: 'stale-token', kind: 'operator', role: 'operator',
    }));
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/auth/status') {
        return { ok: true, status: 200, json: async () => ({ mode: 'operator_token', userCount: 0 }) } as Response;
      }
      return {
        ok: false, status: 401, json: async () => ({ error: 'A valid operator bearer token is required.' }),
      } as Response;
    }));

    render(<AuthPanel />);

    expect(await screen.findByRole('alert')).toHaveTextContent('valid operator bearer token');
    expect(screen.queryByText('Operator token loaded')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Operator bearer token')).toBeInTheDocument();
  });

  it('shows server login errors without retaining the password after success', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/auth/status') return { ok: true, status: 200, json: async () => ({ mode: 'multi_user', userCount: 1 }) } as Response;
      return { ok: false, status: 401, json: async () => ({ error: 'Invalid username or password.' }) } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<AuthPanel />);

    await user.type(await screen.findByLabelText('Username'), 'admin1');
    await user.type(screen.getByLabelText('Password'), 'wrongpass');
    await user.click(screen.getByRole('button', { name: 'Log in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid username or password.');
  });
});

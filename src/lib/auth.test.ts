import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  authenticatedFetch,
  bootstrapAdmin,
  clearAuthSession,
  getAuthSession,
  login,
  logout,
  setAuthSession,
  useOperatorToken,
} from './auth';

afterEach(() => {
  clearAuthSession();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe('authenticated browser transport', () => {
  it('preserves anonymous reads and adds the active bearer token to mutations', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({ ok: true, status: 200 } as Response));
    vi.stubGlobal('fetch', fetchMock);

    await authenticatedFetch('/api/kernel/events');
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/kernel/events');

    setAuthSession({ token: 'operator-secret', kind: 'operator', role: 'operator' });
    await authenticatedFetch('/api/kernel/goals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const headers = fetchMock.mock.calls[1][1]?.headers as Headers;
    expect(headers.get('authorization')).toBe('Bearer operator-secret');
    expect(headers.get('content-type')).toBe('application/json');
  });

  it('stores valid login metadata only for the current browser tab', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        token: 'signed-session', username: 'admin1', role: 'admin', expiresAt: '2099-01-01T00:00:00.000Z',
      }),
    } as Response)));

    await login('admin1', 'password-value');
    expect(getAuthSession()).toEqual({
      token: 'signed-session', kind: 'session', username: 'admin1', role: 'admin', expiresAt: '2099-01-01T00:00:00.000Z',
    });
    expect(localStorage.length).toBe(0);
  });

  it('bootstraps the first admin and immediately logs in', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ bootstrap: true }) } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          token: 'new-session', username: 'first-admin', role: 'admin', expiresAt: '2099-01-01T00:00:00.000Z',
        }),
      } as Response);
    vi.stubGlobal('fetch', fetchMock);

    await bootstrapAdmin('first-admin', 'password-value');
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/auth/users', expect.objectContaining({ method: 'POST' }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/auth/login', expect.objectContaining({ method: 'POST' }));
    expect(getAuthSession()?.username).toBe('first-admin');
  });

  it('attaches the loaded operator token when bootstrapping a protected deployment', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ bootstrap: true }) } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          token: 'admin-session', username: 'first-admin', role: 'admin', expiresAt: '2099-01-01T00:00:00.000Z',
        }),
      } as Response);
    vi.stubGlobal('fetch', fetchMock);
    setAuthSession({ token: 'operator-secret', kind: 'operator', role: 'operator' });

    await bootstrapAdmin('first-admin', 'password-value');

    const headers = fetchMock.mock.calls[0][1]?.headers as Headers;
    expect(headers.get('authorization')).toBe('Bearer operator-secret');
    expect(getAuthSession()).toMatchObject({ kind: 'session', username: 'first-admin', role: 'admin' });
  });

  it('stores an operator token only after the server verifies it', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 204 } as Response));
    vi.stubGlobal('fetch', fetchMock);

    await useOperatorToken('operator-secret');

    expect(fetchMock).toHaveBeenCalledWith('/api/auth/operator/verify', expect.objectContaining({
      method: 'POST',
      headers: { authorization: 'Bearer operator-secret' },
    }));
    expect(getAuthSession()).toMatchObject({ token: 'operator-secret', kind: 'operator' });
  });

  it('does not retain a rejected operator token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 401, json: async () => ({ error: 'A valid operator bearer token is required.' }),
    } as Response)));

    await expect(useOperatorToken('wrong-token')).rejects.toThrow(/valid operator bearer token/i);
    expect(getAuthSession()).toBeNull();
  });

  it('clears credentials even when the logout request fails', async () => {
    setAuthSession({ token: 'session', kind: 'session', role: 'operator', expiresAt: '2099-01-01T00:00:00.000Z' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));

    await expect(logout()).rejects.toThrow('offline');
    expect(getAuthSession()).toBeNull();
  });
});

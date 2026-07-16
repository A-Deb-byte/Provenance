export type AuthMode = 'open' | 'operator_token' | 'multi_user';
export type AuthRole = 'admin' | 'operator' | 'viewer';

export interface AuthStatus {
  mode: AuthMode;
  userCount: number;
}

export interface AuthSession {
  token: string;
  kind: 'session' | 'operator';
  username?: string;
  role?: AuthRole;
  expiresAt?: string;
}

interface LoginResponse {
  token: string;
  username: string;
  role: AuthRole;
  expiresAt: string;
}

const SESSION_KEY = 'agent_kb_auth_session_v1';
const AUTH_EVENT = 'agent-kb-auth-change';

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const readError = async (response: Response, fallback: string): Promise<string> => {
  try {
    const payload: unknown = await response.json();
    return isRecord(payload) && typeof payload.error === 'string' ? payload.error : fallback;
  } catch {
    return fallback;
  }
};

const storage = (): Storage | undefined => {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
};

const isAuthSession = (value: unknown): value is AuthSession => {
  if (!isRecord(value) || typeof value.token !== 'string' || !value.token.trim()) return false;
  if (value.kind !== 'session' && value.kind !== 'operator') return false;
  if (value.username !== undefined && typeof value.username !== 'string') return false;
  if (value.role !== undefined && value.role !== 'admin' && value.role !== 'operator' && value.role !== 'viewer') return false;
  return value.expiresAt === undefined || typeof value.expiresAt === 'string';
};

const emitChange = (): void => {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(AUTH_EVENT));
};

export const getAuthSession = (): AuthSession | null => {
  const raw = storage()?.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isAuthSession(parsed)) {
      storage()?.removeItem(SESSION_KEY);
      return null;
    }
    if (parsed.expiresAt && Date.parse(parsed.expiresAt) <= Date.now()) {
      storage()?.removeItem(SESSION_KEY);
      return null;
    }
    return parsed;
  } catch {
    storage()?.removeItem(SESSION_KEY);
    return null;
  }
};

export const setAuthSession = (session: AuthSession): void => {
  if (!isAuthSession(session)) throw new Error('Authentication session is invalid.');
  storage()?.setItem(SESSION_KEY, JSON.stringify(session));
  emitChange();
};

export const clearAuthSession = (): void => {
  storage()?.removeItem(SESSION_KEY);
  emitChange();
};

export const subscribeAuth = (listener: () => void): (() => void) => {
  if (typeof window === 'undefined') return () => undefined;
  window.addEventListener(AUTH_EVENT, listener);
  return () => window.removeEventListener(AUTH_EVENT, listener);
};

/**
 * Single browser transport for API calls. Reads remain anonymous when no
 * credential is loaded; authenticated sessions are attached to every request.
 */
export const authenticatedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const session = getAuthSession();
  if (!session) return init === undefined ? fetch(input) : fetch(input, init);

  const headers = new Headers(init?.headers);
  if (!headers.has('authorization')) headers.set('authorization', `Bearer ${session.token}`);
  const response = await fetch(input, { ...init, headers });
  if (response.status === 401) clearAuthSession();
  return response;
};

export const fetchAuthStatus = async (): Promise<AuthStatus> => {
  const response = await authenticatedFetch('/api/auth/status');
  if (!response.ok) throw new Error(await readError(response, 'Authentication status is unavailable.'));
  const payload: unknown = await response.json();
  if (!isRecord(payload) ||
      (payload.mode !== 'open' && payload.mode !== 'operator_token' && payload.mode !== 'multi_user') ||
      typeof payload.userCount !== 'number') {
    throw new Error('Authentication status response is invalid.');
  }
  return { mode: payload.mode, userCount: payload.userCount };
};

export const login = async (username: string, password: string): Promise<AuthSession> => {
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) throw new Error(await readError(response, 'Login failed.'));
  const payload: unknown = await response.json();
  if (!isRecord(payload) || typeof payload.token !== 'string' || typeof payload.username !== 'string' ||
      (payload.role !== 'admin' && payload.role !== 'operator' && payload.role !== 'viewer') ||
      typeof payload.expiresAt !== 'string') {
    throw new Error('Login response is invalid.');
  }
  const session: AuthSession = {
    token: payload.token,
    kind: 'session',
    username: payload.username,
    role: payload.role,
    expiresAt: payload.expiresAt,
  };
  setAuthSession(session);
  return session;
};

export const bootstrapAdmin = async (username: string, password: string): Promise<AuthSession> => {
  const response = await authenticatedFetch('/api/auth/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) throw new Error(await readError(response, 'Admin bootstrap failed.'));
  return login(username, password);
};

export const useOperatorToken = async (token: string): Promise<AuthSession> => {
  const normalized = token.trim();
  if (!normalized) throw new Error('Operator token is required.');
  const response = await fetch('/api/auth/operator/verify', {
    method: 'POST',
    headers: { authorization: `Bearer ${normalized}` },
  });
  if (!response.ok) throw new Error(await readError(response, 'Operator token verification failed.'));
  const session: AuthSession = { token: normalized, kind: 'operator', role: 'operator' };
  setAuthSession(session);
  return session;
};

export const verifySessionCredential = async (session: AuthSession): Promise<void> => {
  if (session.kind !== 'session') throw new Error('A signed user session is required.');
  const response = await fetch('/api/auth/session/verify', {
    method: 'POST',
    headers: { authorization: `Bearer ${session.token}` },
  });
  if (!response.ok) throw new Error(await readError(response, 'Stored session verification failed.'));
};

export const logout = async (): Promise<void> => {
  try {
    await authenticatedFetch('/api/auth/logout', { method: 'POST' });
  } finally {
    clearAuthSession();
  }
};

import React, { useCallback, useEffect, useState } from 'react';
import {
  bootstrapAdmin,
  clearAuthSession,
  fetchAuthStatus,
  getAuthSession,
  login,
  logout,
  subscribeAuth,
  useOperatorToken,
  type AuthSession,
  type AuthStatus,
} from '../lib/auth';

const modeLabel: Record<AuthStatus['mode'], string> = {
  open: 'Open loopback',
  operator_token: 'Operator token',
  multi_user: 'Multi-user',
};

export const AuthPanel: React.FC = () => {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [session, setSession] = useState<AuthSession | null>(() => getAuthSession());
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [operatorToken, setOperatorToken] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const nextStatus = await fetchAuthStatus();
      const currentSession = getAuthSession();
      if (currentSession?.kind === 'operator') {
        if (nextStatus.mode !== 'operator_token') {
          clearAuthSession();
        } else {
          try {
            await useOperatorToken(currentSession.token);
          } catch (verificationError) {
            clearAuthSession();
            setStatus(nextStatus);
            setError(verificationError instanceof Error
              ? verificationError.message
              : 'Stored operator token verification failed.');
            return;
          }
        }
      }
      setStatus(nextStatus);
      setError(null);
    } catch (statusError) {
      setError(statusError instanceof Error ? statusError.message : 'Authentication status is unavailable.');
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    return subscribeAuth(() => setSession(getAuthSession()));
  }, [refreshStatus]);

  const submitCredentials = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!status || !username.trim() || !password) return;
    setIsSubmitting(true);
    setError(null);
    try {
      if (status.userCount === 0) {
        await bootstrapAdmin(username.trim(), password);
        await refreshStatus();
      } else {
        await login(username.trim(), password);
      }
      setPassword('');
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Authentication failed.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const submitOperatorToken = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);
    try {
      await useOperatorToken(operatorToken);
      setOperatorToken('');
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Operator token is invalid.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const endSession = async () => {
    setIsSubmitting(true);
    setError(null);
    try {
      await logout();
    } catch {
      // The local credential is discarded even if the stateless logout endpoint is offline.
    } finally {
      setIsSubmitting(false);
    }
  };

  const isBootstrap = status?.userCount === 0 && (
    status.mode === 'open' || session?.kind === 'operator'
  );

  return (
    <section aria-labelledby="auth-panel-title" className="rounded-3xl border border-slate-800 bg-[#101114]/90 p-5 shadow-2xl">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-[0.35em] text-emerald-400 font-mono">Operator Access</p>
          <h2 id="auth-panel-title" className="mt-1 text-xl font-black tracking-tight text-white">Cockpit Authentication</h2>
          <p className="mt-2 max-w-2xl text-xs leading-relaxed text-slate-400">
            Reads remain available on loopback. Every cockpit mutation uses the active bearer credential automatically.
          </p>
        </div>
        <span className="shrink-0 rounded-full border border-slate-700 px-3 py-1 text-[10px] font-mono text-slate-300">
          {status ? modeLabel[status.mode] : 'Checking...'}
        </span>
      </div>

      {error && <p role="alert" className="mt-4 rounded-lg border border-rose-900/60 bg-rose-950/20 px-3 py-2 text-xs text-rose-300">{error}</p>}

      {session && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-emerald-900/60 bg-emerald-950/15 p-4">
          <div>
            <p className="text-sm font-bold text-emerald-200">
              {session.kind === 'operator' ? 'Operator token loaded' : `Signed in as ${session.username}`}
            </p>
            <p className="mt-1 text-[10px] uppercase tracking-wider text-slate-500">
              {session.role ?? 'operator'}{session.expiresAt ? ` / expires ${new Date(session.expiresAt).toLocaleString()}` : ' / current tab only'}
            </p>
          </div>
          <button type="button" onClick={() => void endSession()} disabled={isSubmitting} className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-bold text-slate-200 hover:border-rose-700 hover:text-rose-300 disabled:opacity-50">
            Log out
          </button>
        </div>
      )}

      {!session && status?.mode === 'operator_token' && (
        <form onSubmit={(event) => void submitOperatorToken(event)} className="mt-4 flex flex-col gap-3 rounded-2xl border border-slate-800 bg-black/20 p-4 sm:flex-row sm:items-end">
          <label className="flex-1 text-[10px] font-mono uppercase tracking-wider text-slate-500">
            Operator bearer token
            <input type="password" value={operatorToken} onChange={(event) => setOperatorToken(event.target.value)} autoComplete="off" required className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs normal-case text-slate-200 outline-none focus:border-emerald-700" />
          </label>
          <button type="submit" disabled={isSubmitting} className="rounded-lg bg-emerald-700 px-4 py-2 text-xs font-bold text-white hover:bg-emerald-600 disabled:opacity-50">
            {isSubmitting ? 'Verifying...' : 'Use token'}
          </button>
        </form>
      )}

      {(isBootstrap || (!session && status && status.mode !== 'operator_token')) && (
        <form onSubmit={(event) => void submitCredentials(event)} className="mt-4 grid grid-cols-1 gap-3 rounded-2xl border border-slate-800 bg-black/20 p-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <label className="text-[10px] font-mono uppercase tracking-wider text-slate-500">
            Username
            <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs normal-case text-slate-200 outline-none focus:border-emerald-700" />
          </label>
          <label className="text-[10px] font-mono uppercase tracking-wider text-slate-500">
            Password
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={isBootstrap ? 'new-password' : 'current-password'} required minLength={8} className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs normal-case text-slate-200 outline-none focus:border-emerald-700" />
          </label>
          <button type="submit" disabled={isSubmitting} className="rounded-lg bg-emerald-700 px-4 py-2 text-xs font-bold text-white hover:bg-emerald-600 disabled:opacity-50">
            {isSubmitting ? 'Working...' : isBootstrap ? 'Create admin' : 'Log in'}
          </button>
          {isBootstrap && (
            <p className="text-[10px] text-amber-300 sm:col-span-3">
              No users exist. The first account is created as an administrator using the active deployment authority.
            </p>
          )}
        </form>
      )}

      {!status && !error && (
        <p role="status" className="mt-4 text-xs text-slate-400">Loading access mode...</p>
      )}
    </section>
  );
};

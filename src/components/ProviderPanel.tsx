import React, { useEffect, useMemo, useState } from 'react';
import type { ProviderPublicStatus, ProviderRoutePlan } from '../providers/types';

type RoutingPreviewMode = 'automatic' | 'pinned';

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const previewRequestBody = {
  id: 'routing_preview',
  messages: [{ role: 'user', content: 'Routing preview only.' }],
  requiredCapabilities: ['text'],
  responseFormat: { type: 'text' },
};

export const ProviderPanel: React.FC = () => {
  const [statuses, setStatuses] = useState<ProviderPublicStatus[]>([]);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [previewMode, setPreviewMode] = useState<RoutingPreviewMode>('automatic');
  const [plan, setPlan] = useState<ProviderRoutePlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);

  useEffect(() => {
    let isDisposed = false;

    const loadStatuses = async () => {
      try {
        const response = await fetch('/api/providers/status');
        if (!response.ok) throw new Error(`Provider status request failed with status ${response.status}.`);
        const payload: unknown = await response.json();
        if (!isRecord(payload) || !Array.isArray(payload.providers)) {
          throw new Error('Provider status response is invalid.');
        }
        if (!isDisposed) {
          const next = payload.providers as ProviderPublicStatus[];
          // Keep the previous array identity when nothing changed so the
          // routing-preview effect does not refire on every poll.
          setStatuses((previous) => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
          setStatusError(null);
        }
      } catch (loadError) {
        if (!isDisposed) {
          setStatusError(loadError instanceof Error ? loadError.message : 'Provider status request failed.');
        }
      } finally {
        if (!isDisposed) setIsLoading(false);
      }
    };

    void loadStatuses();
    const interval = setInterval(() => {
      void loadStatuses();
    }, 5000);
    return () => {
      isDisposed = true;
      clearInterval(interval);
    };
  }, []);

  const firstConfigured = useMemo(
    () => statuses.find((status) => status.configured),
    [statuses],
  );

  useEffect(() => {
    if (!firstConfigured) return;
    let isDisposed = false;

    const loadPlan = async () => {
      const policy = previewMode === 'pinned'
        ? { mode: 'pinned', provider: firstConfigured.id }
        : { mode: 'automatic' };
      try {
        const response = await fetch('/api/providers/plan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ request: previewRequestBody, policy }),
        });
        if (!response.ok) throw new Error(`Routing preview failed with status ${response.status}.`);
        const payload: unknown = await response.json();
        if (!isRecord(payload) || !isRecord(payload.plan)) throw new Error('Routing preview response is invalid.');
        if (!isDisposed) {
          setPlan(payload.plan as unknown as ProviderRoutePlan);
          setPlanError(null);
        }
      } catch (previewError) {
        if (!isDisposed) {
          setPlan(null);
          setPlanError(previewError instanceof Error ? previewError.message : 'Routing preview failed.');
        }
      }
    };

    void loadPlan();
    return () => {
      isDisposed = true;
    };
  }, [firstConfigured, previewMode]);

  return (
    <section
      aria-labelledby="provider-panel-title"
      className="rounded-3xl border border-slate-800 bg-[#101114]/90 p-5 shadow-2xl"
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-[0.35em] text-cyan-400 font-mono">
            Phase 3
          </p>
          <h2 id="provider-panel-title" className="text-xl font-black text-white tracking-tight mt-1">
            Provider Intelligence
          </h2>
        </div>
        <span className="text-[10px] font-mono text-slate-400 border border-slate-700 rounded-full px-3 py-1">
          Server-side credentials only
        </span>
      </div>

      {isLoading && (
        <p role="status" className="mt-4 rounded-lg border border-cyan-900/50 bg-cyan-950/20 px-3 py-2 text-xs text-cyan-300">
          Loading provider status...
        </p>
      )}

      {statusError && (
        <p role="alert" className="mt-4 rounded-lg border border-rose-900/60 bg-rose-950/20 px-3 py-2 text-xs text-rose-300">
          Provider status unavailable: {statusError}
        </p>
      )}

      {!isLoading && !statusError && (
        <>
          <ul className="mt-4 space-y-2">
            {statuses.map((status) => (
              <li
                key={status.id}
                className="rounded-xl border border-slate-800 bg-[#0B0C0E]/60 p-3"
              >
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold uppercase tracking-wider text-slate-200">{status.id}</span>
                    {status.configured ? (
                      <span className="text-[9px] font-mono uppercase tracking-wider text-teal-300 border border-teal-800/60 bg-teal-950/30 rounded-full px-2 py-0.5">
                        Configured
                      </span>
                    ) : (
                      <span className="text-[9px] font-mono uppercase tracking-wider text-amber-300 border border-amber-800/60 bg-amber-950/20 rounded-full px-2 py-0.5">
                        Unavailable
                      </span>
                    )}
                  </div>
                  <span className="text-[10px] font-mono text-slate-400">{status.defaultModel}</span>
                </div>

                <div className="mt-2 flex items-center gap-1.5 flex-wrap">
                  {status.capabilities.map((capability) => (
                    <span
                      key={capability}
                      className="text-[9px] font-mono text-slate-400 border border-slate-800 rounded px-1.5 py-0.5"
                    >
                      {capability}
                    </span>
                  ))}
                </div>

                {status.unavailableReason && (
                  <p className="mt-2 text-[10px] text-amber-300/90 font-mono">{status.unavailableReason}</p>
                )}
              </li>
            ))}
          </ul>

          <div className="mt-4 rounded-xl border border-slate-800 bg-[#0B0C0E]/40 p-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="text-[10px] font-mono uppercase tracking-widest text-slate-500 font-bold">
                Routing Preview
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setPreviewMode('automatic')}
                  className={`text-[10px] font-mono px-2 py-1 rounded border transition cursor-pointer ${
                    previewMode === 'automatic'
                      ? 'border-cyan-700 text-cyan-300 bg-cyan-950/30'
                      : 'border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Automatic
                </button>
                <button
                  type="button"
                  onClick={() => setPreviewMode('pinned')}
                  className={`text-[10px] font-mono px-2 py-1 rounded border transition cursor-pointer ${
                    previewMode === 'pinned'
                      ? 'border-cyan-700 text-cyan-300 bg-cyan-950/30'
                      : 'border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Pinned
                </button>
              </div>
            </div>

            {plan && plan.selections.length > 0 && (
              <div className="mt-2">
                <p className="text-xs text-slate-200 font-mono">
                  {plan.selections[0].provider} / {plan.selections[0].model}
                </p>
                <p className="mt-1 text-[10px] text-slate-500">{plan.reason}</p>
              </div>
            )}

            {!plan && planError && (
              <p className="mt-2 text-[10px] text-amber-300/90 font-mono">Routing preview unavailable.</p>
            )}

            {!plan && !planError && !firstConfigured && (
              <p className="mt-2 text-[10px] text-slate-500 font-mono">
                No configured provider is available for a routing preview.
              </p>
            )}
          </div>
        </>
      )}
    </section>
  );
};

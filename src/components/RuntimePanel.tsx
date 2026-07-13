import React, { useEffect, useState } from 'react';
import type { RuntimeCapabilityReport, RuntimeFeatureStatus } from '../kernel/autonomy';

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const statusStyles: Record<string, string> = {
  available: 'text-teal-300 border-teal-800/60 bg-teal-950/30',
  configured: 'text-cyan-300 border-cyan-800/60 bg-cyan-950/30',
  unavailable: 'text-amber-300 border-amber-800/60 bg-amber-950/20',
  blocked: 'text-rose-300 border-rose-800/60 bg-rose-950/20',
};

const featureLabels: Record<string, string> = {
  verificationCommands: 'Verification commands',
  providerCalls: 'Provider calls',
  backgroundAutomation: 'Background automation',
  coreModel: 'Core model (MiniCPM5-1B)',
  secretVault: 'OS secret vault',
  accessControl: 'Access control',
  osSandbox: 'OS sandbox',
  releaseSigning: 'Release signing',
  desktopIpc: 'Desktop shell IPC',
};

export const RuntimePanel: React.FC = () => {
  const [report, setReport] = useState<RuntimeCapabilityReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let isDisposed = false;

    const loadReport = async () => {
      try {
        const response = await fetch('/api/kernel/runtime-report');
        if (!response.ok) throw new Error(`Runtime report request failed with status ${response.status}.`);
        const payload: unknown = await response.json();
        if (!isRecord(payload) || !isRecord(payload.features) || !isRecord(payload.workers)) {
          throw new Error('Runtime report response is invalid.');
        }
        if (!isDisposed) {
          setReport(payload as unknown as RuntimeCapabilityReport);
          setError(null);
        }
      } catch (loadError) {
        if (!isDisposed) {
          setError(loadError instanceof Error ? loadError.message : 'Runtime report request failed.');
        }
      } finally {
        if (!isDisposed) setIsLoading(false);
      }
    };

    void loadReport();
    const interval = setInterval(() => {
      void loadReport();
    }, 5000);
    return () => {
      isDisposed = true;
      clearInterval(interval);
    };
  }, []);

  return (
    <section
      aria-labelledby="runtime-panel-title"
      className="rounded-3xl border border-slate-800 bg-[#101114]/90 p-5 shadow-2xl"
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-[0.35em] text-cyan-400 font-mono">
            Runtime Status
          </p>
          <h2 id="runtime-panel-title" className="text-xl font-black text-white tracking-tight mt-1">
            Capability Report
          </h2>
        </div>
        <span className="text-[10px] font-mono text-slate-400 border border-slate-700 rounded-full px-3 py-1">
          Recorded state only
        </span>
      </div>

      {isLoading && (
        <p role="status" className="mt-4 rounded-lg border border-cyan-900/50 bg-cyan-950/20 px-3 py-2 text-xs text-cyan-300">
          Loading runtime report...
        </p>
      )}

      {error && (
        <p role="alert" className="mt-4 rounded-lg border border-rose-900/60 bg-rose-950/20 px-3 py-2 text-xs text-rose-300">
          Runtime report unavailable: {error}
        </p>
      )}

      {!isLoading && !error && report && (
        <>
          <ul className="mt-4 space-y-1.5">
            {Object.entries(report.features).map(([key, feature]: [string, RuntimeFeatureStatus]) => (
              <li
                key={key}
                className="flex items-start justify-between gap-3 rounded-xl border border-slate-800 bg-[#0B0C0E]/60 px-3 py-2"
              >
                <div>
                  <span className="text-xs font-semibold text-slate-200 block">
                    {featureLabels[key] ?? key}
                  </span>
                  <span className="text-[10px] text-slate-500 leading-snug block mt-0.5">
                    {feature.reason}
                  </span>
                </div>
                <span className={`text-[9px] font-mono uppercase tracking-wider border rounded-full px-2 py-0.5 shrink-0 mt-0.5 ${statusStyles[feature.status] ?? statusStyles.unavailable}`}>
                  {feature.status}
                </span>
              </li>
            ))}
          </ul>

          <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="rounded-xl border border-slate-800 bg-[#0B0C0E]/40 p-3">
              <span className="text-[10px] font-mono uppercase tracking-widest text-slate-500 font-bold block">
                Configured Providers
              </span>
              <p className="mt-1 text-xs text-slate-300 font-mono">
                {report.providers.configured.length > 0
                  ? report.providers.configured.join(', ')
                  : 'None configured'}
              </p>
            </div>
            <div className="rounded-xl border border-slate-800 bg-[#0B0C0E]/40 p-3">
              <span className="text-[10px] font-mono uppercase tracking-widest text-slate-500 font-bold block">
                Capability Workers
              </span>
              <p className="mt-1 text-xs text-slate-300 font-mono">
                {report.workers.available.length > 0
                  ? `Available: ${report.workers.available.join(', ')}`
                  : `Unavailable: ${report.workers.unavailable.length} worker families`}
              </p>
            </div>
          </div>
        </>
      )}
    </section>
  );
};

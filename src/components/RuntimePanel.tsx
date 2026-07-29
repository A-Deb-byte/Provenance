import React, { useEffect, useState } from 'react';
import type { RuntimeCapabilityReport, RuntimeFeatureStatus } from '../kernel/autonomy';
import { authenticatedFetch } from '../lib/auth';

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
  verifiedResearchReports: 'Verified research reports',
  backgroundAutomation: 'Background automation',
  coreModel: 'Core model (MiniCPM5-1B)',
  secretVault: 'OS secret vault',
  accessControl: 'Access control',
  osSandbox: 'OS sandbox',
  releaseSigning: 'Release signing',
  releaseDeployment: 'Supervised core releases',
  desktopIpc: 'Native host bridge',
  desktopAutomation: 'Windows UI Automation',
};

const nativeReadinessTitle = (feature: RuntimeFeatureStatus): string => {
  switch (feature.reasonCode) {
    case 'native_host_absent':
      return 'Native desktop host required';
    case 'native_bridge_health_failed':
      return 'Native bridge needs attention';
    case 'access_control_required':
      return 'Protected access setup required';
    case 'windows_uia_worker_missing':
      return 'Windows UI Automation worker unavailable';
    default:
      return 'Windows desktop automation is not ready';
  }
};

export const RuntimePanel: React.FC = () => {
  const [report, setReport] = useState<RuntimeCapabilityReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let isDisposed = false;
    let isInFlight = false;
    let activeController: AbortController | null = null;

    const loadReport = async () => {
      if (isDisposed || isInFlight) return;
      isInFlight = true;
      const controller = new AbortController();
      activeController = controller;
      const timeout = window.setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await authenticatedFetch('/api/kernel/runtime-report', {
          signal: controller.signal,
        });
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
        window.clearTimeout(timeout);
        if (activeController === controller) activeController = null;
        isInFlight = false;
        if (!isDisposed) setIsLoading(false);
      }
    };

    void loadReport();
    const interval = window.setInterval(() => {
      void loadReport();
    }, 5_000);
    return () => {
      isDisposed = true;
      window.clearInterval(interval);
      activeController?.abort();
    };
  }, []);

  const desktopBridge = report?.features.desktopIpc;
  const desktopAutomation = report?.features.desktopAutomation;
  const nativeReadiness = desktopAutomation
    && desktopAutomation.status !== 'available'
    && desktopAutomation.reasonCode !== 'stop_all_active'
    ? desktopAutomation
    : desktopBridge?.status !== 'available'
      ? desktopBridge
      : null;

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
          {nativeReadiness && (
            <aside
              aria-labelledby="native-readiness-title"
              className="mt-4 rounded-2xl border border-amber-800/60 bg-amber-950/20 p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-[10px] font-mono font-bold uppercase tracking-[0.24em] text-amber-400">
                    Native readiness
                  </p>
                  <h3 id="native-readiness-title" className="mt-1 text-sm font-bold text-amber-100">
                    {nativeReadinessTitle(nativeReadiness)}
                  </h3>
                </div>
                {nativeReadiness.reasonCode && (
                  <span className="rounded-full border border-amber-800 px-2 py-1 text-[9px] font-mono uppercase tracking-wider text-amber-300">
                    {nativeReadiness.reasonCode}
                  </span>
                )}
              </div>
              <p className="mt-2 text-xs leading-relaxed text-slate-300">
                {nativeReadiness.reasonCode === 'native_host_absent'
                  ? 'This browser dashboard cannot establish Windows UI Automation authority by itself.'
                  : nativeReadiness.reason}
              </p>
              <p className="mt-2 text-xs font-semibold leading-relaxed text-amber-200">
                Next step: {nativeReadiness.remediation
                  ?? 'Launch or restart the native desktop application and review its readiness report.'}
              </p>
            </aside>
          )}

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

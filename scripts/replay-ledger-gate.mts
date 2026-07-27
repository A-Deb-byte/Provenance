import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runDeterministicDesktopAcceptance } from '../src/diagnostics/desktopAcceptance';

interface ReplayReport {
  ok?: boolean;
  events?: number;
  decisionsReplayed?: number;
  outcomeOnlyDecisions?: number;
  divergences?: unknown[];
  warnings?: unknown[];
}

const runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'provenance-replay-gate-runtime-'));
const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'provenance-replay-gate-workspace-'));
const replayer = path.resolve(process.cwd(), 'scripts', 'replay-ledger.mjs');

try {
  const acceptance = await runDeterministicDesktopAcceptance({ runtimeDir, workspaceRoot });
  if (!acceptance.passed) {
    throw new Error('Deterministic desktop acceptance did not produce valid decision evidence.');
  }

  const replay = spawnSync(
    process.execPath,
    [replayer, '--json', '--strict', runtimeDir],
    { encoding: 'utf8', windowsHide: true },
  );
  if (replay.error) throw replay.error;

  let report: ReplayReport;
  try {
    report = JSON.parse(replay.stdout) as ReplayReport;
  } catch {
    throw new Error('The independent decision replayer did not return valid JSON.');
  }
  if (replay.status !== 0
      || report.ok !== true
      || !Number.isSafeInteger(report.events)
      || (report.events ?? 0) < 1
      || !Number.isSafeInteger(report.decisionsReplayed)
      || (report.decisionsReplayed ?? 0) < 1
      || report.outcomeOnlyDecisions !== 0
      || report.divergences?.length !== 0
      || report.warnings?.length !== 0) {
    throw new Error(
      `Independent decision replay rejected kernel evidence: ${replay.stderr.trim() || replay.stdout.trim()}`,
    );
  }

  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    status: 'verified',
    evidence: 'kernel-persisted-schema-2-decisions',
    events: report.events,
    decisionsReplayed: report.decisionsReplayed,
    outcomeOnlyDecisions: report.outcomeOnlyDecisions,
    acceptanceChecks: acceptance.checks.length,
  }, null, 2)}\n`);
} finally {
  await Promise.all([
    rm(runtimeDir, { recursive: true, force: true }),
    rm(workspaceRoot, { recursive: true, force: true }),
  ]);
}

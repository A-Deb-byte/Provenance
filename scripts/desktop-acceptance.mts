import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runDeterministicDesktopAcceptance } from '../src/diagnostics/desktopAcceptance';

const runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'provenance-desktop-acceptance-runtime-'));
const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'provenance-desktop-acceptance-workspace-'));

try {
  const report = await runDeterministicDesktopAcceptance({ runtimeDir, workspaceRoot });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
} finally {
  await Promise.all([
    rm(runtimeDir, { recursive: true, force: true }),
    rm(workspaceRoot, { recursive: true, force: true }),
  ]);
}

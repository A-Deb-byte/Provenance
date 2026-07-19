import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDeterministicDesktopAcceptance } from './desktopAcceptance';

let runtimeDir = '';
let workspaceRoot = '';

beforeEach(async () => {
  runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'desktop-acceptance-runtime-'));
  workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'desktop-acceptance-workspace-'));
});

afterEach(async () => {
  await Promise.all([
    rm(runtimeDir, { recursive: true, force: true }),
    rm(workspaceRoot, { recursive: true, force: true }),
  ]);
});

describe('deterministic desktop acceptance harness', () => {
  it('passes approval, discovery, inspection, click, type, and uncertain-outcome contracts', async () => {
    const report = await runDeterministicDesktopAcceptance({
      runtimeDir,
      workspaceRoot,
      generatedAt: '2026-07-17T00:00:00.000Z',
    });

    expect(report.passed).toBe(true);
    expect(report.liveUiAutomation).toBe(false);
    expect(report.checks).toHaveLength(11);
    expect(report.checks.every((check) => check.status === 'passed')).toBe(true);
    expect(report.metrics).toEqual({
      bridgeHealthCalls: 1,
      bridgeActionCalls: 5,
      approvalsConsumed: 3,
      uncertainRuns: 1,
    });
    expect(JSON.stringify(report)).not.toContain('PROVENANCE-DESKTOP-ACCEPTANCE-CANARY');
  });
});

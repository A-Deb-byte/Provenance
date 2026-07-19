import { Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { browserScope, browserWorker } from '../capabilities/testFixtures';
import { createKernelRouter } from './api';
import type { GoalContract } from './types';
import type { RuntimeCapabilityReport } from './autonomy';

let runtimeDir = '';
let workspaceRoot = '';
let server: Server | undefined;
let baseUrl = '';

const providerStatuses = [
  {
    id: 'gemini' as const,
    configured: true,
    credentialSource: 'server_env' as const,
    endpoint: 'https://generativelanguage.googleapis.com',
    defaultModel: 'gemini-3.5-flash',
    allowedModels: ['gemini-3.5-flash'],
    capabilities: ['text' as const],
    routingPriority: 10,
  },
];

const goalInput = () => ({
  objective: 'Verify the autonomy API fixture',
  successCriteria: ['Fixture passes'],
  constraints: ['Stay inside the workspace'],
  autonomyLevel: 'supervised' as const,
  workspaceRoot,
  verificationCommands: ['npm test'],
  budget: {
    maxOperations: 2,
    maxCommandRuntimeMs: 30000,
    maxApprovals: 1,
    maxProviderCalls: 0,
  },
});

const automationInput = (goalId: string) => ({
  name: 'Inspect example account page',
  goalId,
  workerId: browserWorker.id,
  riskLevel: 'L0',
  action: {
    type: 'browser.inspect',
    origin: 'https://example.com',
    url: 'https://example.com/account',
  },
  scope: browserScope,
  trigger: { type: 'manual' },
  approvalMode: 'per_run',
  budget: { maxRuns: 10, maxConsecutiveFailures: 3, maxRuntimeMsPerRun: 60000 },
});

const requestJson = async <T>(pathname: string, init?: RequestInit): Promise<{ response: Response; body: T }> => {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  return { response, body: await response.json() as T };
};

const postJson = <T>(pathname: string, body: unknown) => requestJson<T>(pathname, {
  method: 'POST',
  body: JSON.stringify(body),
});

const closeServer = async (): Promise<void> => {
  if (!server) return;
  const activeServer = server;
  server = undefined;
  await new Promise<void>((resolve, reject) => {
    activeServer.close((error) => error ? reject(error) : resolve());
  });
};

beforeEach(async () => {
  runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'kernel-autonomy-api-'));
  workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'kernel-autonomy-api-workspace-'));
  await writeFile(path.join(workspaceRoot, 'package.json'), JSON.stringify({
    private: true,
    scripts: { test: "node -e \"process.stdout.write('api-ok')\"" },
  }), 'utf8');

  const app = express();
  app.use(express.json());
  app.use('/api/kernel', createKernelRouter({
    runtimeDir,
    allowedWorkspaceRoot: workspaceRoot,
    providerStatuses,
    workerRegistrations: [browserWorker],
  }));
  server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    listening.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/kernel`;
});

afterEach(async () => {
  await closeServer();
  await Promise.all([
    rm(runtimeDir, { recursive: true, force: true }),
    rm(workspaceRoot, { recursive: true, force: true }),
  ]);
});

describe('autonomy API', () => {
  it('reports workers and evaluates automations through the capability policy', async () => {
    const workers = await requestJson<{ report: { available: string[] } }>('/workers');
    expect(workers.response.status).toBe(200);
    expect(workers.body.report.available).toContain(browserWorker.id);

    const goal = await postJson<GoalContract>('/goals', goalInput());
    const automation = await postJson<{ id: string }>('/automations', automationInput(goal.body.id));
    expect(automation.response.status).toBe(201);

    const evaluation = await postJson<{ decision: { kind: string } }>(
      `/automations/${automation.body.id}/evaluate`, {},
    );
    expect(evaluation.response.status).toBe(200);
    expect(evaluation.body.decision.kind).toBe('allow');
  });

  it('halts goal stepping under Stop All and resumes afterwards', async () => {
    const goal = await postJson<GoalContract>('/goals', goalInput());

    const stop = await postJson<{ controls: { stopAll: boolean } }>('/controls/stop-all', { reason: 'Halt.' });
    expect(stop.response.status).toBe(200);
    expect(stop.body.controls.stopAll).toBe(true);

    const blocked = await postJson<{ status: string; reason: string }>(`/goals/${goal.body.id}/step`, {});
    expect(blocked.body.status).toBe('blocked');
    expect(blocked.body.reason).toMatch(/Stop All/);

    const resume = await postJson<{ controls: { stopAll: boolean } }>('/controls/resume', { reason: 'Done.' });
    expect(resume.body.controls.stopAll).toBe(false);
  });

  it('rejects release proposals with forged evaluation references and blocks activation', async () => {
    const forged = await postJson<{ error: string }>('/release-proposals', {
      title: 'Forged release',
      targetVersion: '9.9.9',
      contentHash: 'b'.repeat(64),
      evaluationEventIds: ['event_forged'],
      rollbackInstructions: 'None.',
    });
    expect(forged.response.status).toBe(400);
    expect(forged.body.error).toMatch(/not in the kernel ledger/);

    await postJson<GoalContract>('/goals', goalInput());
    const events = await requestJson<{ events: Array<{ id: string }> }>('/events');
    const proposal = await postJson<{ id: string }>('/release-proposals', {
      title: 'Kernel 0.2 release',
      targetVersion: '0.2.0',
      contentHash: 'a'.repeat(64),
      evaluationEventIds: [events.body.events[0].id],
      rollbackInstructions: 'Reinstall the previous bundle.',
    });
    expect(proposal.response.status).toBe(201);

    const activation = await postJson<{ activationState: string; activationReason: string }>(
      `/release-proposals/${proposal.body.id}/activate`, { artifactId: 'artifact_release' },
    );
    expect(activation.body.activationState).toBe('blocked');
    expect(activation.body.activationReason).toMatch(/lifecycle is unavailable/i);
  });

  it('returns an honest runtime capability report', async () => {
    const { response, body } = await requestJson<RuntimeCapabilityReport>('/runtime-report');

    expect(response.status).toBe(200);
    expect(body.providers.configured).toEqual(['gemini']);
    expect(body.workers.available).toContain(browserWorker.id);
    expect(body.features.secretVault.status).toBe('unavailable');
    expect(body.features.osSandbox.status).toBe('unavailable');
    expect(body.features.verificationCommands).toMatchObject({
      status: 'available',
      reason: expect.stringContaining('trusted-host fallback'),
    });
    expect(body.features.releaseSigning.status).toBe('unavailable');
    expect(body.features.releaseDeployment.status).toBe('unavailable');
    expect(body.features.desktopIpc.status).toBe('unavailable');
  });

  it('exposes recovery as an explicit endpoint', async () => {
    const { response, body } = await postJson<{ recoveredTaskIds: string[] }>('/recovery', {});
    expect(response.status).toBe(200);
    expect(body.recoveredTaskIds).toEqual([]);
  });
});

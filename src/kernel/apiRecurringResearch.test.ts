import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKernelRouter } from './api';
import { createKernelService } from './kernel';

let server: Server | undefined;
let baseUrl = '';

const capability = {
  available: true,
  reason: 'Durable interval scheduling is available.',
  schedulerEnabled: true,
  tickIntervalMs: 15_000,
  minIntervalMinutes: 15,
  maxIntervalMinutes: 525_600,
  allowedOrigins: ['https://example.com'],
  maxSources: 5,
};

const schedule = {
  contract: {
    id: 'research_schedule_1',
    enabled: false,
    objective: 'Track the source.',
  },
};
const occurrence = {
  id: 'occurrence_1',
  scheduleId: 'research_schedule_1',
  status: 'blocked',
};

const makeKernel = () => ({
  recoverInterruptedTasks: vi.fn(async () => ({ recoveredTaskIds: [] })),
  getState: vi.fn(async () => ({ controls: { stopAll: false } })),
  getWorkers: vi.fn(() => ({ report: { available: [], configured: [], unavailable: [] } })),
  getRecurringResearchCapability: vi.fn(() => capability),
  listRecurringResearchSchedules: vi.fn(async () => [schedule]),
  createRecurringResearchSchedule: vi.fn(async () => schedule),
  getRecurringResearchSchedule: vi.fn(async () => ({ schedule, occurrences: [occurrence] })),
  setRecurringResearchScheduleEnabled: vi.fn(async () => ({
    ...schedule,
    contract: { ...schedule.contract, enabled: true },
  })),
  runRecurringResearchTick: vi.fn(async () => ({ outcome: 'idle' })),
  resumeRecurringResearchOccurrence: vi.fn(async () => ({ outcome: 'completed', occurrence })),
  skipRecurringResearchOccurrence: vi.fn(async () => ({ ...occurrence, status: 'skipped' })),
});

const requestJson = async <T>(pathname: string, init?: RequestInit) => {
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

const closeServer = async () => {
  if (!server) return;
  const active = server;
  server = undefined;
  await new Promise<void>((resolve, reject) => active.close((error) => error ? reject(error) : resolve()));
};

beforeEach(() => {
  baseUrl = '';
});

afterEach(async () => {
  await closeServer();
});

const startRouter = async (
  kernel: ReturnType<typeof makeKernel>,
  schedulerStatus?: () => {
    enabled: boolean;
    starting: boolean;
    running: boolean;
    tickInProgress: boolean;
    tickIntervalMs: number;
    lastOutcome?: 'idle' | 'started' | 'completed' | 'blocked' | 'failed' | 'stopped';
  },
) => {
  const app = express();
  app.use(express.json());
  app.use('/api/kernel', createKernelRouter({
    runtimeDir: 'unused',
    allowedWorkspaceRoot: process.cwd(),
    kernelService: kernel as unknown as ReturnType<typeof createKernelService>,
    recurringResearchSchedulerStatus: schedulerStatus,
    recoverOnStart: false,
  }));
  server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    listening.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/kernel`;
};

describe('recurring research API', () => {
  it('exposes schedule configuration, CRUD reads, and explicit enablement', async () => {
    const kernel = makeKernel();
    await startRouter(kernel);

    const config = await requestJson<typeof capability>('/recurring-research/config');
    const listed = await requestJson<{ schedules: unknown[] }>('/recurring-research');
    const created = await postJson<typeof schedule>('/recurring-research', {
      objective: 'Track the source.',
      sourceUrls: ['https://example.com/'],
      intervalMinutes: 60,
    });
    const detailed = await requestJson<{ occurrences: unknown[] }>('/recurring-research/research_schedule_1');
    const enabled = await postJson<typeof schedule>('/recurring-research/research_schedule_1/enabled', {
      enabled: true,
      reason: 'Approved recurring run.',
    });

    expect(config.response.status).toBe(200);
    expect(config.body.schedulerEnabled).toBe(true);
    expect(listed.body.schedules).toHaveLength(1);
    expect(created.response.status).toBe(201);
    expect(detailed.body.occurrences).toHaveLength(1);
    expect(enabled.body.contract.enabled).toBe(true);
    expect(kernel.setRecurringResearchScheduleEnabled)
      .toHaveBeenCalledWith('research_schedule_1', true, 'Approved recurring run.');
    expect(kernel.recoverInterruptedTasks).not.toHaveBeenCalled();
  });

  it('routes manual ticks and explicit occurrence resume/skip controls', async () => {
    const kernel = makeKernel();
    await startRouter(kernel);

    const tick = await postJson<{ outcome: string }>('/recurring-research/tick', {
      now: '2099-01-01T00:00:00.000Z',
    });
    const resumed = await postJson<{ outcome: string }>(
      '/recurring-research/research_schedule_1/occurrences/occurrence_1/resume',
      { reason: 'Reviewed and safe to retry.' },
    );
    const skipped = await postJson<{ status: string }>(
      '/recurring-research/research_schedule_1/occurrences/occurrence_1/skip',
      { reason: 'No longer needed.' },
    );

    expect(tick.response.status).toBe(200);
    expect(tick.body.outcome).toBe('idle');
    expect(resumed.body.outcome).toBe('completed');
    expect(skipped.body.status).toBe('skipped');
    expect(kernel.runRecurringResearchTick).toHaveBeenCalledWith();
    expect(kernel.resumeRecurringResearchOccurrence)
      .toHaveBeenCalledWith('research_schedule_1', 'occurrence_1', 'Reviewed and safe to retry.');
    expect(kernel.skipRecurringResearchOccurrence)
      .toHaveBeenCalledWith('research_schedule_1', 'occurrence_1', 'No longer needed.');
  });

  it('validates enable input and maps missing schedules and conflicts', async () => {
    const kernel = makeKernel();
    kernel.getRecurringResearchSchedule.mockRejectedValueOnce(new Error('Recurring research schedule not found.'));
    kernel.setRecurringResearchScheduleEnabled.mockRejectedValueOnce(new Error('Schedule is already enabled.'));
    await startRouter(kernel);

    const malformed = await postJson<{ error: string }>('/recurring-research/research_schedule_1/enabled', {
      enabled: 'yes',
      reason: 'Invalid.',
    });
    const missing = await requestJson<{ error: string }>('/recurring-research/missing');
    const conflict = await postJson<{ error: string }>('/recurring-research/research_schedule_1/enabled', {
      enabled: true,
      reason: 'Duplicate.',
    });

    expect(malformed.response.status).toBe(400);
    expect(missing.response.status).toBe(404);
    expect(conflict.response.status).toBe(409);
  });

  it('rejects non-string audit reasons and maps live recovery contention', async () => {
    const kernel = makeKernel();
    kernel.recoverInterruptedTasks.mockRejectedValueOnce(
      new Error('Recovery requires a quiescent kernel with no active external dispatch.'),
    );
    await startRouter(kernel);

    const enable = await postJson<{ error: string }>('/recurring-research/research_schedule_1/enabled', {
      enabled: true,
      reason: {},
    });
    const resume = await postJson<{ error: string }>(
      '/recurring-research/research_schedule_1/occurrences/occurrence_1/resume',
      { reason: ['not', 'an', 'audit', 'string'] },
    );
    const skip = await postJson<{ error: string }>(
      '/recurring-research/research_schedule_1/occurrences/occurrence_1/skip',
      { reason: 42 },
    );
    const recovery = await postJson<{ error: string }>('/recovery', {});

    expect(enable.response.status).toBe(400);
    expect(resume.response.status).toBe(400);
    expect(skip.response.status).toBe(400);
    expect(recovery.response.status).toBe(409);
    expect(kernel.setRecurringResearchScheduleEnabled).not.toHaveBeenCalled();
    expect(kernel.resumeRecurringResearchOccurrence).not.toHaveBeenCalled();
    expect(kernel.skipRecurringResearchOccurrence).not.toHaveBeenCalled();
  });

  it('projects the live scheduler clock into the runtime report', async () => {
    const kernel = makeKernel();
    await startRouter(kernel, () => ({
      enabled: true,
      starting: false,
      running: true,
      tickInProgress: false,
      tickIntervalMs: 15_000,
      lastOutcome: 'completed',
    }));

    const report = await requestJson<{ features: Record<string, { status: string; reason: string }> }>(
      '/runtime-report',
    );

    expect(report.response.status).toBe(200);
    expect(report.body.features.recurringResearchScheduler.status).toBe('available');
    expect(report.body.features.recurringResearchScheduler.reason).toContain('last outcome: completed');
  });
});

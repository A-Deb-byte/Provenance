import { Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApprovalRecord } from './approvals';
import { createKernelRouter } from './api';
import { createEmptyKernelState, writeKernelState } from './store';
import {
  ApprovalRecord,
  GoalContract,
  KernelEvent,
  KernelEvidence,
  KernelMemoryRecord,
  KernelTask,
  SkillActivation,
  SkillEvaluation,
  SkillManifest,
  SkillPackage,
} from './types';

let runtimeDir = '';
let workspaceRoot = '';
let outsideWorkspaceRoot = '';
let server: Server | undefined;
let baseUrl = '';

const goalInput = (root = workspaceRoot) => ({
  objective: 'Verify the API fixture',
  successCriteria: ['Fixture test passes'],
  constraints: ['Stay inside the configured workspace'],
  autonomyLevel: 'supervised' as const,
  workspaceRoot: root,
  verificationCommands: ['npm test'],
  budget: {
    maxOperations: 2,
    maxCommandRuntimeMs: 30000,
    maxApprovals: 1,
    maxProviderCalls: 0,
  },
});

const requestJson = async <T>(pathname: string, init?: RequestInit): Promise<{ response: Response; body: T }> => {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...init?.headers,
    },
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
  runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'kernel-api-runtime-'));
  workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'kernel-api-workspace-'));
  outsideWorkspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'kernel-api-outside-'));
  await writeFile(path.join(workspaceRoot, 'package.json'), JSON.stringify({
    private: true,
    scripts: { test: "node -e \"process.stdout.write('api-step-ok')\"" },
  }), 'utf8');

  const app = express();
  const routerOptions = { runtimeDir, allowedWorkspaceRoot: workspaceRoot };
  const router = createKernelRouter(routerOptions);
  routerOptions.allowedWorkspaceRoot = outsideWorkspaceRoot;
  app.use(express.json());
  app.use('/api/kernel', router);
  server = await new Promise<Server>((resolve, reject) => {
    const listeningServer = app.listen(0, '127.0.0.1', () => resolve(listeningServer));
    listeningServer.once('error', reject);
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}/api/kernel`;
});

afterEach(async () => {
  await closeServer();
  await Promise.all([
    rm(runtimeDir, { recursive: true, force: true }),
    rm(workspaceRoot, { recursive: true, force: true }),
    rm(outsideWorkspaceRoot, { recursive: true, force: true }),
  ]);
});

describe('kernel API', () => {
  it('creates, lists, and returns a goal with tasks and events', async () => {
    const created = await postJson<GoalContract>('/goals', goalInput());
    expect(created.response.status).toBe(201);
    expect(created.body.objective).toBe('Verify the API fixture');

    const listed = await requestJson<{ goals: GoalContract[] }>('/goals');
    expect(listed.response.status).toBe(200);
    expect(listed.body.goals.map((goal) => goal.id)).toEqual([created.body.id]);

    const detailed = await requestJson<{
      goal: GoalContract;
      tasks: KernelTask[];
      approvals: ApprovalRecord[];
      events: KernelEvent[];
    }>(`/goals/${created.body.id}`);
    expect(detailed.response.status).toBe(200);
    expect(detailed.body.tasks).toHaveLength(1);
    expect(detailed.body.approvals).toEqual([]);
    expect(detailed.body.events.map((event) => event.type)).toEqual(['goal.created', 'task.created']);

    const events = await requestJson<{ events: KernelEvent[] }>('/events');
    expect(events.response.status).toBe(200);
    expect(events.body.events).toHaveLength(2);
  });

  it('rejects malformed goal input', async () => {
    const result = await postJson<{ error: string }>('/goals', { objective: '' });
    expect(result.response.status).toBe(400);
    expect(result.body.error).toBe('Invalid goal contract input.');
  });

  it('confines goal workspaces to the immutable router root', async () => {
    const result = await postJson<{ error: string }>('/goals', goalInput(outsideWorkspaceRoot));
    expect(result.response.status).toBe(400);
    expect(result.body.error).toBe('Goal workspace is outside the configured kernel workspace.');
  });

  it('steps a goal and returns structured command evidence', async () => {
    const created = await postJson<GoalContract>('/goals', goalInput());
    const stepped = await postJson<{ status: string; evidence: KernelEvidence }>(`/goals/${created.body.id}/step`, {});

    expect(stepped.response.status).toBe(200);
    expect(stepped.body.status).toBe('passed');
    expect(stepped.body.evidence.exitCode).toBe(0);
    expect(stepped.body.evidence.stdout).toContain('api-step-ok');

    const detailed = await requestJson<{ goal: GoalContract }>(`/goals/${created.body.id}`);
    expect(detailed.body.goal.status).toBe('completed');
  });

  it('validates approval decisions and records an accepted decision', async () => {
    const invalidStatus = await postJson<{ error: string }>('/approvals/approval_1/decision', {
      status: 'maybe',
      reason: 'Looks fine',
    });
    expect(invalidStatus.response.status).toBe(400);
    expect(invalidStatus.body.error).toBe('Approval status must be approved or denied.');

    const missingReason = await postJson<{ error: string }>('/approvals/approval_1/decision', {
      status: 'approved',
      reason: '   ',
    });
    expect(missingReason.response.status).toBe(400);
    expect(missingReason.body.error).toBe('Approval decision reason is required.');

    const approval = createApprovalRecord({
      goalId: 'goal_1',
      taskId: 'task_1',
      requestedAction: 'Run a scoped action',
      riskLevel: 'L2',
      reason: 'Explicit user approval is required.',
    });
    await writeKernelState(runtimeDir, {
      ...createEmptyKernelState(),
      approvals: [approval],
    });

    const decided = await postJson<ApprovalRecord>(`/approvals/${approval.id}/decision`, {
      status: 'approved',
      reason: 'Approved for this fixture.',
    });
    expect(decided.response.status).toBe(200);
    expect(decided.body.status).toBe('approved');
    expect(decided.body.decisionReason).toBe('Approved for this fixture.');

    const approvals = await requestJson<{ approvals: ApprovalRecord[] }>('/approvals');
    expect(approvals.body.approvals[0].status).toBe('approved');
  });

  it('returns not found for unknown goal and approval ids', async () => {
    const goal = await requestJson<{ error: string }>('/goals/goal_missing');
    expect(goal.response.status).toBe(404);
    expect(goal.body.error).toBe('Goal not found.');

    const step = await postJson<{ error: string }>('/goals/goal_missing/step', {});
    expect(step.response.status).toBe(404);
    expect(step.body.error).toBe('Goal not found.');

    const approval = await postJson<{ error: string }>('/approvals/approval_missing/decision', {
      status: 'denied',
      reason: 'No matching request.',
    });
    expect(approval.response.status).toBe(404);
    expect(approval.body.error).toBe('Approval not found.');
  });

  it('creates, promotes, lists, and revokes kernel-owned memory', async () => {
    const candidateInput = {
      kind: 'semantic',
      content: 'Kernel memory is authoritative.',
      confidence: 0.95,
      scope: { kind: 'workspace', id: workspaceRoot },
      sensitivity: 'internal',
      retention: { kind: 'durable' },
      provenance: {
        sourceType: 'user',
        sourceId: 'api_user_input_1',
        actor: 'user',
        observedAt: '2026-07-12T00:00:00.000Z',
      },
      contradictionIds: [],
      supersedesIds: [],
    };

    const created = await postJson<KernelMemoryRecord>('/memories/candidates', candidateInput);
    expect(created.response.status).toBe(201);
    expect(created.body.status).toBe('candidate');

    const promoted = await postJson<KernelMemoryRecord>(`/memories/${created.body.id}/promote`, {
      reason: 'Confirmed by the user.',
    });
    expect(promoted.response.status).toBe(200);
    expect(promoted.body.status).toBe('promoted');

    const listed = await requestJson<{ memories: KernelMemoryRecord[] }>('/memories?status=promoted');
    expect(listed.body.memories.map((memory) => memory.id)).toEqual([created.body.id]);

    const revoked = await postJson<KernelMemoryRecord>(`/memories/${created.body.id}/revoke`, {
      reason: 'No longer applicable.',
    });
    expect(revoked.body.status).toBe('revoked');

    const invalid = await postJson<{ error: string }>('/memories/candidates', {
      ...candidateInput,
      sensitivity: 'secret',
    });
    expect(invalid.response.status).toBe(400);
  });

  it('runs the evidence-gated pure skill lifecycle through the API', async () => {
    const manifest: SkillManifest = {
      schemaVersion: 1,
      name: 'NormalizeApiInput',
      version: '1.0.0',
      description: 'Normalizes whitespace in repeated API input.',
      runtime: 'pure-transform-v1',
      inputType: 'text',
      outputType: 'text',
      permissionScopes: [],
      dependencyLock: 'builtin:pure-transform-v1',
      supportedPlatforms: ['any'],
      rateLimitPerMinute: 10,
      maxInputChars: 1024,
      maxSteps: 2,
      sideEffects: 'none',
      expectedArtifacts: ['normalized_text'],
      rollbackInstructions: 'Deactivate this version.',
      provenance: {
        sourceType: 'user',
        sourceId: 'api_skill_gap_1',
        actor: 'user',
        observedAt: '2026-07-12T00:00:00.000Z',
      },
    };
    const created = await postJson<SkillPackage>('/skills/synthesize', {
      manifest,
      trainingCases: [{ id: 'train_1', input: ' A ', expectedOutput: 'A', kind: 'train' }],
      replayCases: [{ id: 'replay_1', input: ' B ', expectedOutput: 'B', kind: 'replay' }],
    });
    expect(created.response.status).toBe(201);
    const evaluated = await postJson<SkillEvaluation>(`/skills/${created.body.id}/evaluate`, {});
    expect(evaluated.body.eligibleForCanary).toBe(true);
    const activated = await postJson<SkillActivation>(`/skills/${created.body.id}/canary`, { maxRuns: 1 });
    expect(activated.body.status).toBe('canary');
    const run = await postJson<{ output: string; passed: boolean }>(`/skills/${created.body.id}/canary-runs`, {
      input: ' C ',
      expectedOutput: 'C',
    });
    expect(run.body.passed).toBe(true);
    const promoted = await postJson<SkillPackage>(`/skills/${created.body.id}/promote`, {});
    expect(promoted.body.status).toBe('promoted');
    const invoked = await postJson<{ output: string }>(`/skills/${created.body.id}/invoke`, { input: ' D ' });
    expect(invoked.body.output).toBe('D');

    const skills = await requestJson<{ skills: SkillPackage[] }>('/skills');
    const evaluations = await requestJson<{ evaluations: SkillEvaluation[] }>('/skill-evaluations');
    expect(skills.body.skills).toHaveLength(1);
    expect(evaluations.body.evaluations).toHaveLength(1);
  });
});

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProviderRouter } from '../providers/router';
import { ProviderAdapter, ProviderEvent, ProviderRequest, ProviderResult } from '../providers/types';
import { createKernelService } from './kernel';

let runtimeDir = '';
let workspaceRoot = '';

const adapter: ProviderAdapter = {
  id: 'gemini',
  status: {
    id: 'gemini',
    configured: true,
    credentialSource: 'server_env',
    endpoint: 'fixed://gemini',
    defaultModel: 'gemini-test',
    allowedModels: ['gemini-test'],
    capabilities: ['text'],
    routingPriority: 1,
  },
  async generate(request): Promise<ProviderResult> {
    return {
      requestId: request.id,
      provider: 'gemini',
      model: 'gemini-test',
      text: 'private provider output',
      toolCalls: [],
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      finishReason: 'stop',
      latencyMs: 4,
    };
  },
  async *stream(): AsyncIterable<ProviderEvent> {
    yield { type: 'completed', finishReason: 'stop' };
  },
};

const request: ProviderRequest = {
  id: 'provider_request_1',
  messages: [{ role: 'user', content: 'private prompt' }],
  requiredCapabilities: ['text'],
  responseFormat: { type: 'text' },
};

beforeEach(async () => {
  runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'kernel-provider-'));
  workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'kernel-provider-workspace-'));
});

afterEach(async () => {
  await Promise.all([
    rm(runtimeDir, { recursive: true, force: true }),
    rm(workspaceRoot, { recursive: true, force: true }),
  ]);
});

describe('kernel provider integration', () => {
  it('reserves budget, routes a scoped provider call, and records redacted evidence', async () => {
    const kernel = createKernelService({
      runtimeDir,
      allowedWorkspaceRoot: workspaceRoot,
      providerRouter: new ProviderRouter([adapter]),
    });
    const goal = await kernel.createGoal({
      objective: 'Use one provider call',
      successCriteria: ['Provider response returned'],
      constraints: ['Do not expose prompts in the ledger'],
      autonomyLevel: 'supervised',
      workspaceRoot,
      verificationCommands: ['npm test'],
      budget: { maxOperations: 2, maxCommandRuntimeMs: 1000, maxApprovals: 1, maxProviderCalls: 1 },
    });

    const execution = await kernel.executeProviderRequest(goal.id, request, { mode: 'automatic' });
    expect(execution.results[0].text).toBe('private provider output');
    expect((await kernel.getState()).goals[0].usage.providerCalls).toBe(1);
    const ledger = JSON.stringify(await kernel.getEvents());
    expect(ledger).toContain('provider.call.completed');
    expect(ledger).not.toContain('private prompt');
    expect(ledger).not.toContain('private provider output');

    await expect(kernel.executeProviderRequest(goal.id, { ...request, id: 'provider_request_2' }, { mode: 'automatic' }))
      .rejects.toThrow('Provider call budget exceeded');
  });
});

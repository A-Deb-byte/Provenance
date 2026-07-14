import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { ProviderExecution, ProviderResult } from '../providers/types';
import { ProviderError } from '../providers/errors';
import { createApplicationAiRouter, type ApplicationAiExecutor } from './router';

const result = (structured: Record<string, unknown>): ProviderResult => ({
  requestId: 'request_1',
  provider: 'openrouter',
  model: 'openrouter/free',
  text: JSON.stringify(structured),
  structured,
  toolCalls: [],
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  finishReason: 'stop',
  latencyMs: 3,
});

describe('application AI router', () => {
  let server: ReturnType<express.Express['listen']>;
  let baseUrl = '';
  const execute = vi.fn<ApplicationAiExecutor['execute']>();

  beforeEach(async () => {
    execute.mockReset();
    const app = express();
    app.use(express.json());
    app.use('/api', createApplicationAiRouter({
      executor: { execute },
      routingPolicy: { mode: 'pinned', provider: 'openrouter', model: 'openrouter/free' },
    }));
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it('routes chat through the pinned provider and returns ledger provenance', async () => {
    const execution: ProviderExecution = {
      plan: { mode: 'pinned', selections: [{ provider: 'openrouter', model: 'openrouter/free' }], reason: 'Pinned.' },
      results: [result({ responseContent: 'Hello.', retrievedMemoryIds: ['mem_1'] })],
      errors: [], disagreement: false,
    };
    execute.mockResolvedValue({ execution, evidenceEventId: 'event_provider_1' });
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Hi' }], memories: [{ id: 'mem_1', content: 'Likes concise replies.' }] }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      responseContent: 'Hello.', servedBy: 'openrouter', model: 'openrouter/free', evidenceEventId: 'event_provider_1',
    });
    expect(execute).toHaveBeenCalledWith('chat', expect.objectContaining({
      responseFormat: expect.objectContaining({ type: 'json_object' }),
      requiredCapabilities: expect.arrayContaining(['json_object']),
    }), { mode: 'pinned', provider: 'openrouter', model: 'openrouter/free' });
  });

  it('returns extraction source evidence and refuses malformed provider output', async () => {
    const plan = { mode: 'pinned' as const, selections: [{ provider: 'openrouter' as const, model: 'openrouter/free' }], reason: 'Pinned.' };
    execute.mockResolvedValueOnce({
      execution: { plan, results: [result({
        newMemories: [{ content: 'Uses TypeScript.', category: 'technical', importance: 4, sourceSnippet: 'I use TypeScript' }],
        deletedMemoryIds: [], updatedBio: 'TypeScript developer.',
      })], errors: [], disagreement: false },
      evidenceEventId: 'event_extract_1',
    });
    const response = await fetch(`${baseUrl}/api/extract`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'I use TypeScript' }] }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ evidenceEventId: 'event_extract_1', newMemories: [{ importance: 4 }] });

    execute.mockResolvedValueOnce({
      execution: { plan, results: [result({ responseContent: 7, retrievedMemoryIds: [] })], errors: [], disagreement: false },
      evidenceEventId: 'event_bad',
    });
    const malformed = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Hi' }] }),
    });
    expect(malformed.status).toBe(502);
  });

  it('constrains skill drafts to the pure transform DSL', async () => {
    execute.mockResolvedValue({
      execution: {
        plan: { mode: 'pinned', selections: [{ provider: 'openrouter', model: 'openrouter/free' }], reason: 'Pinned.' },
        results: [result({
          deficitIdentified: 'Whitespace varies.', synthesizedSkillName: 'NormalizeWhitespace',
          synthesizedSkillDescription: 'Normalizes whitespace.', proposedOperations: ['collapse_whitespace'],
          deterministicCases: [{ input: 'a  b', expectedOutput: 'a b' }], draftNotes: ['Evaluate held-out cases.'],
        })], errors: [], disagreement: false,
      },
      evidenceEventId: 'event_skill_1',
    });
    const response = await fetch(`${baseUrl}/api/self-improve`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskTitle: 'Normalize whitespace' }),
    });
    expect(response.status).toBe(200);
    const payload = await response.json() as Record<string, unknown>;
    expect(payload).not.toHaveProperty('codeSnippet');
    expect(payload).toMatchObject({ proposedOperations: ['collapse_whitespace'] });
  });

  it('retries a transient provider contract failure through the executor', async () => {
    const execution: ProviderExecution = {
      plan: { mode: 'pinned', selections: [{ provider: 'openrouter', model: 'openrouter/free' }], reason: 'Pinned.' },
      results: [result({ responseContent: 'Recovered.', retrievedMemoryIds: [] })],
      errors: [], disagreement: false,
    };
    execute
      .mockRejectedValueOnce(new ProviderError('unavailable', 'Free router temporarily unavailable.', { retryable: true }))
      .mockResolvedValueOnce({ execution, evidenceEventId: 'event_retry_success' });

    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Hi' }] }),
    });

    expect(response.status).toBe(200);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1][1].metadata).toMatchObject({ attempt: '2' });
  });
});

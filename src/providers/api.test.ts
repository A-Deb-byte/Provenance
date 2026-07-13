import { Server } from 'node:http';
import { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderApi, ProviderApiRuntime } from './api';
import { ProviderRoutePlan } from './types';

let server: Server | undefined;
let baseUrl = '';
let runtime: ProviderApiRuntime;

const closeServer = async () => {
  if (!server) return;
  const activeServer = server;
  server = undefined;
  await new Promise<void>((resolve, reject) => activeServer.close((error) => error ? reject(error) : resolve()));
};

beforeEach(async () => {
  const plan: ProviderRoutePlan = {
    mode: 'automatic',
    selections: [{ provider: 'gemini', model: 'gemini-3.5-flash' }],
    reason: 'Deterministic preview.',
  };
  runtime = {
    statuses: [{
      id: 'gemini',
      configured: true,
      credentialSource: 'server_env',
      endpoint: 'https://generativelanguage.googleapis.com',
      defaultModel: 'gemini-3.5-flash',
      allowedModels: ['gemini-3.5-flash'],
      capabilities: ['text', 'streaming', 'json_schema'],
      routingPriority: 10,
    }],
    plan: vi.fn(() => plan),
  };
  const app = express();
  app.use(express.json());
  app.use('/api/providers', createProviderApi(runtime));
  server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    listening.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/providers`;
});

afterEach(closeServer);

const requestJson = async (path: string, init?: RequestInit) => {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  return { response, body: await response.json() as Record<string, unknown> };
};

describe('provider API', () => {
  it('returns sanitized provider status', async () => {
    const { response, body } = await requestJson('/status');

    expect(response.status).toBe(200);
    expect(body.providers).toEqual(runtime.statuses);
    expect(JSON.stringify(body)).not.toMatch(/apiKey|secret|credentialValue/i);
  });

  it('returns a routing plan without invoking a provider', async () => {
    const payload = {
      request: {
        id: 'preview',
        messages: [{ role: 'user', content: 'Preview only.' }],
        requiredCapabilities: ['text'],
        responseFormat: { type: 'text' },
      },
      policy: { mode: 'automatic' },
    };
    const { response, body } = await requestJson('/plan', { method: 'POST', body: JSON.stringify(payload) });

    expect(response.status).toBe(200);
    expect(body.plan).toMatchObject({ mode: 'automatic' });
    expect(runtime.plan).toHaveBeenCalledOnce();
  });

  it('rejects secret, endpoint, and malformed routing input', async () => {
    const forbidden = await requestJson('/plan', {
      method: 'POST',
      body: JSON.stringify({ request: { apiKey: 'browser-secret' }, policy: { mode: 'automatic' } }),
    });
    const endpoint = await requestJson('/plan', {
      method: 'POST',
      body: JSON.stringify({ request: { endpointUrl: 'https://attacker.invalid' }, policy: { mode: 'automatic' } }),
    });

    expect(forbidden.response.status).toBe(400);
    expect(endpoint.response.status).toBe(400);
    expect(runtime.plan).not.toHaveBeenCalled();
  });

  it('does not expose an unbudgeted invoke endpoint', async () => {
    const response = await fetch(`${baseUrl}/invoke`, { method: 'POST' });
    expect(response.status).toBe(404);
  });
});

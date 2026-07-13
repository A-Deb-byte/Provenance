import { Server } from 'node:http';
import { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { createOperatorTokenGuard, operatorTokenStatus } from './operatorToken';

let server: Server | undefined;

const startApp = async (token: string | undefined): Promise<string> => {
  const app = express();
  app.use(express.json());
  app.use(createOperatorTokenGuard(token));
  app.get('/thing', (_req, res) => res.json({ ok: true }));
  app.post('/thing', (_req, res) => res.json({ mutated: true }));
  server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    listening.once('error', reject);
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

afterEach(async () => {
  if (!server) return;
  const active = server;
  server = undefined;
  await new Promise<void>((resolve, reject) => active.close((error) => error ? reject(error) : resolve()));
});

describe('operator token guard', () => {
  it('allows everything when no token is configured', async () => {
    const base = await startApp(undefined);
    expect((await fetch(`${base}/thing`, { method: 'POST' })).status).toBe(200);
  });

  it('allows reads but requires a matching token for mutations', async () => {
    const base = await startApp('correct-horse-battery-staple');

    expect((await fetch(`${base}/thing`)).status).toBe(200);
    expect((await fetch(`${base}/thing`, { method: 'POST' })).status).toBe(401);
    expect((await fetch(`${base}/thing`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-token' },
    })).status).toBe(401);
    expect((await fetch(`${base}/thing`, {
      method: 'POST',
      headers: { authorization: 'Bearer correct-horse-battery-staple' },
    })).status).toBe(200);
  });

  it('reports status honestly', () => {
    expect(operatorTokenStatus(undefined).status).toBe('unavailable');
    expect(operatorTokenStatus('x').status).toBe('available');
  });
});

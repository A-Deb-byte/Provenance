import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendKernelEvent, readKernelEvents } from './ledger';

let tempDir = '';

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'kernel-ledger-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('kernel ledger', () => {
  it('appends hash-chained events', async () => {
    const first = await appendKernelEvent(tempDir, null, {
      actor: 'kernel',
      type: 'goal.created',
      entityId: 'goal_1',
      entityType: 'goal',
      payload: { objective: 'verify' },
    });

    const second = await appendKernelEvent(tempDir, first.hash, {
      actor: 'worker',
      type: 'task.passed',
      entityId: 'task_1',
      entityType: 'task',
      payload: { exitCode: 0 },
    });

    expect(second.previousHash).toBe(first.hash);
    expect(second.hash).not.toBe(first.hash);
    expect(await readKernelEvents(tempDir)).toHaveLength(2);
  });

  it('stores one JSON event per line', async () => {
    const event = await appendKernelEvent(tempDir, null, {
      actor: 'kernel',
      type: 'goal.created',
      entityId: 'goal_1',
      entityType: 'goal',
      payload: {},
    });

    const raw = await readFile(path.join(tempDir, 'events.jsonl'), 'utf8');
    expect(JSON.parse(raw.trim()).hash).toBe(event.hash);
  });

  it('rejects a stale append head and detects tampered records', async () => {
    await appendKernelEvent(tempDir, null, {
      actor: 'kernel',
      type: 'goal.created',
      entityId: 'goal_1',
      entityType: 'goal',
      payload: { objective: 'verify' },
    });

    await expect(appendKernelEvent(tempDir, null, {
      actor: 'kernel',
      type: 'goal.created',
      entityId: 'goal_2',
      entityType: 'goal',
      payload: {},
    })).rejects.toThrow('head');

    const file = path.join(tempDir, 'events.jsonl');
    const [eventLine] = (await readFile(file, 'utf8')).trim().split('\n');
    const event = JSON.parse(eventLine) as { payload: Record<string, unknown> };
    event.payload = { objective: 'tampered' };
    await writeFile(file, `${JSON.stringify(event)}\n`, 'utf8');
    await expect(readKernelEvents(tempDir)).rejects.toThrow('integrity');
  });

  it('reports truncated JSONL as an integrity failure', async () => {
    await writeFile(path.join(tempDir, 'events.jsonl'), '{"id":"event_partial"', 'utf8');
    await expect(readKernelEvents(tempDir)).rejects.toThrow('integrity');
  });
});

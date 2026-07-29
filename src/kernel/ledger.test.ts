import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendKernelEvent, readKernelEvents, readKernelEventTail } from './ledger';

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

  it('reads a bounded tail authenticated by the expected ledger head', async () => {
    let head: string | null = null;
    for (let index = 0; index < 6; index += 1) {
      const appended = await appendKernelEvent(tempDir, head, {
        actor: 'kernel',
        type: `fixture.${index}`,
        entityId: `fixture_${index}`,
        entityType: 'system',
        payload: { index },
      });
      head = appended.hash;
    }

    const tail = await readKernelEventTail(tempDir, head, 3);
    expect(tail.truncated).toBe(true);
    expect(tail.events.map((event) => event.type)).toEqual(['fixture.3', 'fixture.4', 'fixture.5']);
    await expect(readKernelEventTail(tempDir, 'f'.repeat(64), 3)).rejects.toThrow(/snapshot head/);
  });

  it('fills short positional reads without skipping ledger bytes', async () => {
    let head: string | null = null;
    for (let index = 0; index < 8; index += 1) {
      const appended = await appendKernelEvent(tempDir, head, {
        actor: 'kernel',
        type: `short-read.${index}`,
        entityId: `fixture_${index}`,
        entityType: 'system',
        payload: { text: `${index}:${'x'.repeat(12_000)}` },
      });
      head = appended.hash;
    }

    const probe = await open(path.join(tempDir, 'events.jsonl'), 'r');
    const prototype = Object.getPrototypeOf(probe) as { read: typeof probe.read };
    const originalRead = prototype.read;
    await probe.close();
    const readSpy = vi.spyOn(prototype, 'read').mockImplementation((async function (
      this: typeof probe,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
    ) {
      return originalRead.call(this, buffer, offset, Math.min(length, 257), position);
    }) as typeof originalRead);

    try {
      const tail = await readKernelEventTail(tempDir, head, 3);
      expect(tail.events.map((event) => event.type)).toEqual([
        'short-read.5',
        'short-read.6',
        'short-read.7',
      ]);
      expect(tail.truncated).toBe(true);
    } finally {
      readSpy.mockRestore();
    }
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

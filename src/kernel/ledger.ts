import crypto from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createKernelId } from './ids';
import { KernelActor, KernelEvent } from './types';

export type KernelEventInput = {
  actor: KernelActor;
  type: string;
  entityId: string;
  entityType: KernelEvent['entityType'];
  payload: Record<string, unknown>;
};

const ledgerPath = (runtimeDir: string) => path.join(runtimeDir, 'events.jsonl');
const appendQueues = new Map<string, Promise<void>>();

const withAppendLock = <T>(runtimeDir: string, work: () => Promise<T>): Promise<T> => {
  const key = path.resolve(runtimeDir);
  const previous = appendQueues.get(key) ?? Promise.resolve();
  const result = previous.then(work, work);
  const settled = result.then(() => undefined, () => undefined);
  appendQueues.set(key, settled);
  void settled.then(() => {
    if (appendQueues.get(key) === settled) appendQueues.delete(key);
  });
  return result;
};

export const hashKernelEvent = (event: Omit<KernelEvent, 'hash'>): string => {
  const canonical = JSON.stringify(event);
  return crypto.createHash('sha256').update(canonical).digest('hex');
};

export const appendKernelEvent = async (
  runtimeDir: string,
  previousHash: string | null,
  input: KernelEventInput,
): Promise<KernelEvent> => withAppendLock(runtimeDir, async () => {
  const events = await readKernelEvents(runtimeDir);
  const currentHead = events.at(-1)?.hash ?? null;
  if (previousHash !== currentHead) {
    throw new Error('Kernel ledger head mismatch; refusing to fork the event chain.');
  }

  await mkdir(runtimeDir, { recursive: true });
  const eventWithoutHash: Omit<KernelEvent, 'hash'> = {
    id: createKernelId('event'),
    timestamp: new Date().toISOString(),
    previousHash,
    ...input,
  };
  const event: KernelEvent = {
    ...eventWithoutHash,
    hash: hashKernelEvent(eventWithoutHash),
  };
  await appendFile(ledgerPath(runtimeDir), `${JSON.stringify(event)}\n`, 'utf8');
  return event;
});

export const readKernelEvents = async (runtimeDir: string): Promise<KernelEvent[]> => {
  try {
    const raw = await readFile(ledgerPath(runtimeDir), 'utf8');
    const events = raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as KernelEvent);
    let expectedPreviousHash: string | null = null;
    for (const event of events) {
      const { hash, ...eventWithoutHash } = event;
      if (
        typeof hash !== 'string' ||
        event.previousHash !== expectedPreviousHash ||
        hashKernelEvent(eventWithoutHash) !== hash
      ) {
        throw new Error(`Kernel ledger integrity check failed at event ${event.id || 'unknown'}.`);
      }
      expectedPreviousHash = hash;
    }
    return events;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    if (error instanceof SyntaxError) {
      throw new Error('Kernel ledger integrity check failed because an event record is truncated or invalid.');
    }
    throw error;
  }
};

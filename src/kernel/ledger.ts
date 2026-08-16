import crypto from 'node:crypto';
import { appendFile, mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { stableJson } from '../capabilities/hash';
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
const EVENT_TAIL_CHUNK_BYTES = 64 * 1024;
const EVENT_TAIL_MAX_BYTES = 4 * 1024 * 1024;

const readExactRange = async (
  handle: Awaited<ReturnType<typeof open>>,
  position: number,
  length: number,
): Promise<Buffer> => {
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const read = await handle.read(buffer, offset, length - offset, position + offset);
    if (read.bytesRead <= 0) {
      throw new Error('Kernel ledger changed or was truncated during the bounded tail read.');
    }
    offset += read.bytesRead;
  }
  return buffer;
};

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

/**
 * Canonical event hashing.
 *
 * `JSON.stringify` emits keys in insertion order, so the hash it produces is a
 * function of how the object happened to be built rather than of its value.
 * That is reproducible inside one V8 process and nowhere else: a verifier in
 * another language -- the stated purpose of `scripts/verify-ledger.mjs` -- would
 * serialize with sorted keys and fail every event.
 *
 * `stableJson` sorts keys, so the hash depends only on the value.
 *
 * The round-trip through JSON is deliberate, not redundant. The writer holds
 * live objects while every verifier only ever sees `JSON.parse` output, so the
 * two must be made to hash the same value domain. Without it a `Date` in a
 * payload would hash as `{}` here (no own enumerable keys) and as an ISO string
 * on read, and a non-finite number would be written as `null` but throw here.
 * Normalizing first makes the hash a function of the persisted bytes' value,
 * which is exactly what an independent verifier can reproduce.
 */
export const hashKernelEvent = (event: Omit<KernelEvent, 'hash'>): string => {
  const canonical = stableJson(JSON.parse(JSON.stringify(event)) as unknown);
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
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

export interface KernelEventTail {
  events: KernelEvent[];
  truncated: boolean;
}

/**
 * Reads a bounded authenticated suffix. The trusted snapshot head commits to
 * the complete predecessor chain, so the tail can be checked without loading
 * the complete ledger a second time.
 */
export const readKernelEventTail = async (
  runtimeDir: string,
  expectedHead: string | null,
  requestedLimit = 200,
): Promise<KernelEventTail> => {
  const limit = Number.isSafeInteger(requestedLimit)
    ? Math.max(1, Math.min(requestedLimit, 500))
    : 200;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(ledgerPath(runtimeDir), 'r');
    const stats = await handle.stat();
    let position = stats.size;
    let bytesReadTotal = 0;
    let newlineCount = 0;
    const chunks: Buffer[] = [];

    while (position > 0 && newlineCount <= limit && bytesReadTotal < EVENT_TAIL_MAX_BYTES) {
      const readSize = Math.min(
        EVENT_TAIL_CHUNK_BYTES,
        position,
        EVENT_TAIL_MAX_BYTES - bytesReadTotal,
      );
      const readPosition = position - readSize;
      const chunk = await readExactRange(handle, readPosition, readSize);
      position = readPosition;
      chunks.unshift(chunk);
      bytesReadTotal += readSize;
      for (const byte of chunk) {
        if (byte === 0x0a) newlineCount += 1;
      }
    }

    let raw = Buffer.concat(chunks).toString('utf8');
    if (position > 0) {
      const firstCompleteLine = raw.indexOf('\n');
      if (firstCompleteLine < 0) {
        throw new Error('Kernel ledger tail exceeds the bounded event record size.');
      }
      raw = raw.slice(firstCompleteLine + 1);
    }
    const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
    const selected = lines.slice(-limit);
    const events = selected.map((line) => JSON.parse(line) as KernelEvent);
    if ((events.at(-1)?.hash ?? null) !== expectedHead) {
      throw new Error('Kernel ledger tail does not match the authenticated snapshot head.');
    }
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      const { hash, ...eventWithoutHash } = event;
      const expectedPrevious = index > 0 ? events[index - 1].hash : undefined;
      if (
        typeof hash !== 'string' ||
        hashKernelEvent(eventWithoutHash) !== hash ||
        (expectedPrevious !== undefined && event.previousHash !== expectedPrevious)
      ) {
        throw new Error(`Kernel ledger tail integrity check failed at event ${event.id || 'unknown'}.`);
      }
    }
    return {
      events,
      truncated: position > 0 || lines.length > limit,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && expectedHead === null) {
      return { events: [], truncated: false };
    }
    if (error instanceof SyntaxError) {
      throw new Error('Kernel ledger tail contains a truncated or invalid event record.');
    }
    throw error;
  } finally {
    await handle?.close();
  }
};

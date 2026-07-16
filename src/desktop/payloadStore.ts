import { hashArtifactContent, type ArtifactMetadata, type ResolvedArtifact } from '../kernel/artifacts/artifactStore';
import { createKernelId } from '../kernel/ids';

const DEFAULT_MAX_ENTRIES = 32;
const DEFAULT_MAX_PAYLOAD_CHARS = 4_096;
const DEFAULT_MAX_PAYLOAD_BYTES = 16 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024;
const DEFAULT_TTL_MS = 10 * 60 * 1_000;

const MAX_CONFIGURED_ENTRIES = 1_024;
const MAX_CONFIGURED_PAYLOAD_CHARS = 64 * 1024;
const MAX_CONFIGURED_PAYLOAD_BYTES = 256 * 1024;
const MAX_CONFIGURED_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_CONFIGURED_TTL_MS = 60 * 60 * 1_000;

interface DesktopPayloadRecord extends ArtifactMetadata {
  readonly content: string;
  readonly expiresAtMs: number;
}

export interface DesktopPayloadStoreOptions {
  readonly maxEntries?: number;
  readonly maxPayloadChars?: number;
  readonly maxPayloadBytes?: number;
  readonly maxTotalBytes?: number;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

export interface DesktopPayloadStore {
  stage(content: string): Promise<ArtifactMetadata>;
  consume(id: string): Promise<ResolvedArtifact | undefined>;
  clear(): void;
  size(): number;
}

export type DesktopPayloadConsumer = DesktopPayloadStore['consume'];

const boundedInteger = (value: number, label: string, maximum: number): number => {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be an integer between 1 and ${maximum}.`);
  }
  return value;
};

/**
 * Process-local staging for desktop typing. Entries are never persisted and
 * are removed before their content is returned to the one authorized worker.
 */
export const createMemoryDesktopPayloadStore = (
  options: DesktopPayloadStoreOptions = {},
): DesktopPayloadStore => {
  const maxEntries = boundedInteger(
    options.maxEntries ?? DEFAULT_MAX_ENTRIES,
    'Desktop payload entry limit',
    MAX_CONFIGURED_ENTRIES,
  );
  const maxPayloadChars = boundedInteger(
    options.maxPayloadChars ?? DEFAULT_MAX_PAYLOAD_CHARS,
    'Desktop payload character limit',
    MAX_CONFIGURED_PAYLOAD_CHARS,
  );
  const maxPayloadBytes = boundedInteger(
    options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
    'Desktop payload byte limit',
    MAX_CONFIGURED_PAYLOAD_BYTES,
  );
  const maxTotalBytes = boundedInteger(
    options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
    'Desktop payload total byte limit',
    MAX_CONFIGURED_TOTAL_BYTES,
  );
  const ttlMs = boundedInteger(
    options.ttlMs ?? DEFAULT_TTL_MS,
    'Desktop payload lifetime',
    MAX_CONFIGURED_TTL_MS,
  );
  if (maxTotalBytes < maxPayloadBytes) {
    throw new Error('Desktop payload total byte limit must cover one maximum-sized payload.');
  }

  const now = options.now ?? Date.now;
  const entries = new Map<string, DesktopPayloadRecord>();
  let totalBytes = 0;

  const remove = (id: string): DesktopPayloadRecord | undefined => {
    const record = entries.get(id);
    if (!record) return undefined;
    entries.delete(id);
    totalBytes -= record.byteLength;
    return record;
  };

  const pruneExpired = (timestamp: number): void => {
    for (const [id, record] of entries) {
      if (record.expiresAtMs <= timestamp) remove(id);
    }
  };

  return {
    stage: async (content) => {
      if (typeof content !== 'string' || content.length === 0 || content.length > maxPayloadChars) {
        throw new Error(`Desktop typing payload must contain 1-${maxPayloadChars} characters.`);
      }
      const byteLength = Buffer.byteLength(content, 'utf8');
      if (byteLength > maxPayloadBytes) {
        throw new Error(`Desktop typing payload must not exceed ${maxPayloadBytes} UTF-8 bytes.`);
      }

      const timestamp = now();
      pruneExpired(timestamp);
      if (entries.size >= maxEntries || totalBytes + byteLength > maxTotalBytes) {
        throw new Error('Desktop typing payload memory is at capacity; consume or wait for existing entries to expire.');
      }

      const record: DesktopPayloadRecord = {
        id: createKernelId('artifact'),
        content,
        contentHash: hashArtifactContent(content),
        byteLength,
        createdAt: new Date(timestamp).toISOString(),
        expiresAtMs: timestamp + ttlMs,
      };
      entries.set(record.id, record);
      totalBytes += byteLength;
      const { content: _content, expiresAtMs: _expiresAtMs, ...metadata } = record;
      return metadata;
    },

    consume: async (id) => {
      const timestamp = now();
      pruneExpired(timestamp);
      if (!/^artifact_[A-Za-z0-9-]+$/u.test(id)) return undefined;

      // Destructive read: bridge errors, cancellation, and hash mismatches
      // after this point cannot replay the typed value.
      const record = remove(id);
      if (!record || record.expiresAtMs <= timestamp) return undefined;
      if (hashArtifactContent(record.content) !== record.contentHash) return undefined;
      return { content: record.content, contentHash: record.contentHash };
    },

    clear: () => {
      entries.clear();
      totalBytes = 0;
    },

    size: () => {
      pruneExpired(now());
      return entries.size;
    },
  };
};

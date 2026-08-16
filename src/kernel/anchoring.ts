import crypto from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stableJson } from '../capabilities/hash';

/**
 * External anchoring for the event chain.
 *
 * Hash chaining proves *internal consistency*: given the chain, you can tell
 * whether it was edited in place. It cannot detect a chain rewritten from
 * genesis, because the rewrite is internally consistent too. Anchoring closes
 * that by publishing the head hash somewhere the operator does not control, so
 * a later chain that disagrees with a published anchor is provably a rewrite.
 *
 * What this module does: define the anchor record, keep an append-only local
 * log of anchors, and verify a chain against them. What it does NOT do is
 * provide the external witness -- that requires a transparency log, a
 * notary, or a counterparty, and is supplied as a `AnchorPublisher`.
 *
 * The distinction matters and is stated plainly rather than blurred: a
 * deployment with only the local log has *not* achieved external anchoring. It
 * has a tamper-evident record of what its own head hashes were, which detects
 * a rewrite only if the log itself survives.
 */

export const ANCHOR_SCHEMA_VERSION = 1;

export interface AnchorRecord {
  schemaVersion: number;
  /** Ledger head at the moment of anchoring. */
  headHash: string;
  /** Number of events the head covers, so a truncation is visible. */
  eventCount: number;
  createdAt: string;
  /** Identifier returned by the external witness. Absent for local-only. */
  externalRef?: string;
  /** Which publisher produced `externalRef`; `local` means no external witness. */
  publisher: string;
  /** Binds the fields above so an anchor cannot be edited after publication. */
  recordHash: string;
}

export interface AnchorPublisher {
  readonly name: string;
  /** Publishes a head hash externally, returning the witness's reference. */
  publish(headHash: string, eventCount: number): Promise<string>;
}

export type AnchorVerdict =
  | { ok: true; reason: string; checked: number }
  | { ok: false; reason: string; checked: number; divergedAt?: AnchorRecord };

const anchorFile = (runtimeDir: string) => path.join(runtimeDir, 'anchors.jsonl');

export const hashAnchorRecord = (record: Omit<AnchorRecord, 'recordHash'>): string =>
  crypto.createHash('sha256').update(stableJson(record), 'utf8').digest('hex');

export const buildAnchorRecord = (input: {
  headHash: string;
  eventCount: number;
  createdAt: string;
  publisher: string;
  externalRef?: string;
}): AnchorRecord => {
  const base = {
    schemaVersion: ANCHOR_SCHEMA_VERSION,
    headHash: input.headHash,
    eventCount: input.eventCount,
    createdAt: input.createdAt,
    publisher: input.publisher,
    externalRef: input.externalRef,
  };
  return { ...base, recordHash: hashAnchorRecord(base) };
};

const isAnchorRecord = (value: unknown): value is AnchorRecord => {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<AnchorRecord>;
  return record.schemaVersion === ANCHOR_SCHEMA_VERSION &&
    typeof record.headHash === 'string' && /^[a-f0-9]{64}$/.test(record.headHash) &&
    Number.isSafeInteger(record.eventCount) && (record.eventCount as number) >= 0 &&
    typeof record.createdAt === 'string' && Number.isFinite(Date.parse(record.createdAt)) &&
    typeof record.publisher === 'string' && record.publisher.length > 0 &&
    typeof record.recordHash === 'string' &&
    (record.externalRef === undefined || typeof record.externalRef === 'string');
};

export const readAnchors = async (runtimeDir: string): Promise<AnchorRecord[]> => {
  let raw: string;
  try {
    raw = await readFile(anchorFile(runtimeDir), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return raw.split('\n').map((line) => line.trim()).filter(Boolean).map((line, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`Anchor ${index + 1} is not valid JSON.`);
    }
    if (!isAnchorRecord(parsed)) throw new Error(`Anchor ${index + 1} is malformed.`);
    const { recordHash, ...rest } = parsed;
    if (hashAnchorRecord(rest) !== recordHash) {
      throw new Error(`Anchor ${index + 1} does not match its own record hash.`);
    }
    return parsed;
  });
};

export const appendAnchor = async (runtimeDir: string, record: AnchorRecord): Promise<void> => {
  await mkdir(runtimeDir, { recursive: true });
  const destination = anchorFile(runtimeDir);
  const existing = await readAnchors(runtimeDir);
  // Anchors only ever move forward: a new anchor covering fewer events than the
  // last is either a truncation or a rewrite, and must not be recorded quietly.
  const last = existing.at(-1);
  if (last && record.eventCount < last.eventCount) {
    throw new Error('An anchor may not cover fewer events than the anchor before it.');
  }
  const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const lines = [...existing, record].map((item) => JSON.stringify(item)).join('\n');
  await writeFile(temporary, `${lines}\n`, 'utf8');
  await rename(temporary, destination);
};

/**
 * Checks a chain against its anchors.
 *
 * `headHashAt(n)` returns the chain's head after its first `n` events, so a
 * rewritten history diverges from an anchor at the point the rewrite began.
 */
export const verifyAgainstAnchors = async (
  anchors: readonly AnchorRecord[],
  totalEvents: number,
  headHashAt: (eventCount: number) => string | undefined,
): Promise<AnchorVerdict> => {
  if (anchors.length === 0) {
    return { ok: true, reason: 'No anchors are recorded; nothing to check against.', checked: 0 };
  }
  let checked = 0;
  for (const anchor of anchors) {
    if (anchor.eventCount > totalEvents) {
      return {
        ok: false,
        checked,
        reason: `An anchor covers ${anchor.eventCount} events but the chain now holds ${totalEvents}; the chain was truncated.`,
        divergedAt: anchor,
      };
    }
    const actual = headHashAt(anchor.eventCount);
    if (actual !== anchor.headHash) {
      return {
        ok: false,
        checked,
        reason: `The chain head after ${anchor.eventCount} events does not match the anchor published at ${anchor.createdAt}; the history was rewritten.`,
        divergedAt: anchor,
      };
    }
    checked += 1;
  }
  const external = anchors.filter((anchor) => anchor.externalRef).length;
  return {
    ok: true,
    checked,
    reason: external > 0
      ? `Chain matches ${checked} anchor(s), ${external} of them externally witnessed.`
      : `Chain matches ${checked} local anchor(s). None is externally witnessed, so this detects a rewrite only if this log survived it.`,
  };
};

/** Publishes the current head, falling back to a local-only record. */
export const anchorHead = async (
  runtimeDir: string,
  headHash: string,
  eventCount: number,
  now: string,
  publisher?: AnchorPublisher,
): Promise<AnchorRecord> => {
  let externalRef: string | undefined;
  let name = 'local';
  if (publisher) {
    name = publisher.name;
    try {
      externalRef = await publisher.publish(headHash, eventCount);
    } catch (error) {
      // Recorded as local rather than dropped: an anchor that failed to publish
      // is still evidence of what the head was, and the absence of an
      // externalRef states honestly that no witness saw it.
      name = `${publisher.name}:unwitnessed`;
      externalRef = undefined;
      void error;
    }
  }
  const record = buildAnchorRecord({ headHash, eventCount, createdAt: now, publisher: name, externalRef });
  await appendAnchor(runtimeDir, record);
  return record;
};

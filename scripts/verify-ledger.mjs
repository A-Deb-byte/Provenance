#!/usr/bin/env node
/**
 * Independent kernel ledger verifier.
 *
 *   node scripts/verify-ledger.mjs [--require-events] [runtimeDir]
 *
 * Replays .agent-kernel/events.jsonl, recomputing each event's SHA-256 hash
 * over the same canonical form the kernel uses and checking that every event's
 * previousHash links to the prior event's hash. It also confirms the snapshot
 * (state.json) head matches the ledger head.
 *
 * This is deliberately a standalone script with no project imports: it is the
 * reference for a future Rust/other-runtime verifier and proves the ledger
 * format is replayable outside the TypeScript kernel. Exit code 0 on success,
 * 1 on any integrity failure.
 */
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Canonical (key-sorted) JSON. The kernel hashes events this way so the digest
 * depends on the event's value rather than on V8 property-insertion order. That
 * is what lets a verifier in another language reproduce these hashes; a
 * `JSON.stringify` digest could only ever be reproduced by another V8 process
 * that happened to build the object in the same order.
 *
 * Reimplemented here rather than imported, like the rest of this file: a
 * verifier that shares code with the thing it verifies proves less.
 */
const canonicalJson = (value) => {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical JSON requires finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  throw new Error(`canonical JSON does not support ${typeof value}`);
};

const hashEvent = (event) => {
  const { hash, ...withoutHash } = event;
  return crypto.createHash('sha256').update(canonicalJson(withoutHash), 'utf8').digest('hex');
};

const fail = (message) => {
  console.error(`LEDGER INTEGRITY FAILURE: ${message}`);
  process.exit(1);
};

let requireEvents = false;
let runtimeDir = '.agent-kernel';
let runtimeDirProvided = false;

for (const argument of process.argv.slice(2)) {
  if (argument === '--require-events') {
    requireEvents = true;
    continue;
  }
  if (argument.startsWith('--')) {
    fail(`unknown option ${argument}.`);
  }
  if (runtimeDirProvided) {
    fail('expected at most one runtime directory.');
  }
  runtimeDir = argument;
  runtimeDirProvided = true;
}

const ledgerPath = path.join(runtimeDir, 'events.jsonl');
const statePath = path.join(runtimeDir, 'state.json');

let raw;
try {
  raw = readFileSync(ledgerPath, 'utf8');
} catch (error) {
  if (error.code === 'ENOENT') {
    if (requireEvents) {
      fail('required ledger events.jsonl was not found.');
    }
    console.log('No ledger found; nothing to verify (0 events).');
    process.exit(0);
  }
  throw error;
}

const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
if (requireEvents && lines.length === 0) {
  fail('required ledger contains no events.');
}
let previousHash = null;
let count = 0;

for (const line of lines) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    fail(`event ${count + 1} is not valid JSON (truncated or corrupt line).`);
  }
  if (typeof event.hash !== 'string') fail(`event ${event.id ?? count + 1} has no hash.`);
  if (event.previousHash !== previousHash) {
    fail(`event ${event.id ?? count + 1} previousHash does not link to the prior event.`);
  }
  if (hashEvent(event) !== event.hash) {
    fail(`event ${event.id ?? count + 1} hash does not match its recomputed content hash.`);
  }
  previousHash = event.hash;
  count += 1;
}

try {
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const stateHead = typeof state.lastEventHash === 'string' ? state.lastEventHash : null;
  if (stateHead !== previousHash) {
    fail('snapshot head (state.json lastEventHash) does not match the ledger head.');
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

console.log(`Ledger verified: ${count} hash-chained events, head ${previousHash ? previousHash.slice(0, 16) + '...' : '(empty)'}.`);
process.exit(0);

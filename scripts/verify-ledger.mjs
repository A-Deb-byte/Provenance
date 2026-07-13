#!/usr/bin/env node
/**
 * Independent kernel ledger verifier.
 *
 *   node scripts/verify-ledger.mjs [runtimeDir]
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

const runtimeDir = process.argv[2] ?? '.agent-kernel';
const ledgerPath = path.join(runtimeDir, 'events.jsonl');
const statePath = path.join(runtimeDir, 'state.json');

const hashEvent = (event) => {
  const { hash, ...withoutHash } = event;
  return crypto.createHash('sha256').update(JSON.stringify(withoutHash)).digest('hex');
};

const fail = (message) => {
  console.error(`LEDGER INTEGRITY FAILURE: ${message}`);
  process.exit(1);
};

let raw;
try {
  raw = readFileSync(ledgerPath, 'utf8');
} catch (error) {
  if (error.code === 'ENOENT') {
    console.log('No ledger found; nothing to verify (0 events).');
    process.exit(0);
  }
  throw error;
}

const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
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

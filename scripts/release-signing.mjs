#!/usr/bin/env node
/**
 * Release signing helper for the local kernel.
 *
 *   node scripts/release-signing.mjs generate <privateKeyFile>
 *     Creates an Ed25519 keypair. Writes the private key PEM to the given
 *     file (keep it outside the repository) and prints the base64 public key
 *     to configure as RELEASE_SIGNING_PUBLIC_KEY.
 *
 *   node scripts/release-signing.mjs sign <privateKeyFile> <proposalJsonFile>
 *     Prints the base64 Ed25519 signature over the canonical release
 *     authorization payload for the proposal's "signature" field.
 */
import crypto from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const [, , command, keyFile, proposalFile] = process.argv;

const canonicalAuthorization = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Proposal JSON must be an object.');
  }
  const targetVersion = typeof value.targetVersion === 'string' ? value.targetVersion.trim() : '';
  const contentHash = typeof value.contentHash === 'string' ? value.contentHash : '';
  const rollbackInstructions = typeof value.rollbackInstructions === 'string'
    ? value.rollbackInstructions.trim()
    : '';
  if (!targetVersion) throw new Error('targetVersion is required.');
  if (!/^[a-f0-9]{64}$/.test(contentHash)) {
    throw new Error('contentHash must be a lowercase sha256 hex digest.');
  }
  if (!rollbackInstructions) throw new Error('rollbackInstructions are required.');
  if (!Array.isArray(value.evaluationEventIds) || value.evaluationEventIds.length === 0) {
    throw new Error('evaluationEventIds must be a non-empty array.');
  }
  const evaluationEventIds = value.evaluationEventIds.map((eventId) => (
    typeof eventId === 'string' ? eventId.trim() : ''
  ));
  if (evaluationEventIds.some((eventId) => !eventId)) {
    throw new Error('evaluationEventIds cannot contain blank values.');
  }
  if (new Set(evaluationEventIds).size !== evaluationEventIds.length) {
    throw new Error('evaluationEventIds must be unique.');
  }
  evaluationEventIds.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  return JSON.stringify({
    schemaVersion: 1,
    targetVersion,
    contentHash,
    evaluationEventIds,
    rollbackInstructions,
  });
};

if (command === 'generate' && keyFile) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  writeFileSync(keyFile, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  console.log(`Private key written to ${keyFile} - store it safely, outside the repository if possible.`);
  console.log('Set this as RELEASE_SIGNING_PUBLIC_KEY:');
  console.log(publicKey.export({ format: 'der', type: 'spki' }).toString('base64'));
} else if (command === 'sign' && keyFile && proposalFile) {
  try {
    const proposal = JSON.parse(readFileSync(proposalFile, 'utf8'));
    const payload = canonicalAuthorization(proposal);
    const privateKey = crypto.createPrivateKey(readFileSync(keyFile, 'utf8'));
    console.log(crypto.sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64'));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Release signing failed.');
    process.exit(1);
  }
} else {
  console.error('Usage: release-signing.mjs generate <privateKeyFile> | sign <privateKeyFile> <proposalJsonFile>');
  process.exit(1);
}

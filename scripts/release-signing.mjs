#!/usr/bin/env node
/**
 * Release signing helper for the local kernel.
 *
 *   node scripts/release-signing.mjs generate <privateKeyFile>
 *     Creates an Ed25519 keypair. Writes the private key PEM to the given
 *     file (keep it outside the repository) and prints the base64 public key
 *     to configure as RELEASE_SIGNING_PUBLIC_KEY.
 *
 *   node scripts/release-signing.mjs sign <privateKeyFile> <contentHash>
 *     Prints the base64 Ed25519 signature over the release content hash,
 *     for the "signature" field of a release proposal.
 */
import crypto from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const [, , command, keyFile, contentHash] = process.argv;

if (command === 'generate' && keyFile) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  writeFileSync(keyFile, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  console.log(`Private key written to ${keyFile} - store it safely, outside the repository if possible.`);
  console.log('Set this as RELEASE_SIGNING_PUBLIC_KEY:');
  console.log(publicKey.export({ format: 'der', type: 'spki' }).toString('base64'));
} else if (command === 'sign' && keyFile && contentHash) {
  if (!/^[a-f0-9]{64}$/.test(contentHash)) {
    console.error('contentHash must be a lowercase sha256 hex digest.');
    process.exit(1);
  }
  const privateKey = crypto.createPrivateKey(readFileSync(keyFile, 'utf8'));
  console.log(crypto.sign(null, Buffer.from(contentHash, 'utf8'), privateKey).toString('base64'));
} else {
  console.error('Usage: release-signing.mjs generate <privateKeyFile> | sign <privateKeyFile> <contentHash>');
  process.exit(1);
}

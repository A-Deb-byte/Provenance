#!/usr/bin/env node
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const publicKeyPrefix = Buffer.from('302a300506032b6570032100', 'hex');

const decodeTransport = (value, label, maxBytes) => {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new Error(`${label} transport is not canonical base64.`);
  }
  const decoded = Buffer.from(normalized, 'base64');
  if (decoded.length === 0 || decoded.length > maxBytes || decoded.toString('base64') !== normalized) {
    throw new Error(`${label} transport has an invalid encoded length.`);
  }
  const text = decoded.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(decoded)) {
    throw new Error(`${label} transport is not UTF-8 text.`);
  }
  return { normalized, text };
};

const decodeExactBase64 = (value, bytes, label) => {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error(`${label} is not canonical base64.`);
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== bytes || decoded.toString('base64') !== value) {
    throw new Error(`${label} has an invalid encoded length.`);
  }
  return decoded;
};

const parsePublicKey = (publicKeyText) => {
  const transport = decodeTransport(publicKeyText, 'Updater public key', 2 * 1024);
  const publicLines = transport.text.trim().split(/\r?\n/);
  if (publicLines.length !== 2 ||
    !publicLines[0].startsWith('untrusted comment: minisign public key')) {
    throw new Error('Updater public key format is invalid.');
  }
  const publicBytes = decodeExactBase64(publicLines[1], 42, 'Updater public key');
  if (!['Ed', 'ED'].includes(publicBytes.subarray(0, 2).toString('ascii'))) {
    throw new Error('Updater public key algorithm is unsupported.');
  }
  return { publicBytes, normalized: transport.normalized };
};

export const validateUpdaterPublicKey = (publicKeyText) => parsePublicKey(publicKeyText).normalized;

export const verifyUpdaterSignature = (publicKeyText, signatureText, artifact) => {
  const { publicBytes } = parsePublicKey(publicKeyText);

  const signatureTransport = decodeTransport(signatureText, 'Updater signature', 16 * 1024);
  const signatureLines = signatureTransport.text.trim().split(/\r?\n/);
  if (signatureLines.length !== 4 ||
    !signatureLines[0].startsWith('untrusted comment:') ||
    !signatureLines[2].startsWith('trusted comment: ')) {
    throw new Error('Updater signature format is invalid.');
  }
  const signatureBytes = decodeExactBase64(signatureLines[1], 74, 'Updater signature');
  const globalSignature = decodeExactBase64(signatureLines[3], 64, 'Updater global signature');
  if (signatureBytes.subarray(0, 2).toString('ascii') !== 'ED') {
    throw new Error('Updater signatures must use Minisign prehash mode.');
  }
  if (!crypto.timingSafeEqual(publicBytes.subarray(2, 10), signatureBytes.subarray(2, 10))) {
    throw new Error('Updater signature key id does not match the embedded public key.');
  }

  const publicKey = crypto.createPublicKey({
    key: Buffer.concat([publicKeyPrefix, publicBytes.subarray(10, 42)]),
    format: 'der',
    type: 'spki',
  });
  const prehash = crypto.createHash('blake2b512').update(artifact).digest();
  const signature = signatureBytes.subarray(10, 74);
  if (!crypto.verify(null, prehash, publicKey, signature)) {
    throw new Error('Updater artifact signature verification failed.');
  }
  const trustedComment = signatureLines[2].slice('trusted comment: '.length);
  const globalMessage = Buffer.concat([signature, Buffer.from(trustedComment, 'utf8')]);
  if (!crypto.verify(null, globalMessage, publicKey, globalSignature)) {
    throw new Error('Updater trusted-comment signature verification failed.');
  }
  return true;
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [artifactPath, signaturePath, publicKeyPath] = process.argv.slice(2);
  if (!artifactPath || !signaturePath || !publicKeyPath) {
    process.stderr.write('Usage: updater-signature.mjs <artifact> <signature> <public-key>\n');
    process.exitCode = 1;
  } else {
    try {
      const [artifact, signature, publicKey] = await Promise.all([
        readFile(artifactPath),
        readFile(signaturePath, 'utf8'),
        readFile(publicKeyPath, 'utf8'),
      ]);
      verifyUpdaterSignature(publicKey, signature, artifact);
      process.stdout.write('Updater signature verified.\n');
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : 'Updater signature verification failed.'}\n`);
      process.exitCode = 1;
    }
  }
}

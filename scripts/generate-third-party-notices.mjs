#!/usr/bin/env node
import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptedLicenseIdentifiers, validateLicenseExpression } from './license-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
const lockBytes = await readFile(path.join(root, 'package-lock.json'));
const lockSha256 = crypto.createHash('sha256').update(lockBytes).digest('hex');
const maximumLicenseBytes = 512 * 1024;
const licenseName = /^(?:licen[cs]e|copying|notice)(?:\.[a-z0-9._-]+)?$/i;
const utf8 = new TextDecoder('utf-8', { fatal: true });

const records = [];
for (const packagePath of Object.keys(lock.packages ?? {}).sort()) {
  const lockEntry = lock.packages[packagePath];
  if (!packagePath.includes('node_modules/') || lockEntry?.link) continue;
  const directory = path.join(root, ...packagePath.split('/'));
  if (!existsSync(directory)) {
    if (lockEntry?.optional) continue;
    throw new Error(`Required locked package directory is unavailable for ${packagePath}.`);
  }
  let manifest;
  let names;
  try {
    [manifest, names] = await Promise.all([
      readFile(path.join(directory, 'package.json'), 'utf8').then(JSON.parse),
      readdir(directory),
    ]);
  } catch (error) {
    throw new Error(`Locked package files are unavailable for ${packagePath}.`, { cause: error });
  }
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
    throw new Error(`Locked package identity is invalid for ${packagePath}.`);
  }
  const packageSuffix = packagePath.split('node_modules/').at(-1);
  const suffixSegments = packageSuffix?.split('/') ?? [];
  const expectedName = suffixSegments[0]?.startsWith('@')
    ? suffixSegments.slice(0, 2).join('/')
    : suffixSegments[0];
  if (!expectedName || manifest.name !== expectedName || manifest.version !== lockEntry.version) {
    throw new Error(`Installed package identity does not match package-lock.json for ${packagePath}.`);
  }
  const declaredLicense = validateLicenseExpression(manifest.license);
  const licenseFiles = names.filter((name) => licenseName.test(name)).sort();
  const licenses = [];
  for (const name of licenseFiles) {
    const bytes = await readFile(path.join(directory, name));
    if (bytes.length > maximumLicenseBytes || bytes.includes(0)) {
      throw new Error(`License file ${manifest.name}/${name} is outside the release bounds.`);
    }
    let text;
    try {
      text = utf8.decode(bytes).trim();
    } catch {
      throw new Error(`License file ${manifest.name}/${name} is not canonical UTF-8 text.`);
    }
    if (text) licenses.push({ name, text });
  }
  records.push({
    name: manifest.name,
    version: manifest.version,
    declaredLicense,
    licenses,
  });
}

const sections = [
  'PROVENANCE THIRD-PARTY NOTICES',
  '',
  'Generated deterministically from package-lock.json and the installed locked dependency tree.',
  `package-lock.json SHA-256: ${lockSha256}`,
  'This file describes JavaScript dependencies used to build the bundled server and dashboard.',
  `Accepted SPDX identifiers: ${acceptedLicenseIdentifiers().join(', ')}.`,
];
for (const record of records) {
  sections.push('', '='.repeat(78), `${record.name}@${record.version}`, `Declared license: ${record.declaredLicense}`);
  if (record.licenses.length === 0) {
    sections.push('No standalone license text was present in the installed package directory.');
    continue;
  }
  for (const license of record.licenses) {
    sections.push('', `--- ${license.name} ---`, license.text);
  }
}
const content = `${sections.join('\n')}\n`;
const output = path.join(root, 'dist', 'THIRD_PARTY_NOTICES.txt');
const temporary = `${output}.${process.pid}.tmp`;
await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
await rename(temporary, output);
process.stdout.write(`${JSON.stringify({
  schemaVersion: 2,
  packages: records.length,
  packageLockSha256: lockSha256,
  sha256: crypto.createHash('sha256').update(content).digest('hex'),
})}\n`);

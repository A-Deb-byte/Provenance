#!/usr/bin/env node
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = process.env.PROVENANCE_CARGO_ABOUT?.trim();
const expectedHash = process.env.PROVENANCE_CARGO_ABOUT_SHA256?.trim().toLowerCase();
const expectedVersion = process.env.PROVENANCE_CARGO_ABOUT_VERSION?.trim();

const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

if (!executable || !path.isAbsolute(executable) || !existsSync(executable) || !statSync(executable).isFile()) {
  fail('PROVENANCE_CARGO_ABOUT must identify an exact absolute cargo-about executable.');
}
if (!expectedHash || !/^[a-f0-9]{64}$/.test(expectedHash)) {
  fail('PROVENANCE_CARGO_ABOUT_SHA256 must be an exact lowercase SHA-256 digest.');
}
const actualHash = crypto.createHash('sha256').update(readFileSync(executable)).digest('hex');
if (actualHash !== expectedHash) fail('The cargo-about executable hash does not match the release pin.');
if (!expectedVersion || !/^\d+\.\d+\.\d+$/.test(expectedVersion)) {
  fail('PROVENANCE_CARGO_ABOUT_VERSION must be an exact semantic version.');
}

const versionOutput = execFileSync(executable, ['--version'], {
  cwd: root,
  encoding: 'utf8',
  windowsHide: true,
}).trim();
if (versionOutput !== `cargo-about ${expectedVersion}`) {
  fail('The cargo-about executable version does not match the release pin.');
}

const output = path.join(root, 'dist', 'RUST_THIRD_PARTY_NOTICES.txt');
execFileSync(executable, [
  'generate',
  '--manifest-path', path.join(root, 'src-tauri', 'Cargo.toml'),
  '--config', path.join(root, 'about.toml'),
  '--frozen',
  '--fail',
  '--output-file', output,
  path.join(root, 'scripts', 'rust-third-party-notices.hbs'),
], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
});

if (!existsSync(output) || statSync(output).size < 1024 || statSync(output).size > 16 * 1024 * 1024) {
  fail('The generated native third-party notice inventory is missing or outside its size bound.');
}
process.stdout.write(`Generated ${path.relative(root, output)} with cargo-about ${expectedVersion}.\n`);

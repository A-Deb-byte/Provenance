#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targetDirectory = path.join(root, 'src-tauri', 'target', 'acceptance');
const binary = path.join(targetDirectory, 'debug', 'provenance-desktop.exe');
const tauriCli = path.join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const smoke = path.join(root, 'scripts', 'native-host-smoke.mjs');
const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');

const run = (command, args, environment = process.env) => new Promise((resolve, reject) => {
  const child = spawn(command, args, {
    cwd: root,
    env: environment,
    shell: false,
    stdio: 'inherit',
  });
  child.once('error', reject);
  child.once('exit', (code, signal) => {
    if (code === 0 && signal === null) {
      resolve();
      return;
    }
    reject(new Error(
      `${path.basename(command)} failed with code ${String(code)} and signal ${String(signal)}.`,
    ));
  });
});

const main = async () => {
  if (process.platform !== 'win32') {
    throw new Error('Native acceptance-host verification requires Windows.');
  }
  await run(process.execPath, [npmCli, 'run', 'build']);
  await run(process.execPath, [
    tauriCli,
    'build',
    '--debug',
    '--no-bundle',
    '--config',
    path.join(root, 'src-tauri', 'tauri.acceptance.conf.json'),
  ], {
    ...process.env,
    CARGO_TARGET_DIR: targetDirectory,
  });
  await run(process.execPath, [
    smoke,
    '--binary',
    binary,
    '--profile',
    'acceptance',
  ]);
};

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

#!/usr/bin/env node
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'provenance-packaged-smoke-'));
const runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'provenance-packaged-runtime-'));
const maximumLogChars = 32 * 1024;
const startupTimeoutMs = 45_000;
const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
const auditedOptionalExternals = new Set([
  // Optional terminal coloring and ws native accelerators. Their callers use
  // guarded require calls and the clean-root launch below proves fallbacks.
  'supports-color',
  'bufferutil',
  'utf-8-validate',
]);

const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};
const selectedNode = await realpath(argument('--node') || process.execPath);
const expectedNodeHash = argument('--expected-sha256')?.toLowerCase();
const expectedNodeVersion = argument('--expected-version');
const expectedNodeArchitecture = argument('--expected-arch');

const digestFile = (file) => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256');
  createReadStream(file)
    .on('data', (chunk) => hash.update(chunk))
    .once('error', reject)
    .once('end', () => resolve(hash.digest('hex')));
});

let child;
let stdout = '';
let stderr = '';

const appendBounded = (current, chunk) => (
  `${current}${chunk.toString('utf8')}`.slice(-maximumLogChars)
);

const waitForServerUrl = () => new Promise((resolve, reject) => {
  const deadline = setTimeout(() => {
    reject(new Error(`Packaged server did not become ready. ${stderr.slice(-2_000)}`));
  }, startupTimeoutMs);
  const inspect = () => {
    const match = /running on (http:\/\/localhost:\d+)/.exec(stdout);
    if (!match) return;
    clearTimeout(deadline);
    resolve(match[1].replace('localhost', '127.0.0.1'));
  };
  child.stdout.on('data', (chunk) => {
    stdout = appendBounded(stdout, chunk);
    inspect();
  });
  child.stderr.on('data', (chunk) => {
    stderr = appendBounded(stderr, chunk);
  });
  child.once('exit', (code) => {
    clearTimeout(deadline);
    reject(new Error(`Packaged server exited before readiness with code ${code}. ${stderr.slice(-2_000)}`));
  });
});

try {
  await cp(path.join(root, 'dist'), path.join(temporaryRoot, 'dist'), { recursive: true });
  const entrypoint = path.join(temporaryRoot, 'dist', 'server.cjs');
  const metafile = JSON.parse(await readFile(path.join(temporaryRoot, 'dist', 'server.meta.json'), 'utf8'));
  const notices = await readFile(path.join(temporaryRoot, 'dist', 'THIRD_PARTY_NOTICES.txt'), 'utf8');
  if (!notices.includes('PROVENANCE THIRD-PARTY NOTICES') || !notices.includes('express@')) {
    throw new Error('The packaged third-party notices are missing or incomplete.');
  }
  const serverOutput = Object.entries(metafile.outputs).find(([name]) => (
    name.replaceAll('\\', '/').endsWith('/dist/server.cjs') || name.replaceAll('\\', '/') === 'dist/server.cjs'
  ))?.[1];
  if (!serverOutput || !Array.isArray(serverOutput.imports)) {
    throw new Error('The packaged server esbuild metadata is missing.');
  }
  const unexpectedExternalImports = serverOutput.imports.filter((item) => (
    item.external && !builtins.has(item.path) && !auditedOptionalExternals.has(item.path) &&
    !(item.path === 'vite' && item.kind === 'dynamic-import')
  ));
  if (unexpectedExternalImports.length > 0) {
    throw new Error(
      `Packaged server has unexpected external imports: ${unexpectedExternalImports.map((item) => item.path).join(', ')}`,
    );
  }
  const nodeDirectory = path.join(temporaryRoot, 'node');
  const packagedNode = path.join(nodeDirectory, process.platform === 'win32' ? 'node.exe' : 'node');
  await mkdir(nodeDirectory);
  await copyFile(selectedNode, packagedNode);
  if (process.platform !== 'win32') await chmod(packagedNode, 0o755);
  const nodeSha256 = await digestFile(packagedNode);
  if (expectedNodeHash && (!/^[a-f0-9]{64}$/.test(expectedNodeHash) || nodeSha256 !== expectedNodeHash)) {
    throw new Error('The copied packaged Node runtime failed its expected SHA-256 check.');
  }
  const inherited = Object.fromEntries(
    ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA', 'PROGRAMDATA']
      .flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]]),
  );
  child = spawn(packagedNode, [entrypoint], {
    cwd: temporaryRoot,
    env: {
      ...inherited,
      NODE_ENV: 'production',
      NODE_PATH: '',
      PORT: '0',
      PROVENANCE_PROJECT_ROOT: temporaryRoot,
      PROVENANCE_RUNTIME_DIR: runtimeDir,
      DESKTOP_PACKAGED_RELEASE: '1',
      // Fail before Docker I/O; this smoke isolates resource completeness.
      PROVENANCE_SANDBOX_IMAGE: 'unpinned-smoke-image',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const serverUrl = await waitForServerUrl();
  const [auth, diagnostics, runtime] = await Promise.all([
    fetch(`${serverUrl}/api/auth/status`, { headers: { Accept: 'application/json' } }),
    fetch(`${serverUrl}/api/kernel/diagnostics`, { headers: { Accept: 'application/json' } }),
    fetch(`${serverUrl}/api/kernel/runtime-report`, { headers: { Accept: 'application/json' } }),
  ]);
  if (!auth.ok || !diagnostics.ok || !runtime.ok) {
    throw new Error(
      `Packaged API probes failed: auth=${auth.status}, diagnostics=${diagnostics.status}, runtime=${runtime.status}.`,
    );
  }
  const authBody = await auth.json();
  const diagnosticsBody = await diagnostics.json();
  const runtimeBody = await runtime.json();
  if (typeof authBody !== 'object' || authBody === null || diagnosticsBody?.schemaVersion !== 1 ||
    runtimeBody?.features?.verificationCommands?.status !== 'unavailable' ||
    runtimeBody?.features?.coreModel?.status !== 'unavailable' ||
    runtimeBody?.workers?.available?.includes('worker.browser.playwright')) {
    throw new Error('Packaged API probes returned invalid contracts.');
  }
  const nodeVersion = diagnosticsBody?.runtime?.nodeVersion;
  const nodeArchitecture = diagnosticsBody?.runtime?.architecture;
  if (expectedNodeVersion && nodeVersion !== expectedNodeVersion) {
    throw new Error(`Packaged Node version mismatch: expected ${expectedNodeVersion}, received ${nodeVersion}.`);
  }
  if (expectedNodeArchitecture && nodeArchitecture !== expectedNodeArchitecture) {
    throw new Error(
      `Packaged Node architecture mismatch: expected ${expectedNodeArchitecture}, received ${nodeArchitecture}.`,
    );
  }

  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    cleanResourceRoot: true,
    staticBundleExternalImports: ['vite:development-only-dynamic-import'],
    auditedOptionalFallbacks: [...auditedOptionalExternals],
    readiness: 'passed',
    diagnosticsSchemaVersion: diagnosticsBody.schemaVersion,
    nodeVersion,
    nodeArchitecture,
    nodeSha256,
    declaredOptionalCapabilities: {
      commandExecution: 'unavailable_without_pinned_healthy_docker',
      localCoreModel: 'unavailable_without_optional_runtime',
      browserWrite: 'unavailable_without_optional_runtime',
    },
  }, null, 2)}\n`);
} finally {
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
  }
  await Promise.all([
    rm(temporaryRoot, { recursive: true, force: true }),
    rm(runtimeDir, { recursive: true, force: true }),
  ]);
}

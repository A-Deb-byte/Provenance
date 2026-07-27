#!/usr/bin/env node
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  access,
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeRuntimeResourceManifest } from './runtime-resource-manifest.mjs';
import { assertServerBundleHasBuiltinOnlyExternals } from './server-bundle-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'provenance-packaged-smoke-'));
const runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'provenance-packaged-runtime-'));
const maximumLogChars = 32 * 1024;
const startupTimeoutMs = 120_000;

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

const inventoryFiles = async (directory, relative = '') => {
  const files = [];
  for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
    const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...await inventoryFiles(directory, entryRelative));
    } else if (entry.isFile()) {
      files.push(entryRelative);
    } else {
      throw new Error(`Packaged smoke resource ${entryRelative} is not a regular file.`);
    }
  }
  return files;
};

const fileExists = async (file) => {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
};

let child;
let stdout = '';
let stderr = '';

const appendBounded = (current, chunk) => (
  `${current}${chunk.toString('utf8')}`.slice(-maximumLogChars)
);

const waitForServerUrl = () => new Promise((resolve, reject) => {
  const deadline = setTimeout(() => {
    reject(new Error(
      `Packaged server did not become ready within ${startupTimeoutMs}ms. ` +
      `stdout=${JSON.stringify(stdout.slice(-2_000))} stderr=${JSON.stringify(stderr.slice(-2_000))}`,
    ));
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
    reject(new Error(
      `Packaged server exited before readiness with code ${code}. ` +
      `stdout=${JSON.stringify(stdout.slice(-2_000))} stderr=${JSON.stringify(stderr.slice(-2_000))}`,
    ));
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
  assertServerBundleHasBuiltinOnlyExternals(metafile);
  const maliciousModuleMarker = path.join(runtimeDir, 'unsigned-sibling-module-executed.txt');
  const maliciousModules = [
    'bufferutil',
    'dotenv',
    'express',
    'node-llama-cpp',
    'playwright-core',
    'supports-color',
    'utf-8-validate',
    'vite',
  ];
  await Promise.all(maliciousModules.map(async (name) => {
    const directory = path.join(temporaryRoot, 'node_modules', name);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'package.json'), `${JSON.stringify({
      name,
      version: '0.0.0-unsigned-smoke',
      main: 'index.cjs',
    })}\n`, 'utf8');
    await writeFile(path.join(directory, 'index.cjs'), [
      "const fs = require('node:fs');",
      "fs.appendFileSync(process.env.PROVENANCE_MALICIOUS_MODULE_MARKER, 'executed\\n');",
      'function plantedModule() { return true; }',
      'plantedModule.stderr = { level: 0 };',
      'plantedModule.mask = () => undefined;',
      'plantedModule.unmask = () => undefined;',
      'plantedModule.chromium = { executablePath: () => "" };',
      'plantedModule.createServer = async () => ({ middlewares: () => undefined });',
      'module.exports = plantedModule;',
      '',
    ].join('\n'), 'utf8');
  }));
  await writeFile(path.join(temporaryRoot, '.env'), [
    'BROWSER_WRITE_ORIGINS=https://unsigned-sibling.invalid',
    'OPENAI_API_KEY=must-not-enter-packaged-runtime',
    'PROVENANCE_FIRST_ADMIN_BOOTSTRAP_SECRET=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    '',
  ].join('\n'), 'utf8');
  const nodeDirectory = path.join(temporaryRoot, 'node');
  const packagedNode = path.join(nodeDirectory, process.platform === 'win32' ? 'node.exe' : 'node');
  await mkdir(nodeDirectory);
  await copyFile(selectedNode, packagedNode);
  if (process.platform !== 'win32') await chmod(packagedNode, 0o755);
  const nodeSha256 = await digestFile(packagedNode);
  if (expectedNodeHash && (!/^[a-f0-9]{64}$/.test(expectedNodeHash) || nodeSha256 !== expectedNodeHash)) {
    throw new Error('The copied packaged Node runtime failed its expected SHA-256 check.');
  }
  const authenticatedManifest = writeRuntimeResourceManifest([
    {
      source: path.join(temporaryRoot, 'dist', 'index.html'),
      destination: 'dist/index.html',
    },
    ...await inventoryFiles(path.join(temporaryRoot, 'dist', 'assets')).then((assets) => (
      assets.map((asset) => ({
        source: path.join(temporaryRoot, 'dist', 'assets', ...asset.split('/')),
        destination: `dist/assets/${asset}`,
      }))
    )),
  ], path.join(
    runtimeDir,
    '.desktop-resource-manifest-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json',
  ));
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
      PROVENANCE_AUTHENTICATED_RESOURCE_MANIFEST_PATH: authenticatedManifest.path,
      PROVENANCE_AUTHENTICATED_RESOURCE_MANIFEST_SHA256: authenticatedManifest.sha256,
      PROVENANCE_MALICIOUS_MODULE_MARKER: maliciousModuleMarker,
      // Fail before Docker I/O; this smoke isolates resource completeness.
      PROVENANCE_SANDBOX_IMAGE: 'unpinned-smoke-image',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const serverUrl = await waitForServerUrl();
  const [auth, diagnostics, runtime, source, noticeResponse, unknownAsset] = await Promise.all([
    fetch(`${serverUrl}/api/auth/status`, { headers: { Accept: 'application/json' } }),
    fetch(`${serverUrl}/api/kernel/diagnostics`, { headers: { Accept: 'application/json' } }),
    fetch(`${serverUrl}/api/kernel/runtime-report`, { headers: { Accept: 'application/json' } }),
    fetch(`${serverUrl}/server.cjs`),
    fetch(`${serverUrl}/THIRD_PARTY_NOTICES.txt`),
    fetch(`${serverUrl}/assets/not-in-the-signed-manifest.js`),
  ]);
  if (!auth.ok || !diagnostics.ok || !runtime.ok) {
    throw new Error(
      `Packaged API probes failed: auth=${auth.status}, diagnostics=${diagnostics.status}, runtime=${runtime.status}.`,
    );
  }
  if (source.status !== 404 || noticeResponse.status !== 404 || unknownAsset.status !== 404) {
    throw new Error(
      'Packaged static serving exposed a server, notice, or unlisted asset resource.',
    );
  }
  const authBody = await auth.json();
  const diagnosticsBody = await diagnostics.json();
  const runtimeBody = await runtime.json();
  if (typeof authBody !== 'object' || authBody === null || diagnosticsBody?.schemaVersion !== 1 ||
    runtimeBody?.providers?.configured?.length !== 0 ||
    runtimeBody?.features?.verificationCommands?.status !== 'unavailable' ||
    runtimeBody?.features?.coreModel?.status !== 'unavailable' ||
    runtimeBody?.workers?.available?.includes('worker.browser.playwright')) {
    throw new Error('Packaged API probes returned invalid contracts.');
  }
  if (await fileExists(maliciousModuleMarker)) {
    throw new Error('Packaged startup executed a dependency from unsigned sibling node_modules.');
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
    nonBuiltinExternalImports: [],
    unsignedSiblingModulesIgnored: maliciousModules,
    packagedDotenvIgnored: true,
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

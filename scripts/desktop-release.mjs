#!/usr/bin/env node
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  validateUpdaterPublicKey,
  verifyUpdaterSignature,
} from './updater-signature.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tauriRoot = path.join(repositoryRoot, 'src-tauri');
const baseConfigPath = path.join(tauriRoot, 'tauri.conf.json');
const releaseConfigPath = path.join(tauriRoot, 'tauri.release.conf.json');
const tauriCliPath = path.join(repositoryRoot, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const signCommandPath = path.join(repositoryRoot, 'scripts', 'windows-sign-command.ps1');
const payloadManifestName = 'manifest.json';
const payloadKind = 'provenance-windows-unsigned-payload';
const bundleRecordKind = 'provenance-windows-signed-bundle';
const releasePlatform = 'windows-x86_64-nsis';
const nativePayloadPath = 'native/provenance-desktop.exe';
const nativeBinaryName = 'provenance-desktop.exe';
const supportedTauriCliVersion = '2.11.4';
const bundleTypeUnknown = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK', 'ascii');
const bundleTypeNsis = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_NSS', 'ascii');
const maxManifestBytes = 1024 * 1024;
const maxPayloadFiles = 4096;
const maxPayloadFileBytes = 256 * 1024 * 1024;
const maxPayloadBytes = 1024 * 1024 * 1024;

const requiredResourceDestinations = new Map([
  ['dist/server.cjs', 'application-server'],
  ['dist/index.html', 'application-ui'],
  ['dist/THIRD_PARTY_NOTICES.txt', 'third-party-notices'],
  ['dist/RUST_THIRD_PARTY_NOTICES.txt', 'native-third-party-notices'],
  ['node/node.exe', 'bundled-runtime'],
  ['node/LICENSE', 'runtime-license'],
]);

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for a desktop release.`);
  return value;
}

function requiredSha256Environment(name) {
  const value = requiredEnvironment(name).toLowerCase();
  if (!isSha256(value)) throw new Error(`${name} must be an exact lowercase SHA-256 digest.`);
  return value;
}

function validateHttpsUrl(name, raw, { requireStaticManifest = false } = {}) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute HTTPS URL.`);
  }
  const hostname = url.hostname.toLowerCase();
  const address = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  const localName = hostname === 'localhost' || hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') || hostname.endsWith('.internal') ||
    hostname.endsWith('.home.arpa');
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port ||
      hostname.endsWith('.') || !hostname.includes('.') || localName || isIP(address) !== 0) {
    throw new Error(`${name} must be a credential-free public HTTPS URL.`);
  }
  if (requireStaticManifest && (url.search || !url.pathname.endsWith('/latest.json'))) {
    throw new Error(`${name} must identify a query-free static latest.json manifest.`);
  }
  if (requireStaticManifest && process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_REPOSITORY) {
    const expected = `https://github.com/${process.env.GITHUB_REPOSITORY}/releases/latest/download/latest.json`;
    if (url.toString() !== expected) {
      throw new Error(`${name} must match ${expected} for the GitHub publication workflow.`);
    }
  }
  return url.toString();
}

function digestFile(file) {
  return crypto.createHash('sha256').update(readFileSync(file)).digest('hex');
}

function digestText(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function isSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function markerOffsets(bytes, marker) {
  const offsets = [];
  let offset = bytes.indexOf(marker);
  while (offset !== -1) {
    offsets.push(offset);
    offset = bytes.indexOf(marker, offset + 1);
  }
  return offsets;
}

function verifyUnsignedBundleMarker(bytes, label) {
  const unknownOffsets = markerOffsets(bytes, bundleTypeUnknown);
  const nsisOffsets = markerOffsets(bytes, bundleTypeNsis);
  if (unknownOffsets.length !== 1 || nsisOffsets.length !== 0) {
    throw new Error(`${label} must contain exactly one unpatched Tauri bundle-type marker.`);
  }
  return unknownOffsets[0];
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function assertExactKeys(value, expected, label) {
  assertPlainObject(value, label);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unexpected or missing fields.`);
  }
}

function assertSafeInteger(value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be a bounded non-negative integer.`);
  }
}

function canonicalRelativePath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 ||
      value.includes('\\') || value.includes('\0') || path.posix.isAbsolute(value)) {
    throw new Error(`${label} must be a canonical relative path.`);
  }
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' ||
      !/^[A-Za-z0-9][A-Za-z0-9._@+-]*$/.test(segment))) {
    throw new Error(`${label} must be a canonical relative path.`);
  }
  return value;
}

function assertRegularFile(file, label, maximum = maxPayloadFileBytes) {
  let info;
  try {
    info = lstatSync(file);
  } catch {
    throw new Error(`${label} must be a readable file.`);
  }
  if (info.isSymbolicLink() || !info.isFile() || info.size <= 0 || info.size > maximum) {
    throw new Error(`${label} must be a bounded regular file, not a link.`);
  }
  return info;
}

function assertDirectory(file, label) {
  let info;
  try {
    info = lstatSync(file);
  } catch {
    throw new Error(`${label} must be a readable directory.`);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${label} must be a regular directory, not a link.`);
  }
  return info;
}

function readBoundedJson(file, label, maximum = maxManifestBytes) {
  assertRegularFile(file, label, maximum);
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`${label} must contain valid JSON.`);
  }
}

function inventoryTree(root, label) {
  assertDirectory(root, label);
  const files = [];
  const directories = [];
  let totalBytes = 0;

  function visit(directory, relativeDirectory, depth) {
    if (depth > 32) throw new Error(`${label} exceeds the maximum directory depth.`);
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const relative = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      canonicalRelativePath(relative, `${label} entry`);
      const absolute = path.join(directory, entry.name);
      const info = lstatSync(absolute);
      if (entry.isSymbolicLink() || info.isSymbolicLink()) {
        throw new Error(`${label} must not contain symbolic links or junctions.`);
      }
      if (entry.isDirectory() && info.isDirectory()) {
        directories.push(relative);
        visit(absolute, relative, depth + 1);
      } else if (entry.isFile() && info.isFile()) {
        if (info.size <= 0 || info.size > maxPayloadFileBytes) {
          throw new Error(`${label} contains an empty or oversized file.`);
        }
        files.push({ path: relative, absolute, size: info.size });
        totalBytes += info.size;
        if (files.length > maxPayloadFiles || totalBytes > maxPayloadBytes) {
          throw new Error(`${label} exceeds the bounded file or byte count.`);
        }
      } else {
        throw new Error(`${label} contains an unsupported filesystem entry.`);
      }
    }
  }

  visit(root, '', 0);
  return { files, directories, totalBytes };
}

function expectedDirectoriesFor(files) {
  const directories = new Set();
  for (const file of files) {
    let directory = path.posix.dirname(file);
    while (directory !== '.') {
      directories.add(directory);
      directory = path.posix.dirname(directory);
    }
  }
  return [...directories].sort();
}

function assertSameStringSet(actual, expected, label) {
  const left = [...actual].sort();
  const right = [...expected].sort();
  if (left.length !== right.length || left.some((value, index) => value !== right[index])) {
    throw new Error(`${label} does not exactly match its manifest.`);
  }
}

function sanitizedBuildEnvironment(environment) {
  const blocked = /(?:TAURI_SIGNING_PRIVATE_KEY|WINDOWS_PFX|CERTIFICATE|PFX_PASSWORD)/i;
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) =>
      !blocked.test(name) && name.toUpperCase() !== 'PSMODULEPATH'),
  );
}

function run(command, args, environment = process.env) {
  execFileSync(command, args, {
    cwd: repositoryRoot,
    env: environment,
    stdio: 'inherit',
    windowsHide: true,
  });
}

function resolvePinnedNode() {
  const configured = requiredEnvironment('PROVENANCE_BUNDLED_NODE');
  if (!path.isAbsolute(configured)) {
    throw new Error('PROVENANCE_BUNDLED_NODE must be an absolute path.');
  }
  let resolved;
  try {
    resolved = realpathSync(configured);
  } catch {
    throw new Error('PROVENANCE_BUNDLED_NODE must resolve to a readable file.');
  }
  if (!statSync(resolved).isFile() || path.basename(resolved).toLowerCase() !== 'node.exe') {
    throw new Error('PROVENANCE_BUNDLED_NODE must resolve to node.exe.');
  }
  const expected = requiredEnvironment('PROVENANCE_BUNDLED_NODE_SHA256').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expected) || digestFile(resolved) !== expected) {
    throw new Error('PROVENANCE_BUNDLED_NODE_SHA256 does not match the exact Node executable.');
  }
  const signerThumbprint = validateCertificateThumbprint(
    requiredEnvironment('PROVENANCE_BUNDLED_NODE_SIGNER_THUMBPRINT'),
    'PROVENANCE_BUNDLED_NODE_SIGNER_THUMBPRINT',
  );
  verifyAuthenticode(resolved, signerThumbprint, 'Pinned Node runtime');
  const expectedVersion = requiredEnvironment('PROVENANCE_BUNDLED_NODE_VERSION');
  let runtime;
  try {
    runtime = JSON.parse(execFileSync(resolved, [
      '-p',
      'JSON.stringify({version:process.version,arch:process.arch,platform:process.platform})',
    ], {
      encoding: 'utf8',
      env: sanitizedBuildEnvironment(process.env),
      windowsHide: true,
    }).trim());
  } catch {
    throw new Error('PROVENANCE_BUNDLED_NODE must be an executable Node runtime.');
  }
  if (runtime.version !== expectedVersion || runtime.arch !== 'x64' || runtime.platform !== 'win32') {
    throw new Error('The bundled Node runtime must match the declared version and Windows x64 platform.');
  }

  const licenseInput = requiredEnvironment('PROVENANCE_BUNDLED_NODE_LICENSE');
  let licensePath;
  try {
    licensePath = realpathSync(licenseInput);
  } catch {
    throw new Error('PROVENANCE_BUNDLED_NODE_LICENSE must resolve to a readable file.');
  }
  const licenseInfo = statSync(licensePath);
  if (!licenseInfo.isFile() || licenseInfo.size <= 0 || licenseInfo.size > 1024 * 1024) {
    throw new Error('PROVENANCE_BUNDLED_NODE_LICENSE must be a bounded non-empty file.');
  }
  const licenseSha256 = requiredEnvironment('PROVENANCE_BUNDLED_NODE_LICENSE_SHA256').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(licenseSha256) || digestFile(licensePath) !== licenseSha256) {
    throw new Error('PROVENANCE_BUNDLED_NODE_LICENSE_SHA256 does not match the exact license file.');
  }
  return {
    path: resolved,
    sha256: expected,
    signerThumbprint,
    version: runtime.version,
    architecture: runtime.arch,
    licensePath,
    licenseSha256,
  };
}

function releaseVersion() {
  const configVersion = JSON.parse(readFileSync(baseConfigPath, 'utf8')).version;
  const packageVersion = JSON.parse(readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')).version;
  const lockVersion = JSON.parse(readFileSync(path.join(repositoryRoot, 'package-lock.json'), 'utf8')).packages?.['']?.version;
  const cargo = readFileSync(path.join(tauriRoot, 'Cargo.toml'), 'utf8');
  const cargoVersion = cargo.match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1];
  const versions = { tauri: configVersion, package: packageVersion, packageLock: lockVersion, cargo: cargoVersion };
  if (typeof configVersion !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(configVersion)) {
    throw new Error('The Tauri application version must be explicit SemVer.');
  }
  if (Object.values(versions).some((version) => version !== configVersion)) {
    throw new Error(`Release version mismatch: ${JSON.stringify(versions)}.`);
  }
  return configVersion;
}

function resolveTauriCliContract() {
  const packageJsonPath = path.join(repositoryRoot, 'package.json');
  const packageLockPath = path.join(repositoryRoot, 'package-lock.json');
  const installedManifestPath = path.join(
    repositoryRoot,
    'node_modules',
    '@tauri-apps',
    'cli',
    'package.json',
  );
  assertRegularFile(packageJsonPath, 'package.json', 4 * 1024 * 1024);
  assertRegularFile(packageLockPath, 'package-lock.json', 64 * 1024 * 1024);
  assertRegularFile(installedManifestPath, 'Installed Tauri CLI manifest', 1024 * 1024);
  assertRegularFile(tauriCliPath, 'Installed Tauri CLI entrypoint', 4 * 1024 * 1024);
  const packageJson = readBoundedJson(packageJsonPath, 'package.json', 4 * 1024 * 1024);
  const packageLock = readBoundedJson(packageLockPath, 'package-lock.json', 64 * 1024 * 1024);
  const installed = readBoundedJson(installedManifestPath, 'Installed Tauri CLI manifest');
  const declared = packageJson.devDependencies?.['@tauri-apps/cli'];
  const lockedDeclaration = packageLock.packages?.['']?.devDependencies?.['@tauri-apps/cli'];
  const lockedVersion = packageLock.packages?.['node_modules/@tauri-apps/cli']?.version;
  if (declared !== supportedTauriCliVersion || lockedDeclaration !== supportedTauriCliVersion ||
      lockedVersion !== supportedTauriCliVersion || installed.version !== supportedTauriCliVersion) {
    throw new Error(`The Tauri bundler contract requires exact @tauri-apps/cli ${supportedTauriCliVersion}.`);
  }
  return {
    version: supportedTauriCliVersion,
    packageLockSha256: digestFile(packageLockPath),
  };
}

function validateSandboxImage(value) {
  if (!/^[a-z0-9]+(?:[._:-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error('PROVENANCE_SANDBOX_IMAGE must be registry/repository@sha256:<64 lowercase hex>.');
  }
  return value;
}

function validateCertificateThumbprint(
  value,
  name = 'PROVENANCE_WINDOWS_CERTIFICATE_THUMBPRINT',
) {
  const normalized = value.replaceAll(' ', '').toUpperCase();
  if (!/^[A-F0-9]{40}$/.test(normalized)) {
    throw new Error(`${name} must be a 40-character SHA-1 certificate thumbprint.`);
  }
  return normalized;
}

function declaredCargoAboutPins() {
  const configured = requiredEnvironment('PROVENANCE_CARGO_ABOUT');
  if (!path.isAbsolute(configured)) {
    throw new Error('PROVENANCE_CARGO_ABOUT must be an exact absolute executable path.');
  }
  let executable;
  try {
    assertRegularFile(configured, 'PROVENANCE_CARGO_ABOUT', 64 * 1024 * 1024);
    executable = realpathSync(configured);
  } catch {
    throw new Error('PROVENANCE_CARGO_ABOUT must resolve to a bounded regular executable file.');
  }
  if (path.basename(executable).toLowerCase() !== 'cargo-about.exe') {
    throw new Error('PROVENANCE_CARGO_ABOUT must resolve to cargo-about.exe.');
  }
  const sha256 = requiredEnvironment('PROVENANCE_CARGO_ABOUT_SHA256').toLowerCase();
  if (!isSha256(sha256) || digestFile(executable) !== sha256) {
    throw new Error('PROVENANCE_CARGO_ABOUT_SHA256 does not match the exact cargo-about executable.');
  }
  const version = requiredEnvironment('PROVENANCE_CARGO_ABOUT_VERSION');
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error('PROVENANCE_CARGO_ABOUT_VERSION must be an exact semantic version.');
  }
  let versionOutput;
  try {
    versionOutput = execFileSync(executable, ['--version'], {
      encoding: 'utf8',
      env: sanitizedBuildEnvironment(process.env),
      windowsHide: true,
    }).trim();
  } catch {
    throw new Error('PROVENANCE_CARGO_ABOUT must be an executable cargo-about binary.');
  }
  if (versionOutput !== `cargo-about ${version}`) {
    throw new Error('The cargo-about executable does not match PROVENANCE_CARGO_ABOUT_VERSION.');
  }
  return { executable, sha256, version };
}

function createReleasePlan() {
  const updaterPublicKey = validateUpdaterPublicKey(requiredEnvironment('PROVENANCE_UPDATER_PUBLIC_KEY'));
  const updaterEndpoint = validateHttpsUrl(
    'PROVENANCE_UPDATER_ENDPOINT',
    requiredEnvironment('PROVENANCE_UPDATER_ENDPOINT'),
    { requireStaticManifest: true },
  );
  const sandboxImage = validateSandboxImage(requiredEnvironment('PROVENANCE_SANDBOX_IMAGE'));
  const version = releaseVersion();
  const tauriCli = resolveTauriCliContract();
  const cargoLockPath = path.join(tauriRoot, 'Cargo.lock');
  assertRegularFile(cargoLockPath, 'Cargo.lock', 16 * 1024 * 1024);
  const node = resolvePinnedNode();
  const cargoAbout = declaredCargoAboutPins();
  return {
    version,
    node,
    cargoAbout,
    tauriCli,
    cargoLockSha256: digestFile(cargoLockPath),
    updaterEndpoint,
    updaterPublicKey,
    sandboxImage,
    dynamicConfig: {
      bundle: {
        createUpdaterArtifacts: false,
      },
      plugins: {
        updater: {
          pubkey: updaterPublicKey,
          endpoints: [updaterEndpoint],
          dangerousInsecureTransportProtocol: false,
          windows: { installMode: 'passive' },
        },
      },
    },
  };
}

function publicPlan(plan) {
  const rustNotices = path.join(repositoryRoot, 'dist', 'RUST_THIRD_PARTY_NOTICES.txt');
  let rustThirdPartyNoticesSha256 = null;
  if (existsSync(rustNotices)) {
    assertRegularFile(rustNotices, 'Rust third-party notice inventory', 16 * 1024 * 1024);
    rustThirdPartyNoticesSha256 = digestFile(rustNotices);
  }
  return {
    schemaVersion: 1,
    version: plan.version,
    targets: ['nsis'],
    updaterArtifacts: 'protected_signing_job',
    updaterEndpoint: plan.updaterEndpoint,
    updaterEndpointOrigin: new URL(plan.updaterEndpoint).origin,
    updaterPublicKeySha256: digestText(plan.updaterPublicKey),
    nodeSha256: plan.node.sha256,
    nodeSignerThumbprint: plan.node.signerThumbprint,
    nodeVersion: plan.node.version,
    nodeArchitecture: plan.node.architecture,
    nodeResource: 'node/node.exe',
    nodeLicenseResource: 'node/LICENSE',
    nodeLicenseSha256: plan.node.licenseSha256,
    cargoAboutSha256: plan.cargoAbout.sha256,
    cargoAboutVersion: plan.cargoAbout.version,
    tauriCliVersion: plan.tauriCli.version,
    packageLockSha256: plan.tauriCli.packageLockSha256,
    cargoLockSha256: plan.cargoLockSha256,
    rustThirdPartyNoticesResource: 'dist/RUST_THIRD_PARTY_NOTICES.txt',
    rustThirdPartyNoticesSha256,
    rustThirdPartyNoticesHashBinding: 'unsigned-payload-manifest',
    serverResource: 'dist/server.cjs',
    packagedDistResources: [
      'dist/server.cjs',
      'dist/index.html',
      'dist/assets',
      'dist/THIRD_PARTY_NOTICES.txt',
      'dist/RUST_THIRD_PARTY_NOTICES.txt',
    ],
    nsisInstallMode: 'currentUser',
    updaterInstallMode: 'passive',
    authenticode: 'protected_signing_job',
    unsignedPayload: {
      kind: payloadKind,
      native: nativePayloadPath,
      manifest: payloadManifestName,
      symlinks: 'forbidden',
      contents: 'exact-manifest-only',
    },
    releaseCommands: {
      buildUnsigned: 'build-unsigned',
      verifyUnsigned: 'verify-unsigned <payload>',
      bundleSignedNative: 'bundle-signed-native <unsigned-payload>',
      manifest:
        'manifest <artifact.exe> <latest.json> <bundled-release.json> <unsigned-payload> <signed-native-capture>',
    },
    sandboxImage: plan.sandboxImage,
  };
}

function freshReleaseTarget() {
  const configured = requiredEnvironment('PROVENANCE_RELEASE_TARGET_DIR');
  if (!path.isAbsolute(configured)) {
    throw new Error('PROVENANCE_RELEASE_TARGET_DIR must be an absolute fresh directory.');
  }
  const target = path.resolve(configured);
  if (existsSync(target)) {
    assertDirectory(target, 'PROVENANCE_RELEASE_TARGET_DIR');
    if (readdirSync(target).length > 0) {
      throw new Error('PROVENANCE_RELEASE_TARGET_DIR must be empty to exclude stale release artifacts.');
    }
  }
  mkdirSync(target, { recursive: true });
  return target;
}

function findNsisInstaller(target, version) {
  const directory = path.join(target, 'release', 'bundle', 'nsis');
  if (!existsSync(directory)) throw new Error('Tauri did not create the NSIS bundle directory.');
  const candidates = readdirSync(directory)
    .filter((name) => name.toLowerCase().endsWith('-setup.exe') && name.includes(version))
    .map((name) => path.join(directory, name));
  if (candidates.length !== 1) {
    throw new Error(`Expected exactly one NSIS installer for ${version}; found ${candidates.length}.`);
  }
  assertRegularFile(candidates[0], 'NSIS installer');
  return candidates[0];
}

function policyForPlan(plan, rustThirdPartyNoticesSha256) {
  if (!isSha256(rustThirdPartyNoticesSha256)) {
    throw new Error('Rust third-party notice inventory must have an exact SHA-256 binding.');
  }
  return {
    updaterEndpoint: plan.updaterEndpoint,
    updaterPublicKeySha256: digestText(plan.updaterPublicKey),
    nodeSha256: plan.node.sha256,
    nodeSignerThumbprint: plan.node.signerThumbprint,
    nodeVersion: plan.node.version,
    nodeArchitecture: plan.node.architecture,
    nodeLicenseSha256: plan.node.licenseSha256,
    cargoAboutSha256: plan.cargoAbout.sha256,
    cargoAboutVersion: plan.cargoAbout.version,
    tauriCliVersion: plan.tauriCli.version,
    packageLockSha256: plan.tauriCli.packageLockSha256,
    cargoLockSha256: plan.cargoLockSha256,
    rustThirdPartyNoticesSha256,
    sandboxImage: plan.sandboxImage,
  };
}

function discoverResourceSpecifications(plan) {
  const distDirectory = path.join(repositoryRoot, 'dist');
  const assetsDirectory = path.join(distDirectory, 'assets');
  const assetInventory = inventoryTree(assetsDirectory, 'Production dist/assets');
  if (assetInventory.files.length === 0) {
    throw new Error('Production dist/assets must contain at least one built asset.');
  }
  const specifications = [
    {
      source: path.join(distDirectory, 'server.cjs'),
      destination: 'dist/server.cjs',
      role: 'application-server',
    },
    {
      source: path.join(distDirectory, 'index.html'),
      destination: 'dist/index.html',
      role: 'application-ui',
    },
    ...assetInventory.files.map((asset) => ({
      source: asset.absolute,
      destination: `dist/assets/${asset.path}`,
      role: 'application-ui',
    })),
    {
      source: path.join(distDirectory, 'THIRD_PARTY_NOTICES.txt'),
      destination: 'dist/THIRD_PARTY_NOTICES.txt',
      role: 'third-party-notices',
    },
    {
      source: path.join(distDirectory, 'RUST_THIRD_PARTY_NOTICES.txt'),
      destination: 'dist/RUST_THIRD_PARTY_NOTICES.txt',
      role: 'native-third-party-notices',
    },
    {
      source: plan.node.path,
      destination: 'node/node.exe',
      role: 'bundled-runtime',
    },
    {
      source: plan.node.licensePath,
      destination: 'node/LICENSE',
      role: 'runtime-license',
    },
  ];
  specifications.sort((left, right) => left.destination.localeCompare(right.destination, 'en'));
  return specifications;
}

function copyRegularFile(source, destination, label) {
  assertRegularFile(source, label);
  mkdirSync(path.dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  assertRegularFile(destination, `Staged ${label}`);
}

function verifyStagedBundleResources(staged) {
  const inventory = inventoryTree(staged.root, 'Fresh-target bundle resources');
  const expectedFiles = staged.resources.map((resource) => resource.destination);
  assertSameStringSet(
    inventory.files.map((entry) => entry.path),
    expectedFiles,
    'Fresh-target bundle resource file tree',
  );
  assertSameStringSet(
    inventory.directories,
    expectedDirectoriesFor(expectedFiles),
    'Fresh-target bundle resource directory tree',
  );
  for (const resource of staged.resources) {
    const info = assertRegularFile(
      resource.source,
      `Fresh-target resource ${resource.destination}`,
    );
    if (info.size !== resource.size || digestFile(resource.source) !== resource.sha256) {
      throw new Error(`Fresh-target resource ${resource.destination} changed after payload verification.`);
    }
  }
}

function stageBundleResources(verified, target) {
  const root = path.join(target, 'release', 'staged-resources');
  if (existsSync(root)) throw new Error('The fresh-target bundle resource directory already exists.');
  mkdirSync(root, { recursive: true });
  const resources = verified.manifest.resources.map((resource) => {
    const source = path.join(root, ...resource.destination.split('/'));
    const payloadSource = path.join(verified.payload, ...resource.path.split('/'));
    copyRegularFile(payloadSource, source, `bundle resource ${resource.destination}`);
    return { ...resource, source };
  });
  const staged = {
    root,
    resources,
    nodePath: resources.find((resource) => resource.destination === 'node/node.exe')?.source,
  };
  if (!staged.nodePath) throw new Error('The staged bundle is missing its pinned Node runtime.');
  verifyStagedBundleResources(staged);
  return staged;
}

function stageUnsignedPayload(plan, nativeBinary, payload) {
  if (existsSync(payload)) throw new Error('The unsigned payload directory already exists.');
  assertRegularFile(nativeBinary, 'Unsigned native executable');
  mkdirSync(payload, { recursive: false });
  const stagedNative = path.join(payload, ...nativePayloadPath.split('/'));
  copyRegularFile(nativeBinary, stagedNative, 'unsigned native executable');
  const nativeBundleMarkerOffset = verifyUnsignedBundleMarker(
    readFileSync(stagedNative),
    'Unsigned native executable',
  );

  const resources = discoverResourceSpecifications(plan).map((specification) => {
    const resourcePath = `resources/${specification.destination}`;
    const staged = path.join(payload, ...resourcePath.split('/'));
    copyRegularFile(specification.source, staged, `resource ${specification.destination}`);
    const info = assertRegularFile(staged, `Staged resource ${specification.destination}`);
    return {
      path: resourcePath,
      destination: specification.destination,
      role: specification.role,
      sha256: digestFile(staged),
      size: info.size,
    };
  });
  const nativeInfo = assertRegularFile(stagedNative, 'Staged unsigned native executable');
  const rustNotices = resources.find(
    (resource) => resource.destination === 'dist/RUST_THIRD_PARTY_NOTICES.txt',
  );
  const manifest = {
    schemaVersion: 1,
    kind: payloadKind,
    version: plan.version,
    platform: releasePlatform,
    native: {
      path: nativePayloadPath,
      sha256: digestFile(stagedNative),
      size: nativeInfo.size,
      bundleTypeMarker: {
        value: bundleTypeUnknown.toString('ascii'),
        offset: nativeBundleMarkerOffset,
      },
    },
    resources,
    policy: policyForPlan(plan, rustNotices?.sha256),
  };
  const manifestPath = path.join(payload, payloadManifestName);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  return { manifest, manifestPath, stagedNative };
}

function validateResourceDestination(destination) {
  canonicalRelativePath(destination, 'Resource destination');
  if (requiredResourceDestinations.has(destination)) return destination;
  if (destination.startsWith('dist/assets/') || destination.startsWith('dist/notices/')) {
    return destination;
  }
  throw new Error(`Unsigned payload resource destination ${destination} is not allowed.`);
}

function validateUnsignedManifest(value, plan) {
  assertExactKeys(
    value,
    ['schemaVersion', 'kind', 'version', 'platform', 'native', 'resources', 'policy'],
    'Unsigned payload manifest',
  );
  if (value.schemaVersion !== 1 || value.kind !== payloadKind ||
      value.version !== plan.version || value.platform !== releasePlatform) {
    throw new Error('Unsigned payload identity does not match the current production release.');
  }
  assertExactKeys(
    value.native,
    ['path', 'sha256', 'size', 'bundleTypeMarker'],
    'Unsigned payload native record',
  );
  if (value.native.path !== nativePayloadPath || !isSha256(value.native.sha256)) {
    throw new Error('Unsigned payload native record is invalid.');
  }
  assertSafeInteger(value.native.size, 'Unsigned payload native size', {
    minimum: 1,
    maximum: maxPayloadFileBytes,
  });
  assertExactKeys(
    value.native.bundleTypeMarker,
    ['value', 'offset'],
    'Unsigned payload native bundle marker',
  );
  if (value.native.bundleTypeMarker.value !== bundleTypeUnknown.toString('ascii')) {
    throw new Error('Unsigned payload native bundle marker is invalid.');
  }
  assertSafeInteger(
    value.native.bundleTypeMarker.offset,
    'Unsigned payload native bundle marker offset',
    { minimum: 1, maximum: value.native.size - bundleTypeUnknown.length },
  );
  if (!Array.isArray(value.resources) || value.resources.length === 0 ||
      value.resources.length > maxPayloadFiles) {
    throw new Error('Unsigned payload resources must be a bounded non-empty list.');
  }

  const destinations = new Set();
  const resourcePaths = new Set();
  let previousPath = '';
  for (const [index, resource] of value.resources.entries()) {
    const label = `Unsigned payload resource ${index}`;
    assertExactKeys(resource, ['path', 'destination', 'role', 'sha256', 'size'], label);
    canonicalRelativePath(resource.path, `${label} path`);
    validateResourceDestination(resource.destination);
    if (resource.path !== `resources/${resource.destination}`) {
      throw new Error(`${label} path must be derived from its bundle destination.`);
    }
    if (typeof resource.role !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(resource.role) ||
        !isSha256(resource.sha256)) {
      throw new Error(`${label} role or hash is invalid.`);
    }
    assertSafeInteger(resource.size, `${label} size`, {
      minimum: 1,
      maximum: maxPayloadFileBytes,
    });
    if (resource.path.localeCompare(previousPath, 'en') <= 0 ||
        resourcePaths.has(resource.path) || destinations.has(resource.destination)) {
      throw new Error('Unsigned payload resources must be uniquely sorted by path.');
    }
    previousPath = resource.path;
    resourcePaths.add(resource.path);
    destinations.add(resource.destination);
  }

  for (const [destination, role] of requiredResourceDestinations) {
    const resource = value.resources.find((candidate) => candidate.destination === destination);
    if (!resource || resource.role !== role) {
      throw new Error(`Unsigned payload is missing required ${destination} resource metadata.`);
    }
  }
  const assets = value.resources.filter((resource) => resource.destination.startsWith('dist/assets/'));
  if (assets.length === 0 || assets.some((resource) => resource.role !== 'application-ui')) {
    throw new Error('Unsigned payload must contain application-ui assets.');
  }

  assertExactKeys(
    value.policy,
    [
      'updaterEndpoint',
      'updaterPublicKeySha256',
      'nodeSha256',
      'nodeSignerThumbprint',
      'nodeVersion',
      'nodeArchitecture',
      'nodeLicenseSha256',
      'cargoAboutSha256',
      'cargoAboutVersion',
      'tauriCliVersion',
      'packageLockSha256',
      'cargoLockSha256',
      'rustThirdPartyNoticesSha256',
      'sandboxImage',
    ],
    'Unsigned payload policy',
  );
  const rustNotices = value.resources.find(
    (resource) => resource.destination === 'dist/RUST_THIRD_PARTY_NOTICES.txt',
  );
  if (JSON.stringify(value.policy) !==
      JSON.stringify(policyForPlan(plan, rustNotices?.sha256))) {
    throw new Error('Unsigned payload policy does not match the current production pins.');
  }
  const nodeResource = value.resources.find((resource) => resource.destination === 'node/node.exe');
  const licenseResource = value.resources.find((resource) => resource.destination === 'node/LICENSE');
  if (nodeResource.sha256 !== plan.node.sha256 || licenseResource.sha256 !== plan.node.licenseSha256) {
    throw new Error('Unsigned payload runtime resources do not match the current production pins.');
  }
  return value;
}

function resolvePayloadDirectory(payloadInput) {
  const candidate = path.resolve(payloadInput);
  assertDirectory(candidate, 'Unsigned payload');
  const payload = realpathSync(candidate);
  assertDirectory(payload, 'Unsigned payload');
  return payload;
}

function verifyUnsignedPayload(payloadInput, plan) {
  const payload = resolvePayloadDirectory(payloadInput);
  const inventory = inventoryTree(payload, 'Unsigned payload');
  const manifestPath = path.join(payload, payloadManifestName);
  const manifest = validateUnsignedManifest(
    readBoundedJson(manifestPath, 'Unsigned payload manifest'),
    plan,
  );
  const expectedFiles = [
    payloadManifestName,
    manifest.native.path,
    ...manifest.resources.map((resource) => resource.path),
  ];
  assertSameStringSet(
    inventory.files.map((entry) => entry.path),
    expectedFiles,
    'Unsigned payload file tree',
  );
  assertSameStringSet(
    inventory.directories,
    expectedDirectoriesFor(expectedFiles),
    'Unsigned payload directory tree',
  );

  for (const resource of manifest.resources) {
    const file = path.join(payload, ...resource.path.split('/'));
    const info = assertRegularFile(file, `Unsigned payload ${resource.destination}`);
    if (info.size !== resource.size || digestFile(file) !== resource.sha256) {
      throw new Error(`Unsigned payload resource ${resource.destination} does not match its hash manifest.`);
    }
  }
  const nativePath = path.join(payload, ...manifest.native.path.split('/'));
  const nativeInfo = assertRegularFile(nativePath, 'Unsigned payload native executable');
  const nativeBytes = readFileSync(nativePath);
  const nativeSha256 = digestFile(nativePath);
  if (nativeInfo.size !== manifest.native.size || nativeSha256 !== manifest.native.sha256) {
    throw new Error('Unsigned payload native executable does not match its hash manifest.');
  }
  const markerOffset = verifyUnsignedBundleMarker(nativeBytes, 'Unsigned payload native executable');
  if (markerOffset !== manifest.native.bundleTypeMarker.offset) {
    throw new Error('Unsigned payload native bundle marker does not match its manifest.');
  }
  verifyUnsignedAuthenticode(nativePath);

  return {
    payload,
    manifest,
    manifestPath,
    manifestSha256: digestFile(manifestPath),
    nativePath,
    nativeSha256,
  };
}

function buildUnsignedRelease(plan) {
  if (process.platform !== 'win32') throw new Error('Windows desktop releases must be built on Windows.');
  const target = freshReleaseTarget();
  const buildEnvironment = sanitizedBuildEnvironment(process.env);
  run('npm.cmd', ['run', 'build'], buildEnvironment);
  run('npm.cmd', ['run', 'desktop:licenses'], buildEnvironment);
  run('npm.cmd', [
    'run', 'desktop:resource-smoke', '--',
    '--node', plan.node.path,
    '--expected-sha256', plan.node.sha256,
    '--expected-version', plan.node.version,
    '--expected-arch', plan.node.architecture,
  ], buildEnvironment);
  for (const required of [
    path.join(repositoryRoot, 'dist', 'server.cjs'),
    path.join(repositoryRoot, 'dist', 'index.html'),
    path.join(repositoryRoot, 'dist', 'THIRD_PARTY_NOTICES.txt'),
    path.join(repositoryRoot, 'dist', 'RUST_THIRD_PARTY_NOTICES.txt'),
    path.join(repositoryRoot, 'dist', 'assets'),
  ]) {
    if (!existsSync(required)) {
      throw new Error(`Production build did not create ${path.relative(repositoryRoot, required)}.`);
    }
  }
  if (!existsSync(tauriCliPath)) throw new Error('Install JavaScript dependencies with npm ci before packaging.');
  const tauriEnvironment = {
    ...buildEnvironment,
    CARGO_TARGET_DIR: target,
    PROVENANCE_PACKAGED_RELEASE: '1',
    PROVENANCE_SANDBOX_IMAGE: plan.sandboxImage,
  };
  run(process.execPath, [
    tauriCliPath,
    'build',
    '--ci',
    '--no-bundle',
    '--no-sign',
    '--config', baseConfigPath,
    '--config', releaseConfigPath,
    '--config', JSON.stringify(plan.dynamicConfig),
  ], tauriEnvironment);
  const native = path.join(target, 'release', nativeBinaryName);
  assertRegularFile(native, 'Tauri unsigned native executable');
  verifyUnsignedAuthenticode(native);
  const payload = path.join(target, 'unsigned-payload');
  stageUnsignedPayload(plan, native, payload);
  const verified = verifyUnsignedPayload(payload, plan);
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    payload: verified.payload,
    manifest: verified.manifestPath,
    manifestSha256: verified.manifestSha256,
    nativeSha256: verified.nativeSha256,
    cargoLockSha256: verified.manifest.policy.cargoLockSha256,
    cargoAboutSha256: verified.manifest.policy.cargoAboutSha256,
    cargoAboutVersion: verified.manifest.policy.cargoAboutVersion,
    tauriCliVersion: verified.manifest.policy.tauriCliVersion,
    packageLockSha256: verified.manifest.policy.packageLockSha256,
    rustThirdPartyNoticesSha256:
      verified.manifest.policy.rustThirdPartyNoticesSha256,
  })}\n`);
}

function readAuthenticode(artifact) {
  if (process.platform !== 'win32') throw new Error('Authenticode verification must run on Windows.');
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$securityModule = Join-Path $PSHOME "Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1"',
    'Import-Module -Name $securityModule -RequiredVersion 3.0.0.0 -Force -ErrorAction Stop',
    '$artifact = [Environment]::GetEnvironmentVariable("PROVENANCE_AUTHENTICODE_ARTIFACT")',
    'if ([string]::IsNullOrWhiteSpace($artifact)) { throw "Authenticode artifact is unavailable." }',
    '$signature = Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath $artifact',
    '$result = [pscustomobject]@{',
    '  status = [string]$signature.Status',
    '  signerThumbprint = if ($signature.SignerCertificate) { $signature.SignerCertificate.Thumbprint } else { $null }',
    '  timestampThumbprint = if ($signature.TimeStamperCertificate) { $signature.TimeStamperCertificate.Thumbprint } else { $null }',
    '}',
    '$result | ConvertTo-Json -Compress',
  ].join('\n');
  let result;
  try {
    result = JSON.parse(execFileSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', script,
    ], {
      encoding: 'utf8',
      windowsHide: true,
      env: {
        ...sanitizedBuildEnvironment(process.env),
        PROVENANCE_AUTHENTICODE_ARTIFACT: artifact,
      },
    }).trim());
  } catch {
    throw new Error('Authenticode verification could not be completed.');
  }
  return result;
}

function verifyUnsignedAuthenticode(artifact) {
  const result = readAuthenticode(artifact);
  if (result.status !== 'NotSigned' || result.signerThumbprint || result.timestampThumbprint) {
    throw new Error('Unsigned native executable must not contain an Authenticode signature.');
  }
  return { status: 'not-signed' };
}

function verifyAuthenticode(artifact, expectedThumbprint, label = 'Installer') {
  const result = readAuthenticode(artifact);
  if (result.status !== 'Valid' ||
      result.signerThumbprint?.toUpperCase() !== expectedThumbprint ||
      typeof result.timestampThumbprint !== 'string' || !/^[A-Fa-f0-9]{40}$/.test(result.timestampThumbprint)) {
    throw new Error(`${label} Authenticode signature, signer, or RFC3161 timestamp is invalid.`);
  }
  return {
    status: 'valid',
    signerThumbprint: expectedThumbprint,
    timestamped: true,
  };
}

function parsePortableExecutable(bytes, label) {
  if (bytes.length < 256 || bytes.subarray(0, 2).toString('ascii') !== 'MZ') {
    throw new Error(`${label} is not a bounded PE executable.`);
  }
  const peOffset = bytes.readUInt32LE(0x3c);
  if (peOffset < 0x40 || peOffset + 24 > bytes.length ||
      bytes.subarray(peOffset, peOffset + 4).toString('ascii') !== 'PE\0\0') {
    throw new Error(`${label} has an invalid PE header.`);
  }
  const optionalHeader = peOffset + 24;
  const optionalHeaderSize = bytes.readUInt16LE(peOffset + 20);
  if (optionalHeaderSize < 120 || optionalHeader + optionalHeaderSize > bytes.length) {
    throw new Error(`${label} has an invalid PE optional header.`);
  }
  const magic = bytes.readUInt16LE(optionalHeader);
  if (![0x10b, 0x20b].includes(magic)) {
    throw new Error(`${label} uses an unsupported PE format.`);
  }
  const numberOfDirectoriesOffset = optionalHeader + (magic === 0x20b ? 108 : 92);
  const dataDirectories = optionalHeader + (magic === 0x20b ? 112 : 96);
  const checksumOffset = optionalHeader + 64;
  const securityDirectoryOffset = dataDirectories + (4 * 8);
  if (bytes.readUInt32LE(numberOfDirectoriesOffset) < 5 ||
      securityDirectoryOffset + 8 > optionalHeader + optionalHeaderSize) {
    throw new Error(`${label} does not expose the PE security directory.`);
  }
  return {
    peOffset,
    optionalHeader,
    optionalHeaderSize,
    magic,
    checksumOffset,
    securityDirectoryOffset,
    certificateOffset: bytes.readUInt32LE(securityDirectoryOffset),
    certificateSize: bytes.readUInt32LE(securityDirectoryOffset + 4),
  };
}

function verifyAuthenticodeOnlyTransform(unsignedInput, signedInput) {
  assertRegularFile(unsignedInput, 'Manifest-bound unsigned native executable');
  assertRegularFile(
    signedInput,
    'Signed native executable',
    maxPayloadFileBytes + (16 * 1024 * 1024),
  );
  const unsigned = readFileSync(unsignedInput);
  const signed = readFileSync(signedInput);
  const before = parsePortableExecutable(unsigned, 'Manifest-bound unsigned native executable');
  const after = parsePortableExecutable(signed, 'Signed native executable');
  if (before.certificateOffset !== 0 || before.certificateSize !== 0) {
    throw new Error('Manifest-bound native executable already contains a PE certificate table.');
  }
  if (before.peOffset !== after.peOffset || before.optionalHeader !== after.optionalHeader ||
      before.optionalHeaderSize !== after.optionalHeaderSize || before.magic !== after.magic ||
      before.checksumOffset !== after.checksumOffset ||
      before.securityDirectoryOffset !== after.securityDirectoryOffset) {
    throw new Error('Authenticode signing changed the PE header layout.');
  }

  const bundleTypeOffset = verifyUnsignedBundleMarker(
    unsigned,
    'Manifest-bound unsigned native executable',
  );
  const signedPrefix = signed.subarray(0, unsigned.length);
  const signedUnknownOffsets = markerOffsets(signedPrefix, bundleTypeUnknown);
  const signedNsisOffsets = markerOffsets(signedPrefix, bundleTypeNsis);
  if (signedUnknownOffsets.length !== 0 || signedNsisOffsets.length !== 1 ||
      signedNsisOffsets[0] !== bundleTypeOffset) {
    throw new Error('Signed native executable must contain exactly the expected Tauri UNK-to-NSS patch.');
  }

  const expectedCertificateOffset = Math.ceil(unsigned.length / 8) * 8;
  if (after.certificateOffset !== expectedCertificateOffset ||
      after.certificateOffset % 8 !== 0 || after.certificateSize < 8 ||
      after.certificateSize % 8 !== 0 ||
      after.certificateOffset + after.certificateSize !== signed.length) {
    throw new Error('Authenticode certificate table must be aligned and terminate at exact EOF.');
  }
  if (signed.subarray(unsigned.length, after.certificateOffset).some((byte) => byte !== 0)) {
    throw new Error('Authenticode alignment padding must be zero-filled.');
  }
  const certificateLength = signed.readUInt32LE(after.certificateOffset);
  const certificateRevision = signed.readUInt16LE(after.certificateOffset + 4);
  const certificateType = signed.readUInt16LE(after.certificateOffset + 6);
  if (certificateLength < 8 || certificateLength > after.certificateSize ||
      Math.ceil(certificateLength / 8) * 8 !== after.certificateSize ||
      certificateRevision !== 0x0200 || certificateType !== 0x0002) {
    throw new Error('Authenticode WIN_CERTIFICATE metadata is invalid.');
  }
  if (signed.subarray(
    after.certificateOffset + certificateLength,
    after.certificateOffset + after.certificateSize,
  ).some((byte) => byte !== 0)) {
    throw new Error('Authenticode WIN_CERTIFICATE padding must be zero-filled.');
  }

  const normalizedUnsigned = Buffer.from(unsigned);
  const normalizedSigned = Buffer.from(signed.subarray(0, unsigned.length));
  bundleTypeUnknown.copy(normalizedSigned, bundleTypeOffset);
  normalizedUnsigned.writeUInt32LE(0, before.checksumOffset);
  normalizedSigned.writeUInt32LE(0, after.checksumOffset);
  normalizedUnsigned.fill(0, before.securityDirectoryOffset, before.securityDirectoryOffset + 8);
  normalizedSigned.fill(0, after.securityDirectoryOffset, after.securityDirectoryOffset + 8);
  if (normalizedUnsigned.length !== normalizedSigned.length ||
      !crypto.timingSafeEqual(normalizedUnsigned, normalizedSigned)) {
    throw new Error('Signed native executable contains changes outside the Authenticode envelope.');
  }
  return {
    schemaVersion: 1,
    unsignedSha256: digestFile(unsignedInput),
    signedSha256: digestFile(signedInput),
    certificateOffset: after.certificateOffset,
    certificateSize: after.certificateSize,
    certificateSha256: crypto.createHash('sha256')
      .update(signed.subarray(after.certificateOffset))
      .digest('hex'),
    bundleTypePatch: {
      offset: bundleTypeOffset,
      from: bundleTypeUnknown.toString('ascii'),
      to: bundleTypeNsis.toString('ascii'),
    },
  };
}

function resolveSignCommand() {
  assertRegularFile(signCommandPath, 'Windows signing command', 256 * 1024);
  const resolved = realpathSync(signCommandPath);
  if (resolved.toLowerCase() !== path.resolve(signCommandPath).toLowerCase()) {
    throw new Error('Windows signing command must resolve to the fixed repository script.');
  }
  const expected = requiredEnvironment('PROVENANCE_WINDOWS_SIGN_COMMAND_SHA256').toLowerCase();
  const actual = digestFile(resolved);
  if (!isSha256(expected) || expected !== actual) {
    throw new Error('PROVENANCE_WINDOWS_SIGN_COMMAND_SHA256 does not match the fixed signing script.');
  }
  return { path: resolved, sha256: actual };
}

function bundleConfigForPayload(plan, staged, signCommand) {
  const resources = Object.fromEntries(staged.resources.map((resource) => [
    resource.source,
    resource.destination,
  ]));
  return {
    ...plan.dynamicConfig,
    bundle: {
      createUpdaterArtifacts: false,
      resources,
      windows: {
        signCommand: {
          cmd: 'powershell.exe',
          args: [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            signCommand.path,
            '%1',
          ],
        },
      },
    },
  };
}

function bundleSignedNative(plan, payloadInput) {
  if (process.platform !== 'win32') throw new Error('Windows desktop releases must be bundled on Windows.');
  const certificateThumbprint = validateCertificateThumbprint(
    requiredEnvironment('PROVENANCE_WINDOWS_CERTIFICATE_THUMBPRINT'),
  );
  const timestampUrl = validateHttpsUrl(
    'PROVENANCE_WINDOWS_TIMESTAMP_URL',
    requiredEnvironment('PROVENANCE_WINDOWS_TIMESTAMP_URL'),
  );
  const signCommand = resolveSignCommand();
  const expectedManifestSha256 = requiredSha256Environment(
    'PROVENANCE_UNSIGNED_PAYLOAD_MANIFEST_SHA256',
  );
  const expectedNativeSha256 = requiredSha256Environment(
    'PROVENANCE_UNSIGNED_NATIVE_SHA256',
  );
  const payload = resolvePayloadDirectory(payloadInput);
  if (digestFile(path.join(payload, payloadManifestName)) !== expectedManifestSha256) {
    throw new Error('Unsigned payload manifest does not match the unsigned job hash attestation.');
  }
  const verified = verifyUnsignedPayload(payloadInput, plan);
  if (verified.manifestSha256 !== expectedManifestSha256 ||
      verified.manifest.native.sha256 !== expectedNativeSha256) {
    throw new Error('Unsigned payload does not match the unsigned job hash attestation.');
  }
  const target = freshReleaseTarget();
  const targetNative = path.join(target, 'release', nativeBinaryName);
  const nsisSigningTemp = path.join(target, 'release', 'nsis', 'signing-temp');
  const signedNativeCapture = path.join(
    target,
    'release',
    'attestation',
    'provenance-desktop-signed.exe',
  );
  mkdirSync(nsisSigningTemp, { recursive: true });
  mkdirSync(path.dirname(signedNativeCapture), { recursive: true });
  copyRegularFile(verified.nativePath, targetNative, 'unsigned native executable');
  if (digestFile(targetNative) !== verified.nativeSha256) {
    throw new Error('Unsigned native executable changed while entering the fresh bundle target.');
  }
  const staged = stageBundleResources(verified, target);
  if (!existsSync(tauriCliPath)) throw new Error('Install JavaScript dependencies with npm ci before packaging.');

  const bundleEnvironment = {
    ...sanitizedBuildEnvironment(process.env),
    CARGO_TARGET_DIR: target,
    PROVENANCE_PACKAGED_RELEASE: '1',
    PROVENANCE_SANDBOX_IMAGE: plan.sandboxImage,
    PROVENANCE_WINDOWS_CERTIFICATE_THUMBPRINT: certificateThumbprint,
    PROVENANCE_WINDOWS_TIMESTAMP_URL: timestampUrl,
    PROVENANCE_WINDOWS_SIGN_NATIVE_PATH: targetNative,
    PROVENANCE_WINDOWS_SIGN_CAPTURE_PATH: signedNativeCapture,
    PROVENANCE_WINDOWS_SIGN_STAGED_NODE_PATH: staged.nodePath,
    PROVENANCE_WINDOWS_SIGN_BUNDLE_ROOT: path.join(target, 'release', 'bundle'),
    PROVENANCE_WINDOWS_SIGN_NSIS_ROOT: nsisSigningTemp,
    PROVENANCE_WINDOWS_SIGN_EXPECTED_INSTALLER_NAME:
      `Provenance_${plan.version}_x64-setup.exe`,
    PROVENANCE_BUNDLED_NODE_SHA256: plan.node.sha256,
    PROVENANCE_BUNDLED_NODE_SIGNER_THUMBPRINT: plan.node.signerThumbprint,
    TEMP: nsisSigningTemp,
    TMP: nsisSigningTemp,
  };
  run(process.execPath, [
    tauriCliPath,
    'bundle',
    '--ci',
    '--bundles', 'nsis',
    '--config', baseConfigPath,
    '--config', releaseConfigPath,
    '--config', JSON.stringify(bundleConfigForPayload(plan, staged, signCommand)),
  ], bundleEnvironment);

  if (digestFile(targetNative) !== verified.nativeSha256) {
    throw new Error('Tauri did not restore the exact manifest-bound unsigned native after bundling.');
  }
  verifyUnsignedAuthenticode(targetNative);
  verifyStagedBundleResources(staged);
  const nativeTransform = verifyAuthenticodeOnlyTransform(verified.nativePath, signedNativeCapture);
  if (nativeTransform.bundleTypePatch.offset !== verified.manifest.native.bundleTypeMarker.offset) {
    throw new Error('The captured signed native patched a bundle marker outside the unsigned manifest.');
  }
  const nativeAuthenticode = verifyAuthenticode(
    signedNativeCapture,
    certificateThumbprint,
    'Captured native executable',
  );
  const installer = findNsisInstaller(target, plan.version);
  const installerAuthenticode = verifyAuthenticode(installer, certificateThumbprint, 'Installer');
  const record = {
    schemaVersion: 1,
    kind: bundleRecordKind,
    version: plan.version,
    platform: releasePlatform,
    sourcePayload: {
      manifestSha256: verified.manifestSha256,
      unsignedNativeSha256: verified.manifest.native.sha256,
      signedNativeSha256: nativeTransform.signedSha256,
      rustThirdPartyNoticesSha256: verified.manifest.policy.rustThirdPartyNoticesSha256,
    },
    signing: {
      command: 'scripts/windows-sign-command.ps1',
      commandSha256: signCommand.sha256,
      certificateThumbprint,
      timestampUrl,
      authenticode: nativeAuthenticode,
      nativeTransform,
      nativeCapture: {
        file: 'attestation/provenance-desktop-signed.exe',
        sha256: nativeTransform.signedSha256,
      },
    },
    installer: {
      file: path.basename(installer),
      sha256: digestFile(installer),
      authenticode: installerAuthenticode,
    },
    policy: verified.manifest.policy,
  };
  const recordPath = path.join(target, 'release', 'bundle', 'bundled-release.json');
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    installer,
    record: recordPath,
    recordSha256: digestFile(recordPath),
    payloadManifestSha256: verified.manifestSha256,
    signedNativeSha256: nativeTransform.signedSha256,
    signedNativeCapture,
  })}\n`);
}

function verifySignedInstaller(artifactInput) {
  const candidate = path.resolve(artifactInput);
  assertRegularFile(candidate, 'Updater artifact');
  const artifact = realpathSync(candidate);
  if (!artifact.toLowerCase().endsWith('.exe')) {
    throw new Error('The updater artifact must be an existing Windows .exe file.');
  }
  const signaturePath = `${artifact}.sig`;
  assertRegularFile(signaturePath, 'Tauri updater signature', 16 * 1024);
  const signature = readFileSync(signaturePath, 'utf8').trim();
  const publicKey = validateUpdaterPublicKey(requiredEnvironment('PROVENANCE_UPDATER_PUBLIC_KEY'));
  verifyUpdaterSignature(publicKey, signature, readFileSync(artifact));
  const expectedThumbprint = validateCertificateThumbprint(
    requiredEnvironment('PROVENANCE_WINDOWS_CERTIFICATE_THUMBPRINT'),
  );
  const authenticode = verifyAuthenticode(artifact, expectedThumbprint);
  return {
    artifact,
    signature,
    attestation: {
      schemaVersion: 1,
      version: releaseVersion(),
      platform: 'windows-x86_64-nsis',
      artifactFile: path.basename(artifact),
      artifactSha256: digestFile(artifact),
      updaterSignature: 'verified',
      updaterPublicKeySha256: digestText(publicKey),
      updaterEndpoint: validateHttpsUrl(
        'PROVENANCE_UPDATER_ENDPOINT',
        requiredEnvironment('PROVENANCE_UPDATER_ENDPOINT'),
        { requireStaticManifest: true },
      ),
      authenticode,
    },
  };
}

function validateAuthenticodeRecord(value, thumbprint, label) {
  assertExactKeys(value, ['status', 'signerThumbprint', 'timestamped'], label);
  if (value.status !== 'valid' || value.signerThumbprint !== thumbprint || value.timestamped !== true) {
    throw new Error(`${label} does not match the protected signing policy.`);
  }
  return value;
}

function validateNativeTransformRecord(value, sourcePayload) {
  assertExactKeys(
    value,
    [
      'schemaVersion',
      'unsignedSha256',
      'signedSha256',
      'certificateOffset',
      'certificateSize',
      'certificateSha256',
      'bundleTypePatch',
    ],
    'Bundled native Authenticode transform record',
  );
  if (value.schemaVersion !== 1 || !isSha256(value.certificateSha256) ||
      value.unsignedSha256 !== sourcePayload.unsignedNativeSha256 ||
      value.signedSha256 !== sourcePayload.signedNativeSha256) {
    throw new Error('Bundled native Authenticode transform hashes are invalid.');
  }
  assertSafeInteger(value.certificateOffset, 'Bundled certificate offset', { minimum: 256 });
  assertSafeInteger(value.certificateSize, 'Bundled certificate size', { minimum: 8 });
  if (value.certificateOffset % 8 !== 0 || value.certificateSize % 8 !== 0) {
    throw new Error('Bundled native certificate table is not aligned.');
  }
  assertExactKeys(
    value.bundleTypePatch,
    ['offset', 'from', 'to'],
    'Bundled native Tauri bundle-type patch',
  );
  assertSafeInteger(value.bundleTypePatch.offset, 'Bundled native bundle-type patch offset', {
    minimum: 1,
  });
  if (value.bundleTypePatch.from !== bundleTypeUnknown.toString('ascii') ||
      value.bundleTypePatch.to !== bundleTypeNsis.toString('ascii')) {
    throw new Error('Bundled native Tauri bundle-type patch is invalid.');
  }
  return value;
}

function validateBundledRecord(recordInput, verifiedInstaller, plan, payloadInput, signedNativeInput) {
  const candidate = path.resolve(recordInput);
  const record = readBoundedJson(candidate, 'Bundled release record');
  const recordPath = realpathSync(candidate);
  const recordSignaturePath = `${recordPath}.sig`;
  assertRegularFile(recordSignaturePath, 'Bundled release record signature', 16 * 1024);
  const recordSignature = readFileSync(recordSignaturePath, 'utf8').trim();
  verifyUpdaterSignature(plan.updaterPublicKey, recordSignature, readFileSync(recordPath));
  assertExactKeys(
    record,
    ['schemaVersion', 'kind', 'version', 'platform', 'sourcePayload', 'signing', 'installer', 'policy'],
    'Bundled release record',
  );
  if (record.schemaVersion !== 1 || record.kind !== bundleRecordKind ||
      record.version !== plan.version || record.platform !== releasePlatform) {
    throw new Error('Bundled release record identity is invalid.');
  }
  assertExactKeys(
    record.sourcePayload,
    [
      'manifestSha256',
      'unsignedNativeSha256',
      'signedNativeSha256',
      'rustThirdPartyNoticesSha256',
    ],
    'Bundled source payload record',
  );
  if (!isSha256(record.sourcePayload.manifestSha256) ||
      !isSha256(record.sourcePayload.unsignedNativeSha256) ||
      !isSha256(record.sourcePayload.signedNativeSha256) ||
      !isSha256(record.sourcePayload.rustThirdPartyNoticesSha256) ||
      record.sourcePayload.unsignedNativeSha256 === record.sourcePayload.signedNativeSha256) {
    throw new Error('Bundled source payload hashes are invalid.');
  }

  const thumbprint = validateCertificateThumbprint(
    requiredEnvironment('PROVENANCE_WINDOWS_CERTIFICATE_THUMBPRINT'),
  );
  const timestampUrl = validateHttpsUrl(
    'PROVENANCE_WINDOWS_TIMESTAMP_URL',
    requiredEnvironment('PROVENANCE_WINDOWS_TIMESTAMP_URL'),
  );
  const signCommand = resolveSignCommand();
  assertExactKeys(
    record.signing,
    [
      'command',
      'commandSha256',
      'certificateThumbprint',
      'timestampUrl',
      'authenticode',
      'nativeTransform',
      'nativeCapture',
    ],
    'Bundled signing record',
  );
  if (record.signing.command !== 'scripts/windows-sign-command.ps1' ||
      record.signing.commandSha256 !== signCommand.sha256 ||
      record.signing.certificateThumbprint !== thumbprint ||
      record.signing.timestampUrl !== timestampUrl) {
    throw new Error('Bundled signing record does not match the current production pins.');
  }
  validateAuthenticodeRecord(record.signing.authenticode, thumbprint, 'Bundled native Authenticode record');
  validateNativeTransformRecord(record.signing.nativeTransform, record.sourcePayload);
  assertExactKeys(record.signing.nativeCapture, ['file', 'sha256'], 'Bundled signed-native capture');
  if (record.signing.nativeCapture.file !== 'attestation/provenance-desktop-signed.exe' ||
      record.signing.nativeCapture.sha256 !== record.sourcePayload.signedNativeSha256) {
    throw new Error('Bundled signed-native capture record is invalid.');
  }

  assertExactKeys(record.installer, ['file', 'sha256', 'authenticode'], 'Bundled installer record');
  if (record.installer.file !== verifiedInstaller.attestation.artifactFile ||
      record.installer.sha256 !== verifiedInstaller.attestation.artifactSha256) {
    throw new Error('Bundled installer record does not match the signed updater artifact.');
  }
  validateAuthenticodeRecord(record.installer.authenticode, thumbprint, 'Bundled installer Authenticode record');
  if (JSON.stringify(record.installer.authenticode) !==
      JSON.stringify(verifiedInstaller.attestation.authenticode)) {
    throw new Error('Bundled installer Authenticode record does not match live verification.');
  }
  if (record.sourcePayload.rustThirdPartyNoticesSha256 !==
      record.policy?.rustThirdPartyNoticesSha256 ||
      JSON.stringify(record.policy) !== JSON.stringify(policyForPlan(
        plan,
        record.sourcePayload.rustThirdPartyNoticesSha256,
      ))) {
    throw new Error('Bundled release record does not match the current production policy.');
  }

  const verifiedPayload = verifyUnsignedPayload(payloadInput, plan);
  if (verifiedPayload.manifestSha256 !== record.sourcePayload.manifestSha256 ||
      verifiedPayload.nativeSha256 !== record.sourcePayload.unsignedNativeSha256 ||
      verifiedPayload.manifest.policy.rustThirdPartyNoticesSha256 !==
        record.sourcePayload.rustThirdPartyNoticesSha256) {
    throw new Error('Bundled release record does not match the preserved unsigned payload evidence.');
  }
  const signedNativeCandidate = path.resolve(signedNativeInput);
  assertRegularFile(
    signedNativeCandidate,
    'Preserved signed-native capture',
    maxPayloadFileBytes + (16 * 1024 * 1024),
  );
  const signedNative = realpathSync(signedNativeCandidate);
  if (path.basename(signedNative).toLowerCase() !== 'provenance-desktop-signed.exe') {
    throw new Error('Preserved signed-native capture has an unexpected identity.');
  }
  const liveTransform = verifyAuthenticodeOnlyTransform(verifiedPayload.nativePath, signedNative);
  const liveAuthenticode = verifyAuthenticode(signedNative, thumbprint, 'Preserved signed-native capture');
  if (liveTransform.bundleTypePatch.offset !==
        verifiedPayload.manifest.native.bundleTypeMarker.offset ||
      JSON.stringify(liveTransform) !== JSON.stringify(record.signing.nativeTransform) ||
      JSON.stringify(liveAuthenticode) !== JSON.stringify(record.signing.authenticode) ||
      digestFile(signedNative) !== record.signing.nativeCapture.sha256) {
    throw new Error('Bundled release record does not match the preserved signed-native evidence.');
  }
  const canonicalRecord = readFileSync(recordPath);
  return {
    record,
    path: recordPath,
    sha256: digestFile(recordPath),
    signature: recordSignature,
    signaturePath: realpathSync(recordSignaturePath),
    canonicalBase64: canonicalRecord.toString('base64'),
  };
}

function writeUpdaterManifest(
  artifactInput,
  outputInput,
  recordInput,
  payloadInput,
  signedNativeInput,
) {
  const plan = createReleasePlan();
  const verified = verifySignedInstaller(artifactInput);
  const bundled = validateBundledRecord(
    recordInput,
    verified,
    plan,
    payloadInput,
    signedNativeInput,
  );
  const endpoint = validateHttpsUrl(
    'PROVENANCE_UPDATER_ENDPOINT',
    requiredEnvironment('PROVENANCE_UPDATER_ENDPOINT'),
    { requireStaticManifest: true },
  );
  const attestation = {
    ...verified.attestation,
    bundle: {
      recordSha256: bundled.sha256,
      payloadManifestSha256: bundled.record.sourcePayload.manifestSha256,
      unsignedNativeSha256: bundled.record.sourcePayload.unsignedNativeSha256,
      signedNativeSha256: bundled.record.sourcePayload.signedNativeSha256,
      signCommandSha256: bundled.record.signing.commandSha256,
      nativeCertificateSha256:
        bundled.record.signing.nativeTransform.certificateSha256,
      bundleTypePatch: bundled.record.signing.nativeTransform.bundleTypePatch,
      cargoLockSha256: bundled.record.policy.cargoLockSha256,
      cargoAboutSha256: bundled.record.policy.cargoAboutSha256,
      cargoAboutVersion: bundled.record.policy.cargoAboutVersion,
      tauriCliVersion: bundled.record.policy.tauriCliVersion,
      packageLockSha256: bundled.record.policy.packageLockSha256,
      rustThirdPartyNoticesSha256:
        bundled.record.sourcePayload.rustThirdPartyNoticesSha256,
      signedRecord: {
        signature: bundled.signature,
        canonicalBase64: bundled.canonicalBase64,
      },
    },
  };
  const manifest = {
    version: verified.attestation.version,
    notes: `Provenance ${verified.attestation.version}`,
    platforms: {
      'windows-x86_64-nsis': {
        signature: verified.signature,
        url: new URL(encodeURIComponent(verified.attestation.artifactFile), endpoint).toString(),
      },
    },
    provenance: attestation,
  };
  const output = path.resolve(outputInput);
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  const attestationPath = path.join(path.dirname(output), 'release-attestation.json');
  writeFileSync(attestationPath, `${JSON.stringify(attestation, null, 2)}\n`, { flag: 'wx' });
  return { manifest: output, attestation: attestationPath, bundledRecord: bundled.path };
}

const command = process.argv[2];
try {
  if (![
    'plan',
    'build-unsigned',
    'verify-unsigned',
    'bundle-signed-native',
    'verify-authenticode-transform',
    'manifest',
    'verify',
    'probe-build-env',
  ].includes(command)) {
    throw new Error(
      'Usage: desktop-release.mjs plan | build-unsigned | verify-unsigned <payload> | bundle-signed-native <payload> | verify-authenticode-transform <unsigned.exe> <signed.exe> | manifest <artifact.exe> <latest.json> <bundled-release.json> <unsigned-payload> <signed-native-capture> | verify <artifact.exe>',
    );
  }
  if (command === 'probe-build-env') {
    const environment = sanitizedBuildEnvironment(process.env);
    process.stdout.write(`${JSON.stringify({
      privateKey: Object.hasOwn(environment, 'TAURI_SIGNING_PRIVATE_KEY'),
      privateKeyPassword: Object.hasOwn(environment, 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD'),
      pfx: Object.hasOwn(environment, 'WINDOWS_PFX_BASE64'),
      certificate: Object.hasOwn(environment, 'PROVENANCE_WINDOWS_CERTIFICATE_THUMBPRINT'),
      powerShellModulePath: Object.keys(environment).some(
        (name) => name.toUpperCase() === 'PSMODULEPATH',
      ),
      ordinaryMarker: environment.PROVENANCE_BUILD_MARKER === 'present',
    })}\n`);
  } else if (command === 'manifest') {
    const artifact = process.argv[3];
    const output = process.argv[4];
    const record = process.argv[5];
    const payload = process.argv[6];
    const signedNative = process.argv[7];
    if (!artifact || !output || !record || !payload || !signedNative) {
      throw new Error(
        'manifest requires an artifact, output path, bundled release record, unsigned payload, and signed-native capture.',
      );
    }
    process.stdout.write(`${JSON.stringify(writeUpdaterManifest(
      artifact,
      output,
      record,
      payload,
      signedNative,
    ))}\n`);
  } else if (command === 'verify') {
    const artifact = process.argv[3];
    if (!artifact) throw new Error('verify requires an artifact path.');
    process.stdout.write(`${JSON.stringify(verifySignedInstaller(artifact).attestation, null, 2)}\n`);
  } else if (command === 'verify-authenticode-transform') {
    const unsigned = process.argv[3];
    const signed = process.argv[4];
    if (!unsigned || !signed) {
      throw new Error('verify-authenticode-transform requires unsigned and signed PE paths.');
    }
    process.stdout.write(`${JSON.stringify(verifyAuthenticodeOnlyTransform(unsigned, signed))}\n`);
  } else if (command === 'plan') {
    process.stdout.write(`${JSON.stringify(publicPlan(createReleasePlan()), null, 2)}\n`);
  } else if (command === 'verify-unsigned') {
    const payload = process.argv[3];
    if (!payload) throw new Error('verify-unsigned requires an unsigned payload directory.');
    const verified = verifyUnsignedPayload(payload, createReleasePlan());
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      status: 'verified',
      payload: verified.payload,
      manifestSha256: verified.manifestSha256,
      nativeSha256: verified.nativeSha256,
      resources: verified.manifest.resources.length,
    })}\n`);
  } else if (command === 'bundle-signed-native') {
    const payload = process.argv[3];
    if (!payload) throw new Error('bundle-signed-native requires an unsigned payload directory.');
    bundleSignedNative(createReleasePlan(), payload);
  } else {
    buildUnsignedRelease(createReleasePlan());
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Desktop release failed.'}\n`);
  process.exitCode = 1;
}

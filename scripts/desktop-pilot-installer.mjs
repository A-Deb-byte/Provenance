#!/usr/bin/env node
// Builds an UNSIGNED NSIS installer for local pilot use. THIS IS NOT A RELEASE.
//
// The supported release pipeline (scripts/desktop-release.mjs) builds the
// native host with `--no-bundle`, hands the unsigned executable to a protected
// Authenticode signing job, and only then bundles the signed binary into an
// installer. It therefore cannot emit an installer without a code-signing
// certificate, a pinned signed Node runtime, hash-pinned cargo-about, and the
// protected updater key.
//
// This script exists for one narrower purpose: producing something installable
// on a machine you control, so the packaged startup path can be exercised at
// all. Artifacts it produces are unsigned, carry a locally generated updater
// key, and are not authenticated production releases. They do include the
// complete application/runtime notice inventory so installed-file acceptance
// can exercise the same resource boundary. Do not distribute them. See
// docs/Prd_Dev/installer-and-startup-verification.md.
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  lstatSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sanitizedBuildEnvironment } from './build-environment.mjs';
import {
  applicationLicenseSha256,
  digestApplicationLicenseText,
  validateApplicationLicenseContract,
} from './license-policy.mjs';
import {
  createRuntimeResourceManifest,
  RUNTIME_RESOURCE_MANIFEST_KIND,
  writeRuntimeResourceManifest,
} from './runtime-resource-manifest.mjs';
import { assertRuntimeResourceManifestDigest } from './release-resource-contract.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tauriRoot = path.join(repositoryRoot, 'src-tauri');
const baseConfigPath = path.join(tauriRoot, 'tauri.conf.json');
const releaseConfigPath = path.join(tauriRoot, 'tauri.release.conf.json');
const tauriCliPath = path.join(repositoryRoot, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const npmCliPath = path.join(
  path.dirname(process.execPath),
  'node_modules',
  'npm',
  'bin',
  'npm-cli.js',
);
const pilotBuildRoot = path.join(tauriRoot, 'target', 'pilot-installer');
const pilotCargoTarget = path.join(pilotBuildRoot, 'cargo');
const stagingDirectory = path.join(pilotBuildRoot, 'staging');
const stagedNodeResource = 'target/pilot-installer/staging/node.exe';
const stagedNodeLicenseResource = 'target/pilot-installer/staging/LICENSE';

export const PILOT_PRODUCT_NAME = 'Provenance Pilot';
export const PILOT_IDENTIFIER = 'dev.provenance.desktop.pilot';
export const PILOT_VERSION_TAG = 'pilot.1';
export const PILOT_EVIDENCE_FILENAME = 'provenance-pilot-evidence.json';
const maximumPilotEvidenceBytes = 16 * 1024;
const requiredPilotRuntimeResources = Object.freeze([
  'LICENSE',
  'dist/RUST_THIRD_PARTY_NOTICES.txt',
  'dist/THIRD_PARTY_NOTICES.txt',
  'node/LICENSE',
  'node/node.exe',
]);
const pilotLicenseResources = Object.freeze([
  'LICENSE',
  'dist/RUST_THIRD_PARTY_NOTICES.txt',
  'dist/THIRD_PARTY_NOTICES.txt',
  'node/LICENSE',
]);

// Unreachable by construction: a pilot build must never resolve an update
// against a real endpoint, and the plugin requires a syntactically valid one.
const pilotUpdaterEndpoint =
  'https://pilot-updates.provenance.invalid/{{target}}/{{current_version}}';
// build.rs requires a digest-pinned reference in any packaged build, which is
// a supply-chain guard worth respecting rather than working around. This one
// is unresolvable by construction: `.invalid` is RFC 2606 reserved and can
// never resolve, and an all-zero digest can never match a real image. The
// consequence is deliberate and must be understood before piloting -- sandboxed
// command execution is permanently unavailable in this build, fail-closed.
const pilotSandboxImage = `provenance.invalid/pilot-sandbox-disabled@sha256:${'0'.repeat(64)}`;

const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const digestFile = (file) => crypto.createHash('sha256').update(readFileSync(file)).digest('hex');

const assertFile = (target, label) => {
  if (!existsSync(target) || !statSync(target).isFile()) {
    throw new Error(`${label} is missing: ${target}`);
  }
  return target;
};

export function pilotVersion(baseVersion) {
  const core = /^(\d+\.\d+\.\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(baseVersion)?.[1];
  if (!core) throw new Error('The base Tauri version is not valid semantic versioning.');
  return `${core}-${PILOT_VERSION_TAG}`;
}

export { sanitizedBuildEnvironment };

const executeBuildCommand = (command, args, options) =>
  execFileSync(command, args, options);

export function buildPilotResources(environment, execute = executeBuildCommand) {
  assertFile(npmCliPath, 'Node installation npm CLI');
  const buildEnvironment = sanitizedBuildEnvironment(environment);
  const options = {
    cwd: repositoryRoot,
    env: buildEnvironment,
    stdio: 'inherit',
    windowsHide: true,
  };
  execute(process.execPath, [npmCliPath, 'run', 'build'], options);
  execute(process.execPath, [npmCliPath, 'run', 'desktop:licenses'], options);
  return buildEnvironment;
}

function assetResourceSpecifications(root, relative = '') {
  const directory = path.join(root, relative);
  const resources = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const child = path.join(root, ...childRelative.split('/'));
    const metadata = lstatSync(child);
    if (metadata.isSymbolicLink()) {
      throw new Error('Pilot UI assets must not contain symbolic links.');
    }
    if (entry.isDirectory()) {
      resources.push(...assetResourceSpecifications(root, childRelative));
    } else if (entry.isFile()) {
      resources.push({
        source: child,
        destination: `dist/assets/${childRelative}`,
      });
    } else {
      throw new Error('Pilot UI assets must contain only regular files and directories.');
    }
  }
  return resources;
}

export function resolvePilotApplicationLicense(root = repositoryRoot) {
  const packageJson = JSON.parse(readFileSync(
    assertFile(path.join(root, 'package.json'), 'package.json'),
    'utf8',
  ));
  const packageLock = JSON.parse(readFileSync(
    assertFile(path.join(root, 'package-lock.json'), 'package-lock.json'),
    'utf8',
  ));
  const cargoManifest = readFileSync(
    assertFile(path.join(root, 'src-tauri', 'Cargo.toml'), 'src-tauri/Cargo.toml'),
    'utf8',
  );
  const cargoPackage = cargoManifest.match(
    /^\[package\][^\S\r\n]*\r?\n([\s\S]*?)(?=^\[[^\]]+\][^\S\r\n]*$)/m,
  )?.[1] ?? '';
  const cargoLicense = cargoPackage.match(/^license\s*=\s*"([^"]+)"\s*$/m)?.[1];
  const licenseText = readFileSync(
    assertFile(path.join(root, 'LICENSE'), 'Application license'),
    'utf8',
  );
  const identifier = validateApplicationLicenseContract({
    packageLicense: packageJson.license,
    packageLockLicense: packageLock.packages?.['']?.license,
    cargoLicense,
    licenseText,
  });
  const sha256 = digestApplicationLicenseText(licenseText);
  if (sha256 !== applicationLicenseSha256) {
    throw new Error('Application license digest changed after validation.');
  }
  return Object.freeze({
    applicationLicense: identifier,
    applicationLicenseSha256: sha256,
  });
}

export function createPilotConfig(baseConfig, updaterPublicKey) {
  if (typeof baseConfig?.version !== 'string' || !Array.isArray(baseConfig?.app?.windows)) {
    throw new Error('The base Tauri configuration has no versioned window definition.');
  }
  const version = pilotVersion(baseConfig.version);
  return {
    productName: PILOT_PRODUCT_NAME,
    identifier: PILOT_IDENTIFIER,
    version,
    app: {
      windows: baseConfig.app.windows.map((window) => ({
        ...window,
        title: window.label === 'main'
          ? `${PILOT_PRODUCT_NAME} ${version} (Unsigned Local Pilot)`
          : window.title,
      })),
    },
    bundle: {
      active: true,
      targets: ['nsis'],
      createUpdaterArtifacts: false,
      resources: {
        '../dist/server.cjs': 'dist/server.cjs',
        '../dist/index.html': 'dist/index.html',
        '../dist/assets/*': 'dist/assets/',
        '../dist/THIRD_PARTY_NOTICES.txt': 'dist/THIRD_PARTY_NOTICES.txt',
        '../dist/RUST_THIRD_PARTY_NOTICES.txt': 'dist/RUST_THIRD_PARTY_NOTICES.txt',
        '../LICENSE': 'LICENSE',
        [stagedNodeResource]: 'node/node.exe',
        [stagedNodeLicenseResource]: 'node/LICENSE',
      },
    },
    plugins: {
      updater: {
        pubkey: updaterPublicKey,
        endpoints: [pilotUpdaterEndpoint],
        windows: { installMode: 'passive' },
      },
    },
  };
}

export function createPilotEvidence({
  dynamicConfig,
  installerFile,
  installerBytes,
  installerSha256,
  runtimeResourceManifest,
  bundledNodeVersion,
  applicationLicense,
  rustNoticeGenerator,
}) {
  const manifestResources = runtimeResourceManifest?.manifest?.resources;
  const runtimeResourceManifestSha256 = runtimeResourceManifest?.sha256;
  if (path.basename(installerFile) !== installerFile
      || !installerFile.toLowerCase().endsWith('-setup.exe')
      || !Number.isSafeInteger(installerBytes)
      || installerBytes < 1
      || !/^[a-f0-9]{64}$/u.test(installerSha256)
      || !/^[a-f0-9]{64}$/u.test(runtimeResourceManifestSha256)
      || runtimeResourceManifest?.manifest?.schemaVersion !== 1
      || runtimeResourceManifest?.manifest?.kind !== RUNTIME_RESOURCE_MANIFEST_KIND
      || !Array.isArray(manifestResources)
      || !/^\d+\.\d+\.\d+$/u.test(rustNoticeGenerator?.version)
      || !/^[a-f0-9]{64}$/u.test(rustNoticeGenerator?.executableSha256)
      || !/^[a-f0-9]{64}$/u.test(rustNoticeGenerator?.cargoLockSha256)) {
    throw new Error('Pilot evidence inputs are invalid.');
  }
  const reconstructedManifest = createRuntimeResourceManifest(manifestResources);
  if (reconstructedManifest.sha256 !== runtimeResourceManifestSha256) {
    throw new Error('Pilot evidence runtime-resource manifest digest is invalid.');
  }
  const resourcesByPath = new Map();
  for (const resource of manifestResources) {
    if (typeof resource?.path !== 'string'
        || !/^[a-f0-9]{64}$/u.test(resource?.sha256)
        || !Number.isSafeInteger(resource?.size)
        || resource.size < 1
        || resourcesByPath.has(resource.path)) {
      throw new Error('Pilot evidence runtime-resource inventory is invalid.');
    }
    resourcesByPath.set(resource.path, resource);
  }
  for (const resourcePath of requiredPilotRuntimeResources) {
    if (!resourcesByPath.has(resourcePath)) {
      throw new Error(`Pilot evidence is missing required runtime resource ${resourcePath}.`);
    }
  }
  const licenseInventory = pilotLicenseResources.map((resourcePath) => ({
    ...resourcesByPath.get(resourcePath),
  }));
  const bundledNode = resourcesByPath.get('node/node.exe');
  return Object.freeze({
    schemaVersion: 2,
    kind: 'provenance.pilot-installer-evidence',
    artifact: 'provenance-pilot-installer',
    signed: false,
    distributable: false,
    identity: {
      productName: dynamicConfig.productName,
      identifier: dynamicConfig.identifier,
      version: dynamicConfig.version,
    },
    installerFile,
    installerBytes,
    installerSha256,
    runtimeResourceManifestSha256,
    bundledNodeVersion,
    bundledNodeSha256: bundledNode.sha256,
    licenseInventory,
    requiredLicenseInventoryPresent: true,
    rustNoticeGeneration: {
      tool: 'cargo-about',
      version: rustNoticeGenerator.version,
      executableSha256: rustNoticeGenerator.executableSha256,
      cargoLockSha256: rustNoticeGenerator.cargoLockSha256,
      noticesSha256: resourcesByPath.get('dist/RUST_THIRD_PARTY_NOTICES.txt').sha256,
    },
    ...applicationLicense,
    sandboxImage: pilotSandboxImage,
    sandboxedCommandExecution: 'permanently_unavailable_by_construction',
    distributionBlockers: [
      'unsigned_application_and_installer',
      'unverified_local_node_runtime',
      'local_pilot_updater_key',
      'unresolvable_command_sandbox',
      'no_protected_release_attestation',
    ],
  });
}

function main() {
  const applicationLicense = resolvePilotApplicationLicense();
  if (process.platform !== 'win32') {
    throw new Error('The pilot installer targets Windows NSIS and must be built on Windows.');
  }

  assertFile(tauriCliPath, 'Installed Tauri CLI entrypoint');

  const updaterPublicKeyPath = argument('--updater-public-key');
  if (!updaterPublicKeyPath) {
    throw new Error(
      'Pass --updater-public-key <file>. Generate a pilot-only keypair with:\n' +
      '  node node_modules/@tauri-apps/cli/tauri.js signer generate --ci -w <path outside the repository>',
    );
  }
  const updaterPublicKey = readFileSync(
    assertFile(path.resolve(updaterPublicKeyPath), 'Updater public key'),
    'utf8',
  ).trim();
  if (!/^[A-Za-z0-9+/=]+$/.test(updaterPublicKey) || updaterPublicKey.length < 40) {
    throw new Error('The updater public key file does not contain a single minisign public key.');
  }

  const buildEnvironment = buildPilotResources(process.env);
  const cargoAboutExecutable = assertFile(
    path.resolve(buildEnvironment.PROVENANCE_CARGO_ABOUT),
    'Pinned cargo-about executable',
  );
  if (digestFile(cargoAboutExecutable) !== buildEnvironment.PROVENANCE_CARGO_ABOUT_SHA256) {
    throw new Error('Pinned cargo-about changed after Rust notice generation.');
  }
  const cargoLockPath = assertFile(path.join(tauriRoot, 'Cargo.lock'), 'Cargo.lock');
  const rustNoticeGenerator = Object.freeze({
    version: buildEnvironment.PROVENANCE_CARGO_ABOUT_VERSION,
    executableSha256: buildEnvironment.PROVENANCE_CARGO_ABOUT_SHA256,
    cargoLockSha256: digestFile(cargoLockPath),
  });
  const distDirectory = path.join(repositoryRoot, 'dist');
  for (const required of [
    'server.cjs',
    'index.html',
    'THIRD_PARTY_NOTICES.txt',
    'RUST_THIRD_PARTY_NOTICES.txt',
  ]) {
    assertFile(path.join(distDirectory, required), `Production dist/${required}`);
  }
  const assetsDirectory = path.join(distDirectory, 'assets');
  if (!existsSync(assetsDirectory) || readdirSync(assetsDirectory).length === 0) {
    throw new Error('Production dist/assets is empty after the isolated build.');
  }

  const baseConfig = JSON.parse(readFileSync(baseConfigPath, 'utf8'));
  const dynamicConfig = createPilotConfig(baseConfig, updaterPublicKey);

  // The host resolves its Node runtime from `<resources>/node/node.exe` in a
  // packaged build. The entire pilot tree is rebuilt from an empty directory,
  // so neither native objects nor a stale installer can leak in from release.
  const nodeSource = path.resolve(argument('--node') || process.execPath);
  assertFile(nodeSource, 'Bundled Node runtime');
  const nodeLicenseSource = path.resolve(
    argument('--node-license') || path.join(path.dirname(nodeSource), 'LICENSE'),
  );
  assertFile(
    nodeLicenseSource,
    'Bundled Node license (pass --node-license when it is not adjacent to node.exe)',
  );
  rmSync(pilotBuildRoot, { recursive: true, force: true });
  mkdirSync(stagingDirectory, { recursive: true });
  const stagedNode = path.join(stagingDirectory, 'node.exe');
  const stagedNodeLicense = path.join(stagingDirectory, 'LICENSE');
  copyFileSync(nodeSource, stagedNode);
  copyFileSync(nodeLicenseSource, stagedNodeLicense);
  const nodeRuntime = JSON.parse(execFileSync(stagedNode, [
    '-p',
    'JSON.stringify({version:process.version,arch:process.arch,platform:process.platform})',
  ], {
    encoding: 'utf8',
    env: buildEnvironment,
    windowsHide: true,
  }));
  if (nodeRuntime.platform !== 'win32' || nodeRuntime.arch !== 'x64') {
    throw new Error('The bundled Node runtime must be Windows x64.');
  }
  const resourceSpecifications = [
    { source: path.join(repositoryRoot, 'LICENSE'), destination: 'LICENSE' },
    { source: path.join(distDirectory, 'server.cjs'), destination: 'dist/server.cjs' },
    { source: path.join(distDirectory, 'index.html'), destination: 'dist/index.html' },
    ...assetResourceSpecifications(assetsDirectory),
    {
      source: path.join(distDirectory, 'THIRD_PARTY_NOTICES.txt'),
      destination: 'dist/THIRD_PARTY_NOTICES.txt',
    },
    {
      source: path.join(distDirectory, 'RUST_THIRD_PARTY_NOTICES.txt'),
      destination: 'dist/RUST_THIRD_PARTY_NOTICES.txt',
    },
    { source: stagedNode, destination: 'node/node.exe' },
    { source: stagedNodeLicense, destination: 'node/LICENSE' },
  ];
  const runtimeResourceManifest = writeRuntimeResourceManifest(
    resourceSpecifications,
    path.join(pilotBuildRoot, 'runtime-resource-manifest.json'),
  );

  process.stderr.write(
    'Building an UNSIGNED isolated pilot installer. Not a release artifact: unsigned, ' +
    'locally keyed updater, and no protected release attestation. Do not distribute.\n',
  );

  execFileSync(process.execPath, [
    tauriCliPath,
    'build',
    '--ci',
    '--no-sign',
    '--config', baseConfigPath,
    '--config', releaseConfigPath,
    '--config', JSON.stringify(dynamicConfig),
  ], {
    cwd: repositoryRoot,
    env: {
      ...buildEnvironment,
      CARGO_TARGET_DIR: pilotCargoTarget,
      PROVENANCE_PACKAGED_RELEASE: '1',
      PROVENANCE_SANDBOX_IMAGE: pilotSandboxImage,
      PROVENANCE_RESOURCE_MANIFEST_PATH: runtimeResourceManifest.path,
      PROVENANCE_RESOURCE_MANIFEST_SHA256: runtimeResourceManifest.sha256,
    },
    stdio: 'inherit',
    windowsHide: true,
  });

  const nsisDirectory = path.join(pilotCargoTarget, 'release', 'bundle', 'nsis');
  if (!existsSync(nsisDirectory)) throw new Error('Tauri did not create the NSIS bundle directory.');
  const installers = readdirSync(nsisDirectory)
    .filter((name) => name.toLowerCase().endsWith('-setup.exe'))
    .map((name) => path.join(nsisDirectory, name));
  if (installers.length !== 1) {
    throw new Error(`Expected exactly one NSIS installer; found ${installers.length}.`);
  }

  const postBuildResourceManifest = createRuntimeResourceManifest(resourceSpecifications);
  assertRuntimeResourceManifestDigest({
    compiledSha256: runtimeResourceManifest.sha256,
    currentSha256: postBuildResourceManifest.sha256,
    phase: 'after the pilot native build',
  });
  if (digestFile(cargoAboutExecutable) !== rustNoticeGenerator.executableSha256
      || digestFile(cargoLockPath) !== rustNoticeGenerator.cargoLockSha256) {
    throw new Error('Rust notice generator inputs changed during the pilot build.');
  }

  const installer = installers[0];
  const evidence = createPilotEvidence({
    dynamicConfig,
    installerFile: path.basename(installer),
    installerBytes: statSync(installer).size,
    installerSha256: digestFile(installer),
    runtimeResourceManifest: postBuildResourceManifest,
    bundledNodeVersion: nodeRuntime.version,
    applicationLicense,
    rustNoticeGenerator,
  });
  const evidenceBytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  if (evidenceBytes.length > maximumPilotEvidenceBytes) {
    throw new Error('Pilot evidence exceeds its bounded size.');
  }
  const evidenceFile = path.join(nsisDirectory, PILOT_EVIDENCE_FILENAME);
  writeFileSync(evidenceFile, evidenceBytes, { flag: 'wx' });
  const evidenceMetadata = lstatSync(evidenceFile);
  if (!evidenceMetadata.isFile()
      || evidenceMetadata.isSymbolicLink()
      || evidenceMetadata.size !== evidenceBytes.length) {
    throw new Error('Pilot evidence was not persisted as a bounded regular file.');
  }

  process.stdout.write(`${JSON.stringify({
    ...evidence,
    installer,
    evidenceFile,
    evidenceSha256: digestFile(evidenceFile),
  }, null, 2)}\n`);
}

const invokedAsScript = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedAsScript) main();

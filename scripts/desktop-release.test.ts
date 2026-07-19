import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const suiteRoots: string[] = [];
const script = path.join(process.cwd(), 'scripts', 'desktop-release.mjs');
const privateKeyMarker = 'DO-NOT-PRINT-PRIVATE-KEY';
const bundleTypeUnknown = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK', 'ascii');
const bundleTypeNsis = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_NSS', 'ascii');
let cargoAboutFixture: { executable: string; sha256: string; version: string };
let nodeSignerThumbprint: string;

beforeAll(async () => {
  const configured = (
    process.env.PROVENANCE_TEST_CARGO_ABOUT ?? process.env.PROVENANCE_CARGO_ABOUT
  )?.trim();
  if (configured) {
    const versionOutput = (await execFileAsync(configured, ['--version'], { timeout: 30_000 })).stdout.trim();
    const version = versionOutput.match(/^cargo-about (\d+\.\d+\.\d+)$/)?.[1];
    if (!version) throw new Error('PROVENANCE_TEST_CARGO_ABOUT has an invalid version identity.');
    cargoAboutFixture = {
      executable: configured,
      sha256: sha256(await readFile(configured)),
      version,
    };
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'cargo-about-fixture-'));
  suiteRoots.push(root);
  const executable = path.join(root, 'cargo-about.exe');
  const compile = [
    "$source = @'",
    'using System;',
    'public static class CargoAboutFixture {',
    '  public static int Main(string[] args) {',
    '    if (args.Length == 1 && args[0] == "--version") {',
    '      Console.WriteLine("cargo-about 0.1.0");',
    '      return 0;',
    '    }',
    '    return 2;',
    '  }',
    '}',
    "'@",
    'Add-Type -TypeDefinition $source -OutputAssembly $env:CARGO_ABOUT_FIXTURE_OUTPUT -OutputType ConsoleApplication',
  ].join('\n');
  await execFileAsync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-Command', compile,
  ], {
    env: { ...process.env, CARGO_ABOUT_FIXTURE_OUTPUT: executable },
    timeout: 60_000,
  });
  cargoAboutFixture = {
    executable,
    sha256: sha256(await readFile(executable)),
    version: '0.1.0',
  };
}, 60_000);

beforeAll(async () => {
  const command = [
    '$ErrorActionPreference = "Stop"',
    '$signature = Get-AuthenticodeSignature -LiteralPath $env:PROVENANCE_TEST_NODE',
    'if ($signature.Status -ne "Valid" -or $null -eq $signature.SignerCertificate -or $null -eq $signature.TimeStamperCertificate) { throw "Test Node signature is invalid." }',
    '$signature.SignerCertificate.Thumbprint',
  ].join('\n');
  nodeSignerThumbprint = (await execFileAsync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-Command', command,
  ], {
    env: { ...process.env, PROVENANCE_TEST_NODE: process.execPath },
    timeout: 30_000,
  })).stdout.trim().toUpperCase();
  if (!/^[A-F0-9]{40}$/.test(nodeSignerThumbprint)) {
    throw new Error('Test Node signer thumbprint is invalid.');
  }
}, 30_000);

afterAll(async () => {
  await Promise.all(suiteRoots.map((root) => rm(root, { recursive: true, force: true })));
});

async function fixtureEnvironment(overrides: NodeJS.ProcessEnv = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'desktop-release-'));
  roots.push(root);
  const node = process.execPath;
  const bytes = await readFile(node);
  const license = path.join(root, 'LICENSE');
  const licenseBytes = Buffer.from('Node.js fixture license');
  await writeFile(license, licenseBytes);
  const baseEnvironment = { ...process.env };
  delete baseEnvironment.GITHUB_ACTIONS;
  delete baseEnvironment.GITHUB_REPOSITORY;
  return {
    ...baseEnvironment,
    PROVENANCE_BUNDLED_NODE: node,
    PROVENANCE_BUNDLED_NODE_SHA256: crypto.createHash('sha256').update(bytes).digest('hex'),
    PROVENANCE_BUNDLED_NODE_SIGNER_THUMBPRINT: nodeSignerThumbprint,
    PROVENANCE_BUNDLED_NODE_VERSION: process.version,
    PROVENANCE_BUNDLED_NODE_LICENSE: license,
    PROVENANCE_BUNDLED_NODE_LICENSE_SHA256: crypto.createHash('sha256').update(licenseBytes).digest('hex'),
    PROVENANCE_CARGO_ABOUT: cargoAboutFixture.executable,
    PROVENANCE_CARGO_ABOUT_SHA256: cargoAboutFixture.sha256,
    PROVENANCE_CARGO_ABOUT_VERSION: cargoAboutFixture.version,
    PROVENANCE_UPDATER_PUBLIC_KEY: Buffer.from([
      'untrusted comment: minisign public key E7620F1842B4E81F',
      'RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3',
    ].join('\n'), 'utf8').toString('base64'),
    PROVENANCE_UPDATER_ENDPOINT: 'https://updates.example.test/provenance/latest.json',
    PROVENANCE_SANDBOX_IMAGE: `registry.example.test/provenance/sandbox@sha256:${'b'.repeat(64)}`,
    ...overrides,
  };
}

const sha256 = (value: Buffer | string) => crypto.createHash('sha256').update(value).digest('hex');

function syntheticUnsignedPe() {
  const bytes = Buffer.alloc(512);
  bytes.write('MZ', 0, 'ascii');
  const peOffset = 0x80;
  bytes.writeUInt32LE(peOffset, 0x3c);
  bytes.write('PE\0\0', peOffset, 'ascii');
  bytes.writeUInt16LE(0x8664, peOffset + 4);
  bytes.writeUInt16LE(240, peOffset + 20);
  const optionalHeader = peOffset + 24;
  bytes.writeUInt16LE(0x20b, optionalHeader);
  bytes.writeUInt32LE(16, optionalHeader + 108);
  bytes.writeUInt32LE(0x1234, optionalHeader + 64);
  bytes.fill(0x5a, optionalHeader + 240, bytes.length);
  bundleTypeUnknown.copy(bytes, 432);
  return bytes;
}

function addSyntheticAuthenticodeEnvelope(unsigned: Buffer) {
  const certificateOffset = Math.ceil(unsigned.length / 8) * 8;
  const certificateLength = 12;
  const certificateSize = 16;
  const signed = Buffer.alloc(certificateOffset + certificateSize);
  unsigned.copy(signed);
  const bundleTypeOffset = unsigned.indexOf(bundleTypeUnknown);
  if (bundleTypeOffset === -1) throw new Error('Synthetic PE is missing the Tauri bundle marker.');
  bundleTypeNsis.copy(signed, bundleTypeOffset);
  const peOffset = signed.readUInt32LE(0x3c);
  const optionalHeader = peOffset + 24;
  const securityDirectory = optionalHeader + 112 + (4 * 8);
  signed.writeUInt32LE(0x5678, optionalHeader + 64);
  signed.writeUInt32LE(certificateOffset, securityDirectory);
  signed.writeUInt32LE(certificateSize, securityDirectory + 4);
  signed.writeUInt32LE(certificateLength, certificateOffset);
  signed.writeUInt16LE(0x0200, certificateOffset + 4);
  signed.writeUInt16LE(0x0002, certificateOffset + 6);
  signed.writeUInt32LE(0xfeedface, certificateOffset + 8);
  return signed;
}

async function createUnsignedPayload(
  env: NodeJS.ProcessEnv,
  { materializeRuntime = true }: { materializeRuntime?: boolean } = {},
) {
  const root = path.dirname(env.PROVENANCE_BUNDLED_NODE_LICENSE!);
  const payload = path.join(root, `payload-${crypto.randomUUID()}`);
  const nativePath = path.join(payload, 'native', 'provenance-desktop.exe');
  await mkdir(path.dirname(nativePath), { recursive: true });
  const nodeBytes = await readFile(env.PROVENANCE_BUNDLED_NODE!);
  const nativeBytes = syntheticUnsignedPe();
  await writeFile(nativePath, nativeBytes);

  const licenseBytes = await readFile(env.PROVENANCE_BUNDLED_NODE_LICENSE!);
  const rustNoticeBytes = Buffer.from(`Rust third-party notices fixture\n${'license\n'.repeat(200)}`);
  const resources = [
    ['dist/RUST_THIRD_PARTY_NOTICES.txt', 'native-third-party-notices', rustNoticeBytes],
    ['dist/THIRD_PARTY_NOTICES.txt', 'third-party-notices', Buffer.from('JavaScript notices')],
    ['dist/assets/index-fixture.css', 'application-ui', Buffer.from('body{color:#111}')],
    ['dist/index.html', 'application-ui', Buffer.from('<main id="root"></main>')],
    ['dist/server.cjs', 'application-server', Buffer.from('module.exports = {};')],
    ['node/LICENSE', 'runtime-license', licenseBytes],
    [
      'node/node.exe',
      'bundled-runtime',
      materializeRuntime ? nodeBytes : Buffer.from('runtime-placeholder'),
    ],
  ] as const;
  const manifestResources = [];
  for (const [destination, role, contents] of resources) {
    const resourcePath = `resources/${destination}`;
    const absolute = path.join(payload, ...resourcePath.split('/'));
    await mkdir(path.dirname(absolute), { recursive: true });
    if (destination === 'node/node.exe' && materializeRuntime) {
      await copyFile(env.PROVENANCE_BUNDLED_NODE!, absolute);
    } else {
      await writeFile(absolute, contents);
    }
    manifestResources.push({
      path: resourcePath,
      destination,
      role,
      sha256: destination === 'node/node.exe'
        ? env.PROVENANCE_BUNDLED_NODE_SHA256!
        : sha256(contents),
      size: contents.length,
    });
  }
  manifestResources.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  const rustNotices = manifestResources.find(
    (resource) => resource.destination === 'dist/RUST_THIRD_PARTY_NOTICES.txt',
  )!;
  const cargoLock = await readFile(path.join(process.cwd(), 'src-tauri', 'Cargo.lock'));
  const packageLock = await readFile(path.join(process.cwd(), 'package-lock.json'));
  const manifest = {
    schemaVersion: 1,
    kind: 'provenance-windows-unsigned-payload',
    version: '0.1.0',
    platform: 'windows-x86_64-nsis',
    native: {
      path: 'native/provenance-desktop.exe',
      sha256: sha256(nativeBytes),
      size: nativeBytes.length,
      bundleTypeMarker: {
        value: bundleTypeUnknown.toString('ascii'),
        offset: nativeBytes.indexOf(bundleTypeUnknown),
      },
    },
    resources: manifestResources,
    policy: {
      updaterEndpoint: env.PROVENANCE_UPDATER_ENDPOINT,
      updaterPublicKeySha256: sha256(env.PROVENANCE_UPDATER_PUBLIC_KEY!),
      nodeSha256: env.PROVENANCE_BUNDLED_NODE_SHA256,
      nodeSignerThumbprint: env.PROVENANCE_BUNDLED_NODE_SIGNER_THUMBPRINT,
      nodeVersion: env.PROVENANCE_BUNDLED_NODE_VERSION,
      nodeArchitecture: 'x64',
      nodeLicenseSha256: env.PROVENANCE_BUNDLED_NODE_LICENSE_SHA256,
      cargoAboutSha256: env.PROVENANCE_CARGO_ABOUT_SHA256,
      cargoAboutVersion: env.PROVENANCE_CARGO_ABOUT_VERSION,
      tauriCliVersion: '2.11.4',
      packageLockSha256: sha256(packageLock),
      cargoLockSha256: sha256(cargoLock),
      rustThirdPartyNoticesSha256: rustNotices.sha256,
      sandboxImage: env.PROVENANCE_SANDBOX_IMAGE,
    },
  };
  await writeFile(path.join(payload, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { payload, manifest };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('desktop release planner', () => {
  it('produces a public, pinned Windows release plan without signing secrets', async () => {
    const env = await fixtureEnvironment();
    const result = await execFileAsync(process.execPath, [script, 'plan'], { env });
    const plan = JSON.parse(result.stdout);

    expect(plan).toMatchObject({
      schemaVersion: 1,
      targets: ['nsis'],
      updaterArtifacts: 'protected_signing_job',
      updaterEndpoint: 'https://updates.example.test/provenance/latest.json',
      updaterEndpointOrigin: 'https://updates.example.test',
      updaterPublicKeySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      nodeResource: 'node/node.exe',
      nodeVersion: process.version,
      nodeArchitecture: 'x64',
      nodeSignerThumbprint,
      nodeLicenseResource: 'node/LICENSE',
      cargoAboutSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      cargoAboutVersion: cargoAboutFixture.version,
      tauriCliVersion: '2.11.4',
      packageLockSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      cargoLockSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      rustThirdPartyNoticesResource: 'dist/RUST_THIRD_PARTY_NOTICES.txt',
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
      sandboxImage: `registry.example.test/provenance/sandbox@sha256:${'b'.repeat(64)}`,
    });
    expect(result.stdout).not.toContain(privateKeyMarker);
    expect(result.stdout).not.toContain('PROVENANCE_UPDATER_PUBLIC_KEY');
    expect(result.stdout).not.toContain('E7620F1842B4E81F');
  });

  it('rejects insecure or mutable updater endpoints before invoking Tauri', async () => {
    const env = await fixtureEnvironment({
      PROVENANCE_UPDATER_ENDPOINT: 'http://localhost:8080/latest.json?channel=mutable',
    });
    await expect(execFileAsync(process.execPath, [script, 'plan'], { env })).rejects.toMatchObject({
      stderr: expect.stringContaining('credential-free public HTTPS URL'),
    });
  });

  it('rejects loopback, IP-literal, and local-name updater endpoints', async () => {
    for (const endpoint of [
      'https://[::1]/latest.json',
      'https://127.0.0.1/latest.json',
      'https://agent.localhost/latest.json',
      'https://updates.internal/latest.json',
      'https://localhost./latest.json',
    ]) {
      const env = await fixtureEnvironment({ PROVENANCE_UPDATER_ENDPOINT: endpoint });
      await expect(execFileAsync(process.execPath, [script, 'plan'], { env })).rejects.toMatchObject({
        stderr: expect.stringContaining('public HTTPS URL'),
      });
    }
  });

  it('binds GitHub release jobs to the repository static latest manifest', async () => {
    const env = await fixtureEnvironment({
      GITHUB_ACTIONS: 'true',
      GITHUB_REPOSITORY: 'owner/provenance',
      PROVENANCE_UPDATER_ENDPOINT: 'https://updates.example.test/provenance/latest.json',
    });
    await expect(execFileAsync(process.execPath, [script, 'plan'], { env })).rejects.toMatchObject({
      stderr: expect.stringContaining(
        'https://github.com/owner/provenance/releases/latest/download/latest.json',
      ),
    });
  });

  it('rejects an unpinned bundled Node runtime', async () => {
    const env = await fixtureEnvironment({ PROVENANCE_BUNDLED_NODE_SHA256: 'f'.repeat(64) });
    await expect(execFileAsync(process.execPath, [script, 'plan'], { env })).rejects.toMatchObject({
      stderr: expect.stringContaining('does not match the exact Node executable'),
    });
  });

  it('rejects a bundled Node runtime with the wrong vendor signer pin', async () => {
    const env = await fixtureEnvironment({
      PROVENANCE_BUNDLED_NODE_SIGNER_THUMBPRINT: 'F'.repeat(40),
    });
    await expect(execFileAsync(process.execPath, [script, 'plan'], { env })).rejects.toMatchObject({
      stderr: expect.stringContaining('Pinned Node runtime Authenticode signature'),
    });
  });

  it('revalidates the exact cargo-about executable in protected release phases', async () => {
    const env = await fixtureEnvironment({ PROVENANCE_CARGO_ABOUT_SHA256: 'f'.repeat(64) });
    await expect(execFileAsync(process.execPath, [script, 'plan'], { env })).rejects.toMatchObject({
      stderr: expect.stringContaining('does not match the exact cargo-about executable'),
    });
  });

  it('rejects mutable command sandbox images', async () => {
    const env = await fixtureEnvironment({ PROVENANCE_SANDBOX_IMAGE: 'provenance/sandbox:latest' });
    await expect(execFileAsync(process.execPath, [script, 'plan'], { env })).rejects.toMatchObject({
      stderr: expect.stringContaining('registry/repository@sha256'),
    });
  });

  it('removes signing credentials from JavaScript build subprocesses', async () => {
    const result = await execFileAsync(process.execPath, [script, 'probe-build-env'], {
      env: {
        ...process.env,
        TAURI_SIGNING_PRIVATE_KEY: privateKeyMarker,
        TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'password-marker',
        WINDOWS_PFX_BASE64: 'pfx-marker',
        PROVENANCE_WINDOWS_CERTIFICATE_THUMBPRINT: 'certificate-marker',
        PROVENANCE_BUILD_MARKER: 'present',
      },
    });
    expect(JSON.parse(result.stdout)).toEqual({
      privateKey: false,
      privateKeyPassword: false,
      pfx: false,
      certificate: false,
      ordinaryMarker: true,
    });
    expect(result.stdout).not.toContain(privateKeyMarker);
  });

  it('verifies an exact symlink-free unsigned native payload', async () => {
    const env = await fixtureEnvironment();
    const { payload, manifest } = await createUnsignedPayload(env);
    const result = await execFileAsync(process.execPath, [script, 'verify-unsigned', payload], {
      env,
      timeout: 30_000,
    });

    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      status: 'verified',
      payload,
      manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      nativeSha256: manifest.native.sha256,
      resources: manifest.resources.length,
    });
  }, 30_000);

  it('rejects any resource mutation before worker dispatch', async () => {
    const env = await fixtureEnvironment();
    const { payload, manifest } = await createUnsignedPayload(env, { materializeRuntime: false });
    const first = manifest.resources[0];
    await writeFile(path.join(payload, ...first.path.split('/')), Buffer.from('tampered-resource'));

    await expect(
      execFileAsync(process.execPath, [script, 'verify-unsigned', payload], { env }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining('does not match its hash manifest'),
    });
  });

  it('rejects unlisted payload content before worker dispatch', async () => {
    const env = await fixtureEnvironment();
    const { payload } = await createUnsignedPayload(env, { materializeRuntime: false });
    await writeFile(path.join(payload, 'unlisted.txt'), Buffer.from('unlisted'));

    await expect(
      execFileAsync(process.execPath, [script, 'verify-unsigned', payload], { env }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining('file tree does not exactly match'),
    });
  });

  it('accepts only an Authenticode PE envelope and rejects unrelated native mutation', async () => {
    const env = await fixtureEnvironment();
    const root = roots.at(-1)!;
    const unsignedPath = path.join(root, 'unsigned.exe');
    const signedPath = path.join(root, 'signed.exe');
    const unsigned = syntheticUnsignedPe();
    const signed = addSyntheticAuthenticodeEnvelope(unsigned);
    await writeFile(unsignedPath, unsigned);
    await writeFile(signedPath, signed);

    const verified = await execFileAsync(process.execPath, [
      script,
      'verify-authenticode-transform',
      unsignedPath,
      signedPath,
    ], { env });
    expect(JSON.parse(verified.stdout)).toMatchObject({
      schemaVersion: 1,
      unsignedSha256: sha256(unsigned),
      signedSha256: sha256(signed),
      certificateOffset: 512,
      certificateSize: 16,
      certificateSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      bundleTypePatch: {
        offset: 432,
        from: bundleTypeUnknown.toString('ascii'),
        to: bundleTypeNsis.toString('ascii'),
      },
    });

    signed[480] ^= 0xff;
    await writeFile(signedPath, signed);
    await expect(execFileAsync(process.execPath, [
      script,
      'verify-authenticode-transform',
      unsignedPath,
      signedPath,
    ], { env })).rejects.toMatchObject({
      stderr: expect.stringContaining('outside the Authenticode envelope'),
    });

    const unpatchedSigned = addSyntheticAuthenticodeEnvelope(unsigned);
    bundleTypeUnknown.copy(unpatchedSigned, 432);
    await writeFile(signedPath, unpatchedSigned);
    await expect(execFileAsync(process.execPath, [
      script,
      'verify-authenticode-transform',
      unsignedPath,
      signedPath,
    ], { env })).rejects.toMatchObject({
      stderr: expect.stringContaining('UNK-to-NSS'),
    });

    const duplicateMarker = syntheticUnsignedPe();
    bundleTypeUnknown.copy(duplicateMarker, 472);
    await writeFile(unsignedPath, duplicateMarker);
    await writeFile(signedPath, addSyntheticAuthenticodeEnvelope(duplicateMarker));
    await expect(execFileAsync(process.execPath, [
      script,
      'verify-authenticode-transform',
      unsignedPath,
      signedPath,
    ], { env })).rejects.toMatchObject({
      stderr: expect.stringContaining('exactly one unpatched'),
    });
  });

  it('refuses to publish a manifest for an unverified updater signature', async () => {
    const env = await fixtureEnvironment();
    const root = roots.at(-1)!;
    const artifact = path.join(root, 'Provenance_0.1.0_x64-setup.exe');
    const output = path.join(root, 'latest.json');
    const record = path.join(root, 'bundled-release.json');
    await writeFile(artifact, Buffer.from('signed-installer-fixture'));
    await writeFile(`${artifact}.sig`, 'tauri-minisign-signature-fixture\n');

    await expect(
      execFileAsync(process.execPath, [
        script,
        'manifest',
        artifact,
        output,
        record,
        artifact,
        artifact,
      ], { env }),
    ).rejects.toMatchObject({
      stderr: expect.stringMatching(/signature format|canonical base64/i),
    });
    await expect(readFile(output, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

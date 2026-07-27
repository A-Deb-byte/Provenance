import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildPilotResources,
  createPilotEvidence,
  createPilotConfig,
  PILOT_EVIDENCE_FILENAME,
  PILOT_IDENTIFIER,
  PILOT_PRODUCT_NAME,
  pilotVersion,
  resolvePilotApplicationLicense,
  sanitizedBuildEnvironment,
} from './desktop-pilot-installer.mjs';
import { applicationLicenseSha256 } from './license-policy.mjs';
import { createRuntimeResourceManifest } from './runtime-resource-manifest.mjs';

const baseConfig = {
  productName: 'Provenance',
  identifier: 'dev.provenance.desktop',
  version: '0.1.0',
  app: {
    windows: [{
      label: 'main',
      title: 'Provenance',
      width: 1440,
      visible: false,
    }],
  },
};

const runtimeResourceManifest = createRuntimeResourceManifest([
  { path: 'LICENSE', sha256: '1'.repeat(64), size: 10 },
  {
    path: 'dist/RUST_THIRD_PARTY_NOTICES.txt',
    sha256: '2'.repeat(64),
    size: 20,
  },
  {
    path: 'dist/THIRD_PARTY_NOTICES.txt',
    sha256: '3'.repeat(64),
    size: 30,
  },
  { path: 'node/LICENSE', sha256: '4'.repeat(64), size: 40 },
  { path: 'node/node.exe', sha256: '5'.repeat(64), size: 50 },
]);
const rustNoticeGenerator = {
  version: '0.9.1',
  executableSha256: '6'.repeat(64),
  cargoLockSha256: '7'.repeat(64),
};

describe('desktop pilot installer isolation', () => {
  it('assigns a distinct app identity, state namespace, and visible pilot version', () => {
    const config = createPilotConfig(baseConfig, 'pilot-public-key');

    expect(config.productName).toBe(PILOT_PRODUCT_NAME);
    expect(config.productName).not.toBe(baseConfig.productName);
    expect(config.identifier).toBe(PILOT_IDENTIFIER);
    expect(config.identifier).not.toBe(baseConfig.identifier);
    expect(config.bundle.resources['../LICENSE']).toBe('LICENSE');
    expect(config.version).toBe('0.1.0-pilot.1');
    expect(config.app.windows[0]).toMatchObject({
      label: 'main',
      width: 1440,
      visible: false,
      title: 'Provenance Pilot 0.1.0-pilot.1 (Unsigned Local Pilot)',
    });
    expect(config.bundle.resources).toHaveProperty(
      'target/pilot-installer/staging/node.exe',
      'node/node.exe',
    );
    expect(config.bundle.resources).toMatchObject({
      '../dist/RUST_THIRD_PARTY_NOTICES.txt': 'dist/RUST_THIRD_PARTY_NOTICES.txt',
      'target/pilot-installer/staging/LICENSE': 'node/LICENSE',
    });
    const updaterEndpoint = new URL(config.plugins.updater.endpoints[0]);
    expect(updaterEndpoint.protocol).toBe('https:');
    expect(updaterEndpoint.hostname.endsWith('.invalid')).toBe(true);
    expect(config.plugins.updater).not.toHaveProperty('dangerousInsecureTransportProtocol');
    expect(baseConfig.app.windows[0].title).toBe('Provenance');
  });

  it('authenticates the application license contract used by the pilot manifest', () => {
    expect(resolvePilotApplicationLicense()).toEqual({
      applicationLicense: 'BUSL-1.1',
      applicationLicenseSha256,
    });
  });

  it('creates bounded non-release evidence with the installed acceptance digest', () => {
    const dynamicConfig = createPilotConfig(baseConfig, 'pilot-public-key');
    const evidence = createPilotEvidence({
      dynamicConfig,
      installerFile: 'Provenance_Pilot_0.1.0_x64-setup.exe',
      installerBytes: 1024,
      installerSha256: 'a'.repeat(64),
      runtimeResourceManifest,
      bundledNodeVersion: 'v22.23.1',
      applicationLicense: {
        applicationLicense: 'BUSL-1.1',
        applicationLicenseSha256,
      },
      rustNoticeGenerator,
    });

    expect(PILOT_EVIDENCE_FILENAME).toBe('provenance-pilot-evidence.json');
    expect(evidence).toMatchObject({
      schemaVersion: 2,
      kind: 'provenance.pilot-installer-evidence',
      signed: false,
      distributable: false,
      installerFile: 'Provenance_Pilot_0.1.0_x64-setup.exe',
      runtimeResourceManifestSha256: runtimeResourceManifest.sha256,
      bundledNodeSha256: '5'.repeat(64),
      requiredLicenseInventoryPresent: true,
      rustNoticeGeneration: {
        tool: 'cargo-about',
        version: '0.9.1',
        executableSha256: '6'.repeat(64),
        cargoLockSha256: '7'.repeat(64),
        noticesSha256: '2'.repeat(64),
      },
      applicationLicense: 'BUSL-1.1',
    });
    expect(evidence.licenseInventory).toEqual([
      { path: 'LICENSE', sha256: '1'.repeat(64), size: 10 },
      {
        path: 'dist/RUST_THIRD_PARTY_NOTICES.txt',
        sha256: '2'.repeat(64),
        size: 20,
      },
      {
        path: 'dist/THIRD_PARTY_NOTICES.txt',
        sha256: '3'.repeat(64),
        size: 30,
      },
      { path: 'node/LICENSE', sha256: '4'.repeat(64), size: 40 },
    ]);
    expect(evidence).not.toHaveProperty('omittedForDistribution');
    expect(evidence.distributionBlockers).toContain('unsigned_application_and_installer');
    expect(() => createPilotEvidence({
      dynamicConfig,
      installerFile: '../pilot.exe',
      installerBytes: 1024,
      installerSha256: 'a'.repeat(64),
      runtimeResourceManifest,
      bundledNodeVersion: 'v22.23.1',
      applicationLicense: {
        applicationLicense: 'BUSL-1.1',
        applicationLicenseSha256,
      },
      rustNoticeGenerator,
    })).toThrow(/inputs are invalid/iu);
  });

  it('rejects pilot evidence unless the full runtime and license inventory is bound', () => {
    const dynamicConfig = createPilotConfig(baseConfig, 'pilot-public-key');
    const incompleteManifest = {
      ...createRuntimeResourceManifest(runtimeResourceManifest.manifest.resources.filter(
        (resource) => resource.path !== 'node/LICENSE',
      )),
    };

    expect(() => createPilotEvidence({
      dynamicConfig,
      installerFile: 'Provenance_Pilot_0.1.0_x64-setup.exe',
      installerBytes: 1024,
      installerSha256: 'a'.repeat(64),
      runtimeResourceManifest: incompleteManifest,
      bundledNodeVersion: 'v22.23.1',
      applicationLicense: {
        applicationLicense: 'BUSL-1.1',
        applicationLicenseSha256,
      },
      rustNoticeGenerator,
    })).toThrow(/missing required runtime resource node\/LICENSE/iu);
  });

  it('rejects a pilot evidence inventory whose manifest digest is not authentic', () => {
    const dynamicConfig = createPilotConfig(baseConfig, 'pilot-public-key');

    expect(() => createPilotEvidence({
      dynamicConfig,
      installerFile: 'Provenance_Pilot_0.1.0_x64-setup.exe',
      installerBytes: 1024,
      installerSha256: 'a'.repeat(64),
      runtimeResourceManifest: {
        ...runtimeResourceManifest,
        sha256: 'b'.repeat(64),
      },
      bundledNodeVersion: 'v22.23.1',
      applicationLicense: {
        applicationLicense: 'BUSL-1.1',
        applicationLicenseSha256,
      },
      rustNoticeGenerator,
    })).toThrow(/manifest digest is invalid/iu);
  });

  it('normalizes prerelease and build metadata to the dedicated pilot version', () => {
    expect(pilotVersion('2.4.6-rc.3+build.9')).toBe('2.4.6-pilot.1');
    expect(() => pilotVersion('2.4')).toThrow(/semantic versioning/);
  });

  it('removes signing, certificate, PFX, and PowerShell module environment variables', () => {
    const environment = {
      Path: 'safe-path',
      SystemRoot: 'C:\\Windows',
      PROVENANCE_CARGO_ABOUT: 'C:\\tools\\cargo-about.exe',
      PROVENANCE_CARGO_ABOUT_SHA256: 'a'.repeat(64),
      PROVENANCE_CARGO_ABOUT_VERSION: '0.9.1',
      TAURI_SIGNING_PRIVATE_KEY: 'private-key',
      tauri_signing_private_key_password: 'private-key-password',
      WINDOWS_PFX_PATH: 'certificate.pfx',
      PROVENANCE_WINDOWS_CERTIFICATE_THUMBPRINT: 'certificate-thumbprint',
      WINDOWS_PFX_PASSWORD: 'pfx-password',
      PSModulePath: 'unsafe-module-search-path',
      OPENROUTER_API_KEY: 'provider-key',
      AWS_SECRET_ACCESS_KEY: 'cloud-secret',
      GITHUB_TOKEN: 'repository-token',
      UNRELATED_SERVICE_SECRET: 'generic-secret',
      PROVENANCE_SAFE_SETTING: 'formerly-kept-by-blocklist',
    };

    expect(sanitizedBuildEnvironment(environment)).toEqual({
      PATH: 'safe-path',
      SYSTEMROOT: 'C:\\Windows',
      PROVENANCE_CARGO_ABOUT: 'C:\\tools\\cargo-about.exe',
      PROVENANCE_CARGO_ABOUT_SHA256: 'a'.repeat(64),
      PROVENANCE_CARGO_ABOUT_VERSION: '0.9.1',
    });
    expect(environment.TAURI_SIGNING_PRIVATE_KEY).toBe('private-key');
  });

  it('runs both pilot resource builds inside the exact allowlisted environment', () => {
    const calls: Array<{
      command: string;
      args: string[];
      options: { env: Record<string, string> };
    }> = [];
    const buildEnvironment = buildPilotResources({
      PATH: 'safe-path',
      SYSTEMROOT: 'C:\\Windows',
      PROVENANCE_CARGO_ABOUT: 'C:\\tools\\cargo-about.exe',
      PROVENANCE_CARGO_ABOUT_SHA256: 'a'.repeat(64),
      PROVENANCE_CARGO_ABOUT_VERSION: '0.9.1',
      OPENROUTER_API_KEY: 'must-not-cross',
      AWS_SECRET_ACCESS_KEY: 'must-not-cross',
    }, (command, args = [], options = {}) => {
      if (!Array.isArray(args) || !('env' in options) || !options.env) {
        throw new Error('The test build invocation requires args and an environment.');
      }
      calls.push({
        command,
        args: [...args],
        options: { env: options.env as Record<string, string> },
      });
      return '';
    });

    expect(calls.map(({ command, args }) => ({ command, args }))).toEqual([
      {
        command: process.execPath,
        args: [expect.stringMatching(/[/\\]npm[/\\]bin[/\\]npm-cli\.js$/u), 'run', 'build'],
      },
      {
        command: process.execPath,
        args: [
          expect.stringMatching(/[/\\]npm[/\\]bin[/\\]npm-cli\.js$/u),
          'run',
          'desktop:licenses',
        ],
      },
    ]);
    expect(calls.every(({ options }) => options.env === buildEnvironment)).toBe(true);
    expect(buildEnvironment).toEqual({
      PATH: 'safe-path',
      SYSTEMROOT: 'C:\\Windows',
      PROVENANCE_CARGO_ABOUT: 'C:\\tools\\cargo-about.exe',
      PROVENANCE_CARGO_ABOUT_SHA256: 'a'.repeat(64),
      PROVENANCE_CARGO_ABOUT_VERSION: '0.9.1',
    });
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(packageJson.scripts['desktop:pilot-installer']).toBe(
      'node scripts/desktop-pilot-installer.mjs',
    );
  });
});

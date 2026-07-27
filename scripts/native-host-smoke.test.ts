import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  acceptanceAttestationPath,
  acceptanceNonceDigest,
  acceptanceSigningPayload,
  assertDedicatedProfilePath,
  assertProfileMayRun,
  assertTemporaryScratchPath,
  createAcceptanceUsers,
  expectedProfileBuildVersion,
  parseSmokeArguments,
  PROFILE_DEFINITIONS,
  proveAuthenticatedDesktopDiscover,
  proveAuthenticatedKernelRead,
  proveUnauthenticatedKernelReadDenied,
  validateAcceptanceRecord,
} from './native-host-smoke.mjs';

const nonce = Buffer.alloc(32, 7).toString('base64url');
const startedAtMs = 1_800_000_000_000;
const resourceManifestSha256 = 'c'.repeat(64);

const signedRecord = () => {
  const record = {
    schemaVersion: 3,
    type: 'native.acceptance.ready',
    nonceDigest: acceptanceNonceDigest(nonce),
    applicationIdentifier: 'dev.provenance.desktop.pilot',
    hostPid: 4100,
    nodePid: 4101,
    nodePort: 43123,
    hostInstanceId: `desktop-host-${'a'.repeat(32)}`,
    buildVersion: '1.2.3-pilot.1+build.4',
    packagedRelease: true,
    resourceManifestSha256,
    accessMode: 'multi_user',
    desktopAuthority: 'available',
    issuedAtMs: startedAtMs + 1_000,
    components: {
      runtimeOwnership: true,
      uiaHealthy: true,
      bridgeAuthenticated: true,
      nodeReady: true,
      kernelReady: true,
      schedulerDisabled: true,
      updaterSuppressed: true,
      exactOriginNavigation: true,
      dashboardMounted: true,
      monitorStarted: true,
    },
    proof: '',
  };
  record.proof = crypto
    .createHmac('sha256', nonce)
    .update(acceptanceSigningPayload(record), 'utf8')
    .digest('hex');
  return record;
};

const validationContext = {
  nonce,
  expectedHostPid: 4100,
  expectedBuildVersion: '1.2.3-pilot.1+build.4',
  expectedPackagedRelease: true,
  expectedResourceManifestSha256: resourceManifestSha256,
  expectedIdentifier: 'dev.provenance.desktop.pilot',
  startedAtMs,
  nowMs: startedAtMs + 2_000,
};

describe('native host acceptance profiles', () => {
  it('uses distinct fixed identities and restricts production to ephemeral Actions', () => {
    expect(new Set(Object.values(PROFILE_DEFINITIONS).map(({ identity }) => identity)).size).toBe(3);
    expect(PROFILE_DEFINITIONS.development).toEqual({
      identity: 'dev.provenance.desktop.development',
      packagedRelease: false,
    });
    expect(() => assertProfileMayRun('production', {})).toThrow(/ephemeral GitHub Actions/);
    expect(assertProfileMayRun('production', {
      GITHUB_ACTIONS: 'true',
      PROVENANCE_EPHEMERAL_ACCEPTANCE: '1',
    })).toBe(PROFILE_DEFINITIONS.production);
  });

  it('matches the compiled development and release configuration identities', () => {
    const development = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')) as {
      identifier?: unknown;
    };
    const production = JSON.parse(readFileSync('src-tauri/tauri.release.conf.json', 'utf8')) as {
      identifier?: unknown;
    };
    expect(development.identifier).toBe(PROFILE_DEFINITIONS.development.identity);
    expect(production.identifier).toBe(PROFILE_DEFINITIONS.production.identity);
  });

  it('requires the packaged flag exactly for production and pilot profiles', () => {
    expect(parseSmokeArguments(['--binary', 'host.exe'], {})).toMatchObject({
      profile: 'development',
      packagedRelease: false,
      expectedResourceManifestSha256: 'unverified-development',
    });
    expect(() => parseSmokeArguments([], {})).toThrow(/--binary is required/);
    expect(() => parseSmokeArguments(['--binary', 'host.exe', '--packaged'], {})).toThrow(/unpackaged host/);
    expect(() => parseSmokeArguments(['--binary', 'host.exe', '--profile', 'pilot'], {})).toThrow(/requires --packaged/);
    expect(() => parseSmokeArguments([
      '--binary', 'host.exe', '--profile', 'pilot', '--packaged',
    ], {})).toThrow(/expected-resource-manifest/);
    expect(parseSmokeArguments([
      '--binary', 'host.exe',
      '--profile', 'pilot',
      '--packaged',
      '--expected-resource-manifest-sha256', resourceManifestSha256,
    ], {})).toMatchObject({
      identity: 'dev.provenance.desktop.pilot',
      packagedRelease: true,
      expectedResourceManifestSha256: resourceManifestSha256,
    });
  });

  it('derives the compiled pilot version without carrying unrelated metadata', () => {
    expect(expectedProfileBuildVersion('1.2.3', 'development')).toBe('1.2.3');
    expect(expectedProfileBuildVersion('1.2.3-rc.4+build.7', 'pilot')).toBe('1.2.3-pilot.1');
  });

  it('keeps the seeded administrator password out of the persisted user records', () => {
    const users = createAcceptanceUsers();
    expect(users.adminCredentials).toMatchObject({ username: 'acceptance_admin' });
    expect(users.adminCredentials.password.length).toBeGreaterThan(32);
    expect(users.records).toHaveLength(2);
    expect(users.records.some((record: Record<string, unknown>) => 'password' in record)).toBe(false);
  });
});

describe('native host acceptance proof', () => {
  it('derives the nonce-bound runtime path and authenticates the exact Rust payload', () => {
    const runtime = path.join('C:\\', 'acceptance', 'runtime');
    const digest = acceptanceNonceDigest(nonce);
    const record = signedRecord();
    expect(acceptanceAttestationPath(runtime, nonce)).toBe(
      path.join(runtime, `.native-acceptance-${digest.slice(0, 32)}.json`),
    );
    expect(acceptanceSigningPayload(record)).toBe([
      'schemaVersion=3',
      'type=native.acceptance.ready',
      `nonceDigest=${digest}`,
      'applicationIdentifier=dev.provenance.desktop.pilot',
      'hostPid=4100',
      'nodePid=4101',
      'nodePort=43123',
      `hostInstanceId=desktop-host-${'a'.repeat(32)}`,
      'buildVersion=1.2.3-pilot.1+build.4',
      'packagedRelease=true',
      `resourceManifestSha256=${resourceManifestSha256}`,
      'accessMode=multi_user',
      'desktopAuthority=available',
      `issuedAtMs=${startedAtMs + 1_000}`,
      'runtimeOwnership=true',
      'uiaHealthy=true',
      'bridgeAuthenticated=true',
      'nodeReady=true',
      'kernelReady=true',
      'schedulerDisabled=true',
      'updaterSuppressed=true',
      'exactOriginNavigation=true',
      'dashboardMounted=true',
      'monitorStarted=true',
    ].join('\n'));
    expect(validateAcceptanceRecord(record, validationContext)).toMatchObject({
      hostPid: 4100,
      applicationIdentifier: 'dev.provenance.desktop.pilot',
      packagedRelease: true,
      desktopAuthority: 'available',
    });
  });

  it('denies unknown fields at both attestation levels', () => {
    expect(() => validateAcceptanceRecord({
      ...signedRecord(),
      token: 'must-not-be-accepted',
    }, validationContext)).toThrow(/exact authenticated schema/);
    const record = signedRecord();
    record.components = { ...record.components, recoveryMode: false } as typeof record.components;
    expect(() => validateAcceptanceRecord(record, validationContext)).toThrow(
      /exact authenticated schema/,
    );
  });

  it.each([
    ['host pid', (record: ReturnType<typeof signedRecord>) => { record.hostPid = 9999; }],
    ['application identity', (record: ReturnType<typeof signedRecord>) => {
      record.applicationIdentifier = 'dev.provenance.desktop';
    }],
    ['Node port', (record: ReturnType<typeof signedRecord>) => { record.nodePort = 0; }],
    ['packaging identity', (record: ReturnType<typeof signedRecord>) => { record.packagedRelease = false; }],
    ['resource manifest', (record: ReturnType<typeof signedRecord>) => {
      record.resourceManifestSha256 = 'd'.repeat(64);
    }],
    ['access mode', (record: ReturnType<typeof signedRecord>) => { record.accessMode = 'open'; }],
    ['desktop authority', (record: ReturnType<typeof signedRecord>) => { record.desktopAuthority = 'blocked'; }],
    ['readiness component', (record: ReturnType<typeof signedRecord>) => {
      record.components.bridgeAuthenticated = false;
    }],
    ['proof', (record: ReturnType<typeof signedRecord>) => { record.proof = '0'.repeat(64); }],
  ])('rejects tampered %s evidence', (_label, tamper) => {
    const record = signedRecord();
    tamper(record);
    expect(() => validateAcceptanceRecord(record, validationContext)).toThrow();
  });

  it('rejects stale evidence even when its proof is otherwise valid', () => {
    const record = signedRecord();
    record.issuedAtMs = startedAtMs - 31_000;
    record.proof = crypto
      .createHmac('sha256', nonce)
      .update(acceptanceSigningPayload(record), 'utf8')
      .digest('hex');
    expect(() => validateAcceptanceRecord(record, validationContext)).toThrow(/stale|timestamp/);
  });
});

describe('native host authentication boundary', () => {
  it.each([401, 403])('accepts HTTP %i as an unauthenticated protected-read denial', async (status) => {
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    const fetchImplementation = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      requests.push({ input: String(input), init });
      return new Response(null, { status });
    };

    await expect(proveUnauthenticatedKernelReadDenied(
      'http://127.0.0.1:43123',
      fetchImplementation,
    )).resolves.toBe(status);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.input).toBe('http://127.0.0.1:43123/api/kernel/workers');
    expect(requests[0]?.init?.headers).toEqual({ origin: 'http://127.0.0.1:43123' });
  });

  it.each([200, 302, 500])('rejects HTTP %i as missing anonymous access control', async (status) => {
    await expect(proveUnauthenticatedKernelReadDenied(
      'http://127.0.0.1:43123',
      async () => new Response(null, { status }),
    )).rejects.toThrow(`was not denied (HTTP ${status})`);
  });

  it('proves denial before login and returns the denial status as evidence', async () => {
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    const token = 't'.repeat(64);
    const responses = [
      new Response(null, { status: 401 }),
      Response.json({ token, role: 'admin', username: 'acceptance_admin' }),
      new Response(null, { status: 204 }),
      Response.json({ report: { available: ['worker.desktop.windows_uia'] } }),
    ];
    const fetchImplementation = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      requests.push({ input: String(input), init });
      const response = responses.shift();
      if (!response) throw new Error('Unexpected acceptance request.');
      return response;
    };

    await expect(proveAuthenticatedKernelRead(
      { nodePort: 43123 },
      { username: 'acceptance_admin', password: 'acceptance-password' },
      fetchImplementation,
    )).resolves.toEqual({
      unauthenticatedKernelReadStatus: 401,
      authorization: `Bearer ${token}`,
    });
    expect(requests.map(({ input }) => input)).toEqual([
      'http://127.0.0.1:43123/api/kernel/workers',
      'http://127.0.0.1:43123/api/auth/login',
      'http://127.0.0.1:43123/api/auth/session/verify',
      'http://127.0.0.1:43123/api/kernel/workers',
    ]);
    expect(requests[0]?.init?.headers).toEqual({ origin: 'http://127.0.0.1:43123' });
    expect(requests[3]?.init?.headers).toEqual({
      authorization: `Bearer ${token}`,
      origin: 'http://127.0.0.1:43123',
    });
  });

  it('creates, enables, and executes an authenticated L0 UIA discovery mission', async () => {
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    const responses = [
      Response.json({ id: 'goal_acceptance' }, { status: 201 }),
      Response.json({
        id: 'automation_acceptance',
        workerId: 'worker.desktop.windows_uia',
        action: { type: 'desktop.discover', appId: 'windows.notepad' },
      }, { status: 201 }),
      Response.json({ id: 'automation_acceptance', enabled: true }),
      Response.json({
        decision: { kind: 'allow' },
        dispatch: {
          status: 'succeeded',
          sourceRef: 'desktop:windows.notepad:windows',
          summary: 'Recorded bounded windows for the allowlisted application.',
        },
        content: JSON.stringify({
          schemaVersion: 1,
          kind: 'desktop.windows',
          appId: 'windows.notepad',
          windows: [],
        }),
      }),
    ];
    const fetchImplementation = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      requests.push({ input: String(input), init });
      const response = responses.shift();
      if (!response) throw new Error('Unexpected acceptance request.');
      return response;
    };

    await expect(proveAuthenticatedDesktopDiscover(
      { nodePort: 43123 },
      `Bearer ${'t'.repeat(64)}`,
      path.resolve('acceptance-workspace'),
      fetchImplementation,
    )).resolves.toEqual({
      goalId: 'goal_acceptance',
      automationId: 'automation_acceptance',
      workerId: 'worker.desktop.windows_uia',
      discoveredWindows: 0,
    });
    expect(requests.map(({ input }) => input)).toEqual([
      'http://127.0.0.1:43123/api/kernel/goals',
      'http://127.0.0.1:43123/api/kernel/automations',
      'http://127.0.0.1:43123/api/kernel/automations/automation_acceptance/enabled',
      'http://127.0.0.1:43123/api/kernel/automations/automation_acceptance/run',
    ]);
    const goalBody = JSON.parse(String(requests[0]?.init?.body));
    const automationBody = JSON.parse(String(requests[1]?.init?.body));
    expect(goalBody.workspaceRoot).toBe(path.resolve('acceptance-workspace'));
    expect(automationBody).toMatchObject({
      workerId: 'worker.desktop.windows_uia',
      riskLevel: 'L0',
      action: { type: 'desktop.discover', appId: 'windows.notepad' },
      scope: {
        family: 'desktop',
        operations: ['desktop.discover'],
        appId: 'windows.notepad',
      },
    });
  });
});

describe('native host acceptance deletion boundaries', () => {
  it('accepts only exact fixed profile and direct scratch paths', () => {
    const local = path.join('C:\\', 'Users', 'runner', 'AppData', 'Local');
    const profile = path.join(local, PROFILE_DEFINITIONS.pilot.identity);
    expect(assertDedicatedProfilePath(local, profile, PROFILE_DEFINITIONS.pilot.identity)).toBe(profile);
    expect(() => assertDedicatedProfilePath(
      local,
      path.join(local, `${PROFILE_DEFINITIONS.pilot.identity}-other`),
      PROFILE_DEFINITIONS.pilot.identity,
    )).toThrow(/exact dedicated/);

    const temporary = path.join('C:\\', 'temp');
    expect(assertTemporaryScratchPath(
      path.join(temporary, 'provenance-native-acceptance-abc123'),
      temporary,
    )).toBe(path.join(temporary, 'provenance-native-acceptance-abc123'));
    expect(() => assertTemporaryScratchPath(
      path.join(temporary, 'parent', 'provenance-native-acceptance-abc123'),
      temporary,
    )).toThrow(/outside/);
  });
});

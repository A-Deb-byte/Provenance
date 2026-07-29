#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const maximumLogChars = 32 * 1024;
const maximumAttestationBytes = 8 * 1024;
const defaultTimeoutMs = 150_000;
const pollIntervalMs = 250;
const gracefulShutdownTimeoutMs = 15_000;
const cleanupTimeoutMs = 10_000;
const livenessSoakMs = 2_000;
const maximumApiResponseBytes = 64 * 1024;
const profileMarkerName = '.provenance-native-acceptance-owner.json';
const acceptanceType = 'native.acceptance.ready';
const semanticVersionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const hostInstancePattern = /^desktop-host-[a-f0-9]{32}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const noncePattern = /^[A-Za-z0-9_-]{43}$/u;
const developmentResourceManifestSentinel = 'unverified-development';

export const PROFILE_DEFINITIONS = Object.freeze({
  acceptance: Object.freeze({
    identity: 'dev.provenance.desktop.acceptance',
    packagedRelease: false,
  }),
  development: Object.freeze({
    identity: 'dev.provenance.desktop.development',
    packagedRelease: false,
  }),
  production: Object.freeze({
    identity: 'dev.provenance.desktop',
    packagedRelease: true,
  }),
  pilot: Object.freeze({
    identity: 'dev.provenance.desktop.pilot',
    packagedRelease: true,
  }),
});

const topLevelAttestationKeys = Object.freeze([
  'accessMode',
  'applicationIdentifier',
  'buildVersion',
  'components',
  'desktopAuthority',
  'hostInstanceId',
  'hostPid',
  'issuedAtMs',
  'nodePid',
  'nodePort',
  'nonceDigest',
  'packagedRelease',
  'proof',
  'resourceManifestSha256',
  'schemaVersion',
  'type',
]);
const componentKeys = Object.freeze([
  'bridgeAuthenticated',
  'dashboardMounted',
  'exactOriginNavigation',
  'kernelReady',
  'monitorStarted',
  'nodeReady',
  'runtimeOwnership',
  'schedulerDisabled',
  'updaterSuppressed',
  'uiaHealthy',
]);

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const appendBounded = (current, chunk) => (
  `${current}${chunk.toString('utf8')}`.slice(-maximumLogChars)
);
const tail = (value) => JSON.stringify(value.slice(-2_000));
const isPlainRecord = (value) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const errorText = (error) => error instanceof Error ? error.message : String(error);
const samePath = (left, right) => (
  process.platform === 'win32'
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right)
);
const isProcessComplete = (child) => child.exitCode !== null || child.signalCode !== null;

const exactKeys = (value, expected, label) => {
  if (!isPlainRecord(value)) throw new Error(`${label} must be a plain object.`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} does not have the exact authenticated schema.`);
  }
};

const validateNonce = (nonce) => {
  if (typeof nonce !== 'string' || !noncePattern.test(nonce)) {
    throw new Error('The native acceptance nonce must be a 32-byte base64url value.');
  }
  return nonce;
};

export const assertProfileMayRun = (profile, environment = process.env) => {
  if (!Object.hasOwn(PROFILE_DEFINITIONS, profile)) {
    throw new Error('--profile must be acceptance, development, production, or pilot.');
  }
  if (profile === 'production' && !(
    environment.GITHUB_ACTIONS === 'true'
    && environment.PROVENANCE_EPHEMERAL_ACCEPTANCE === '1'
  )) {
    throw new Error(
      'The production profile is restricted to an ephemeral GitHub Actions acceptance runner.',
    );
  }
  return PROFILE_DEFINITIONS[profile];
};

export const parseSmokeArguments = (args, environment = process.env) => {
  const values = new Map();
  let packaged = false;
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === '--packaged') {
      if (packaged) throw new Error('--packaged may be supplied only once.');
      packaged = true;
      continue;
    }
    if (![
      '--binary',
      '--expected-resource-manifest-sha256',
      '--profile',
      '--timeout-ms',
      '--window-ms',
    ].includes(name)) {
      throw new Error(`Unknown native acceptance argument: ${name}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
    const key = name === '--window-ms' ? '--timeout-ms' : name;
    if (values.has(key)) throw new Error(`${key} may be supplied only once.`);
    values.set(key, value);
    index += 1;
  }

  const profile = values.get('--profile') || 'development';
  const definition = assertProfileMayRun(profile, environment);
  if (definition.packagedRelease !== packaged) {
    throw new Error(
      definition.packagedRelease
        ? `The ${profile} profile requires --packaged.`
        : 'The development profile must exercise an unpackaged host.',
    );
  }
  const timeoutMs = Number(values.get('--timeout-ms') || defaultTimeoutMs);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 300_000) {
    throw new Error('--timeout-ms must be an integer between 5000 and 300000.');
  }
  const configuredBinary = values.get('--binary');
  if (!configuredBinary) {
    throw new Error('--binary is required so acceptance exercises an explicit executable.');
  }
  const configuredResourceDigest = values.get('--expected-resource-manifest-sha256');
  if (definition.packagedRelease
      && (typeof configuredResourceDigest !== 'string'
        || !sha256Pattern.test(configuredResourceDigest))) {
    throw new Error(
      '--expected-resource-manifest-sha256 is required for packaged acceptance.',
    );
  }
  if (!definition.packagedRelease && configuredResourceDigest !== undefined) {
    throw new Error('Development acceptance uses the fixed unverified resource sentinel.');
  }
  return {
    binary: path.resolve(configuredBinary),
    profile,
    identity: definition.identity,
    packagedRelease: definition.packagedRelease,
    timeoutMs,
    expectedResourceManifestSha256:
      configuredResourceDigest ?? developmentResourceManifestSentinel,
  };
};

export const expectedProfileBuildVersion = (baseVersion, profile) => {
  if (typeof baseVersion !== 'string' || !semanticVersionPattern.test(baseVersion)) {
    throw new Error('The base Tauri configuration does not contain a public semantic version.');
  }
  if (!Object.hasOwn(PROFILE_DEFINITIONS, profile)) {
    throw new Error('Cannot derive a build version for an unknown acceptance profile.');
  }
  if (profile !== 'pilot') return baseVersion;
  return `${baseVersion.split(/[+-]/u, 1)[0]}-pilot.1`;
};

export const acceptanceNonceDigest = (nonce) => (
  crypto.createHash('sha256').update(validateNonce(nonce), 'utf8').digest('hex')
);

export const acceptanceAttestationPath = (runtimeDirectory, nonce) => path.join(
  path.resolve(runtimeDirectory),
  `.native-acceptance-${acceptanceNonceDigest(nonce).slice(0, 32)}.json`,
);

export const acceptanceSigningPayload = (record) => [
  `schemaVersion=${record.schemaVersion}`,
  `type=${record.type}`,
  `nonceDigest=${record.nonceDigest}`,
  `applicationIdentifier=${record.applicationIdentifier}`,
  `hostPid=${record.hostPid}`,
  `nodePid=${record.nodePid}`,
  `nodePort=${record.nodePort}`,
  `hostInstanceId=${record.hostInstanceId}`,
  `buildVersion=${record.buildVersion}`,
  `packagedRelease=${record.packagedRelease}`,
  `resourceManifestSha256=${record.resourceManifestSha256}`,
  `accessMode=${record.accessMode}`,
  `desktopAuthority=${record.desktopAuthority}`,
  `issuedAtMs=${record.issuedAtMs}`,
  `runtimeOwnership=${record.components.runtimeOwnership}`,
  `uiaHealthy=${record.components.uiaHealthy}`,
  `bridgeAuthenticated=${record.components.bridgeAuthenticated}`,
  `nodeReady=${record.components.nodeReady}`,
  `kernelReady=${record.components.kernelReady}`,
  `schedulerDisabled=${record.components.schedulerDisabled}`,
  `updaterSuppressed=${record.components.updaterSuppressed}`,
  `exactOriginNavigation=${record.components.exactOriginNavigation}`,
  `dashboardMounted=${record.components.dashboardMounted}`,
  `monitorStarted=${record.components.monitorStarted}`,
].join('\n');

export const validateAcceptanceRecord = (record, context) => {
  exactKeys(record, topLevelAttestationKeys, 'Native acceptance attestation');
  exactKeys(record.components, componentKeys, 'Native acceptance components');
  const nonce = validateNonce(context.nonce);
  if (record.schemaVersion !== 3 || record.type !== acceptanceType) {
    throw new Error('Native acceptance attestation version or type is invalid.');
  }
  const digest = acceptanceNonceDigest(nonce);
  if (typeof record.nonceDigest !== 'string' || !sha256Pattern.test(record.nonceDigest)
      || record.nonceDigest !== digest) {
    throw new Error('Native acceptance attestation is not bound to this launch nonce.');
  }
  if (record.applicationIdentifier !== context.expectedIdentifier) {
    throw new Error('Native acceptance attestation is not bound to the expected application identity.');
  }
  if (!Number.isSafeInteger(record.hostPid) || record.hostPid <= 0
      || record.hostPid !== context.expectedHostPid) {
    throw new Error('Native acceptance attestation is not bound to the spawned host process.');
  }
  if (!Number.isSafeInteger(record.nodePid) || record.nodePid <= 0
      || record.nodePid === record.hostPid) {
    throw new Error('Native acceptance attestation has an invalid supervised Node process.');
  }
  if (!Number.isSafeInteger(record.nodePort) || record.nodePort < 1 || record.nodePort > 65_535) {
    throw new Error('Native acceptance attestation has an invalid supervised Node port.');
  }
  if (typeof record.hostInstanceId !== 'string'
      || !hostInstancePattern.test(record.hostInstanceId)) {
    throw new Error('Native acceptance attestation has an invalid host instance identity.');
  }
  if (typeof record.buildVersion !== 'string'
      || record.buildVersion.length > 128
      || !semanticVersionPattern.test(record.buildVersion)
      || record.buildVersion !== context.expectedBuildVersion) {
    throw new Error('Native acceptance attestation has an unexpected build version.');
  }
  if (typeof record.packagedRelease !== 'boolean'
      || record.packagedRelease !== context.expectedPackagedRelease) {
    throw new Error('Native acceptance attestation has the wrong packaging identity.');
  }
  const expectedResourceManifestSha256 = context.expectedResourceManifestSha256;
  if (record.resourceManifestSha256 !== expectedResourceManifestSha256
      || (context.expectedPackagedRelease
        ? !sha256Pattern.test(record.resourceManifestSha256)
        : record.resourceManifestSha256 !== developmentResourceManifestSentinel)) {
    throw new Error(
      'Native acceptance attestation is not bound to the independently expected resource manifest.',
    );
  }
  if (record.accessMode !== 'multi_user') {
    throw new Error('Native acceptance did not establish authenticated multi-user access.');
  }
  if (record.desktopAuthority !== 'available') {
    throw new Error('Native acceptance did not establish available desktop authority.');
  }
  if (!Number.isSafeInteger(record.issuedAtMs)
      || record.issuedAtMs < context.startedAtMs - 5_000
      || record.issuedAtMs > context.nowMs + 5_000
      || context.nowMs - record.issuedAtMs > 30_000) {
    throw new Error('Native acceptance attestation is stale or has an invalid timestamp.');
  }
  for (const key of componentKeys) {
    if (record.components[key] !== true) {
      throw new Error(`Native acceptance component ${key} is not authenticated as ready.`);
    }
  }
  if (typeof record.proof !== 'string' || !sha256Pattern.test(record.proof)) {
    throw new Error('Native acceptance proof is malformed.');
  }
  const expectedProof = crypto
    .createHmac('sha256', nonce)
    .update(acceptanceSigningPayload(record), 'utf8')
    .digest();
  const actualProof = Buffer.from(record.proof, 'hex');
  if (actualProof.length !== expectedProof.length
      || !crypto.timingSafeEqual(actualProof, expectedProof)) {
    throw new Error('Native acceptance proof failed authentication.');
  }
  return record;
};

export const assertDedicatedProfilePath = (rootDirectory, candidate, identity) => {
  const identities = new Set(Object.values(PROFILE_DEFINITIONS).map((item) => item.identity));
  if (!identities.has(identity)) throw new Error('Refusing an unknown native profile identity.');
  const expected = path.join(path.resolve(rootDirectory), identity);
  if (!samePath(candidate, expected)) {
    throw new Error('Refusing a profile path outside the exact dedicated native identity.');
  }
  return expected;
};

export const assertTemporaryScratchPath = (candidate, temporaryDirectory = os.tmpdir()) => {
  const resolved = path.resolve(candidate);
  const parent = path.resolve(temporaryDirectory);
  const relative = path.relative(parent, resolved);
  if (path.dirname(relative) !== '.' || !path.basename(resolved).startsWith('provenance-native-acceptance-')) {
    throw new Error('Refusing to delete a path outside the native acceptance scratch root.');
  }
  return resolved;
};

const fileExists = async (target) => {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
};

const startWindowsDesktopFixture = async (scratchRoot, maximumLifetimeMs) => {
  if (process.platform !== 'win32') {
    throw new Error('The native Windows acceptance fixture requires Windows.');
  }
  if (!Number.isSafeInteger(maximumLifetimeMs)
      || maximumLifetimeMs < 30_000
      || maximumLifetimeMs > 360_000) {
    throw new Error('The Windows UIA fixture requires a bounded absolute lifetime.');
  }
  const executablePath = await realpath(path.join(
    process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  ));
  const readyPath = path.join(scratchRoot, '.desktop-fixture-ready');
  const stopPath = path.join(scratchRoot, '.desktop-fixture-stop');
  const title = `Provenance native UIA acceptance ${crypto.randomUUID()}`;
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$form = New-Object System.Windows.Forms.Form',
    '$form.Text = $env:PROVENANCE_UIA_FIXTURE_TITLE',
    '$form.Width = 420',
    '$form.Height = 220',
    '$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual',
    '$form.Location = New-Object System.Drawing.Point(40, 40)',
    '$form.ShowInTaskbar = $false',
    '$toggle = New-Object System.Windows.Forms.CheckBox',
    '$toggle.Name = "AcceptanceToggle"',
    '$toggle.Text = "Acceptance toggle"',
    '$toggle.Location = New-Object System.Drawing.Point(24, 28)',
    '$input = New-Object System.Windows.Forms.TextBox',
    '$input.Name = "AcceptanceInput"',
    '$input.AccessibleName = "Acceptance input"',
    '$input.Location = New-Object System.Drawing.Point(24, 74)',
    '$input.Width = 340',
    '$form.Controls.Add($toggle)',
    '$form.Controls.Add($input)',
    '$timer = New-Object System.Windows.Forms.Timer',
    '$timer.Interval = 200',
    '$timer.Add_Tick({',
    '  $owner = Get-Process -Id ([int]$env:PROVENANCE_UIA_FIXTURE_OWNER_PID) -ErrorAction SilentlyContinue',
    '  $expired = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge ([long]$env:PROVENANCE_UIA_FIXTURE_DEADLINE_MS)',
    '  if (-not $owner -or $expired -or (Test-Path -LiteralPath $env:PROVENANCE_UIA_FIXTURE_STOP)) {',
    '    $timer.Stop()',
    '    $form.Close()',
    '  }',
    '})',
    '$form.Add_Shown({',
    '  [System.IO.File]::WriteAllText($env:PROVENANCE_UIA_FIXTURE_READY, "ready")',
    '  $timer.Start()',
    '})',
    '[void]$form.ShowDialog()',
  ].join('\r\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const logs = { stdout: '', stderr: '' };
  const child = spawn(executablePath, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-STA',
    '-EncodedCommand',
    encoded,
  ], {
    cwd: scratchRoot,
    env: {
      ...inheritedEnvironment(),
      PROVENANCE_UIA_FIXTURE_READY: readyPath,
      PROVENANCE_UIA_FIXTURE_STOP: stopPath,
      PROVENANCE_UIA_FIXTURE_TITLE: title,
      PROVENANCE_UIA_FIXTURE_OWNER_PID: String(process.pid),
      PROVENANCE_UIA_FIXTURE_DEADLINE_MS: String(Date.now() + maximumLifetimeMs),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', (chunk) => {
    logs.stdout = appendBounded(logs.stdout, chunk);
  });
  child.stderr.on('data', (chunk) => {
    logs.stderr = appendBounded(logs.stderr, chunk);
  });
  await new Promise((resolve, reject) => {
    const spawned = () => {
      child.off('error', failed);
      resolve();
    };
    const failed = (error) => {
      child.off('spawn', spawned);
      reject(new Error(`The Windows UIA fixture could not be spawned: ${error.message}`));
    };
    child.once('spawn', spawned);
    child.once('error', failed);
  });

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (isProcessComplete(child)) {
      throw new Error(
        `The Windows UIA fixture exited before readiness (code ${child.exitCode}). `
        + `stdout=${tail(logs.stdout)} stderr=${tail(logs.stderr)}`,
      );
    }
    if (await fileExists(readyPath)) {
      return {
        appId: 'windows.acceptance_fixture',
        executablePath,
        child,
        logs,
        stopPath,
        title,
      };
    }
    await delay(pollIntervalMs);
  }
  const terminated = child.kill('SIGKILL');
  if (!terminated) {
    throw new Error(
      `The Windows UIA fixture did not become visible and could not be terminated. `
      + `stdout=${tail(logs.stdout)} stderr=${tail(logs.stderr)}`,
    );
  }
  try {
    await waitForExit(child, 5_000);
  } catch {
    throw new Error(
      `The Windows UIA fixture did not become visible and survived forced termination. `
      + `stdout=${tail(logs.stdout)} stderr=${tail(logs.stderr)}`,
    );
  }
  throw new Error(
    `The Windows UIA fixture did not become visible. stdout=${tail(logs.stdout)} stderr=${tail(logs.stderr)}`,
  );
};

const stopWindowsDesktopFixture = async (fixture) => {
  if (!fixture || isProcessComplete(fixture.child)) return;
  try {
    await writeFile(fixture.stopPath, 'stop', { encoding: 'utf8', flag: 'wx' });
    const exit = await waitForExit(fixture.child, 10_000);
    if (exit.code !== 0 || exit.signal !== null) {
      throw new Error(
        `The Windows UIA fixture did not exit cleanly (code ${exit.code}, signal ${exit.signal}).`,
      );
    }
  } catch (error) {
    if (!isProcessComplete(fixture.child)) {
      const terminated = fixture.child.kill('SIGKILL');
      if (!terminated) {
        throw new Error(`The Windows UIA fixture cleanup failed and could not terminate its process: ${errorText(error)}`);
      }
      try {
        await waitForExit(fixture.child, 5_000);
      } catch {
        throw new Error(`The Windows UIA fixture survived forced cleanup after: ${errorText(error)}`);
      }
    }
    throw error;
  }
};

const reserveProfile = async (rootDirectory, identity, runId) => {
  const profile = assertDedicatedProfilePath(rootDirectory, path.join(rootDirectory, identity), identity);
  try {
    await mkdir(profile, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error(
        `Refusing to reuse the existing ${identity} profile at ${profile}; acceptance state must be fresh.`,
      );
    }
    throw error;
  }
  const marker = path.join(profile, profileMarkerName);
  try {
    await writeFile(marker, JSON.stringify({ schemaVersion: 1, identity, runId }), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    await rm(profile, { recursive: true, force: true });
    throw error;
  }
  return { profile, rootDirectory, identity, runId, marker };
};

const removeOwnedProfile = async (reservation) => {
  const profile = assertDedicatedProfilePath(
    reservation.rootDirectory,
    reservation.profile,
    reservation.identity,
  );
  if (!(await fileExists(profile))) return;
  const profileMetadata = await lstat(profile);
  if (!profileMetadata.isDirectory() || profileMetadata.isSymbolicLink()) {
    throw new Error(`Refusing to delete a replaced native profile path: ${profile}`);
  }
  const markerMetadata = await lstat(reservation.marker);
  if (!markerMetadata.isFile() || markerMetadata.isSymbolicLink()) {
    throw new Error(`Refusing to delete a native profile without its ownership marker: ${profile}`);
  }
  const marker = JSON.parse(await readFile(reservation.marker, 'utf8'));
  exactKeys(marker, ['identity', 'runId', 'schemaVersion'], 'Native acceptance profile marker');
  if (marker.schemaVersion !== 1 || marker.identity !== reservation.identity
      || marker.runId !== reservation.runId) {
    throw new Error(`Refusing to delete a native profile owned by another run: ${profile}`);
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
};

export const createAcceptanceUsers = () => {
  const createdAt = new Date().toISOString();
  const createUser = (role) => {
    const salt = crypto.randomBytes(16).toString('hex');
    const password = crypto.randomBytes(32).toString('base64url');
    const username = `acceptance_${role}`;
    return {
      credentials: { username, password },
      record: {
        id: `user_${crypto.randomUUID()}`,
        username,
        role,
        salt,
        passwordHash: crypto.scryptSync(password, salt, 64).toString('hex'),
        sessionVersion: 0,
        createdAt,
      },
    };
  };
  const admin = createUser('admin');
  const operator = createUser('operator');
  return {
    records: [admin.record, operator.record],
    adminCredentials: admin.credentials,
  };
};

export const readBoundedRegularFile = async (target, maximumBytes = maximumAttestationBytes) => {
  const initial = await lstat(target);
  if (!initial.isFile() || initial.isSymbolicLink() || initial.size > maximumBytes) {
    throw new Error('Native acceptance attestation must be a bounded, non-link regular file.');
  }
  const handle = await open(target, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > maximumBytes) {
      throw new Error('Native acceptance attestation changed or exceeds its bounded size.');
    }
    const buffer = Buffer.alloc(maximumBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maximumBytes) {
      throw new Error('Native acceptance attestation exceeds its bounded size.');
    }
    return buffer.subarray(0, offset).toString('utf8');
  } finally {
    await handle.close();
  }
};

const processIsAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
};

export const assertDirectChildProcess = async (hostPid, nodePid) => {
  if (!Number.isSafeInteger(hostPid) || hostPid <= 0
      || !Number.isSafeInteger(nodePid) || nodePid <= 0 || nodePid === hostPid) {
    throw new Error('Direct-child verification requires distinct positive process ids.');
  }
  const script = [
    `$child = Get-CimInstance Win32_Process -Filter \"ProcessId = ${nodePid}\" -ErrorAction Stop`,
    "if ($null -eq $child) { throw 'The attested Node process is not running.' }",
    `[Console]::Out.Write($child.ParentProcessId)`,
  ].join('; ');
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script,
  ], {
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 16 * 1024,
  });
  if (Number.parseInt(stdout.trim(), 10) !== hostPid) {
    throw new Error('The attested Node process is not a direct child of the spawned native host.');
  }
};

const readBoundedJsonResponse = async (response) => {
  const declared = Number.parseInt(response.headers.get('content-length') || '', 10);
  if (Number.isFinite(declared) && declared > maximumApiResponseBytes) {
    throw new Error('Native acceptance API response exceeds its bounded size.');
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body || []) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > maximumApiResponseBytes) {
      throw new Error('Native acceptance API response exceeds its bounded size.');
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
  } catch {
    throw new Error('Native acceptance API returned invalid JSON.');
  }
};

export const proveUnauthenticatedKernelReadDenied = async (
  origin,
  fetchImplementation = fetch,
) => {
  const response = await fetchImplementation(`${origin}/api/kernel/workers`, {
    headers: { origin },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== 401 && response.status !== 403) {
    throw new Error(
      `Native acceptance unauthenticated kernel read was not denied (HTTP ${response.status}).`,
    );
  }
  return response.status;
};

export const proveAuthenticatedKernelRead = async (
  record,
  credentials,
  fetchImplementation = fetch,
) => {
  if (!credentials?.username || !credentials?.password) {
    throw new Error('The isolated acceptance administrator credentials are unavailable.');
  }
  const origin = `http://127.0.0.1:${record.nodePort}`;
  const unauthenticatedKernelReadStatus = await proveUnauthenticatedKernelReadDenied(
    origin,
    fetchImplementation,
  );
  const login = await fetchImplementation(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify(credentials),
    signal: AbortSignal.timeout(10_000),
  });
  if (login.status !== 200) {
    throw new Error(`Native acceptance login failed with HTTP ${login.status}.`);
  }
  const session = await readBoundedJsonResponse(login);
  if (!isPlainRecord(session)
      || typeof session.token !== 'string' || session.token.length < 32 || session.token.length > 8_192
      || session.role !== 'admin' || session.username !== credentials.username) {
    throw new Error('Native acceptance login returned an invalid administrator session.');
  }
  const authorization = `Bearer ${session.token}`;
  const verified = await fetchImplementation(`${origin}/api/auth/session/verify`, {
    method: 'POST',
    headers: { authorization, origin },
    signal: AbortSignal.timeout(10_000),
  });
  if (verified.status !== 204) {
    throw new Error(`Native acceptance session verification failed with HTTP ${verified.status}.`);
  }
  const workersResponse = await fetchImplementation(`${origin}/api/kernel/workers`, {
    headers: { authorization, origin },
    signal: AbortSignal.timeout(10_000),
  });
  if (workersResponse.status !== 200) {
    throw new Error(`Native acceptance protected kernel read failed with HTTP ${workersResponse.status}.`);
  }
  const workers = await readBoundedJsonResponse(workersResponse);
  if (!isPlainRecord(workers) || !isPlainRecord(workers.report)
      || !Array.isArray(workers.report.available)
      || !workers.report.available.includes('worker.desktop.windows_uia')) {
    throw new Error('Native acceptance protected kernel read did not expose the available desktop worker.');
  }
  return { unauthenticatedKernelReadStatus, authorization };
};

export const proveAuthenticatedDesktopDiscover = async (
  record,
  authorization,
  workspaceRoot,
  fetchImplementation = fetch,
  options = {},
) => {
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')
      || typeof workspaceRoot !== 'string' || !path.isAbsolute(workspaceRoot)) {
    throw new Error('Native acceptance desktop proof requires its authenticated session and scratch workspace.');
  }
  const appId = typeof options.appId === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/u.test(options.appId)
    ? options.appId
    : 'windows.notepad';
  const origin = `http://127.0.0.1:${record.nodePort}`;
  const postJson = async (pathname, body, expectedStatus) => {
    const response = await fetchImplementation(`${origin}/api/kernel${pathname}`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json', origin },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(35_000),
    });
    const payload = await readBoundedJsonResponse(response);
    if (response.status !== expectedStatus) {
      const detail = isPlainRecord(payload) && typeof payload.error === 'string'
        ? `: ${payload.error.slice(0, 500)}`
        : '';
      throw new Error(
        `Native acceptance desktop proof ${pathname} failed with HTTP ${response.status}${detail}.`,
      );
    }
    if (!isPlainRecord(payload)) {
      throw new Error(`Native acceptance desktop proof ${pathname} returned an invalid object.`);
    }
    return payload;
  };

  const goal = await postJson('/goals', {
    objective: 'Prove authenticated native desktop discovery',
    successCriteria: ['The Windows UI Automation worker returns a succeeded discovery result.'],
    constraints: [
      `Use only the configured ${appId} application scope.`,
      'Do not mutate any desktop application.',
    ],
    autonomyLevel: 'supervised',
    workspaceRoot,
    verificationCommands: ['npm test'],
    budget: {
      maxOperations: 2,
      maxCommandRuntimeMs: 30_000,
      maxApprovals: 0,
      maxProviderCalls: 0,
    },
  }, 201);
  if (typeof goal.id !== 'string' || !goal.id) {
    throw new Error('Native acceptance goal creation returned no goal id.');
  }

  const automation = await postJson('/automations', {
    name: 'Native acceptance UIA fixture discovery',
    goalId: goal.id,
    workerId: 'worker.desktop.windows_uia',
    riskLevel: 'L0',
    action: { type: 'desktop.discover', appId },
    scope: {
      family: 'desktop',
      operations: ['desktop.discover'],
      appId,
    },
    trigger: { type: 'manual' },
    approvalMode: 'per_run',
    budget: { maxRuns: 1, maxConsecutiveFailures: 1, maxRuntimeMsPerRun: 30_000 },
  }, 201);
  if (typeof automation.id !== 'string' || !automation.id
      || automation.workerId !== 'worker.desktop.windows_uia'
      || !isPlainRecord(automation.action)
      || automation.action.type !== 'desktop.discover'
      || automation.action.appId !== appId) {
    throw new Error('Native acceptance automation was not bound to the exact desktop discovery scope.');
  }

  const enabled = await postJson(`/automations/${encodeURIComponent(automation.id)}/enabled`, {
    enabled: true,
    reason: 'Execute the bounded authenticated native acceptance discovery.',
  }, 200);
  if (enabled.enabled !== true) {
    throw new Error('Native acceptance desktop discovery automation did not become enabled.');
  }
  const outcome = await postJson(
    `/automations/${encodeURIComponent(automation.id)}/run`,
    {},
    200,
  );
  if (!isPlainRecord(outcome.decision) || outcome.decision.kind !== 'allow'
      || !isPlainRecord(outcome.dispatch) || outcome.dispatch.status !== 'succeeded'
      || outcome.dispatch.sourceRef !== `desktop:${appId}:windows`
      || typeof outcome.content !== 'string') {
    const dispatch = isPlainRecord(outcome.dispatch) ? outcome.dispatch : {};
    const detail = [
      `decision=${isPlainRecord(outcome.decision) ? String(outcome.decision.kind) : 'invalid'}`,
      `status=${typeof dispatch.status === 'string' ? dispatch.status : 'missing'}`,
      `errorCode=${typeof dispatch.errorCode === 'string' ? dispatch.errorCode : 'missing'}`,
      `sourceRef=${typeof dispatch.sourceRef === 'string' ? dispatch.sourceRef : 'missing'}`,
      `summary=${typeof dispatch.summary === 'string' ? dispatch.summary.slice(0, 500) : 'missing'}`,
    ].join(' ');
    throw new Error(
      `Native acceptance desktop discovery did not return a succeeded UIA dispatch. ${detail}`,
    );
  }
  let discovery;
  try {
    discovery = JSON.parse(outcome.content);
  } catch {
    throw new Error('Native acceptance desktop discovery returned invalid observation JSON.');
  }
  if (!isPlainRecord(discovery)
      || discovery.schemaVersion !== 1
      || discovery.kind !== 'desktop.windows'
      || discovery.appId !== appId
      || !Array.isArray(discovery.windows)) {
    throw new Error('Native acceptance desktop discovery returned an invalid UIA observation.');
  }
  if (discovery.windows.length === 0) {
    throw new Error('Native acceptance desktop discovery found no controlled fixture window.');
  }
  for (const window of discovery.windows) {
    if (!isPlainRecord(window)
        || typeof window.windowId !== 'string' || !window.windowId
        || typeof window.title !== 'string'
        || typeof window.treeRevision !== 'string' || !window.treeRevision) {
      throw new Error('Native acceptance desktop discovery returned an invalid window record.');
    }
  }
  if (typeof options.expectedWindowTitle === 'string'
      && !discovery.windows.some((window) => window.title === options.expectedWindowTitle)) {
    throw new Error('Native acceptance desktop discovery did not find its controlled fixture window.');
  }
  return {
    goalId: goal.id,
    automationId: automation.id,
    workerId: automation.workerId,
    discoveredWindows: discovery.windows.length,
  };
};

const waitForProcessExit = async (pid, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return;
    await delay(pollIntervalMs);
  }
  throw new Error(`The attested Node process ${pid} survived native host shutdown.`);
};

const waitForExit = async (child, timeoutMs) => {
  if (isProcessComplete(child)) return { code: child.exitCode, signal: child.signalCode };
  return await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      child.off('exit', exited);
      reject(new Error(`Native host did not exit within ${timeoutMs}ms.`));
    }, timeoutMs);
    const exited = (code, signal) => {
      clearTimeout(deadline);
      resolve({ code, signal });
    };
    child.once('exit', exited);
  });
};

const waitForAttestation = async (attestationPath, context, child, deadlineAt, logs) => {
  while (Date.now() < deadlineAt) {
    if (isProcessComplete(child)) {
      throw new Error(
        `Native host exited before authenticated readiness with code ${child.exitCode} `
        + `(signal ${child.signalCode}). stdout=${tail(logs.stdout)} stderr=${tail(logs.stderr)}`,
      );
    }
    try {
      const raw = await readBoundedRegularFile(attestationPath);
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error('Native acceptance attestation is not valid JSON.');
      }
      return validateAcceptanceRecord(parsed, { ...context, nowMs: Date.now() });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await delay(pollIntervalMs);
  }
  throw new Error(
    `Native host did not publish authenticated full readiness within ${context.timeoutMs}ms. `
    + `stdout=${tail(logs.stdout)} stderr=${tail(logs.stderr)}`,
  );
};

const closeMainWindow = async (pid) => {
  const command = [
    `$target = Get-Process -Id ${pid} -ErrorAction Stop`,
    "if (-not $target.CloseMainWindow()) { throw 'CloseMainWindow returned false.' }",
  ].join('; ');
  await execFileAsync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    command,
  ], {
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
};

const waitForCleanup = async (paths, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const states = await Promise.all(paths.map(fileExists));
    if (states.every((present) => !present)) return;
    await delay(pollIntervalMs);
  }
  const remaining = [];
  for (const target of paths) {
    if (await fileExists(target)) remaining.push(path.basename(target));
  }
  throw new Error(`Graceful shutdown left authenticated runtime files behind: ${remaining.join(', ')}`);
};

const inheritedEnvironment = () => Object.fromEntries(
  [
    'SystemRoot',
    'WINDIR',
    'ComSpec',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'HOME',
    'LOCALAPPDATA',
    'APPDATA',
    'PROGRAMDATA',
    'PATH',
  ].flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]]),
);

export const runNativeHostAcceptance = async (options) => {
  if (process.platform !== 'win32') {
    throw new Error('Native host acceptance requires Windows UI Automation and CloseMainWindow.');
  }
  const definition = assertProfileMayRun(options.profile, process.env);
  if (definition.identity !== options.identity
      || definition.packagedRelease !== options.packagedRelease) {
    throw new Error('Native acceptance profile settings do not match the fixed identity contract.');
  }

  const tauriConfig = JSON.parse(await readFile(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const expectedBuildVersion = expectedProfileBuildVersion(tauriConfig.version, options.profile);
  const binary = await realpath(options.binary);
  const binaryMetadata = await stat(binary);
  if (!binaryMetadata.isFile() || path.extname(binary).toLowerCase() !== '.exe') {
    throw new Error(`Native acceptance requires a regular Windows executable: ${binary}`);
  }

  const localAppData = await realpath(
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  );
  const appData = await realpath(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  );
  if (samePath(localAppData, appData)) {
    throw new Error('Native local-data and configuration roots must be distinct.');
  }

  const runId = crypto.randomUUID();
  const nonce = crypto.randomBytes(32).toString('base64url');
  const scratchRoot = await mkdtemp(path.join(os.tmpdir(), 'provenance-native-acceptance-'));
  assertTemporaryScratchPath(scratchRoot);
  const reservations = [];
  let child;
  let forcedTermination = false;
  let result;
  let primaryError;
  const logs = { stdout: '', stderr: '' };
  let adminCredentials;
  let desktopFixture;

  try {
    const configReservation = await reserveProfile(appData, options.identity, runId);
    reservations.push(configReservation);
    const localReservation = await reserveProfile(localAppData, options.identity, runId);
    reservations.push(localReservation);

    const projectRoot = path.join(scratchRoot, 'project');
    const workspaceRoot = path.join(scratchRoot, 'workspace');
    const runtimeDirectory = path.join(localReservation.profile, 'runtime');
    const acceptanceUsers = createAcceptanceUsers();
    adminCredentials = acceptanceUsers.adminCredentials;
    await Promise.all([
      mkdir(projectRoot, { recursive: true }),
      mkdir(workspaceRoot, { recursive: true }),
      mkdir(runtimeDirectory, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
        name: 'provenance-native-acceptance-project',
        private: true,
        version: '0.0.0',
      }), 'utf8'),
      writeFile(path.join(workspaceRoot, 'package.json'), JSON.stringify({
        name: 'provenance-native-acceptance-workspace',
        private: true,
        version: '0.0.0',
      }), 'utf8'),
      writeFile(path.join(runtimeDirectory, 'users.json'), JSON.stringify(
        acceptanceUsers.records,
        null,
        2,
      ), { encoding: 'utf8', mode: 0o600, flag: 'wx' }),
    ]);

    desktopFixture = await startWindowsDesktopFixture(
      scratchRoot,
      Math.min(360_000, options.timeoutMs + 60_000),
    );
    const allowlist = [{
      appId: desktopFixture.appId,
      executablePath: desktopFixture.executablePath,
    }];
    if (options.packagedRelease) {
      await Promise.all([
        writeFile(
          path.join(configReservation.profile, 'desktop-allowlist.json'),
          JSON.stringify(allowlist, null, 2),
          { encoding: 'utf8', mode: 0o600, flag: 'wx' },
        ),
        writeFile(
          path.join(configReservation.profile, 'project-workspace.json'),
          JSON.stringify({ schemaVersion: 1, workspaceRoot }, null, 2),
          { encoding: 'utf8', mode: 0o600, flag: 'wx' },
        ),
      ]);
    } else {
      const builtDist = path.join(root, 'dist');
      if (!(await fileExists(path.join(builtDist, 'server.cjs')))) {
        throw new Error('Development acceptance requires a completed npm run build.');
      }
      await cp(builtDist, path.join(projectRoot, 'dist'), {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
    }

    const attestationPath = acceptanceAttestationPath(runtimeDirectory, nonce);
    const ownerRecordPath = path.join(runtimeDirectory, 'runtime-owner.json');
    const environment = {
      ...inheritedEnvironment(),
      PROVENANCE_NATIVE_ACCEPTANCE_NONCE: nonce,
      PROVENANCE_NATIVE_ACCEPTANCE_IDENTIFIER: options.identity,
      RUST_BACKTRACE: '1',
    };
    if (!options.packagedRelease) {
      Object.assign(environment, {
        PROVENANCE_PROJECT_ROOT: projectRoot,
        PROVENANCE_WORKSPACE_ROOT: workspaceRoot,
        PROVENANCE_NODE_EXECUTABLE: process.execPath,
        DESKTOP_APP_ALLOWLIST: JSON.stringify(allowlist),
        // A pinned but deliberately absent image makes command execution fail
        // closed without making this desktop/authentication gate depend on Docker.
        PROVENANCE_SANDBOX_IMAGE: `invalid.local/provenance-acceptance@sha256:${'0'.repeat(64)}`,
      });
    }

    const startedAtMs = Date.now();
    child = spawn(binary, [], {
      cwd: scratchRoot,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout.on('data', (chunk) => {
      logs.stdout = appendBounded(logs.stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      logs.stderr = appendBounded(logs.stderr, chunk);
    });
    await new Promise((resolve, reject) => {
      const spawned = () => {
        child.off('error', failed);
        resolve();
      };
      const failed = (error) => {
        child.off('spawn', spawned);
        reject(new Error(`The native host could not be spawned: ${error.message}`));
      };
      child.once('spawn', spawned);
      child.once('error', failed);
    });

    const record = await waitForAttestation(
      attestationPath,
      {
        nonce,
        expectedHostPid: child.pid,
        expectedBuildVersion,
        expectedPackagedRelease: options.packagedRelease,
        expectedResourceManifestSha256: options.expectedResourceManifestSha256,
        expectedIdentifier: options.identity,
        startedAtMs,
        timeoutMs: options.timeoutMs,
      },
      child,
      startedAtMs + options.timeoutMs,
      logs,
    );
    if (/panicked at/iu.test(logs.stderr)) {
      throw new Error(`The native host panicked before readiness. stderr=${tail(logs.stderr)}`);
    }
    if (isProcessComplete(child)) {
      throw new Error('The native host exited after attestation but before graceful shutdown.');
    }

    await assertDirectChildProcess(child.pid, record.nodePid);
    const authenticationEvidence = await proveAuthenticatedKernelRead(record, adminCredentials);
    const desktopDiscoveryEvidence = await proveAuthenticatedDesktopDiscover(
      record,
      authenticationEvidence.authorization,
      workspaceRoot,
      fetch,
      {
        appId: desktopFixture.appId,
        expectedWindowTitle: desktopFixture.title,
      },
    );
    await stopWindowsDesktopFixture(desktopFixture);
    await delay(livenessSoakMs);
    if (isProcessComplete(child)) {
      throw new Error('The native host exited during the authenticated liveness soak.');
    }
    await assertDirectChildProcess(child.pid, record.nodePid);

    await closeMainWindow(child.pid);
    const exit = await waitForExit(child, gracefulShutdownTimeoutMs);
    if (exit.code !== 0 || exit.signal !== null) {
      throw new Error(
        `The native host did not exit cleanly after CloseMainWindow (code ${exit.code}, signal ${exit.signal}).`,
      );
    }
    if (/panicked at/iu.test(logs.stderr)) {
      throw new Error(`The native host panicked during shutdown. stderr=${tail(logs.stderr)}`);
    }
    await waitForProcessExit(record.nodePid, cleanupTimeoutMs);
    await waitForCleanup([attestationPath, ownerRecordPath], cleanupTimeoutMs);

    result = {
      schemaVersion: 3,
      binary,
      profile: options.profile,
      identity: options.identity,
      buildVersion: record.buildVersion,
      packagedRelease: record.packagedRelease,
      resourceManifestSha256: record.resourceManifestSha256,
      desktopAuthority: record.desktopAuthority,
      authenticatedReadiness: 'passed',
      unauthenticatedKernelReadDenied: 'passed',
      unauthenticatedKernelReadStatus: authenticationEvidence.unauthenticatedKernelReadStatus,
      sessionAuthenticated: 'passed',
      protectedKernelRead: 'passed',
      desktopDiscovery: 'passed',
      desktopDiscoveryWorker: desktopDiscoveryEvidence.workerId,
      desktopDiscoveryWindows: desktopDiscoveryEvidence.discoveredWindows,
      directChildSupervision: 'passed',
      schedulerDisabled: true,
      updaterSuppressed: true,
      shutdown: 'graceful',
      nodeProcessCleanup: 'passed',
      runtimeCleanup: 'passed',
    };
  } catch (error) {
    primaryError = error instanceof Error ? error : new Error(String(error));
  } finally {
    const cleanupErrors = [];
    if (desktopFixture && !isProcessComplete(desktopFixture.child)) {
      try {
        await stopWindowsDesktopFixture(desktopFixture);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (child && !isProcessComplete(child)) {
      forcedTermination = true;
      try {
        child.kill('SIGKILL');
        await waitForExit(child, 5_000);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (!child || isProcessComplete(child)) {
      for (const reservation of reservations.reverse()) {
        try {
          await removeOwnedProfile(reservation);
        } catch (error) {
          cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
        }
      }
      try {
        await rm(assertTemporaryScratchPath(scratchRoot), {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 250,
        });
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
      }
    } else {
      cleanupErrors.push(new Error('The native host survived forced termination; state was left intact.'));
    }
    if (forcedTermination && !primaryError) {
      primaryError = new Error('Native acceptance required forced termination and therefore failed.');
    }
    if (cleanupErrors.length > 0) {
      const detail = cleanupErrors.map((error) => error.message).join('; ');
      primaryError = new Error(
        `${primaryError ? `${primaryError.message} ` : ''}Acceptance cleanup failed: ${detail}`,
      );
    }
  }

  if (primaryError) throw primaryError;
  return result;
};

const isDirectExecution = process.argv[1]
  && samePath(fileURLToPath(import.meta.url), process.argv[1]);
if (isDirectExecution) {
  try {
    const options = parseSmokeArguments(process.argv.slice(2));
    const result = await runNativeHostAcceptance(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.exitCode = 1;
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
}

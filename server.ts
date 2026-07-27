/**
 * @license
 * SPDX-License-Identifier: BUSL-1.1
 */

import crypto from 'node:crypto';
import { open, readFile, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import express from 'express';
import { createApplicationAiRouter } from './src/app-ai/router';
import {
  accessControlStatus,
  createAccessGuard,
  getRequestAccessPrincipal,
  resolveAccessMode,
} from './src/auth/accessControl';
import { createAuthApi } from './src/auth/api';
import { createFirstAdminBootstrapAuthority } from './src/auth/bootstrapAuthority';
import { createLoopbackRequestGuard, createSecurityHeaders } from './src/auth/loopbackGuard';
import { resolveSessionSecret } from './src/auth/session';
import { createUserStore } from './src/auth/users';
import { createFileCapabilityGrantStore } from './src/capabilities/grantStore';
import { createCoreModelRuntime } from './src/core-model/runtime';
import { resolveDesktopBridgeConfiguration } from './src/desktop/config';
import { createDesktopBridgeClient } from './src/desktop/ipc';
import { createMemoryDesktopPayloadStore, type DesktopPayloadStore } from './src/desktop/payloadStore';
import { resolveDiagnosticBuildMetadata } from './src/diagnostics';
import { createKernelRouter } from './src/kernel/api';
import { createFileArtifactStore } from './src/kernel/artifacts/artifactStore';
import {
  BROWSER_WRITE_WORKER_ID,
  buildBrowserWriteWorkerRegistration,
  buildDesktopWorkerRegistration,
  buildWorkerRegistrations,
  DESKTOP_V1_ACTIONS,
  DESKTOP_WORKER_ID,
  type RuntimeFeatureStatus,
  WEB_INSPECT_WORKER_ID,
} from './src/kernel/autonomy';
import { createKernelService, type KernelActionWorker } from './src/kernel/kernel';
import { readKernelEvents } from './src/kernel/ledger';
import { createReleaseLifecycle } from './src/kernel/releases/lifecycle';
import { createNodeReleaseSupervisor } from './src/kernel/releases/supervisor';
import { createRecurringResearchScheduler } from './src/kernel/scheduler/service';
import {
  DEFAULT_DOCKER_SANDBOX_CONFIG,
  resolveCommandSandbox,
  sandboxStatus,
} from './src/kernel/sandbox/sandbox';
import { createBrowserWorker, createPlaywrightDriver } from './src/kernel/workers/browserWorker';
import { createDesktopWorker } from './src/kernel/workers/desktopWorker';
import { createWebInspectWorker } from './src/kernel/workers/webInspectWorker';
import { createProviderApi } from './src/providers/api';
import { createProviderRuntime } from './src/providers/runtime';
import { PROVIDER_IDS, type ProviderId, type ProviderRoutingPolicy } from './src/providers/types';
import { createDesktopReadyPublisher } from './src/runtime/desktopReadiness';
import { createDesktopShutdownControl } from './src/runtime/desktopShutdown';
import { loadAuthenticatedStaticResources } from './src/runtime/authenticatedStatic';
import { acquireRuntimeOwnership } from './src/runtime/ownership';
import { createVaultApi } from './src/vault/api';
import { createPlatformVault, injectVaultSecretsIntoEnvironment } from './src/vault/index';

const PROJECT_ROOT = path.resolve(process.env.PROVENANCE_PROJECT_ROOT?.trim() || process.cwd());
const CONFIGURED_WORKSPACE_ROOT = path.resolve(
  process.env.PROVENANCE_WORKSPACE_ROOT?.trim() || PROJECT_ROOT,
);
const NATIVE_ACCEPTANCE_MODE = process.env.PROVENANCE_NATIVE_ACCEPTANCE === '1';
const NATIVE_ACCEPTANCE_MOUNT_ORIGIN =
  process.env.PROVENANCE_NATIVE_ACCEPTANCE_MOUNT_ORIGIN || undefined;
delete process.env.PROVENANCE_NATIVE_ACCEPTANCE_MOUNT_ORIGIN;
if (NATIVE_ACCEPTANCE_MODE !== Boolean(NATIVE_ACCEPTANCE_MOUNT_ORIGIN)) {
  throw new Error('Native acceptance and its pre-bound mount origin must be configured together.');
}
const PACKAGED_RELEASE_MARKER = process.env.DESKTOP_PACKAGED_RELEASE;
if (PACKAGED_RELEASE_MARKER && PACKAGED_RELEASE_MARKER !== '1') {
  throw new Error('DESKTOP_PACKAGED_RELEASE must be exactly 1 when configured.');
}
const IS_PACKAGED_RELEASE = PACKAGED_RELEASE_MARKER === '1';
const AUTHENTICATED_RESOURCE_MANIFEST_PATH =
  process.env.PROVENANCE_AUTHENTICATED_RESOURCE_MANIFEST_PATH;
const AUTHENTICATED_RESOURCE_MANIFEST_SHA256 =
  process.env.PROVENANCE_AUTHENTICATED_RESOURCE_MANIFEST_SHA256;
delete process.env.PROVENANCE_AUTHENTICATED_RESOURCE_MANIFEST_PATH;
delete process.env.PROVENANCE_AUTHENTICATED_RESOURCE_MANIFEST_SHA256;
if (IS_PACKAGED_RELEASE !== Boolean(
  AUTHENTICATED_RESOURCE_MANIFEST_PATH && AUTHENTICATED_RESOURCE_MANIFEST_SHA256,
)) {
  throw new Error('Packaged mode and its Rust-authenticated resource manifest must be configured together.');
}
if (!NATIVE_ACCEPTANCE_MODE && !IS_PACKAGED_RELEASE) {
  dotenv.config({ path: path.join(PROJECT_ROOT, '.env') });
}

const app = express();
const configuredPort = Number.parseInt(process.env.PORT || '3000', 10);
const PORT = Number.isSafeInteger(configuredPort) && configuredPort >= 0 && configuredPort <= 65_535
  ? configuredPort
  : 3000;
const RUNTIME_DIR = path.resolve(process.env.PROVENANCE_RUNTIME_DIR?.trim() || path.join(PROJECT_ROOT, '.agent-kernel'));
const IS_DEVELOPMENT = process.env.NODE_ENV === 'development' || /\.[cm]?tsx?$/iu.test(process.argv[1] || '');
const IS_RELEASE_CHILD = process.env.RELEASE_CHILD_MODE === '1';

const publishReleaseReadiness = async (
  nonce: string,
  targetVersion: string,
  contentHash: string,
): Promise<void> => {
  const record = {
    schemaVersion: 1,
    type: 'release.ready',
    nonce,
    targetVersion,
    contentHash,
    pid: process.pid,
  } as const;
  const readyPath = process.env.RELEASE_SUPERVISOR_READY_FILE;
  if (!readyPath) {
    if (!process.send) throw new Error('Release child has no authenticated readiness channel.');
    process.send(record);
    return;
  }
  if (!path.isAbsolute(readyPath) || path.basename(readyPath) !== `.release-ready-${nonce}.json`) {
    throw new Error('Release readiness path is not bound to the supervisor nonce.');
  }
  const temporaryPath = `${readyPath}.${nonce}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(record), 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, readyPath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
};
const recurringResearchSchedulerSetting = process.env.RECURRING_RESEARCH_SCHEDULER_ENABLED?.trim().toLowerCase();
const RECURRING_RESEARCH_SCHEDULER_ENABLED = !IS_RELEASE_CHILD && !NATIVE_ACCEPTANCE_MODE &&
  !['0', 'false', 'no', 'off'].includes(recurringResearchSchedulerSetting ?? '');
const configuredRecurringResearchTickMs = Number.parseInt(
  process.env.RECURRING_RESEARCH_TICK_MS || '15000',
  10,
);
const RECURRING_RESEARCH_TICK_MS = Number.isSafeInteger(configuredRecurringResearchTickMs)
  ? Math.min(60_000, Math.max(1_000, configuredRecurringResearchTickMs))
  : 15_000;
const VAULT_INJECTED_SECRETS = [
  'GEMINI_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'DEEPSEEK_API_KEY',
  'ZAI_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'RELEASE_SIGNING_PUBLIC_KEY',
  'KERNEL_API_TOKEN',
  'SESSION_SECRET',
] as const;

let coreModelPromise: ReturnType<typeof createCoreModelRuntime>;
const vault = createPlatformVault({ vaultDir: path.join(RUNTIME_DIR, 'vault') });

app.use(createSecurityHeaders({
  allowViteDevelopment: IS_DEVELOPMENT,
  nativeAcceptanceMountOrigin: NATIVE_ACCEPTANCE_MOUNT_ORIGIN,
}));
app.use(createLoopbackRequestGuard());
app.use(express.json({ limit: '32mb' }));

const createServerContext = async () => {
  const workspaceRoot = await realpath(CONFIGURED_WORKSPACE_ROOT);
  await injectVaultSecretsIntoEnvironment(vault, VAULT_INJECTED_SECRETS);
  let configuredFirstAdminBootstrapSecret = process.env.PROVENANCE_FIRST_ADMIN_BOOTSTRAP_SECRET;
  delete process.env.PROVENANCE_FIRST_ADMIN_BOOTSTRAP_SECRET;
  const firstAdminBootstrapAuthority = createFirstAdminBootstrapAuthority(
    configuredFirstAdminBootstrapSecret,
    { required: Boolean(process.env.DESKTOP_RUNTIME_OWNER_NONCE?.trim()) },
  );
  configuredFirstAdminBootstrapSecret = undefined;
  const diagnosticBuildMetadata = resolveDiagnosticBuildMetadata({
    packageVersion: process.env.npm_package_version,
    buildVersion: process.env.PROVENANCE_BUILD_VERSION,
    buildCommit: process.env.PROVENANCE_BUILD_COMMIT,
    builtAt: process.env.PROVENANCE_BUILD_TIMESTAMP,
    mode: IS_DEVELOPMENT ? 'development' : 'production',
  });

  const providerRuntime = createProviderRuntime();
  coreModelPromise = createCoreModelRuntime();
  const operatorToken = process.env.KERNEL_API_TOKEN;
  const userStore = await createUserStore(path.join(RUNTIME_DIR, 'users.json'));
  if (userStore.count() > 0) firstAdminBootstrapAuthority?.completeAfterPersistence();
  const sessionSecret = resolveSessionSecret(process.env.SESSION_SECRET);
  const accessGuard = createAccessGuard({
    userStore,
    operatorToken,
    sessionSecret,
    firstAdminBootstrapPending: () => Boolean(firstAdminBootstrapAuthority?.isPending()),
  });

  const sandboxSelection = await resolveCommandSandbox({
    env: process.env,
    workspaceRoot,
    config: {
      ...DEFAULT_DOCKER_SANDBOX_CONFIG,
      dockerPath: process.env.DOCKER_PATH?.trim() || DEFAULT_DOCKER_SANDBOX_CONFIG.dockerPath,
    },
  });
  const sandbox = sandboxSelection.runner;
  const commandStatus = sandboxStatus(sandbox).commandExecution;
  console.log(
    `[Sandbox] Runtime=${sandboxSelection.runtimeMode}; mode=${sandbox.mode}; ` +
    `commandExecution=${commandStatus.status} (${commandStatus.reason})`,
  );

  const artifactStore = createFileArtifactStore(path.join(RUNTIME_DIR, 'artifacts'), {
    // Signed release packages are base64 encoded. Browser typing applies a
    // separate, much smaller limit at the worker boundary.
    maxArtifactChars: 24 * 1024 * 1024,
  });
  const browserDriver = createPlaywrightDriver({
    userDataDir: path.join(RUNTIME_DIR, 'browser-profile'),
  });
  const browserWorkerAvailable = Boolean(process.env.BROWSER_WRITE_ORIGINS?.trim()) &&
    await browserDriver.isAvailable();
  const browserWriteRegistration = browserWorkerAvailable
    ? buildBrowserWriteWorkerRegistration(process.env.BROWSER_WRITE_ORIGINS)
    : undefined;
  const desktopConfiguration = resolveDesktopBridgeConfiguration(process.env);
  const accessMode = resolveAccessMode(userStore.count(), operatorToken);
  const desktopAuthorityConfigured = accessMode !== 'open';
  let desktopIpcStatus: RuntimeFeatureStatus = {
    status: desktopConfiguration.status,
    reason: desktopConfiguration.reason,
  };
  let desktopRegistration = desktopConfiguration.configuration
    ? buildDesktopWorkerRegistration(
      desktopConfiguration.configuration.applications.map((application) => application.id),
      { available: false, reason: 'The configured native desktop bridge has not passed its authenticated health check.' },
    )
    : undefined;
  let desktopWorker: KernelActionWorker | undefined;
  let desktopBridgeAuthenticated = false;
  const desktopPayloadBacking = desktopConfiguration.configuration
    ? createMemoryDesktopPayloadStore()
    : undefined;
  let desktopPayloadEnabled = false;
  const desktopPayloadStore: DesktopPayloadStore | undefined = desktopPayloadBacking
    ? {
      stage: async (content) => {
        if (!desktopPayloadEnabled) {
          throw new Error('Desktop typed-payload staging is unavailable until desktop authority is active.');
        }
        return desktopPayloadBacking.stage(content);
      },
      consume: (id) => desktopPayloadEnabled
        ? desktopPayloadBacking.consume(id)
        : Promise.resolve(undefined),
      clear: () => desktopPayloadBacking.clear(),
      size: () => desktopPayloadEnabled ? desktopPayloadBacking.size() : 0,
    }
    : undefined;
  const authenticateDesktopRuntime = async (): Promise<{
    registration: NonNullable<typeof desktopRegistration>;
    worker: KernelActionWorker;
    status: RuntimeFeatureStatus;
  }> => {
    const configuration = desktopConfiguration.configuration;
    if (!configuration || !desktopPayloadStore) {
      throw new Error('Native desktop bridge configuration is unavailable.');
    }
    const bridge = createDesktopBridgeClient({
      baseUrl: configuration.baseUrl,
      token: configuration.token,
    });
    const health = await bridge.health();
    const expectedHostInstanceId = process.env.DESKTOP_HOST_INSTANCE_ID?.trim();
    if (!expectedHostInstanceId || health.hostInstanceId !== expectedHostInstanceId) {
      throw new Error('Native host identity does not match the authenticated bridge health response.');
    }
    const expectedApps = configuration.applications.map((application) => application.id).sort();
    const healthyApps = [...new Set(health.allowedAppIds)].sort();
    const capabilitiesMatch = DESKTOP_V1_ACTIONS.every((action) => health.capabilities.includes(action));
    const allowlistMatches = expectedApps.length === healthyApps.length &&
      expectedApps.every((appId, index) => appId === healthyApps[index]);
    if (!capabilitiesMatch || !allowlistMatches) {
      throw new Error('Native host capabilities or application allowlist do not match the server configuration.');
    }
    return {
      registration: buildDesktopWorkerRegistration(expectedApps, { available: true }),
      worker: createDesktopWorker(bridge, (id) => desktopPayloadStore.consume(id)),
      status: {
        status: 'available',
        reason: `An authenticated Windows desktop host is available for ${expectedApps.length} allowlisted application(s).`,
      },
    };
  };
  if (desktopConfiguration.configuration) {
    try {
      const runtime = await authenticateDesktopRuntime();
      desktopBridgeAuthenticated = true;
      if (!desktopAuthorityConfigured) {
        desktopIpcStatus = {
          status: 'blocked',
          reason: 'Native desktop execution is blocked until an operator token or multi-user access control is configured.',
        };
      } else {
        desktopPayloadEnabled = true;
        desktopRegistration = runtime.registration;
        desktopWorker = runtime.worker;
        desktopIpcStatus = runtime.status;
      }
    } catch {
      desktopIpcStatus = {
        status: 'configured',
        reason: 'Native desktop bridge settings are present, but its authenticated health check failed.',
      };
    }
  }
  const baseRegistrations = buildWorkerRegistrations(process.env);
  const workerRegistrations = [
    ...baseRegistrations.filter((registration) => !(
      (browserWriteRegistration && registration.family === 'browser' && registration.availability === 'unavailable') ||
      (desktopRegistration && registration.family === 'desktop')
    )),
    ...(browserWriteRegistration ? [browserWriteRegistration] : []),
    ...(desktopRegistration ? [desktopRegistration] : []),
  ];
  const actionWorkers: Record<string, KernelActionWorker> = {
    [WEB_INSPECT_WORKER_ID]: createWebInspectWorker(),
    ...(browserWriteRegistration
      ? { [BROWSER_WRITE_WORKER_ID]: createBrowserWorker(browserDriver, (id) => artifactStore.resolve(id)) }
      : {}),
    ...(desktopWorker ? { [DESKTOP_WORKER_ID]: desktopWorker } : {}),
  };
  if (browserWorkerAvailable) console.log('[Browser] Write-capable Playwright worker registered.');
  if (desktopWorker) console.log('[Desktop] Authenticated Windows UI Automation worker registered.');

  const capabilityGrantStore = await createFileCapabilityGrantStore(
    path.join(RUNTIME_DIR, 'capability-grants.json'),
  );
  const releaseSupervisor = createNodeReleaseSupervisor();
  const releaseLifecycle = createReleaseLifecycle({
    releasesDir: path.join(RUNTIME_DIR, 'releases'),
    publicKey: process.env.RELEASE_SIGNING_PUBLIC_KEY?.trim() || '',
    resolveArtifact: (artifactId) => artifactStore.resolve(artifactId),
    verifyEvaluationReference: async (eventId) => {
      const event = (await readKernelEvents(RUNTIME_DIR)).find((candidate) => candidate.id === eventId);
      return Boolean(event && ['task.passed', 'skill.evaluated', 'benchmark.recorded'].includes(event.type));
    },
    healthCheck: async ({ proposal, manifest, releaseDir }) => {
      try {
        const parsed = JSON.parse(await readFile(path.join(releaseDir, 'release-manifest.json'), 'utf8')) as {
          targetVersion?: unknown;
          contentHash?: unknown;
          entrypoint?: unknown;
          files?: Array<{ path?: unknown; contentHash?: unknown }>;
        };
        if (
          parsed.targetVersion !== proposal.targetVersion ||
          parsed.contentHash !== manifest.contentHash ||
          parsed.entrypoint !== manifest.entrypoint ||
          !Array.isArray(parsed.files) ||
          parsed.files.length === 0
        ) {
          return { ok: false, reason: 'Installed release manifest does not match the signed proposal.' };
        }
        for (const file of parsed.files) {
          if (typeof file.path !== 'string' || typeof file.contentHash !== 'string') {
            return { ok: false, reason: 'Installed release manifest contains an invalid file entry.' };
          }
          const installedPath = path.resolve(releaseDir, ...file.path.split('/'));
          const relative = path.relative(releaseDir, installedPath);
          if (relative.startsWith('..') || path.isAbsolute(relative)) {
            return { ok: false, reason: 'Installed release health check detected a path escape.' };
          }
          const installedHash = crypto.createHash('sha256').update(await readFile(installedPath)).digest('hex');
          if (installedHash !== file.contentHash) {
            return { ok: false, reason: `Installed release file failed its health hash: ${file.path}.` };
          }
        }
        return { ok: true, reason: 'Installed release manifest and file hashes are healthy.' };
      } catch (error) {
        return {
          ok: false,
          reason: error instanceof Error ? error.message : 'Installed release health check failed.',
        };
      }
    },
    supervisor: releaseSupervisor,
  });

  const observationAssessor = process.env.CORE_MODEL_INJECTION_ASSESSMENT?.trim()
    ? async (content: string) => (await coreModelPromise).assessObservation(content)
    : undefined;
  const providerName = process.env.AI_PROVIDER?.trim() || 'openrouter';
  if (!PROVIDER_IDS.includes(providerName as ProviderId)) {
    throw new Error(`AI_PROVIDER must be one of: ${PROVIDER_IDS.join(', ')}.`);
  }
  const modelName = process.env.AI_MODEL?.trim();
  const applicationRoutingPolicy: ProviderRoutingPolicy = {
    mode: 'pinned',
    provider: providerName as ProviderId,
    ...(modelName ? { model: modelName } : {}),
  };
  const selectedProviderStatus = providerRuntime.statuses.find((status) => status.id === providerName);
  const selectedModel = modelName || selectedProviderStatus?.defaultModel;
  const researchProviderConfigured = Boolean(
    selectedProviderStatus?.configured &&
    selectedModel &&
    selectedProviderStatus.allowedModels.includes(selectedModel) &&
    selectedProviderStatus.capabilities.includes('text') &&
    selectedProviderStatus.capabilities.includes('json_schema'),
  );
  const kernelConfig = {
    runtimeDir: RUNTIME_DIR,
    allowedWorkspaceRoot: workspaceRoot,
    providerRouter: providerRuntime.router,
    releaseSigningPublicKey: process.env.RELEASE_SIGNING_PUBLIC_KEY,
    workerRegistrations,
    actionWorkers,
    observationAssessor,
    sandbox,
    artifactStore,
    capabilityGrantStore,
    releaseLifecycle,
    researchRoutingPolicy: applicationRoutingPolicy,
    researchProviderConfigured,
    researchWorkerId: WEB_INSPECT_WORKER_ID,
    recurringResearchSchedulerEnabled: RECURRING_RESEARCH_SCHEDULER_ENABLED,
    recurringResearchTickMs: RECURRING_RESEARCH_TICK_MS,
  };
  const kernel = createKernelService(kernelConfig);
  let desktopActivationPromise: Promise<void> | undefined;
  const activateDesktopAuthority = async (): Promise<void> => {
    if (!desktopConfiguration.configuration || desktopIpcStatus.status === 'available') return;
    if (resolveAccessMode(userStore.count(), operatorToken) === 'open') {
      throw new Error('Desktop authority cannot activate while access control is open.');
    }
    if (desktopActivationPromise) return desktopActivationPromise;

    const pending = (async () => {
      const runtime = await authenticateDesktopRuntime();
      desktopBridgeAuthenticated = true;
      // Values staged before the authority transition cannot cross into the
      // newly executable runtime, even if their opaque ids were retained.
      desktopPayloadBacking!.clear();
      desktopPayloadEnabled = true;
      try {
        kernel.activateWorkerRuntime(runtime.registration, runtime.worker);
      } catch (error) {
        desktopPayloadEnabled = false;
        throw error;
      }
      desktopRegistration = runtime.registration;
      desktopIpcStatus = runtime.status;
      console.log('[Desktop] Authenticated Windows UI Automation worker activated after first-admin bootstrap.');
    })();
    desktopActivationPromise = pending;
    try {
      await pending;
    } catch (error) {
      desktopPayloadEnabled = false;
      desktopPayloadBacking?.clear();
      desktopIpcStatus = {
        status: 'configured',
        reason: 'Native desktop bridge settings are present, but its authenticated health check failed.',
      };
      throw error;
    } finally {
      if (desktopActivationPromise === pending) desktopActivationPromise = undefined;
    }
  };
  await kernel.recoverInterruptedTasks();
  const recurringResearchScheduler = IS_RELEASE_CHILD
    ? undefined
    : createRecurringResearchScheduler(kernel, {
      enabled: RECURRING_RESEARCH_SCHEDULER_ENABLED,
      tickIntervalMs: RECURRING_RESEARCH_TICK_MS,
      onError: (error) => {
        console.warn(
          '[Scheduler] Recurring research tick failed:',
          error instanceof Error ? error.message : error,
        );
      },
    });

  const appGoalObjective = 'Application AI provider execution budget';
  const state = await kernel.getState();
  if (process.env.RELEASE_CHILD_MODE !== '1') {
    try {
      const activeManifest = await releaseLifecycle.getActiveManifest();
      if (activeManifest) {
        const activeProposal = state.releaseProposals.find((proposal) => (
          proposal.id === activeManifest.releaseId &&
          proposal.activationState === 'activated' &&
          proposal.targetVersion === activeManifest.targetVersion &&
          proposal.contentHash === activeManifest.contentHash
        ));
        if (!activeProposal) {
          await releaseLifecycle.shutdown();
          console.warn('[Release] Persisted active release restore blocked (proposal_missing).');
        } else {
          const restored = await releaseLifecycle.restoreActive(activeProposal);
          if (restored.status === 'activated') {
            console.log('[Release] Persisted active supervised core restored.');
          } else {
            console.warn(`[Release] Persisted active release restore blocked (${restored.reasonCode}).`);
          }
        }
      }
    } catch {
      await releaseLifecycle.shutdown().catch(() => undefined);
      console.warn('[Release] Persisted active release restore blocked (restore_error).');
    }
  }
  let appGoal = state.goals.find((goal) => (
    goal.objective === appGoalObjective &&
    goal.status === 'active' &&
    path.resolve(goal.workspaceRoot) === workspaceRoot &&
    goal.usage.providerCalls < goal.budget.maxProviderCalls &&
    goal.usage.operations < goal.budget.maxOperations
  ));
  if (!appGoal) {
    const configuredBudget = Number.parseInt(process.env.APP_AI_MAX_PROVIDER_CALLS || '1000', 10);
    const maxProviderCalls = Number.isSafeInteger(configuredBudget) && configuredBudget > 0
      ? Math.min(configuredBudget, 100_000)
      : 1000;
    appGoal = await kernel.createGoal({
      objective: appGoalObjective,
      successCriteria: ['Every application AI call is provider-routed and ledgered with provenance.'],
      constraints: ['Pinned provider/model policy', 'No application route may bypass the kernel call budget'],
      autonomyLevel: 'bounded',
      workspaceRoot,
      verificationCommands: ['npm run lint'],
      budget: {
        maxOperations: maxProviderCalls,
        maxCommandRuntimeMs: 1,
        maxApprovals: 0,
        maxProviderCalls,
      },
    });
  }
  const applicationGoalId = appGoal.id;

  // Authentication endpoints self-check bootstrap/login/logout authority and
  // must remain reachable before the shared mutation guard.
  app.use('/api/auth', createAuthApi({
    userStore,
    sessionSecret,
    operatorToken,
    firstAdminBootstrapAuthority,
    onFirstAdminCreated: activateDesktopAuthority,
    onSuccessfulLogin: activateDesktopAuthority,
  }));
  app.use('/api', accessGuard);
  app.use('/api/providers', createProviderApi(providerRuntime));
  app.use('/api/vault', createVaultApi(vault));
  app.use('/api/kernel', createKernelRouter({
    ...kernelConfig,
    kernelService: kernel,
    providerStatuses: providerRuntime.statuses,
    coreModelStatus: async () => (await coreModelPromise).getStatus(),
    secretVaultStatus: async () => {
      const status = await vault.getStatus();
      return { status: status.status, reason: status.reason };
    },
    accessControlStatus: () => accessControlStatus(userStore.count(), operatorToken),
    skillAuthorPrincipal: (request) => getRequestAccessPrincipal(request)?.principalId,
    recurringResearchSchedulerStatus: () => recurringResearchScheduler?.status() ?? {
      enabled: false,
      starting: false,
      running: false,
      tickInProgress: false,
      tickIntervalMs: RECURRING_RESEARCH_TICK_MS,
    },
    desktopIpcStatus: () => desktopIpcStatus,
    desktopPayloadStore,
    diagnostics: {
      build: diagnosticBuildMetadata,
      runtime: {
        ownershipMode: process.env.DESKTOP_RUNTIME_OWNER_NONCE?.trim()
          ? 'desktop-host'
          : 'node-standalone',
        desktopHost: Boolean(process.env.DESKTOP_RUNTIME_OWNER_NONCE?.trim()),
      },
      health: () => {
        const configuredProviders = providerRuntime.statuses.filter((status) => status.configured).length;
        const accessMode = resolveAccessMode(userStore.count(), operatorToken);
        const schedulerStatus = recurringResearchScheduler?.status();
        const desktopHealth = desktopIpcStatus.status === 'available'
          ? { status: 'ok' as const, reasonCode: 'available' }
          : desktopIpcStatus.status === 'blocked'
            ? { status: 'blocked' as const, reasonCode: 'blocked' }
            : desktopIpcStatus.status === 'configured'
              ? { status: 'degraded' as const, reasonCode: 'configured' }
              : { status: 'unavailable' as const, reasonCode: 'unavailable' };
        return [
          {
            component: 'access.control',
            status: accessMode === 'open' ? 'degraded' as const : 'ok' as const,
            reasonCode: accessMode,
            metrics: { users: userStore.count() },
          },
          {
            component: 'command.sandbox',
            status: commandStatus.status === 'unavailable'
              ? 'blocked' as const
              : sandboxSelection.trustedHostFallback ? 'degraded' as const : 'ok' as const,
            reasonCode: commandStatus.status === 'unavailable'
              ? 'disabled'
              : sandboxSelection.trustedHostFallback ? 'trusted_host' : 'isolated',
            metrics: {
              docker_healthy: sandboxSelection.dockerHealthy,
              trusted_host_fallback: sandboxSelection.trustedHostFallback,
            },
          },
          {
            component: 'desktop.bridge',
            ...desktopHealth,
            metrics: {
              configured_apps: desktopConfiguration.configuration?.applications.length ?? 0,
            },
          },
          {
            component: 'provider.router',
            status: configuredProviders > 0 ? 'ok' as const : 'unavailable' as const,
            reasonCode: configuredProviders > 0 ? 'available' : 'not_configured',
            metrics: { configured: configuredProviders, total: providerRuntime.statuses.length },
          },
          {
            component: 'scheduler.research',
            status: !RECURRING_RESEARCH_SCHEDULER_ENABLED
              ? 'unavailable' as const
              : schedulerStatus?.running ? 'ok' as const : 'degraded' as const,
            reasonCode: !RECURRING_RESEARCH_SCHEDULER_ENABLED
              ? 'disabled'
              : schedulerStatus?.running ? 'running' : 'stopped',
            metrics: {
              enabled: RECURRING_RESEARCH_SCHEDULER_ENABLED,
              running: schedulerStatus?.running ?? false,
              tick_in_progress: schedulerStatus?.tickInProgress ?? false,
            },
          },
        ];
      },
    },
    recoverOnStart: false,
  }));
  app.use('/api', createApplicationAiRouter({
    routingPolicy: applicationRoutingPolicy,
    executor: {
      execute: async (_channel, request, policy) => {
        const execution = await kernel.executeProviderRequest(applicationGoalId, request, policy);
        const evidenceEvent = [...await kernel.getEvents()].reverse().find((event) => (
          event.type === 'provider.call.completed' && event.entityId === request.id
        ));
        if (!evidenceEvent) throw new Error('Provider execution completed without ledger evidence.');
        return { execution, evidenceEventId: evidenceEvent.id };
      },
    },
  }));
  app.get('/api/core-model/status', async (_req, res) => {
    res.json((await coreModelPromise).getStatus());
  });

  return {
    coreModelPromise,
    kernel,
    recurringResearchScheduler,
    releaseLifecycle,
    desktopIpcStatus,
    desktopBridgeAuthenticated,
    hostInstanceId: process.env.DESKTOP_HOST_INSTANCE_ID?.trim() ?? '',
    kernelReady: true,
    accessMode,
  };
};

async function start() {
  const desktopHostPid = Number.parseInt(process.env.DESKTOP_RUNTIME_OWNER_PID ?? '', 10);
  const runtimeOwnership = await acquireRuntimeOwnership(RUNTIME_DIR, {
    desktopOwnerNonce: process.env.DESKTOP_RUNTIME_OWNER_NONCE,
    desktopHostPid: Number.isSafeInteger(desktopHostPid) && desktopHostPid > 0 ? desktopHostPid : undefined,
  });
  const desktopShutdown = createDesktopShutdownControl(RUNTIME_DIR, process.env);
  delete process.env.DESKTOP_HOST_SHUTDOWN_TOKEN;
  delete process.env.DESKTOP_HOST_SHUTDOWN_NONCE;
  delete process.env.DESKTOP_HOST_SHUTDOWN_FILE;
  let desktopReady: ReturnType<typeof createDesktopReadyPublisher> | undefined;
  try {
    desktopReady = createDesktopReadyPublisher(RUNTIME_DIR, process.env);
    const authenticatedStaticResources = IS_PACKAGED_RELEASE
      ? await loadAuthenticatedStaticResources({
        projectRoot: PROJECT_ROOT,
        runtimeDirectory: RUNTIME_DIR,
        manifestPath: AUTHENTICATED_RESOURCE_MANIFEST_PATH,
        manifestSha256: AUTHENTICATED_RESOURCE_MANIFEST_SHA256,
      })
      : undefined;
    const {
      recurringResearchScheduler,
      releaseLifecycle,
      desktopIpcStatus,
      desktopBridgeAuthenticated,
      hostInstanceId,
      kernelReady,
      accessMode,
    } = await createServerContext();

    if (IS_DEVELOPMENT) {
      const { createServer: createViteServer } = await import('vite');
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: 'spa',
      });
      app.use(vite.middlewares);
    } else if (authenticatedStaticResources) {
      app.get('/assets/*', (req, res, next) => {
        const asset = authenticatedStaticResources.assets.get(req.path);
        if (!asset) {
          res.status(404).end();
          return;
        }
        res.sendFile(asset, (error) => {
          if (error) next(error);
        });
      });
      app.get('*', (req, res, next) => {
        if (req.path.startsWith('/api/')
            || req.path === '/assets'
            || req.path.startsWith('/assets/')
            || (req.path !== '/index.html' && path.posix.extname(req.path) !== '')) {
          res.status(404).end();
          return;
        }
        res.sendFile(authenticatedStaticResources.indexFile, (error) => {
          if (error) next(error);
        });
      });
    } else {
      const distPath = path.join(PROJECT_ROOT, 'dist');
      app.use(express.static(distPath));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
    }

    await recurringResearchScheduler?.start();

    let shuttingDown = false;
    let httpServer: ReturnType<typeof app.listen>;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      await recurringResearchScheduler?.stop();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await releaseLifecycle.shutdown();
      await desktopReady!.cleanup();
      await runtimeOwnership.release();
    };

    if (desktopShutdown.enabled) {
      app.post('/__provenance/native/shutdown', (req, res) => {
        if (!desktopShutdown.authenticate(req.header('x-provenance-native-shutdown'))) {
          res.status(404).end();
          return;
        }
        res.status(204).end(() => {
          void shutdown()
            .then(() => desktopShutdown.publish())
            .then(() => process.exit(0))
            .catch((error) => {
              console.error('[Desktop] Authenticated native shutdown failed:', error instanceof Error ? error.message : error);
              process.exit(1);
            });
        });
      });
    }

    httpServer = app.listen(PORT, '127.0.0.1', () => {
      const address = httpServer.address();
      const listeningPort = typeof address === 'object' && address ? address.port : PORT;
      console.log(`[Server] Persistent Agent Knowledgebase running on http://localhost:${listeningPort}`);
      const nonce = process.env.RELEASE_SUPERVISOR_NONCE;
      const targetVersion = process.env.RELEASE_TARGET_VERSION;
      const contentHash = process.env.RELEASE_CONTENT_HASH;
      const releaseReady = IS_RELEASE_CHILD
        ? nonce && targetVersion && contentHash
          ? publishReleaseReadiness(nonce, targetVersion, contentHash)
          : Promise.reject(new Error('Release child readiness metadata is incomplete.'))
        : Promise.resolve();
      void releaseReady.then(() => desktopReady!.publish({
        port: listeningPort,
        hostInstanceId,
        kernelReady,
        accessMode,
        bridgeAuthenticated: desktopBridgeAuthenticated,
        schedulerEnabled: RECURRING_RESEARCH_SCHEDULER_ENABLED,
        desktopStatus: desktopIpcStatus.status,
      })).catch((error) => {
        console.error('[Desktop] Failed to publish authenticated host readiness:', error instanceof Error ? error.message : error);
        void shutdown().finally(() => { process.exitCode = 1; });
      });
    });

    process.once('SIGINT', () => void shutdown().finally(() => process.exit(0)));
    process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)));
  } catch (error) {
    await desktopReady?.cleanup().catch(() => undefined);
    await runtimeOwnership.release().catch(() => undefined);
    throw error;
  }
}

void start().catch((error) => {
  console.error('[Server] Startup failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

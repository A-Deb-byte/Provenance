/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import { createApplicationAiRouter } from './src/app-ai/router';
import { accessControlStatus, createAccessGuard } from './src/auth/accessControl';
import { createAuthApi } from './src/auth/api';
import { createLoopbackRequestGuard, createSecurityHeaders } from './src/auth/loopbackGuard';
import { resolveSessionSecret } from './src/auth/session';
import { createUserStore } from './src/auth/users';
import { createFileCapabilityGrantStore } from './src/capabilities/grantStore';
import { createCoreModelRuntime } from './src/core-model/runtime';
import { createKernelRouter } from './src/kernel/api';
import { createFileArtifactStore } from './src/kernel/artifacts/artifactStore';
import {
  BROWSER_WRITE_WORKER_ID,
  buildBrowserWriteWorkerRegistration,
  buildWorkerRegistrations,
  WEB_INSPECT_WORKER_ID,
} from './src/kernel/autonomy';
import { createKernelService, type KernelActionWorker } from './src/kernel/kernel';
import { readKernelEvents } from './src/kernel/ledger';
import { createReleaseLifecycle } from './src/kernel/releases/lifecycle';
import { createNodeReleaseSupervisor } from './src/kernel/releases/supervisor';
import { createRecurringResearchScheduler } from './src/kernel/scheduler/service';
import {
  createHostSandbox,
  DEFAULT_DOCKER_SANDBOX_CONFIG,
  detectDockerSandbox,
} from './src/kernel/sandbox/sandbox';
import { createBrowserWorker, createPlaywrightDriver } from './src/kernel/workers/browserWorker';
import { createWebInspectWorker } from './src/kernel/workers/webInspectWorker';
import { createProviderApi } from './src/providers/api';
import { createProviderRuntime } from './src/providers/runtime';
import { PROVIDER_IDS, type ProviderId, type ProviderRoutingPolicy } from './src/providers/types';
import { createVaultApi } from './src/vault/api';
import { createPlatformVault, injectVaultSecretsIntoEnvironment } from './src/vault/index';

dotenv.config();

const app = express();
const configuredPort = Number.parseInt(process.env.PORT || '3000', 10);
const PORT = Number.isSafeInteger(configuredPort) && configuredPort >= 0 && configuredPort <= 65_535
  ? configuredPort
  : 3000;
const RUNTIME_DIR = path.join(process.cwd(), '.agent-kernel');
const IS_DEVELOPMENT = process.env.NODE_ENV === 'development' || /\.[cm]?tsx?$/iu.test(process.argv[1] || '');
const IS_RELEASE_CHILD = process.env.RELEASE_CHILD_MODE === '1';
const recurringResearchSchedulerSetting = process.env.RECURRING_RESEARCH_SCHEDULER_ENABLED?.trim().toLowerCase();
const RECURRING_RESEARCH_SCHEDULER_ENABLED = !IS_RELEASE_CHILD &&
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

app.use(createSecurityHeaders({ allowViteDevelopment: IS_DEVELOPMENT }));
app.use(createLoopbackRequestGuard());
app.use(express.json({ limit: '32mb' }));

const createServerContext = async () => {
  await injectVaultSecretsIntoEnvironment(vault, VAULT_INJECTED_SECRETS);

  const providerRuntime = createProviderRuntime();
  coreModelPromise = createCoreModelRuntime();
  const operatorToken = process.env.KERNEL_API_TOKEN;
  const userStore = await createUserStore(path.join(RUNTIME_DIR, 'users.json'));
  const sessionSecret = resolveSessionSecret(process.env.SESSION_SECRET);
  const accessGuard = createAccessGuard({ userStore, operatorToken, sessionSecret });

  const sandbox = (await detectDockerSandbox(undefined, {
    ...DEFAULT_DOCKER_SANDBOX_CONFIG,
    dockerPath: process.env.DOCKER_PATH?.trim() || DEFAULT_DOCKER_SANDBOX_CONFIG.dockerPath,
  })) ?? createHostSandbox();
  console.log(`[Sandbox] Command execution isolation: ${sandbox.mode} (${sandbox.isolation}).`);

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
  const baseRegistrations = buildWorkerRegistrations(process.env);
  const workerRegistrations = browserWriteRegistration
    ? [
      ...baseRegistrations.filter((registration) => !(
        registration.family === 'browser' && registration.availability === 'unavailable'
      )),
      browserWriteRegistration,
    ]
    : baseRegistrations;
  const actionWorkers: Record<string, KernelActionWorker> = {
    [WEB_INSPECT_WORKER_ID]: createWebInspectWorker(),
    ...(browserWriteRegistration
      ? { [BROWSER_WRITE_WORKER_ID]: createBrowserWorker(browserDriver, (id) => artifactStore.resolve(id)) }
      : {}),
  };
  if (browserWorkerAvailable) console.log('[Browser] Write-capable Playwright worker registered.');

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
    allowedWorkspaceRoot: process.cwd(),
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
      workspaceRoot: process.cwd(),
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
  app.use('/api/auth', createAuthApi({ userStore, sessionSecret, operatorToken }));
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
    recurringResearchSchedulerStatus: () => recurringResearchScheduler?.status() ?? {
      enabled: false,
      starting: false,
      running: false,
      tickInProgress: false,
      tickIntervalMs: RECURRING_RESEARCH_TICK_MS,
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

  return { coreModelPromise, kernel, recurringResearchScheduler, releaseLifecycle };
};

async function start() {
  const { recurringResearchScheduler, releaseLifecycle } = await createServerContext();

  if (IS_DEVELOPMENT) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  await recurringResearchScheduler?.start();

  const httpServer = app.listen(PORT, '127.0.0.1', () => {
    const address = httpServer.address();
    const listeningPort = typeof address === 'object' && address ? address.port : PORT;
    console.log(`[Server] Persistent Agent Knowledgebase running on http://localhost:${listeningPort}`);
    const nonce = process.env.RELEASE_SUPERVISOR_NONCE;
    const targetVersion = process.env.RELEASE_TARGET_VERSION;
    const contentHash = process.env.RELEASE_CONTENT_HASH;
    if (process.send && nonce && targetVersion && contentHash) {
      process.send({ type: 'release.ready', nonce, targetVersion, contentHash });
    }
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await recurringResearchScheduler?.stop();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await releaseLifecycle.shutdown();
  };
  process.once('SIGINT', () => void shutdown().finally(() => process.exit(0)));
  process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)));
}

void start().catch((error) => {
  console.error('[Server] Startup failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

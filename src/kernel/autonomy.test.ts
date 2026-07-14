import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { browserScope, browserWorker } from '../capabilities/testFixtures';
import { isWorkerRegistration } from '../capabilities/validators';
import {
  buildAutomationContract,
  buildBenchmarkRun,
  buildReleaseAuthorizationPayload,
  buildReleaseProposal,
  buildRuntimeCapabilityReport,
  decideReleaseActivation,
  defaultWorkerRegistrations,
  isAutomationContractInput,
  isReleaseProposalInput,
  rejectReleaseProposal,
  serializeReleaseAuthorizationPayload,
} from './autonomy';
import { BenchmarkRun, GoalContract, KernelTask } from './types';

const automationInput = () => ({
  name: 'Inspect example account page',
  goalId: 'goal_1',
  workerId: browserWorker.id,
  riskLevel: 'L0' as const,
  action: {
    type: 'browser.inspect' as const,
    origin: 'https://example.com',
    url: 'https://example.com/account',
  },
  scope: browserScope,
  trigger: { type: 'manual' as const },
  approvalMode: 'per_run' as const,
  budget: { maxRuns: 10, maxConsecutiveFailures: 3, maxRuntimeMsPerRun: 60000 },
});

const releaseInput = () => ({
  title: 'Kernel 0.2 release',
  targetVersion: '0.2.0',
  contentHash: 'a'.repeat(64),
  evaluationEventIds: ['event_1'],
  rollbackInstructions: 'Reinstall the 0.1 bundle from the artifact store.',
});

const finishedGoal = (status: 'completed' | 'failed'): GoalContract => ({
  objective: 'Verify fixture',
  successCriteria: ['Tests pass'],
  constraints: ['Local only'],
  autonomyLevel: 'supervised',
  workspaceRoot: 'C:\\workspace',
  verificationCommands: ['npm test'],
  budget: { maxOperations: 2, maxCommandRuntimeMs: 30000, maxApprovals: 1, maxProviderCalls: 0 },
  id: 'goal_1',
  status,
  usage: { operations: 1, commandRuntimeMs: 1234, approvals: 0, providerCalls: 0 },
  createdAt: '2026-07-12T00:00:00.000Z',
  updatedAt: '2026-07-12T00:05:00.000Z',
});

const passedTask = (): KernelTask => ({
  id: 'task_1',
  goalId: 'goal_1',
  title: 'Verification 1: npm test',
  description: 'Run npm test.',
  status: 'passed',
  riskLevel: 'L1',
  capabilityFamily: 'command.run',
  dependsOn: [],
  expectedEvidence: 'npm test exits with code 0.',
  evidenceEventIds: ['event_evidence_1'],
  createdAt: '2026-07-12T00:00:00.000Z',
  updatedAt: '2026-07-12T00:05:00.000Z',
});

describe('default worker registrations', () => {
  it('registers browser, desktop, and connector families as honestly unavailable', () => {
    const workers = defaultWorkerRegistrations();
    expect(workers.map((worker) => worker.family).sort()).toEqual(['browser', 'connector', 'desktop']);
    for (const worker of workers) {
      expect(isWorkerRegistration(worker)).toBe(true);
      expect(worker.availability).toBe('unavailable');
      expect(worker.unavailableReason).toMatch(/is installed/);
    }
  });
});

describe('automation contracts', () => {
  it('builds a disabled automation from validated input', () => {
    expect(isAutomationContractInput(automationInput())).toBe(true);
    const contract = buildAutomationContract(automationInput());
    expect(contract.enabled).toBe(false);
    expect(contract.id).toMatch(/^automation_/);
    expect(contract.schemaVersion).toBe(1);
  });

  it('rejects contracts whose risk understates the action', () => {
    const input = {
      ...automationInput(),
      action: {
        type: 'browser.navigate' as const,
        origin: 'https://example.com',
        url: 'https://example.com/settings',
      },
      scope: { ...browserScope, operations: ['browser.navigate' as const] },
      riskLevel: 'L0' as const,
    };
    expect(() => buildAutomationContract(input)).toThrow(/understates/);
  });

  it('rejects malformed automation input before contract construction', () => {
    expect(isAutomationContractInput({ name: 'incomplete' })).toBe(false);
    expect(isAutomationContractInput({ ...automationInput(), action: { type: 'browser.inspect' } })).toBe(false);
  });
});

describe('release proposals', () => {
  it('validates proposal input including the content hash format', () => {
    expect(isReleaseProposalInput(releaseInput())).toBe(true);
    expect(isReleaseProposalInput({ ...releaseInput(), contentHash: 'not-a-hash' })).toBe(false);
    expect(isReleaseProposalInput({ ...releaseInput(), rollbackInstructions: ' ' })).toBe(false);
    expect(isReleaseProposalInput({ ...releaseInput(), evaluationEventIds: [] })).toBe(false);
    expect(isReleaseProposalInput({ ...releaseInput(), evaluationEventIds: ['event_1', 'event_1'] })).toBe(false);
    expect(isReleaseProposalInput({ ...releaseInput(), evaluationEventIds: ['event_1', ' '] })).toBe(false);
  });

  it('serializes a deterministic, versioned authorization payload', () => {
    const input = { ...releaseInput(), evaluationEventIds: ['event_2', 'event_1'] };
    expect(buildReleaseProposal(input).evaluationEventIds).toEqual(['event_1', 'event_2']);
    const expectedPayload = {
      schemaVersion: 1,
      targetVersion: '0.2.0',
      contentHash: 'a'.repeat(64),
      evaluationEventIds: ['event_1', 'event_2'],
      rollbackInstructions: 'Reinstall the 0.1 bundle from the artifact store.',
    };
    expect(buildReleaseAuthorizationPayload(input)).toEqual(expectedPayload);
    expect(serializeReleaseAuthorizationPayload(input)).toBe(JSON.stringify(expectedPayload));
    expect(serializeReleaseAuthorizationPayload(input)).toBe(
      serializeReleaseAuthorizationPayload({ ...input, evaluationEventIds: ['event_1', 'event_2'] }),
    );
  });

  it('blocks unsigned activation with an explicit reason', () => {
    const proposal = buildReleaseProposal(releaseInput());
    const blocked = decideReleaseActivation(proposal);
    expect(blocked.activationState).toBe('blocked');
    expect(blocked.activationReason).toBe('Unsigned release proposals cannot activate core changes.');
  });

  it('blocks signed activation when no verification key is installed', () => {
    const proposal = buildReleaseProposal({ ...releaseInput(), signature: 'deadbeef' });
    const blocked = decideReleaseActivation(proposal);
    expect(blocked.activationState).toBe('blocked');
    expect(blocked.activationReason).toMatch(/No release signing verification key/);
  });

  it('activates only when the Ed25519 signature verifies against the configured key', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const publicKeyBase64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const input = releaseInput();
    const signature = crypto.sign(
      null,
      Buffer.from(serializeReleaseAuthorizationPayload(input), 'utf8'),
      privateKey,
    ).toString('base64');

    const activated = decideReleaseActivation(
      buildReleaseProposal({ ...input, signature }),
      publicKeyBase64,
    );
    expect(activated.activationState).toBe('activated');
    expect(activated.activationReason).toMatch(/signature verified/i);

    const forged = decideReleaseActivation(
      buildReleaseProposal({ ...releaseInput(), signature: Buffer.from('forged').toString('base64') }),
      publicKeyBase64,
    );
    expect(forged.activationState).toBe('blocked');
    expect(forged.activationReason).toMatch(/failed verification/);

    const proposal = buildReleaseProposal({ ...input, signature });
    const alteredAuthorizations = [
      { ...proposal, targetVersion: '0.2.1' },
      { ...proposal, contentHash: 'b'.repeat(64) },
      { ...proposal, evaluationEventIds: ['event_2'] },
      { ...proposal, rollbackInstructions: 'Do not restore the previous release.' },
    ];
    for (const altered of alteredAuthorizations) {
      expect(decideReleaseActivation(altered, publicKeyBase64).activationState).toBe('blocked');
    }
  });

  it('rejects proposals with a reason and refuses activation afterwards', () => {
    const rejected = rejectReleaseProposal(buildReleaseProposal(releaseInput()), 'Superseded by 0.3.');
    expect(rejected.activationState).toBe('rejected');
    expect(() => decideReleaseActivation(rejected)).toThrow(/Rejected release proposals/);
  });
});

describe('benchmark runs', () => {
  it('projects a finished goal into a benchmark record', () => {
    const run: BenchmarkRun = buildBenchmarkRun(finishedGoal('completed'), [passedTask()], [], []);
    expect(run.completion).toBe('completed');
    expect(run.taskDefinitions).toHaveLength(1);
    expect(run.interventionCount).toBe(0);
    expect(run.commandRuntimeMs).toBe(1234);
    expect(run.evidenceEventIds).toEqual(['event_evidence_1']);
  });

  it('refuses benchmark records for unfinished goals', () => {
    expect(() => buildBenchmarkRun({ ...finishedGoal('completed'), status: 'active' }, [], [], []))
      .toThrow(/completed or failed/);
  });
});

describe('runtime capability report', () => {
  const providerStatuses = [
    { id: 'gemini', configured: true },
    { id: 'openai', configured: false, unavailableReason: 'OPENAI_API_KEY is not configured.' },
  ];

  it('distinguishes available, unavailable, and deployment-blocked features', () => {
    const report = buildRuntimeCapabilityReport({
      providerStatuses,
      workerReport: { available: [], configured: [], unavailable: [{ id: 'worker.browser.placeholder', reason: 'No runtime.' }] },
      stopAll: false,
    });

    expect(report.providers.configured).toEqual(['gemini']);
    expect(report.providers.unavailable[0].id).toBe('openai');
    expect(report.features.providerCalls.status).toBe('available');
    expect(report.features.backgroundAutomation.status).toBe('unavailable');
    expect(report.features.secretVault.status).toBe('unavailable');
    expect(report.features.osSandbox.status).toBe('unavailable');
    expect(report.features.releaseSigning.status).toBe('unavailable');
    expect(report.features.releaseDeployment.status).toBe('unavailable');
  });

  it('projects the core model status when one is supplied', () => {
    const report = buildRuntimeCapabilityReport({
      providerStatuses,
      workerReport: { available: [], configured: [], unavailable: [] },
      stopAll: false,
      coreModel: { status: 'available', reason: 'MiniCPM5-1B weights are loaded.' },
      releaseDeployment: { status: 'configured', reason: 'Supervisor installed.' },
    });
    const defaulted = buildRuntimeCapabilityReport({
      providerStatuses,
      workerReport: { available: [], configured: [], unavailable: [] },
      stopAll: false,
    });

    expect(report.features.coreModel.status).toBe('available');
    expect(report.features.releaseDeployment.status).toBe('configured');
    expect(defaulted.features.coreModel.status).toBe('unavailable');
    expect(defaulted.features.coreModel.reason).toContain('No core model runtime');
  });

  it('reports execution features as blocked while Stop All is active', () => {
    const report = buildRuntimeCapabilityReport({
      providerStatuses,
      workerReport: { available: ['worker.browser.local'], configured: [], unavailable: [] },
      stopAll: true,
    });

    expect(report.features.verificationCommands.status).toBe('blocked');
    expect(report.features.providerCalls.status).toBe('blocked');
    expect(report.features.backgroundAutomation.status).toBe('blocked');
  });
});

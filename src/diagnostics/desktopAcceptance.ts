import path from 'node:path';
import type { DesktopAction, DesktopCapabilityScope } from '../capabilities/types';
import type { DesktopBridgeClient } from '../desktop/ipc';
import { createMemoryDesktopPayloadStore } from '../desktop/payloadStore';
import { createFileArtifactStore } from '../kernel/artifacts/artifactStore';
import {
  buildDesktopWorkerRegistration,
  DESKTOP_V1_ACTIONS,
  DESKTOP_WORKER_ID,
} from '../kernel/autonomy';
import { createKernelService } from '../kernel/kernel';
import { createDesktopWorker } from '../kernel/workers/desktopWorker';

const APP_ID = 'acceptance.notepad';
const WINDOW_ID = 'window.acceptance.main';
const TREE_REVISION = 'a'.repeat(64);
const CLICK_NODE_ID = 'b'.repeat(64);
const TYPE_NODE_ID = 'c'.repeat(64);
const UNCERTAIN_NODE_ID = 'd'.repeat(64);
const TYPED_CANARY = 'PROVENANCE-DESKTOP-ACCEPTANCE-CANARY';

export type DesktopAcceptanceCheckId =
  | 'desktop.health.available'
  | 'desktop.discover.completed'
  | 'desktop.inspect.exact_revision'
  | 'desktop.click.approval_required'
  | 'desktop.click.approval_consumed'
  | 'desktop.type.approval_required'
  | 'desktop.type.payload_consumed'
  | 'desktop.type.payload_absent_from_authority_state'
  | 'desktop.uncertain.recorded'
  | 'desktop.uncertain.retry_blocked'
  | 'desktop.harness.completed';

export interface DesktopAcceptanceCheck {
  id: DesktopAcceptanceCheckId;
  status: 'passed' | 'failed';
  evidenceCode: string;
}

export interface DesktopAcceptanceReport {
  schemaVersion: 1;
  mode: 'deterministic-native-bridge-fixture';
  liveUiAutomation: false;
  generatedAt: string;
  passed: boolean;
  checks: DesktopAcceptanceCheck[];
  metrics: {
    bridgeHealthCalls: number;
    bridgeActionCalls: number;
    approvalsConsumed: number;
    uncertainRuns: number;
  };
}

export interface DeterministicDesktopAcceptanceOptions {
  runtimeDir: string;
  workspaceRoot: string;
  generatedAt?: string;
}

class AcceptanceFailure extends Error {
  constructor(readonly checkId: DesktopAcceptanceCheckId) {
    super(checkId);
  }
}

const desktopScope = (action: DesktopAction): DesktopCapabilityScope => ({
  family: 'desktop',
  operations: [action.type],
  appId: action.appId,
  ...(action.type === 'desktop.discover'
    ? {}
    : { windowId: action.windowId, treeRevision: action.treeRevision }),
});

/**
 * Exercises the trusted kernel and real desktop worker with only the native
 * UIA bridge replaced by a deterministic fixture. This is a CI foundation,
 * not evidence that live Windows UI Automation has passed acceptance.
 */
export const runDeterministicDesktopAcceptance = async (
  options: DeterministicDesktopAcceptanceOptions,
): Promise<DesktopAcceptanceReport> => {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(generatedAt)) || new Date(generatedAt).toISOString() !== generatedAt) {
    throw new Error('Desktop acceptance report time must be a canonical ISO timestamp.');
  }
  const checks: DesktopAcceptanceCheck[] = [];
  const bridgeActions: DesktopAction['type'][] = [];
  let bridgeHealthCalls = 0;
  let approvalsConsumed = 0;
  let uncertainRuns = 0;

  const check = (
    id: DesktopAcceptanceCheckId,
    condition: boolean,
    evidenceCode: string,
  ): void => {
    checks.push({ id, status: condition ? 'passed' : 'failed', evidenceCode });
    if (!condition) throw new AcceptanceFailure(id);
  };

  try {
    const payloadStore = createMemoryDesktopPayloadStore();
    const bridge: DesktopBridgeClient = {
      health: async () => {
        bridgeHealthCalls += 1;
        return {
          schemaVersion: 1,
          status: 'ok',
          hostInstanceId: 'fixture-host',
          platform: 'windows',
          capabilities: [...DESKTOP_V1_ACTIONS],
          allowedAppIds: [APP_ID],
        };
      },
      perform: async (action, performOptions) => {
        bridgeActions.push(action.type);
        const sourceRef = action.type === 'desktop.discover'
          ? `desktop:${action.appId}`
          : `desktop:${action.appId}/${action.windowId}`;
        if (action.type === 'desktop.discover') {
          return {
            schemaVersion: 1,
            status: 'succeeded',
            sourceRef,
            summary: 'Fixture window discovery completed.',
            content: JSON.stringify({ windows: [{ windowId: WINDOW_ID, treeRevision: TREE_REVISION }] }),
          };
        }
        if (action.type === 'desktop.inspect') {
          return {
            schemaVersion: 1,
            status: 'succeeded',
            sourceRef,
            summary: 'Fixture window inspection completed.',
            content: JSON.stringify({
              windowId: WINDOW_ID,
              treeRevision: TREE_REVISION,
              nodes: [{ nodeId: CLICK_NODE_ID }, { nodeId: TYPE_NODE_ID }],
            }),
          };
        }
        if (action.type === 'desktop.click' && action.nodeId === UNCERTAIN_NODE_ID) {
          throw new Error('Injected native bridge transport loss.');
        }
        if (action.type === 'desktop.type' && performOptions.payloadText !== TYPED_CANARY) {
          return {
            schemaVersion: 1,
            status: 'failed',
            sourceRef,
            summary: 'Fixture typed-payload validation failed.',
            errorCode: 'fixture_payload_mismatch',
          };
        }
        return {
          schemaVersion: 1,
          status: 'succeeded',
          sourceRef,
          summary: `${action.type} fixture mutation completed.`,
        };
      },
    };

    const health = await bridge.health();
    check(
      'desktop.health.available',
      health.status === 'ok' && health.allowedAppIds.includes(APP_ID) &&
        DESKTOP_V1_ACTIONS.every((action) => health.capabilities.includes(action)),
      'fixture_bridge_health_contract_verified',
    );

    const worker = createDesktopWorker(bridge, (id) => payloadStore.consume(id));
    const registration = buildDesktopWorkerRegistration([APP_ID], {
      available: true,
      registeredAt: generatedAt,
    });
    const kernel = createKernelService({
      runtimeDir: path.resolve(options.runtimeDir),
      allowedWorkspaceRoot: path.resolve(options.workspaceRoot),
      workerRegistrations: [registration],
      actionWorkers: { [DESKTOP_WORKER_ID]: worker },
      artifactStore: createFileArtifactStore(path.join(options.runtimeDir, 'acceptance-artifacts')),
    });
    const goal = await kernel.createGoal({
      objective: 'Verify deterministic desktop authority and execution contracts',
      successCriteria: ['Every desktop acceptance check passes'],
      constraints: ['Use only the deterministic native bridge fixture'],
      autonomyLevel: 'supervised',
      workspaceRoot: path.resolve(options.workspaceRoot),
      verificationCommands: ['npm test'],
      budget: {
        maxOperations: 8,
        maxCommandRuntimeMs: 1_000,
        maxApprovals: 3,
        maxProviderCalls: 0,
      },
    });

    const createAutomation = async (name: string, action: DesktopAction) => {
      const automation = await kernel.createAutomation({
        name,
        goalId: goal.id,
        workerId: DESKTOP_WORKER_ID,
        riskLevel: action.type === 'desktop.discover' || action.type === 'desktop.inspect' ? 'L0' : 'L2',
        action,
        scope: desktopScope(action),
        trigger: { type: 'manual' },
        approvalMode: 'per_run',
        budget: { maxRuns: 3, maxConsecutiveFailures: 2, maxRuntimeMsPerRun: 5_000 },
      });
      await kernel.setAutomationEnabled(automation.id, true, 'Enable deterministic desktop acceptance check.');
      return automation;
    };

    const discovery = await createAutomation('Discover fixture window', {
      type: 'desktop.discover', appId: APP_ID,
    });
    const discoveryOutcome = await kernel.runAutomation(discovery.id);
    check(
      'desktop.discover.completed',
      discoveryOutcome.decision.kind === 'allow' && discoveryOutcome.dispatch?.status === 'succeeded' &&
        bridgeActions.filter((action) => action === 'desktop.discover').length === 1,
      'l0_discovery_dispatched_once',
    );

    const inspection = await createAutomation('Inspect fixture window', {
      type: 'desktop.inspect', appId: APP_ID, windowId: WINDOW_ID, treeRevision: TREE_REVISION,
    });
    const inspectionOutcome = await kernel.runAutomation(inspection.id);
    check(
      'desktop.inspect.exact_revision',
      inspectionOutcome.decision.kind === 'allow' && inspectionOutcome.dispatch?.status === 'succeeded' &&
        bridgeActions.filter((action) => action === 'desktop.inspect').length === 1,
      'l0_exact_revision_inspection_dispatched_once',
    );

    const click = await createAutomation('Click fixture control', {
      type: 'desktop.click', appId: APP_ID, windowId: WINDOW_ID,
      treeRevision: TREE_REVISION, nodeId: CLICK_NODE_ID,
    });
    const clickBlocked = await kernel.runAutomation(click.id);
    check(
      'desktop.click.approval_required',
      clickBlocked.decision.kind === 'approval_required' && Boolean(clickBlocked.approvalId) &&
        clickBlocked.dispatch === undefined && !bridgeActions.includes('desktop.click'),
      'l2_click_stopped_before_bridge_io',
    );
    await kernel.decideApproval(clickBlocked.approvalId!, 'approved', 'Approve the exact fixture click once.');
    const clickOutcome = await kernel.runAutomation(click.id);
    const clickApproval = (await kernel.getState()).approvals
      .find((approval) => approval.id === clickBlocked.approvalId);
    if (clickApproval?.status === 'consumed') approvalsConsumed += 1;
    check(
      'desktop.click.approval_consumed',
      clickOutcome.dispatch?.status === 'succeeded' && clickApproval?.status === 'consumed' &&
        bridgeActions.filter((action) => action === 'desktop.click').length === 1,
      'approved_click_consumed_and_dispatched_once',
    );

    const stagedPayload = await payloadStore.stage(TYPED_CANARY);
    const type = await createAutomation('Type fixture content', {
      type: 'desktop.type', appId: APP_ID, windowId: WINDOW_ID, treeRevision: TREE_REVISION,
      nodeId: TYPE_NODE_ID, payloadArtifactId: stagedPayload.id, payloadHash: stagedPayload.contentHash,
    });
    const typeBlocked = await kernel.runAutomation(type.id);
    check(
      'desktop.type.approval_required',
      typeBlocked.decision.kind === 'approval_required' && Boolean(typeBlocked.approvalId) &&
        typeBlocked.dispatch === undefined && !bridgeActions.includes('desktop.type'),
      'l2_type_stopped_before_payload_consumption',
    );
    await kernel.decideApproval(typeBlocked.approvalId!, 'approved', 'Approve the exact fixture type action once.');
    const typeOutcome = await kernel.runAutomation(type.id);
    const typeApproval = (await kernel.getState()).approvals
      .find((approval) => approval.id === typeBlocked.approvalId);
    if (typeApproval?.status === 'consumed') approvalsConsumed += 1;
    check(
      'desktop.type.payload_consumed',
      typeOutcome.dispatch?.status === 'succeeded' && typeApproval?.status === 'consumed' &&
        payloadStore.size() === 0 && bridgeActions.filter((action) => action === 'desktop.type').length === 1,
      'approved_type_consumed_one_use_payload',
    );
    const authorityState = JSON.stringify({
      state: await kernel.getState(),
      events: await kernel.getEvents(),
      outcome: typeOutcome,
    });
    check(
      'desktop.type.payload_absent_from_authority_state',
      !authorityState.includes(TYPED_CANARY),
      'typed_canary_absent_from_state_ledger_and_outcome',
    );

    const uncertain = await createAutomation('Inject uncertain fixture click', {
      type: 'desktop.click', appId: APP_ID, windowId: WINDOW_ID,
      treeRevision: TREE_REVISION, nodeId: UNCERTAIN_NODE_ID,
    });
    const uncertainBlocked = await kernel.runAutomation(uncertain.id);
    await kernel.decideApproval(
      uncertainBlocked.approvalId!,
      'approved',
      'Approve one exact fixture click with injected transport loss.',
    );
    const uncertainOutcome = await kernel.runAutomation(uncertain.id);
    const uncertainApproval = (await kernel.getState()).approvals
      .find((approval) => approval.id === uncertainBlocked.approvalId);
    if (uncertainApproval?.status === 'consumed') approvalsConsumed += 1;
    if (uncertainOutcome.dispatch?.status === 'uncertain') uncertainRuns += 1;
    check(
      'desktop.uncertain.recorded',
      uncertainOutcome.dispatch?.status === 'uncertain' &&
        uncertainOutcome.dispatch.errorCode === 'desktop_outcome_uncertain' &&
        (await kernel.getEvents()).some((event) => event.type === 'automation.run_uncertain' && event.entityId === uncertain.id),
      'transport_loss_recorded_as_uncertain',
    );
    let retryBlocked = false;
    try {
      await kernel.runAutomation(uncertain.id);
    } catch (error) {
      retryBlocked = error instanceof Error &&
        /unresolved uncertain mutation outcome and cannot be retried/i.test(error.message);
    }
    check(
      'desktop.uncertain.retry_blocked',
      retryBlocked && bridgeActions.filter((action) => action === 'desktop.click').length === 2,
      'uncertain_mutation_not_replayed',
    );
    check('desktop.harness.completed', true, 'all_fixture_contracts_verified');
  } catch (error) {
    if (!(error instanceof AcceptanceFailure)) {
      checks.push({
        id: 'desktop.harness.completed',
        status: 'failed',
        evidenceCode: 'unexpected_harness_failure',
      });
    }
  }

  return {
    schemaVersion: 1,
    mode: 'deterministic-native-bridge-fixture',
    liveUiAutomation: false,
    generatedAt,
    passed: checks.length === 11 && checks.every((item) => item.status === 'passed'),
    checks,
    metrics: {
      bridgeHealthCalls,
      bridgeActionCalls: bridgeActions.length,
      approvalsConsumed,
      uncertainRuns,
    },
  };
};

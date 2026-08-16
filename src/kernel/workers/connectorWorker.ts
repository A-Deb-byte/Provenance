import {
  claimCapabilityDispatchAuthorization,
  type CapabilityDispatchAuthorization,
} from '../../capabilities/dispatch';
import type { ActionIntent, ConnectorAction } from '../../capabilities/types';
import type { DesktopPayloadConsumer } from '../../desktop/payloadStore';
import type { KernelActionWorkerResult } from '../kernel';

/**
 * Outbound connector actions (mail, chat, ticketing).
 *
 * The connector vocabulary existed in the type system and risk ladder with no
 * worker behind it, so `connector.send` was a promise the runtime could not
 * keep. This closes that: the kernel now either performs the action or refuses
 * it for a stated reason, and never silently accepts one it cannot honour.
 *
 * Adapters are supplied by the deployment. The worker owns the parts that must
 * not vary per adapter -- authorization claiming, scope containment, payload
 * hash verification, and the send/delete confirmation rule -- so a new adapter
 * cannot weaken them by omission.
 */

const MAX_PAYLOAD_CHARS = 256 * 1024;

export interface ConnectorAdapterResult {
  status: 'succeeded' | 'failed' | 'uncertain';
  summary: string;
  /** Provider-side identifier, when one exists. */
  externalRef?: string;
  content?: string;
  errorCode?: string;
}

export interface ConnectorAdapter {
  readonly connectorId: string;
  read(resourceId: string, signal?: AbortSignal): Promise<ConnectorAdapterResult>;
  draft(resourceId: string, body: string, signal?: AbortSignal): Promise<ConnectorAdapterResult>;
  send(resourceId: string, body: string | undefined, signal?: AbortSignal): Promise<ConnectorAdapterResult>;
  remove(resourceId: string, signal?: AbortSignal): Promise<ConnectorAdapterResult>;
}

const fail = (summary: string, sourceRef: string, errorCode: string): KernelActionWorkerResult =>
  ({ status: 'failed', summary, sourceRef, errorCode });

/**
 * An outbound effect whose result was lost is reported as uncertain, never as
 * failed. "Failed" invites a retry, and a retried send may deliver twice.
 */
const uncertain = (summary: string, sourceRef: string): KernelActionWorkerResult =>
  ({ status: 'uncertain', summary, sourceRef, errorCode: 'connector_outcome_uncertain' });

const resourceWithinRoot = (resource: string, root: string): boolean =>
  resource === root || resource.startsWith(`${root}/`);

export const createConnectorWorker = (
  adapters: readonly ConnectorAdapter[],
  payloadConsumer?: DesktopPayloadConsumer,
) => {
  const byId = new Map<string, ConnectorAdapter>();
  for (const adapter of adapters) {
    if (byId.has(adapter.connectorId)) {
      throw new Error(`Duplicate connector adapter: ${adapter.connectorId}.`);
    }
    byId.set(adapter.connectorId, adapter);
  }

  return {
    execute: async (
      intent: ActionIntent,
      options: {
        timeoutMs: number;
        authorization?: CapabilityDispatchAuthorization;
        signal?: AbortSignal;
      },
    ): Promise<KernelActionWorkerResult> => {
      const claim = claimCapabilityDispatchAuthorization(options.authorization, intent, intent.workerId);
      if (!claim.allowed) {
        return fail(claim.reason, 'connector:invalid', claim.reasonCode ?? 'authorization_invalid');
      }

      const action = intent.action as ConnectorAction;
      if (!action.type?.startsWith('connector.')) {
        return fail('Connector worker received a non-connector action.', 'connector:invalid', 'unsupported_action');
      }
      const sourceRef = `connector:${action.connectorId}`;

      if (intent.scope.family !== 'connector' || intent.scope.connectorId !== action.connectorId) {
        return fail('Connector action is outside the granted connector scope.', sourceRef, 'scope_mismatch');
      }
      // Defense-in-depth. Unreachable through the authorized path today --
      // isActionIntent rejects a scope-mismatched intent before a grant can be
      // minted -- but a worker that trusts its caller to have validated scope is
      // one refactor away from not being checked at all.
      if (!intent.scope.resourceRoots.some((root) => resourceWithinRoot(action.resourceId, root))) {
        return fail('Connector resource is outside the granted resource roots.', sourceRef, 'scope_mismatch');
      }

      const adapter = byId.get(action.connectorId);
      if (!adapter) {
        return fail(`No connector adapter is configured for ${action.connectorId}.`, sourceRef, 'adapter_unavailable');
      }

      // Outbound bodies are hash-addressed, never inline, so untrusted content
      // cannot be smuggled into a message the operator approved by summary.
      let body: string | undefined;
      const needsBody = action.type === 'connector.draft' ||
        (action.type === 'connector.send' && action.payloadArtifactId !== undefined);
      if (needsBody) {
        const artifactId = (action as { payloadArtifactId?: string }).payloadArtifactId;
        if (!payloadConsumer) {
          return fail('No one-use payload store is configured for connector content.', sourceRef, 'no_payload_store');
        }
        if (!artifactId) {
          return fail('Connector content requires a staged payload artifact.', sourceRef, 'payload_missing');
        }
        const payload = await payloadConsumer(artifactId);
        if (!payload) {
          return fail('Connector payload was not found, expired, or already consumed.', sourceRef, 'payload_not_found');
        }
        if (payload.content.length > MAX_PAYLOAD_CHARS) {
          return fail('Connector payload exceeds the size limit.', sourceRef, 'payload_too_large');
        }
        if (payload.contentHash !== action.payloadHash) {
          return fail('Connector payload hash does not match the staged value.', sourceRef, 'payload_hash_mismatch');
        }
        body = payload.content;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Math.min(options.timeoutMs, 60_000));
      const abort = () => controller.abort();
      options.signal?.addEventListener('abort', abort);
      try {
        let result: ConnectorAdapterResult;
        switch (action.type) {
          case 'connector.read':
            result = await adapter.read(action.resourceId, controller.signal);
            break;
          case 'connector.draft':
            result = await adapter.draft(action.resourceId, body ?? '', controller.signal);
            break;
          case 'connector.send':
            result = await adapter.send(action.resourceId, body, controller.signal);
            break;
          case 'connector.delete':
            result = await adapter.remove(action.resourceId, controller.signal);
            break;
          default:
            return fail('Unsupported connector action.', sourceRef, 'unsupported_action');
        }
        return {
          status: result.status,
          summary: result.summary,
          sourceRef: result.externalRef ? `${sourceRef}#${result.externalRef}` : sourceRef,
          content: action.type === 'connector.read' ? result.content : undefined,
          errorCode: result.errorCode,
        };
      } catch {
        // send and delete may have taken effect before the result was lost.
        if (action.type === 'connector.send' || action.type === 'connector.delete') {
          return uncertain(
            `The ${action.type} request lost its result and may have completed; do not retry it automatically.`,
            sourceRef,
          );
        }
        return fail(
          options.signal?.aborted || controller.signal.aborted
            ? 'Connector action was cancelled.'
            : 'Connector adapter request failed.',
          sourceRef,
          options.signal?.aborted ? 'cancelled' : 'adapter_transport',
        );
      } finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener('abort', abort);
      }
    },
  };
};

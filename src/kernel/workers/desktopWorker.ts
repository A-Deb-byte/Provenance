import {
  claimCapabilityDispatchAuthorization,
  type CapabilityDispatchAuthorization,
} from '../../capabilities/dispatch';
import type { ActionIntent, DesktopAction } from '../../capabilities/types';
import type { DesktopBridgeClient } from '../../desktop/ipc';
import type { DesktopPayloadConsumer } from '../../desktop/payloadStore';

const MAX_TYPED_PAYLOAD_CHARS = 64 * 1024;

type SupportedDesktopAction = Extract<DesktopAction, {
  type: 'desktop.discover' | 'desktop.inspect' | 'desktop.click' | 'desktop.type';
}>;

const isSupportedAction = (action: DesktopAction): action is SupportedDesktopAction => (
  action.type === 'desktop.discover' || action.type === 'desktop.inspect' ||
  action.type === 'desktop.click' || action.type === 'desktop.type'
);

const fail = (summary: string, sourceRef: string, errorCode: string) => ({
  status: 'failed' as const,
  summary,
  sourceRef,
  errorCode,
});

const uncertain = (summary: string, sourceRef: string) => ({
  status: 'uncertain' as const,
  summary,
  sourceRef,
  errorCode: 'desktop_outcome_uncertain',
});

export const createDesktopWorker = (
  bridge: DesktopBridgeClient,
  payloadConsumer?: DesktopPayloadConsumer,
) => ({
  execute: async (
    intent: ActionIntent,
    options: {
      timeoutMs: number;
      authorization?: CapabilityDispatchAuthorization;
      signal?: AbortSignal;
    },
  ) => {
    const authorization = claimCapabilityDispatchAuthorization(
      options.authorization,
      intent,
      intent.workerId,
    );
    if (!authorization.allowed) {
      return fail(authorization.reason, 'desktop:invalid', authorization.reasonCode ?? 'authorization_invalid');
    }

    const action = intent.action as DesktopAction;
    if (!isSupportedAction(action)) {
      return fail('Desktop worker supports only discover, inspect, click, and type.', 'desktop:invalid', 'unsupported_action');
    }
    if (intent.scope.family !== 'desktop' || intent.scope.appId !== action.appId) {
      return fail('Desktop action is outside the granted app scope.', `desktop:${action.appId}`, 'scope_mismatch');
    }
    if (action.type !== 'desktop.discover' && (
      intent.scope.windowId !== action.windowId || intent.scope.treeRevision !== action.treeRevision
    )) {
      return fail('Desktop action is outside the exact window snapshot scope.', `desktop:${action.appId}`, 'scope_mismatch');
    }

    let payloadText: string | undefined;
    if (action.type === 'desktop.type') {
      if (!payloadConsumer) {
        return fail('No one-use payload store is configured for desktop text entry.', `desktop:${action.appId}/${action.windowId}`, 'no_payload_store');
      }
      const payload = await payloadConsumer(action.payloadArtifactId);
      if (!payload) {
        return fail('Desktop typed payload was not found, expired, or already consumed.', `desktop:${action.appId}/${action.windowId}`, 'payload_not_found');
      }
      if (payload.content.length > MAX_TYPED_PAYLOAD_CHARS) {
        return fail('Desktop typed payload exceeds the entry limit.', `desktop:${action.appId}/${action.windowId}`, 'payload_too_large');
      }
      if (payload.contentHash !== action.payloadHash) {
        return fail('Desktop typed-payload hash does not match the staged value.', `desktop:${action.appId}/${action.windowId}`, 'payload_hash_mismatch');
      }
      payloadText = payload.content;
    }

    try {
      const result = await bridge.perform(action, {
        timeoutMs: Math.min(options.timeoutMs, 30_000),
        payloadText,
        signal: options.signal,
      });
      return {
        status: result.status,
        summary: result.summary,
        sourceRef: result.sourceRef,
        content: result.content,
        errorCode: result.errorCode,
      };
    } catch {
      const aborted = options.signal?.aborted;
      const sourceRef = action.type === 'desktop.discover'
        ? `desktop:${action.appId}`
        : `desktop:${action.appId}/${action.windowId}`;
      if (action.type === 'desktop.click' || action.type === 'desktop.type') {
        return uncertain(
          'The authenticated native mutation request lost its result and may have completed; do not retry it automatically.',
          sourceRef,
        );
      }
      return fail(
        aborted ? 'Desktop action was cancelled.' : 'Authenticated desktop bridge request failed.',
        sourceRef,
        aborted ? 'cancelled' : 'bridge_transport',
      );
    }
  },
});

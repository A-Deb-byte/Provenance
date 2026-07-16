import { describe, expect, it } from 'vitest';
import { browserIntent, browserScope, browserWorker } from './testFixtures';
import {
  isActionIntent,
  isActionWithinScope,
  isCapabilityScope,
  isScopeWithinScope,
  isUntrustedObservation,
  isWorkerRegistration,
} from './validators';

describe('capability contract validation', () => {
  it('accepts a structurally valid intent and worker registration', () => {
    expect(isActionIntent(browserIntent())).toBe(true);
    expect(isWorkerRegistration(browserWorker)).toBe(true);
  });

  it('rejects untrusted content as an authority source', () => {
    const malicious = {
      ...browserIntent(),
      authority: { kind: 'untrusted_observation', referenceId: 'observation_1' },
    };
    expect(isActionIntent(malicious)).toBe(false);
  });

  it('keeps observations explicitly non-authoritative', () => {
    expect(isUntrustedObservation({
      id: 'observation_1',
      source: 'web',
      sourceRef: 'https://example.com',
      contentHash: 'a'.repeat(64),
      capturedAt: '2026-07-12T00:00:00.000Z',
      canGrantAuthority: false,
      injectionSignalCodes: ['instruction_override'],
    })).toBe(true);
    expect(isUntrustedObservation({
      id: 'observation_1',
      source: 'web',
      sourceRef: 'https://example.com',
      contentHash: 'a'.repeat(64),
      capturedAt: '2026-07-12T00:00:00.000Z',
      canGrantAuthority: true,
      injectionSignalCodes: [],
    })).toBe(false);
  });

  it('requires exact canonical browser origins and download roots', () => {
    expect(isActionWithinScope(browserIntent().action, browserScope)).toBe(true);
    expect(isActionWithinScope({
      type: 'browser.inspect',
      origin: 'https://evil.example',
      url: 'https://evil.example/',
    }, browserScope)).toBe(false);
    expect(isActionWithinScope({
      type: 'browser.inspect',
      origin: 'https://example.com/path',
      url: 'https://example.com/path',
    }, browserScope)).toBe(false);
    expect(isActionWithinScope({
      type: 'browser.download',
      origin: 'https://example.com',
      url: 'https://example.com/file',
      downloadRoot: 'C:\\AgentDownloads\\nested',
      fileName: 'file.txt',
    }, browserScope)).toBe(false);
    expect(isActionWithinScope({
      type: 'browser.download',
      origin: 'https://example.com',
      url: 'https://example.com/file',
      downloadRoot: 'C:\\AgentDownloads',
      fileName: '..\\escape.txt',
    }, browserScope)).toBe(false);
  });

  it('requires exact desktop app, window, and accessibility-tree revision', () => {
    const scope = {
      family: 'desktop' as const,
      operations: ['desktop.click' as const],
      appId: 'com.example.editor',
      windowId: 'window_7',
      treeRevision: 'tree_sha256_1',
    };
    const action = {
      type: 'desktop.click' as const,
      appId: scope.appId,
      windowId: scope.windowId,
      treeRevision: scope.treeRevision,
      nodeId: 'save_button',
    };

    expect(isActionWithinScope(action, scope)).toBe(true);
    expect(isActionWithinScope({ ...action, treeRevision: 'tree_sha256_2' }, scope)).toBe(false);
    expect(isActionWithinScope({ ...action, windowId: 'window_8' }, scope)).toBe(false);
  });

  it('uses an app-only registration scope while keeping every non-discovery intent exact', () => {
    const configured = {
      family: 'desktop' as const,
      operations: ['desktop.discover' as const, 'desktop.inspect' as const, 'desktop.click' as const],
      appId: 'notepad',
    };
    const exact = {
      family: 'desktop' as const,
      operations: ['desktop.click' as const],
      appId: 'notepad',
      windowId: 'window_1',
      treeRevision: 'rev_1',
    };
    expect(isCapabilityScope(configured)).toBe(true);
    expect(isScopeWithinScope(exact, configured)).toBe(true);
    expect(isScopeWithinScope({ ...exact, appId: 'calculator' }, configured)).toBe(false);
    expect(isActionWithinScope({ type: 'desktop.discover', appId: 'notepad' }, {
      family: 'desktop', operations: ['desktop.discover'], appId: 'notepad',
    })).toBe(true);
    expect(isActionWithinScope({
      type: 'desktop.click', appId: 'notepad', windowId: 'window_1', treeRevision: 'rev_1', nodeId: 'node_1',
    }, configured)).toBe(false);
  });

  it('matches connector resources on segment boundaries', () => {
    const scope = {
      family: 'connector' as const,
      operations: ['connector.read' as const],
      connectorId: 'mail',
      resourceRoots: ['mailbox/inbox'],
    };
    expect(isActionWithinScope({
      type: 'connector.read', connectorId: 'mail', resourceId: 'mailbox/inbox/message-1',
    }, scope)).toBe(true);
    expect(isActionWithinScope({
      type: 'connector.read', connectorId: 'mail', resourceId: 'mailbox/inbox-old/message-1',
    }, scope)).toBe(false);
  });
});

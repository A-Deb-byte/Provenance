import { describe, expect, it } from 'vitest';
import { validateAgentPlan } from './planner';
import type { AgentSpawn } from './types';
import type { WorkerRegistration } from '../../capabilities/types';

const NOW = '2026-08-16T12:00:00.000Z';
const DOWNLOAD_ROOT = 'C:\\Agent\\Downloads';

const spawn = (overrides: Partial<AgentSpawn> = {}): AgentSpawn => ({
  schemaVersion: 1,
  id: 'spawn_1',
  definitionId: 'agent_1',
  goalId: 'goal_1',
  depth: 0,
  tier: 'T1_operator',
  domain: 'web',
  requestedAuthority: 'propose_only',
  effectiveAuthority: 'propose_only',
  effectiveRiskCeiling: 'L1',
  status: 'running',
  objective: 'Do the work',
  budget: { maxOperations: 10, maxChildren: 3, maxDepth: 2, deadlineMs: 600_000 },
  operationsUsed: 0,
  childCount: 0,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const browserWorker: WorkerRegistration = {
  id: 'worker.browser.playwright',
  family: 'browser',
  availability: 'available',
  supportedActions: ['browser.inspect', 'browser.navigate', 'browser.click', 'browser.type', 'browser.download'],
  configuredScopes: [{
    family: 'browser',
    operations: ['browser.inspect', 'browser.navigate', 'browser.click', 'browser.type', 'browser.download'],
    origins: ['https://docs.example.com'],
    downloadRoots: [DOWNLOAD_ROOT],
  }],
  registeredAt: NOW,
};

const inspectOnlyWorker: WorkerRegistration = {
  ...browserWorker,
  supportedActions: ['browser.inspect'],
  configuredScopes: [{
    family: 'browser',
    operations: ['browser.inspect'],
    origins: ['https://docs.example.com'],
    downloadRoots: [DOWNLOAD_ROOT],
  }],
};

const connectorWorker: WorkerRegistration = {
  id: 'worker.connector.mail',
  family: 'connector',
  availability: 'available',
  supportedActions: ['connector.read', 'connector.draft', 'connector.send'],
  configuredScopes: [{
    family: 'connector',
    operations: ['connector.read', 'connector.draft', 'connector.send'],
    connectorId: 'mail.primary',
    resourceRoots: ['mailbox/team'],
  }],
  registeredAt: NOW,
};

const desktopWorker: WorkerRegistration = {
  id: 'worker.desktop.uia',
  family: 'desktop',
  availability: 'available',
  supportedActions: ['desktop.discover', 'desktop.inspect'],
  configuredScopes: [{
    family: 'desktop',
    operations: ['desktop.discover', 'desktop.inspect'],
    appId: 'windows.notepad',
  }],
  registeredAt: NOW,
};

describe('browser vocabulary', () => {
  it('plans navigate inside configured origins', () => {
    const result = validateAgentPlan(
      { targets: ['https://docs.example.com/a'], action: 'navigate' },
      spawn(), browserWorker, 10,
    );
    expect(result.ok).toBe(true);
    expect(result.action).toBe('navigate');
  });

  it('requires a staged artifact to type, and offers no field for a model-supplied hash', () => {
    // The model names content; it never authors it or vouches for it.
    const missing = validateAgentPlan(
      { targets: ['https://docs.example.com/a'], action: 'type', selector: '#field' },
      spawn(), browserWorker, 10,
    );
    expect(missing.ok).toBe(false);
    expect(missing.reason).toContain('staged payload artifact id');

    const traversal = validateAgentPlan(
      {
        targets: ['https://docs.example.com/a'], action: 'type', selector: '#field',
        payloadArtifactId: '../../etc/passwd',
      },
      spawn(), browserWorker, 10,
    );
    expect(traversal.ok).toBe(false);
    expect(traversal.reason).toContain('malformed payload artifact id');

    const good = validateAgentPlan(
      {
        targets: ['https://docs.example.com/a'], action: 'type', selector: '#field',
        payloadArtifactId: 'artifact_abc123',
      },
      spawn(), browserWorker, 10,
    );
    expect(good.ok).toBe(true);
    expect(good.payloadArtifactId).toBe('artifact_abc123');
    expect((good as unknown as Record<string, unknown>).payloadHash).toBeUndefined();
  });

  it('confines a download to a configured root and a bare file name', () => {
    const escaped = validateAgentPlan(
      {
        targets: ['https://docs.example.com/a'], action: 'download',
        downloadRoot: 'C:\\Windows\\System32', fileName: 'report.pdf',
      },
      spawn(), browserWorker, 10,
    );
    expect(escaped.ok).toBe(false);
    expect(escaped.reason).toContain('outside the configured roots');

    const traversal = validateAgentPlan(
      {
        targets: ['https://docs.example.com/a'], action: 'download',
        downloadRoot: DOWNLOAD_ROOT, fileName: '../../evil.exe',
      },
      spawn(), browserWorker, 10,
    );
    expect(traversal.ok).toBe(false);
    expect(traversal.reason).toContain('containing a path');

    const good = validateAgentPlan(
      {
        targets: ['https://docs.example.com/a'], action: 'download',
        downloadRoot: DOWNLOAD_ROOT, fileName: 'report.pdf',
      },
      spawn(), browserWorker, 10,
    );
    expect(good.ok).toBe(true);
    expect(good.fileName).toBe('report.pdf');
  });

  it('refuses an action the worker does not support, whatever the scope allows', () => {
    const result = validateAgentPlan(
      {
        targets: ['https://docs.example.com/a'], action: 'download',
        downloadRoot: DOWNLOAD_ROOT, fileName: 'x.pdf',
      },
      spawn(), inspectOnlyWorker, 10,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('does not support browser.download');
  });
});

describe('connector vocabulary', () => {
  it('refuses a connector outside the configured scope', () => {
    const result = validateAgentPlan(
      { targets: ['mailbox/team/a'], action: 'connector.read', connectorId: 'other.mail' },
      spawn(), connectorWorker, 10,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('outside the configured scope');
  });

  it('discards resources outside the configured roots and reports them', () => {
    const result = validateAgentPlan(
      {
        targets: ['mailbox/team/ok', 'mailbox/private/secret'],
        action: 'connector.read', connectorId: 'mail.primary',
      },
      spawn(), connectorWorker, 10,
    );
    expect(result.ok).toBe(true);
    expect(result.targets).toEqual(['mailbox/team/ok']);
    expect(result.rejected).toEqual([
      { value: 'mailbox/private/secret', reasonCode: 'resource_not_configured' },
    ]);
  });

  it('requires staged content to draft, but permits a bodyless send', () => {
    const draft = validateAgentPlan(
      { targets: ['mailbox/team/a'], action: 'connector.draft', connectorId: 'mail.primary' },
      spawn(), connectorWorker, 10,
    );
    expect(draft.ok).toBe(false);
    expect(draft.reason).toContain('staged payload artifact id');

    // A forward carries no new body, so it needs no artifact.
    const forward = validateAgentPlan(
      { targets: ['mailbox/team/a'], action: 'connector.send', connectorId: 'mail.primary' },
      spawn(), connectorWorker, 10,
    );
    expect(forward.ok).toBe(true);
  });

  it('fails when every proposed resource is outside the roots', () => {
    const result = validateAgentPlan(
      { targets: ['mailbox/private/a'], action: 'connector.read', connectorId: 'mail.primary' },
      spawn(), connectorWorker, 10,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('No proposed resource fell inside a root');
  });
});

describe('desktop vocabulary', () => {
  it('refuses any action needing a live window snapshot', () => {
    // A treeRevision is valid only for the snapshot it came from. A planned one
    // is either stale, or matches a window that has since changed underneath it.
    for (const action of ['desktop.inspect', 'desktop.click', 'desktop.type', 'desktop.shortcut']) {
      const result = validateAgentPlan({ targets: ['x'], action }, spawn(), desktopWorker, 10);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('cannot be planned ahead');
    }
  });

  it('plans discovery only for a configured application', () => {
    const foreign = validateAgentPlan(
      { targets: [], action: 'desktop.discover', appId: 'windows.cmd' },
      spawn(), desktopWorker, 10,
    );
    expect(foreign.ok).toBe(false);
    expect(foreign.reason).toContain('outside the configured desktop scope');

    const good = validateAgentPlan(
      { targets: [], action: 'desktop.discover', appId: 'windows.notepad' },
      spawn(), desktopWorker, 10,
    );
    expect(good.ok).toBe(true);
    expect(good.appId).toBe('windows.notepad');
  });
});

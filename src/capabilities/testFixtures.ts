import {
  ActionIntent,
  BrowserCapabilityScope,
  WorkerRegistration,
} from './types';

export const browserScope: BrowserCapabilityScope = {
  family: 'browser',
  operations: ['browser.inspect', 'browser.navigate', 'browser.download'],
  origins: ['https://example.com'],
  downloadRoots: ['C:\\AgentDownloads'],
};

export const browserWorker: WorkerRegistration = {
  id: 'worker.browser.local',
  family: 'browser',
  availability: 'available',
  supportedActions: ['browser.inspect', 'browser.navigate', 'browser.download'],
  configuredScopes: [browserScope],
  registeredAt: '2026-07-12T00:00:00.000Z',
};

export const browserIntent = (overrides: Partial<ActionIntent> = {}): ActionIntent => ({
  schemaVersion: 1,
  id: 'intent_browser_1',
  goalId: 'goal_1',
  taskId: 'task_1',
  workerId: browserWorker.id,
  riskLevel: 'L0',
  action: {
    type: 'browser.inspect',
    origin: 'https://example.com',
    url: 'https://example.com/account',
  },
  scope: browserScope,
  authority: { kind: 'user_request', referenceId: 'request_1' },
  untrustedObservationIds: [],
  createdAt: '2026-07-12T00:01:00.000Z',
  ...overrides,
});

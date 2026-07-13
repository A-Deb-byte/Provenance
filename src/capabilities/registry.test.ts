import { describe, expect, it } from 'vitest';
import { browserWorker } from './testFixtures';
import { createWorkerRegistry } from './registry';

describe('worker registry', () => {
  it('reports available, configured, and unavailable workers separately', () => {
    const registry = createWorkerRegistry([
      browserWorker,
      { ...browserWorker, id: 'worker.browser.configured', availability: 'configured' },
      { ...browserWorker, id: 'worker.browser.missing', availability: 'unavailable', unavailableReason: 'Executable missing.' },
    ]);
    expect(registry.report()).toEqual({
      available: ['worker.browser.local'],
      configured: ['worker.browser.configured'],
      unavailable: [{ id: 'worker.browser.missing', reason: 'Executable missing.' }],
    });
  });

  it('rejects duplicate worker ids and protects registry snapshots from mutation', () => {
    expect(() => createWorkerRegistry([browserWorker, browserWorker])).toThrow('Duplicate');
    const registry = createWorkerRegistry([browserWorker]);
    const found = registry.get(browserWorker.id)!;
    found.supportedActions.length = 0;
    expect(registry.get(browserWorker.id)?.supportedActions).toContain('browser.inspect');
  });

  it('rejects actions that do not belong to the worker family', () => {
    expect(() => createWorkerRegistry([{
      ...browserWorker,
      supportedActions: ['connector.send'],
    }])).toThrow('Invalid worker');
  });
});

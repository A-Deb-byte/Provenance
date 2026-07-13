import { describe, expect, it } from 'vitest';
import { browserIntent } from './testFixtures';
import { validateAutomationContract } from './automation';
import { AutomationContract } from './types';

const contract = (): AutomationContract => {
  const intent = browserIntent();
  return {
    schemaVersion: 1,
    id: 'automation_1',
    name: 'Inspect account page',
    enabled: true,
    goalId: intent.goalId,
    workerId: intent.workerId,
    riskLevel: intent.riskLevel,
    action: intent.action,
    scope: intent.scope,
    trigger: { type: 'interval', everyMinutes: 60, startsAt: '2026-07-12T01:00:00.000Z' },
    approvalMode: 'per_run',
    budget: { maxRuns: 10, maxConsecutiveFailures: 2, maxRuntimeMsPerRun: 30000 },
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  };
};

describe('automation contract schema', () => {
  it('accepts a bounded action contract with an exact scope', () => {
    expect(validateAutomationContract(contract())).toEqual({ valid: true, errors: [] });
  });

  it('rejects L4, consequential preapproval, invalid scope, and unbounded budgets', () => {
    expect(validateAutomationContract({ ...contract(), riskLevel: 'L4' }).valid).toBe(false);
    expect(validateAutomationContract({ ...contract(), riskLevel: 'L3', approvalMode: 'preapproved_l2' }).errors)
      .toContain('L3 automations require approval for every run.');
    expect(validateAutomationContract({
      ...contract(),
      action: { type: 'browser.inspect', origin: 'https://evil.example', url: 'https://evil.example/' },
    }).errors).toContain('Automation action is outside its declared scope.');
    expect(validateAutomationContract({
      ...contract(), budget: { ...contract().budget, maxRuns: 0 },
    }).valid).toBe(false);
  });
});

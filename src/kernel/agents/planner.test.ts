import { describe, expect, it } from 'vitest';
import {
  buildPlannerPrompt,
  configuredOrigins,
  parseProposedPlan,
  validateAgentPlan,
} from './planner';
import type { AgentSpawn } from './types';
import type { WorkerRegistration } from '../../capabilities/types';

const NOW = '2026-08-16T12:00:00.000Z';

const worker: WorkerRegistration = {
  id: 'worker.browser.playwright',
  family: 'browser',
  availability: 'available',
  supportedActions: ['browser.inspect', 'browser.click'],
  configuredScopes: [{
    family: 'browser',
    operations: ['browser.inspect', 'browser.click'],
    origins: ['https://docs.example.com', 'https://api.example.com'],
    downloadRoots: [],
  }],
  registeredAt: NOW,
};

const readOnlyWorker: WorkerRegistration = {
  ...worker,
  supportedActions: ['browser.inspect'],
  configuredScopes: [{
    family: 'browser',
    operations: ['browser.inspect'],
    origins: ['https://docs.example.com', 'https://api.example.com'],
    downloadRoots: [],
  }],
};

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
  objective: 'Review the API docs',
  budget: { maxOperations: 10, maxChildren: 3, maxDepth: 2, deadlineMs: 600_000 },
  operationsUsed: 0,
  childCount: 0,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

describe('model-proposed plan validation', () => {
  it('accepts targets inside configured origins and reports the plan', () => {
    const result = validateAgentPlan({
      targets: ['https://docs.example.com/a', 'https://api.example.com/v1'],
      action: 'inspect',
      rationale: 'Both pages describe the endpoint.',
    }, spawn(), worker, 10);

    expect(result.ok).toBe(true);
    expect(result.targets).toEqual(['https://docs.example.com/a', 'https://api.example.com/v1']);
    expect(result.action).toBe('inspect');
    expect(result.rejected).toEqual([]);
    expect(result.rationale).toBe('Both pages describe the endpoint.');
  });

  it('discards any origin the worker is not configured for', () => {
    // The containment rule. A model that hallucinates, or is steered by injected
    // page content, still cannot reach a new origin.
    const result = validateAgentPlan({
      targets: [
        'https://docs.example.com/keep',
        'https://evil.test/steal',
        'http://169.254.169.254/latest/meta-data',
      ],
      action: 'inspect',
    }, spawn(), worker, 10);

    expect(result.ok).toBe(true);
    expect(result.targets).toEqual(['https://docs.example.com/keep']);
    expect(result.rejected).toEqual([
      { value: 'https://evil.test/steal', reasonCode: 'origin_not_configured' },
      { value: 'http://169.254.169.254/latest/meta-data', reasonCode: 'origin_not_configured' },
    ]);
  });

  it('fails rather than succeeding emptily when every target is refused', () => {
    const result = validateAgentPlan({
      targets: ['https://evil.test/a', 'https://other.test/b'],
      action: 'inspect',
    }, spawn(), worker, 10);

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('No proposed target fell inside an origin');
    expect(result.targets).toEqual([]);
  });

  it('refuses malformed URLs, non-http schemes, and embedded credentials', () => {
    const result = validateAgentPlan({
      targets: [
        'https://docs.example.com/ok',
        'not-a-url',
        'file:///etc/passwd',
        'javascript:alert(1)',
        'https://user:pass@docs.example.com/x',
      ],
      action: 'inspect',
    }, spawn(), worker, 10);

    expect(result.targets).toEqual(['https://docs.example.com/ok']);
    expect(result.rejected.map((item) => item.reasonCode)).toEqual([
      'malformed_url', 'unsupported_scheme', 'unsupported_scheme', 'embedded_credentials',
    ]);
  });

  it('drops duplicates rather than spending budget twice on one target', () => {
    const result = validateAgentPlan({
      targets: ['https://docs.example.com/a', 'https://docs.example.com/a'],
      action: 'inspect',
    }, spawn(), worker, 10);

    expect(result.targets).toEqual(['https://docs.example.com/a']);
    expect(result.rejected).toEqual([{ value: 'https://docs.example.com/a', reasonCode: 'duplicate' }]);
  });

  it('truncates to the remaining operation budget and says how much it cut', () => {
    const result = validateAgentPlan({
      targets: ['https://docs.example.com/1', 'https://docs.example.com/2', 'https://docs.example.com/3'],
      action: 'inspect',
    }, spawn({ operationsUsed: 8 }), worker, 10);

    // 10 max - 8 used = 2 remaining.
    expect(result.targets).toHaveLength(2);
    expect(result.truncated).toBe(1);
    expect(result.reason).toContain('exceeded the remaining operation budget');
  });

  it('refuses an action the worker does not support', () => {
    const result = validateAgentPlan({
      targets: ['https://docs.example.com/a'], action: 'click', selector: '#go',
    }, spawn(), readOnlyWorker, 10);

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('does not support browser.click');
  });

  it('refuses an unrecognised action rather than defaulting to a safe one', () => {
    // Silently substituting `inspect` would let a malformed plan through as if
    // it had been understood.
    const result = validateAgentPlan({
      targets: ['https://docs.example.com/a'], action: 'browser.download',
    }, spawn(), worker, 10);

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('unrecognised action');
  });

  it('refuses a click with no usable selector', () => {
    for (const selector of [undefined, '', '   ', 42]) {
      const result = validateAgentPlan({
        targets: ['https://docs.example.com/a'], action: 'click', selector,
      }, spawn(), worker, 10);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('without a usable selector');
    }
  });

  it('refuses empty, oversized, and non-array target lists', () => {
    expect(validateAgentPlan({ targets: [] }, spawn(), worker, 10).ok).toBe(false);
    expect(validateAgentPlan({ targets: 'https://docs.example.com/a' }, spawn(), worker, 10).ok).toBe(false);
    expect(validateAgentPlan({}, spawn(), worker, 10).ok).toBe(false);
    expect(validateAgentPlan({
      targets: Array.from({ length: 101 }, (_, index) => `https://docs.example.com/${index}`),
    }, spawn(), worker, 10).ok).toBe(false);
  });

  it('refuses to plan for a worker with no configured origins', () => {
    const unscoped = { ...worker, configuredScopes: [] };
    const result = validateAgentPlan({ targets: ['https://docs.example.com/a'] }, spawn(), unscoped, 10);

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('no configured browser origins');
  });

  it('does not carry an over-long rationale into evidence', () => {
    const result = validateAgentPlan({
      targets: ['https://docs.example.com/a'],
      rationale: 'x'.repeat(5_000),
    }, spawn(), worker, 10);

    expect(result.ok).toBe(true);
    expect(result.rationale).toBeUndefined();
  });
});

describe('planner response parsing', () => {
  it('parses a JSON object and rejects anything else', () => {
    expect(parseProposedPlan('{"targets":["https://a.test"]}')).toEqual({ targets: ['https://a.test'] });
    expect(parseProposedPlan('not json')).toBeUndefined();
    expect(parseProposedPlan('[1,2,3]')).toBeUndefined();
    expect(parseProposedPlan('null')).toBeUndefined();
    expect(parseProposedPlan('"a string"')).toBeUndefined();
  });
});

describe('planner prompt', () => {
  it('tells the model exactly which origins it may select from', () => {
    const prompt = buildPlannerPrompt(spawn({ operationsUsed: 3 }), worker);

    expect(prompt.user).toContain('https://docs.example.com, https://api.example.com');
    expect(prompt.user).toContain('Maximum targets: 7');
    expect(prompt.user).toContain('Review the API docs');
    // Stated to the model as guidance; enforcement does not depend on it.
    expect(prompt.system).toContain('discarded by the kernel');
  });

  it('reports configured origins across every browser scope', () => {
    expect(configuredOrigins(worker)).toEqual(['https://docs.example.com', 'https://api.example.com']);
    expect(configuredOrigins({ ...worker, configuredScopes: [] })).toEqual([]);
  });
});

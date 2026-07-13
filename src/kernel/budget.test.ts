import { describe, expect, it } from 'vitest';
import { createEmptyUsage, reserveBudget } from './budget';

describe('kernel budget', () => {
  const budget = {
    maxOperations: 2,
    maxCommandRuntimeMs: 1000,
    maxApprovals: 1,
    maxProviderCalls: 0,
  };

  it('reserves budget until exhausted', () => {
    const first = reserveBudget(budget, createEmptyUsage(), { operations: 1 });
    expect(first.allowed).toBe(true);
    const second = reserveBudget(budget, first.usage, { operations: 2 });
    expect(second.allowed).toBe(false);
  });

  it('rejects negative or non-finite reservations', () => {
    expect(reserveBudget(budget, createEmptyUsage(), { operations: -1 }).allowed).toBe(false);
    expect(reserveBudget(budget, createEmptyUsage(), { commandRuntimeMs: Number.NaN }).allowed).toBe(false);
  });
});

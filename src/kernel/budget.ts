import { BudgetUsage, KernelBudget } from './types';

export const createEmptyUsage = (): BudgetUsage => ({
  operations: 0,
  commandRuntimeMs: 0,
  approvals: 0,
  providerCalls: 0,
});

export const reserveBudget = (
  budget: KernelBudget,
  usage: BudgetUsage,
  delta: Partial<BudgetUsage>,
): { allowed: boolean; reason: string; usage: BudgetUsage } => {
  if (Object.values(delta).some((value) => value !== undefined && (!Number.isFinite(value) || value < 0))) {
    return { allowed: false, reason: 'Budget reservation must be finite and non-negative.', usage };
  }

  const next = {
    operations: usage.operations + (delta.operations ?? 0),
    commandRuntimeMs: usage.commandRuntimeMs + (delta.commandRuntimeMs ?? 0),
    approvals: usage.approvals + (delta.approvals ?? 0),
    providerCalls: usage.providerCalls + (delta.providerCalls ?? 0),
  };

  if (next.operations > budget.maxOperations) return { allowed: false, reason: 'Operation budget exceeded.', usage };
  if (next.commandRuntimeMs > budget.maxCommandRuntimeMs) return { allowed: false, reason: 'Command runtime budget exceeded.', usage };
  if (next.approvals > budget.maxApprovals) return { allowed: false, reason: 'Approval budget exceeded.', usage };
  if (next.providerCalls > budget.maxProviderCalls) return { allowed: false, reason: 'Provider call budget exceeded.', usage };
  return { allowed: true, reason: 'Budget reserved.', usage: next };
};

import type { AgentDefinition, AgentSpawn } from './types';
import { TIER_MAY_SPAWN } from './types';

/**
 * Decomposition for a T3 orchestrator.
 *
 * The split is deterministic: one child per target, in order, capped by the
 * parent's own child budget. A model may later produce the target list, but the
 * fan-out itself stays mechanical so the resulting tree is reproducible from
 * the ledger rather than dependent on a sampling temperature.
 */

export interface ChildPlan {
  objective: string;
  targets: string[];
}

export interface DecompositionPlan {
  ok: boolean;
  reason: string;
  children: ChildPlan[];
  /** Targets dropped because the parent's child budget could not cover them. */
  deferred: string[];
}

export interface DecomposeInput {
  parent: AgentSpawn;
  childDefinition: AgentDefinition;
  /** Targets to distribute; defaults to the parent's own. */
  targets?: string[];
  /** Children per batch. One target each keeps failures isolated. */
  targetsPerChild?: number;
}

export const decomposeObjective = (input: DecomposeInput): DecompositionPlan => {
  const { parent, childDefinition } = input;
  if (!TIER_MAY_SPAWN[parent.tier]) {
    return { ok: false, reason: `Tier ${parent.tier} may not decompose work.`, children: [], deferred: [] };
  }
  if (parent.status !== 'running') {
    return { ok: false, reason: 'Only a running orchestrator may decompose work.', children: [], deferred: [] };
  }
  if (TIER_MAY_SPAWN[childDefinition.tier]) {
    // Permitting orchestrators to spawn orchestrators is how a bounded tree
    // becomes an unbounded one; depth caps alone are a fragile defence.
    return { ok: false, reason: 'An orchestrator may not spawn another orchestrator.', children: [], deferred: [] };
  }

  const targets = (input.targets ?? parent.targets ?? []).filter((value) => value.trim().length > 0);
  if (targets.length === 0) {
    return { ok: false, reason: 'Decomposition requires at least one target.', children: [], deferred: [] };
  }

  const perChild = Math.max(1, input.targetsPerChild ?? 1);
  const remainingChildBudget = Math.max(0, parent.budget.maxChildren - parent.childCount);
  if (remainingChildBudget === 0) {
    return { ok: false, reason: 'Orchestrator has exhausted its child budget.', children: [], deferred: targets };
  }

  const children: ChildPlan[] = [];
  let cursor = 0;
  while (cursor < targets.length && children.length < remainingChildBudget) {
    const slice = targets.slice(cursor, cursor + perChild);
    children.push({
      objective: `${parent.objective} — part ${children.length + 1}`,
      targets: slice,
    });
    cursor += slice.length;
  }

  // Deferred rather than silently dropped: the caller ledgers what was not
  // covered, so a partial fan-out is never mistaken for a complete one.
  const deferred = targets.slice(cursor);
  return {
    ok: true,
    reason: deferred.length > 0
      ? `Planned ${children.length} children; ${deferred.length} target(s) exceed the child budget.`
      : `Planned ${children.length} children covering every target.`,
    children,
    deferred,
  };
};

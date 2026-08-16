import path from 'node:path';
import type { CapabilityScope, WorkerRegistration } from '../../capabilities/types';
import type { AgentSpawn } from './types';

/**
 * Model-driven planning.
 *
 * A model may *propose* what an agent should work on. It gains no authority by
 * doing so: everything it returns is untrusted data, validated deterministically
 * against bounds the model cannot see or influence.
 *
 * The rule that generalises across every action type: **a model may only select
 * identifiers the kernel already knows, never mint one.** Origins, download
 * roots, connectors, and resource roots must already appear in the worker's
 * configured scope; payload content is referenced by a staged artifact id whose
 * hash the *kernel* computes. A model can therefore reorder and choose, but
 * cannot introduce a destination or author the bytes that get sent.
 */

export type PlannedAction =
  | 'inspect'
  | 'navigate'
  | 'click'
  | 'type'
  | 'download'
  | 'desktop.discover'
  | 'connector.read'
  | 'connector.draft'
  | 'connector.send'
  | 'connector.delete';

const BROWSER_ACTIONS: Record<string, string> = {
  inspect: 'browser.inspect',
  navigate: 'browser.navigate',
  click: 'browser.click',
  type: 'browser.type',
  download: 'browser.download',
};

const CONNECTOR_ACTIONS = new Set([
  'connector.read', 'connector.draft', 'connector.send', 'connector.delete',
]);

/**
 * Actions requiring a live window snapshot are deliberately unplannable.
 *
 * `desktop.click` and friends carry a `treeRevision` that is only valid for the
 * snapshot it came from. A model cannot know one, and a stale one would either
 * be refused at dispatch or -- worse -- match a window that has since changed.
 * Discovery is plannable; acting on a window is not.
 */
const WINDOW_BOUND_DESKTOP = new Set([
  'desktop.inspect', 'desktop.click', 'desktop.type', 'desktop.shortcut',
]);

export const ALL_PLANNED_ACTIONS: PlannedAction[] = [
  'inspect', 'navigate', 'click', 'type', 'download',
  'desktop.discover', 'connector.read', 'connector.draft', 'connector.send', 'connector.delete',
];

/** The capability action a planned action maps to. */
export const capabilityActionFor = (action: PlannedAction): string =>
  BROWSER_ACTIONS[action] ?? action;

/** Shape a model is asked to return. Nothing here is trusted. */
export interface ProposedAgentPlan {
  targets?: unknown;
  action?: unknown;
  selector?: unknown;
  /** Reference to already-staged content. The model never supplies a hash. */
  payloadArtifactId?: unknown;
  downloadRoot?: unknown;
  fileName?: unknown;
  connectorId?: unknown;
  appId?: unknown;
  rationale?: unknown;
}

export interface RejectedTarget {
  value: string;
  reasonCode:
    | 'malformed_url'
    | 'unsupported_scheme'
    | 'embedded_credentials'
    | 'origin_not_configured'
    | 'resource_not_configured'
    | 'duplicate';
}

export interface AgentPlanValidation {
  ok: boolean;
  reason: string;
  targets: string[];
  action: PlannedAction;
  selector?: string;
  payloadArtifactId?: string;
  downloadRoot?: string;
  fileName?: string;
  connectorId?: string;
  appId?: string;
  rejected: RejectedTarget[];
  truncated: number;
  rationale?: string;
}

const MAX_RATIONALE_CHARS = 500;
const MAX_SELECTOR_CHARS = 200;
const MAX_PROPOSED_TARGETS = 100;
const ARTIFACT_ID = /^artifact_[A-Za-z0-9_-]{1,64}$/u;

const browserScopes = (worker: WorkerRegistration) =>
  worker.configuredScopes.filter(
    (scope): scope is Extract<CapabilityScope, { family: 'browser' }> => scope.family === 'browser',
  );

const connectorScopes = (worker: WorkerRegistration) =>
  worker.configuredScopes.filter(
    (scope): scope is Extract<CapabilityScope, { family: 'connector' }> => scope.family === 'connector',
  );

const desktopScopes = (worker: WorkerRegistration) =>
  worker.configuredScopes.filter(
    (scope): scope is Extract<CapabilityScope, { family: 'desktop' }> => scope.family === 'desktop',
  );

export const configuredOrigins = (worker: WorkerRegistration): string[] =>
  browserScopes(worker).flatMap((scope) => scope.origins);

export const configuredDownloadRoots = (worker: WorkerRegistration): string[] =>
  browserScopes(worker).flatMap((scope) => scope.downloadRoots);

const originOf = (url: string): { origin?: string; reasonCode?: RejectedTarget['reasonCode'] } => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { reasonCode: 'malformed_url' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return { reasonCode: 'unsupported_scheme' };
  if (parsed.username || parsed.password) return { reasonCode: 'embedded_credentials' };
  return { origin: parsed.origin };
};

const asText = (value: unknown, max: number): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : undefined;
};

const resourceWithinRoot = (resource: string, root: string): boolean =>
  resource === root || resource.startsWith(`${root}/`);

export const validateAgentPlan = (
  proposal: ProposedAgentPlan,
  spawn: AgentSpawn,
  worker: WorkerRegistration,
  remainingOperations: number,
): AgentPlanValidation => {
  const rejected: RejectedTarget[] = [];
  const fail = (reason: string): AgentPlanValidation =>
    ({ ok: false, reason, targets: [], action: 'inspect', rejected, truncated: 0 });

  const requested = proposal.action === undefined ? 'inspect' : proposal.action;
  if (typeof requested !== 'string') return fail('Planner proposed an unrecognised action.');
  if (WINDOW_BOUND_DESKTOP.has(requested)) {
    return fail(
      `${requested} needs a live window snapshot and cannot be planned ahead; discover the window first.`,
    );
  }
  if (!ALL_PLANNED_ACTIONS.includes(requested as PlannedAction)) {
    return fail('Planner proposed an unrecognised action.');
  }
  const action = requested as PlannedAction;

  const capabilityAction = capabilityActionFor(action);
  if (!worker.supportedActions.includes(capabilityAction as never)) {
    return fail(`Agent worker does not support ${capabilityAction}.`);
  }

  // --- desktop.discover: appId must already be configured -------------------
  if (action === 'desktop.discover') {
    const scopes = desktopScopes(worker);
    if (scopes.length === 0) return fail('Agent worker has no configured desktop scope to plan within.');
    const appId = asText(proposal.appId, 200);
    if (!appId) return fail('Desktop discovery requires an appId.');
    if (!scopes.some((scope) => scope.appId === appId)) {
      return fail('Planner proposed an application outside the configured desktop scope.');
    }
    return {
      ok: true, reason: `Planned discovery of ${appId}.`, targets: [appId], action, appId,
      rejected, truncated: 0, rationale: asText(proposal.rationale, MAX_RATIONALE_CHARS),
    };
  }

  // --- connector.*: connector and resource roots must already be configured --
  if (CONNECTOR_ACTIONS.has(action)) {
    const scopes = connectorScopes(worker);
    if (scopes.length === 0) return fail('Agent worker has no configured connector scope to plan within.');
    const connectorId = asText(proposal.connectorId, 200);
    if (!connectorId) return fail('Connector actions require a connectorId.');
    const scope = scopes.find((candidate) => candidate.connectorId === connectorId);
    if (!scope) return fail('Planner proposed a connector outside the configured scope.');

    if (!Array.isArray(proposal.targets) || proposal.targets.length === 0) {
      return fail('Planner returned no targets.');
    }
    if (proposal.targets.length > MAX_PROPOSED_TARGETS) {
      return fail(`Planner returned more than ${MAX_PROPOSED_TARGETS} targets.`);
    }

    const accepted: string[] = [];
    const seen = new Set<string>();
    for (const candidate of proposal.targets) {
      const value = asText(candidate, 1024);
      if (!value) {
        rejected.push({ value: String(candidate).slice(0, 120), reasonCode: 'malformed_url' });
        continue;
      }
      if (seen.has(value)) {
        rejected.push({ value, reasonCode: 'duplicate' });
        continue;
      }
      seen.add(value);
      if (!scope.resourceRoots.some((root) => resourceWithinRoot(value, root))) {
        rejected.push({ value, reasonCode: 'resource_not_configured' });
        continue;
      }
      accepted.push(value);
    }
    if (accepted.length === 0) {
      return fail('No proposed resource fell inside a root configured for this agent.');
    }

    // Outbound content is referenced, never authored: the model names a staged
    // artifact and the kernel resolves its hash.
    let payloadArtifactId: string | undefined;
    if (action === 'connector.draft' || action === 'connector.send') {
      payloadArtifactId = asText(proposal.payloadArtifactId, 128);
      if (action === 'connector.draft' && !payloadArtifactId) {
        return fail('Drafting requires a staged payload artifact id.');
      }
      if (payloadArtifactId && !ARTIFACT_ID.test(payloadArtifactId)) {
        return fail('Planner proposed a malformed payload artifact id.');
      }
    }

    const budget = Math.max(0, Math.min(remainingOperations, spawn.budget.maxOperations - spawn.operationsUsed));
    const targets = accepted.slice(0, budget);
    if (targets.length === 0) return fail('The agent has no remaining operation budget for a plan.');
    const truncated = accepted.length - targets.length;
    return {
      ok: true,
      reason: truncated > 0
        ? `Planned ${targets.length} resource(s); ${truncated} exceeded the remaining operation budget.`
        : `Planned ${targets.length} resource(s).`,
      targets, action, connectorId, payloadArtifactId, rejected, truncated,
      rationale: asText(proposal.rationale, MAX_RATIONALE_CHARS),
    };
  }

  // --- browser.*: origins must already be configured -------------------------
  const selector = asText(proposal.selector, MAX_SELECTOR_CHARS);
  if ((action === 'click' || action === 'type') && !selector) {
    return fail(`Planner proposed a ${action} without a usable selector.`);
  }

  let payloadArtifactId: string | undefined;
  if (action === 'type') {
    payloadArtifactId = asText(proposal.payloadArtifactId, 128);
    if (!payloadArtifactId) return fail('Typing requires a staged payload artifact id.');
    if (!ARTIFACT_ID.test(payloadArtifactId)) {
      return fail('Planner proposed a malformed payload artifact id.');
    }
  }

  let downloadRoot: string | undefined;
  let fileName: string | undefined;
  if (action === 'download') {
    downloadRoot = asText(proposal.downloadRoot, 512);
    fileName = asText(proposal.fileName, 255);
    if (!downloadRoot || !fileName) return fail('Downloading requires a download root and a file name.');
    const roots = configuredDownloadRoots(worker);
    if (!roots.some((root) => path.resolve(root) === path.resolve(downloadRoot as string))) {
      return fail('Planner proposed a download root outside the configured roots.');
    }
    // A basename, not a path: `../../etc/passwd` must not survive as a name.
    if (path.basename(fileName) !== fileName) {
      return fail('Planner proposed a file name containing a path.');
    }
  }

  if (!Array.isArray(proposal.targets) || proposal.targets.length === 0) {
    return fail('Planner returned no targets.');
  }
  if (proposal.targets.length > MAX_PROPOSED_TARGETS) {
    return fail(`Planner returned more than ${MAX_PROPOSED_TARGETS} targets.`);
  }

  const allowedOrigins = new Set(configuredOrigins(worker));
  if (allowedOrigins.size === 0) return fail('Agent worker has no configured browser origins to plan within.');

  const accepted: string[] = [];
  const seen = new Set<string>();
  for (const candidate of proposal.targets) {
    const value = asText(candidate, 2048);
    if (!value) {
      rejected.push({ value: String(candidate).slice(0, 120), reasonCode: 'malformed_url' });
      continue;
    }
    if (seen.has(value)) {
      rejected.push({ value, reasonCode: 'duplicate' });
      continue;
    }
    seen.add(value);
    const { origin, reasonCode } = originOf(value);
    if (!origin) {
      rejected.push({ value, reasonCode: reasonCode ?? 'malformed_url' });
      continue;
    }
    if (!allowedOrigins.has(origin)) {
      rejected.push({ value, reasonCode: 'origin_not_configured' });
      continue;
    }
    accepted.push(value);
  }

  if (accepted.length === 0) {
    return fail('No proposed target fell inside an origin configured for this agent.');
  }

  const budget = Math.max(0, Math.min(remainingOperations, spawn.budget.maxOperations - spawn.operationsUsed));
  const targets = accepted.slice(0, budget);
  const truncated = accepted.length - targets.length;
  if (targets.length === 0) return fail('The agent has no remaining operation budget for a plan.');

  return {
    ok: true,
    reason: truncated > 0
      ? `Planned ${targets.length} target(s); ${truncated} exceeded the remaining operation budget.`
      : `Planned ${targets.length} target(s).`,
    targets, action, selector, payloadArtifactId, downloadRoot, fileName,
    rejected, truncated, rationale: asText(proposal.rationale, MAX_RATIONALE_CHARS),
  };
};

/** Parses a model response body into a proposal shape. Never throws. */
export const parseProposedPlan = (content: string): ProposedAgentPlan | undefined => {
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as ProposedAgentPlan;
  } catch {
    return undefined;
  }
};

/**
 * The planning prompt.
 *
 * Candidates are supplied so the model selects rather than invents, and it is
 * told plainly that anything outside them is discarded. That is usability, not
 * security -- validation enforces it whether or not the model cooperates.
 */
export const buildPlannerPrompt = (
  spawn: AgentSpawn,
  worker: WorkerRegistration,
): { system: string; user: string } => {
  const supported = worker.supportedActions.join(', ');
  return {
    system: [
      'You plan work for a bounded automation agent.',
      'Return ONLY a JSON object with: targets (array), action, and any fields the action needs.',
      'Actions: inspect, navigate, click, type, download, desktop.discover, connector.read,',
      'connector.draft, connector.send, connector.delete.',
      'click and type need "selector". type, connector.draft and connector.send need',
      '"payloadArtifactId" referring to already-staged content -- you never supply content or hashes.',
      'download needs "downloadRoot" (from the permitted roots) and a bare "fileName".',
      'connector actions need "connectorId". desktop.discover needs "appId".',
      'Every destination must come from the permitted lists below; anything else is discarded.',
      'Desktop actions on a window (inspect, click, type, shortcut) cannot be planned ahead.',
      'Do not include credentials in URLs. Do not invent origins, connectors, or roots.',
    ].join('\n'),
    user: [
      `Objective: ${spawn.objective}`,
      `Agent domain: ${spawn.domain}`,
      `Worker supports: ${supported || '(none)'}`,
      `Permitted origins: ${configuredOrigins(worker).join(', ') || '(none)'}`,
      `Permitted download roots: ${configuredDownloadRoots(worker).join(', ') || '(none)'}`,
      `Permitted connectors: ${connectorScopes(worker).map((scope) => scope.connectorId).join(', ') || '(none)'}`,
      `Permitted desktop apps: ${desktopScopes(worker).map((scope) => scope.appId).join(', ') || '(none)'}`,
      `Maximum targets: ${Math.max(0, spawn.budget.maxOperations - spawn.operationsUsed)}`,
    ].join('\n'),
  };
};

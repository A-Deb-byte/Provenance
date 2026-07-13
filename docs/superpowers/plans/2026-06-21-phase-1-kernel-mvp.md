# Phase 1 Kernel MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first trusted local kernel for goal contracts, task graphs, approvals, budgets, capability tokens, evidence events, and allowlisted local verification commands.

**Architecture:** Add a focused TypeScript kernel under `src/kernel/` and expose it through Express endpoints. Persist local kernel state to `.agent-kernel/` JSONL/state files, keep the React dashboard as a client of kernel state, and cover every authority boundary with Vitest tests.

**Tech Stack:** TypeScript 5.8, Express 4, React 19, Vite 6, Vitest, Node `fs/promises`, Node `crypto`, Node `child_process`.

---

## Scope Boundary

This plan implements Phase 1 from `docs/superpowers/specs/2026-06-21-phase-1-kernel-mvp-design.md`.

It does not implement desktop automation, browser automation, provider auto-routing, OS secret vault storage, SQLite, real skill installation, or autonomous core updates. Those depend on this kernel boundary.

Current repository note: `git rev-parse --is-inside-work-tree` currently returns `fatal: not a git repository`. Commit steps are included as workflow checkpoints. In this workspace they should be treated as checkpoints unless git is initialized before execution begins.

## File Structure

- Modify: `.gitignore`
  - Ignore `.agent-kernel/` runtime state.
- Create: `src/kernel/types.ts`
  - Shared kernel domain types.
- Create: `src/kernel/ids.ts`
  - Deterministic id helpers for tests and runtime ids for production.
- Create: `src/kernel/guards.ts`
  - Runtime validation for API payloads and stored state.
- Create: `src/kernel/guards.test.ts`
  - Tests for goal, task, and command payload validation.
- Create: `src/kernel/ledger.ts`
  - Hash-chained JSONL event ledger.
- Create: `src/kernel/ledger.test.ts`
  - Event append, hash-chain, and replay tests.
- Create: `src/kernel/policy.ts`
  - Risk classification and allow/deny/approval policy decisions.
- Create: `src/kernel/policy.test.ts`
  - Policy tests for L0-L4 actions and command allowlist behavior.
- Create: `src/kernel/approvals.ts`
  - Approval record lifecycle.
- Create: `src/kernel/approvals.test.ts`
  - Approval creation, approval, denial, and expiry tests.
- Create: `src/kernel/budget.ts`
  - Operation/runtime/provider budget accounting.
- Create: `src/kernel/budget.test.ts`
  - Budget reservation and exhaustion tests.
- Create: `src/kernel/taskGraph.ts`
  - Goal-to-task graph creation and task transition helpers.
- Create: `src/kernel/taskGraph.test.ts`
  - Dependency and next-task selection tests.
- Create: `src/kernel/capabilities.ts`
  - Capability token creation and validation.
- Create: `src/kernel/capabilities.test.ts`
  - Scope, expiry, and operation limit tests.
- Create: `src/kernel/workers/commandWorker.ts`
  - Allowlisted local command execution worker.
- Create: `src/kernel/workers/commandWorker.test.ts`
  - Command allowlist, workspace containment, and evidence output tests.
- Create: `src/kernel/store.ts`
  - Kernel state snapshot persistence.
- Create: `src/kernel/store.test.ts`
  - State read/write fallback tests.
- Create: `src/kernel/kernel.ts`
  - Kernel service orchestration.
- Create: `src/kernel/kernel.test.ts`
  - End-to-end goal creation, step execution, event recording, and approval blocking tests.
- Create: `src/kernel/api.ts`
  - Express router for kernel endpoints.
- Create: `src/kernel/api.test.ts`
  - Handler tests using request/response fakes.
- Modify: `server.ts`
  - Mount the kernel router.
- Create: `src/components/KernelPanel.tsx`
  - Dashboard panel for goals, approvals, and evidence.
- Modify: `src/App.tsx`
  - Add the kernel panel entry point.
- Create: `src/components/KernelPanel.test.tsx`
  - UI smoke tests for kernel state rendering.
- Modify: `README.md`
  - Document Kernel MVP commands and limitations.

---

### Task 1: Add Kernel Runtime Ignore Rule

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Add runtime state ignore**

Add this line to `.gitignore`:

```gitignore
.agent-kernel/
```

- [ ] **Step 2: Verify ignore entry**

Run:

```powershell
rg -n "^\\.agent-kernel/$" .gitignore
```

Expected: one match.

- [ ] **Step 3: Checkpoint**

Run:

```powershell
git rev-parse --is-inside-work-tree
```

Expected in the current workspace: `fatal: not a git repository`.

---

### Task 2: Define Kernel Domain Types And Guards

**Files:**
- Create: `src/kernel/types.ts`
- Create: `src/kernel/ids.ts`
- Create: `src/kernel/guards.ts`
- Create: `src/kernel/guards.test.ts`

- [ ] **Step 1: Write failing guard tests**

Create `src/kernel/guards.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isGoalContractInput, isKernelCommandRequest, isRiskLevel } from './guards';

describe('kernel guards', () => {
  it('accepts a valid goal contract input', () => {
    expect(isGoalContractInput({
      objective: 'Run project verification',
      successCriteria: ['Tests pass', 'Build passes'],
      constraints: ['Stay inside workspace'],
      autonomyLevel: 'supervised',
      workspaceRoot: 'C:/workspace/project',
      verificationCommands: ['npm test'],
      budget: {
        maxOperations: 8,
        maxCommandRuntimeMs: 120000,
        maxApprovals: 2,
        maxProviderCalls: 0,
      },
    })).toBe(true);
  });

  it('rejects vague or malformed goal input', () => {
    expect(isGoalContractInput({ objective: '', successCriteria: [] })).toBe(false);
    expect(isGoalContractInput({ objective: 'x', successCriteria: ['ok'], autonomyLevel: 'silent' })).toBe(false);
  });

  it('validates risk levels and command requests', () => {
    expect(isRiskLevel('L1')).toBe(true);
    expect(isRiskLevel('L9')).toBe(false);
    expect(isKernelCommandRequest({
      command: 'npm',
      args: ['test'],
      cwd: 'C:/workspace/project',
      expectedEvidence: 'Vitest passes',
    })).toBe(true);
    expect(isKernelCommandRequest({ command: 'rm', args: ['-rf', '.'] })).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
npx vitest run src/kernel/guards.test.ts
```

Expected: FAIL because kernel guard files do not exist.

- [ ] **Step 3: Create domain types**

Create `src/kernel/types.ts`:

```ts
export type AutonomyLevel = 'manual' | 'supervised' | 'bounded';
export type RiskLevel = 'L0' | 'L1' | 'L2' | 'L3' | 'L4';
export type KernelActor = 'user' | 'kernel' | 'worker' | 'provider' | 'system';

export type GoalStatus = 'drafted' | 'active' | 'blocked' | 'completed' | 'failed' | 'cancelled';
export type TaskStatus = 'pending' | 'ready' | 'running' | 'awaiting_approval' | 'passed' | 'failed' | 'blocked' | 'denied' | 'cancelled';
export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';
export type PolicyDecisionKind = 'allow' | 'deny' | 'approval_required';
export type CapabilityFamily = 'state.read' | 'state.write' | 'command.run' | 'provider.call' | 'approval.decide';

export interface KernelBudget {
  maxOperations: number;
  maxCommandRuntimeMs: number;
  maxApprovals: number;
  maxProviderCalls: number;
}

export interface BudgetUsage {
  operations: number;
  commandRuntimeMs: number;
  approvals: number;
  providerCalls: number;
}

export interface GoalContractInput {
  objective: string;
  successCriteria: string[];
  constraints: string[];
  autonomyLevel: AutonomyLevel;
  workspaceRoot: string;
  verificationCommands: string[];
  budget: KernelBudget;
}

export interface GoalContract extends GoalContractInput {
  id: string;
  status: GoalStatus;
  createdAt: string;
  updatedAt: string;
  usage: BudgetUsage;
}

export interface KernelTask {
  id: string;
  goalId: string;
  title: string;
  description: string;
  status: TaskStatus;
  riskLevel: RiskLevel;
  capabilityFamily: CapabilityFamily;
  dependsOn: string[];
  expectedEvidence: string;
  commandRequest?: KernelCommandRequest;
  approvalId?: string;
  evidenceEventIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface KernelCommandRequest {
  command: string;
  args: string[];
  cwd: string;
  expectedEvidence: string;
}

export interface KernelEvidence {
  kind: 'command_output' | 'state_change' | 'approval_decision' | 'policy_decision';
  summary: string;
  command?: string;
  exitCode?: number;
  durationMs?: number;
  stdout?: string;
  stderr?: string;
}

export interface KernelEvent {
  id: string;
  timestamp: string;
  actor: KernelActor;
  type: string;
  entityId: string;
  entityType: 'goal' | 'task' | 'approval' | 'capability' | 'budget' | 'worker' | 'system';
  payload: Record<string, unknown>;
  previousHash: string | null;
  hash: string;
}

export interface ApprovalRecord {
  id: string;
  goalId: string;
  taskId: string;
  status: ApprovalStatus;
  requestedAction: string;
  riskLevel: RiskLevel;
  reason: string;
  createdAt: string;
  updatedAt: string;
  decidedAt?: string;
  decisionReason?: string;
}

export interface PolicyDecision {
  kind: PolicyDecisionKind;
  riskLevel: RiskLevel;
  reason: string;
}

export interface CapabilityToken {
  id: string;
  family: CapabilityFamily;
  goalId: string;
  taskId: string;
  scope: {
    workspaceRoot: string;
    command?: string;
  };
  riskLevel: RiskLevel;
  expiresAt: string;
  maxOperations: number;
  usedOperations: number;
}

export interface KernelState {
  goals: GoalContract[];
  tasks: KernelTask[];
  approvals: ApprovalRecord[];
  lastEventHash: string | null;
}
```

- [ ] **Step 4: Create id helpers**

Create `src/kernel/ids.ts`:

```ts
import crypto from 'node:crypto';

export type IdPrefix = 'goal' | 'task' | 'event' | 'approval' | 'cap';

export const createKernelId = (prefix: IdPrefix): string => {
  return `${prefix}_${crypto.randomUUID()}`;
};
```

- [ ] **Step 5: Create guards**

Create `src/kernel/guards.ts`:

```ts
import { AutonomyLevel, GoalContractInput, KernelBudget, KernelCommandRequest, RiskLevel } from './types';

const riskLevels = new Set<RiskLevel>(['L0', 'L1', 'L2', 'L3', 'L4']);
const autonomyLevels = new Set<AutonomyLevel>(['manual', 'supervised', 'bounded']);
const allowedCommands = new Set(['npm']);
const allowedNpmScripts = new Set(['test', 'run lint', 'run build']);

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const isStringArray = (value: unknown): value is string[] => {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim().length > 0);
};

export const isRiskLevel = (value: unknown): value is RiskLevel => {
  return typeof value === 'string' && riskLevels.has(value as RiskLevel);
};

export const isKernelBudget = (value: unknown): value is KernelBudget => {
  if (!isRecord(value)) return false;
  return (
    typeof value.maxOperations === 'number' &&
    value.maxOperations > 0 &&
    typeof value.maxCommandRuntimeMs === 'number' &&
    value.maxCommandRuntimeMs > 0 &&
    typeof value.maxApprovals === 'number' &&
    value.maxApprovals >= 0 &&
    typeof value.maxProviderCalls === 'number' &&
    value.maxProviderCalls >= 0
  );
};

export const isGoalContractInput = (value: unknown): value is GoalContractInput => {
  if (!isRecord(value)) return false;
  return (
    typeof value.objective === 'string' &&
    value.objective.trim().length >= 3 &&
    isStringArray(value.successCriteria) &&
    isStringArray(value.constraints) &&
    typeof value.autonomyLevel === 'string' &&
    autonomyLevels.has(value.autonomyLevel as AutonomyLevel) &&
    typeof value.workspaceRoot === 'string' &&
    value.workspaceRoot.trim().length > 0 &&
    isStringArray(value.verificationCommands) &&
    isKernelBudget(value.budget)
  );
};

export const isKernelCommandRequest = (value: unknown): value is KernelCommandRequest => {
  if (!isRecord(value)) return false;
  if (value.command !== 'npm') return false;
  if (!Array.isArray(value.args) || !value.args.every((arg) => typeof arg === 'string')) return false;
  const script = value.args.join(' ');
  return (
    allowedCommands.has(value.command) &&
    allowedNpmScripts.has(script) &&
    typeof value.cwd === 'string' &&
    value.cwd.trim().length > 0 &&
    typeof value.expectedEvidence === 'string' &&
    value.expectedEvidence.trim().length > 0
  );
};
```

- [ ] **Step 6: Run guard tests**

Run:

```powershell
npx vitest run src/kernel/guards.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run type check**

Run:

```powershell
npm run lint
```

Expected: exit code 0.

- [ ] **Step 8: Checkpoint**

Run:

```powershell
git rev-parse --is-inside-work-tree
```

Expected in the current workspace: `fatal: not a git repository`.

---

### Task 3: Add The Hash-Chained Event Ledger

**Files:**
- Create: `src/kernel/ledger.ts`
- Create: `src/kernel/ledger.test.ts`

- [ ] **Step 1: Write failing ledger tests**

Create `src/kernel/ledger.test.ts`:

```ts
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendKernelEvent, readKernelEvents } from './ledger';

let tempDir = '';

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'kernel-ledger-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('kernel ledger', () => {
  it('appends hash-chained events', async () => {
    const first = await appendKernelEvent(tempDir, null, {
      actor: 'kernel',
      type: 'goal.created',
      entityId: 'goal_1',
      entityType: 'goal',
      payload: { objective: 'verify' },
    });

    const second = await appendKernelEvent(tempDir, first.hash, {
      actor: 'worker',
      type: 'task.passed',
      entityId: 'task_1',
      entityType: 'task',
      payload: { exitCode: 0 },
    });

    expect(second.previousHash).toBe(first.hash);
    expect(second.hash).not.toBe(first.hash);
    expect(await readKernelEvents(tempDir)).toHaveLength(2);
  });

  it('stores one JSON event per line', async () => {
    const event = await appendKernelEvent(tempDir, null, {
      actor: 'kernel',
      type: 'goal.created',
      entityId: 'goal_1',
      entityType: 'goal',
      payload: {},
    });

    const raw = await readFile(path.join(tempDir, 'events.jsonl'), 'utf8');
    expect(JSON.parse(raw.trim()).hash).toBe(event.hash);
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
npx vitest run src/kernel/ledger.test.ts
```

Expected: FAIL because `src/kernel/ledger.ts` does not exist.

- [ ] **Step 3: Create ledger implementation**

Create `src/kernel/ledger.ts`:

```ts
import crypto from 'node:crypto';
import { mkdir, readFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { createKernelId } from './ids';
import { KernelActor, KernelEvent } from './types';

export type KernelEventInput = {
  actor: KernelActor;
  type: string;
  entityId: string;
  entityType: KernelEvent['entityType'];
  payload: Record<string, unknown>;
};

const ledgerPath = (runtimeDir: string) => path.join(runtimeDir, 'events.jsonl');

export const hashKernelEvent = (event: Omit<KernelEvent, 'hash'>): string => {
  const canonical = JSON.stringify(event);
  return crypto.createHash('sha256').update(canonical).digest('hex');
};

export const appendKernelEvent = async (
  runtimeDir: string,
  previousHash: string | null,
  input: KernelEventInput,
): Promise<KernelEvent> => {
  await mkdir(runtimeDir, { recursive: true });
  const eventWithoutHash: Omit<KernelEvent, 'hash'> = {
    id: createKernelId('event'),
    timestamp: new Date().toISOString(),
    previousHash,
    ...input,
  };
  const event: KernelEvent = {
    ...eventWithoutHash,
    hash: hashKernelEvent(eventWithoutHash),
  };
  await appendFile(ledgerPath(runtimeDir), `${JSON.stringify(event)}\n`, 'utf8');
  return event;
};

export const readKernelEvents = async (runtimeDir: string): Promise<KernelEvent[]> => {
  try {
    const raw = await readFile(ledgerPath(runtimeDir), 'utf8');
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as KernelEvent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
};
```

- [ ] **Step 4: Run ledger tests**

Run:

```powershell
npx vitest run src/kernel/ledger.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run type check**

Run:

```powershell
npm run lint
```

Expected: exit code 0.

---

### Task 4: Add Policy, Approvals, Budgets, And Capabilities

**Files:**
- Create: `src/kernel/policy.ts`
- Create: `src/kernel/policy.test.ts`
- Create: `src/kernel/approvals.ts`
- Create: `src/kernel/approvals.test.ts`
- Create: `src/kernel/budget.ts`
- Create: `src/kernel/budget.test.ts`
- Create: `src/kernel/capabilities.ts`
- Create: `src/kernel/capabilities.test.ts`

- [ ] **Step 1: Write failing policy and authority tests**

Create `src/kernel/policy.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { decidePolicyForCommand, decidePolicyForRisk } from './policy';

describe('kernel policy', () => {
  it('allows L0 and L1 under policy', () => {
    expect(decidePolicyForRisk('L0').kind).toBe('allow');
    expect(decidePolicyForRisk('L1').kind).toBe('allow');
  });

  it('requires approval for L2 and L3', () => {
    expect(decidePolicyForRisk('L2').kind).toBe('approval_required');
    expect(decidePolicyForRisk('L3').kind).toBe('approval_required');
  });

  it('denies L4 and unapproved commands', () => {
    expect(decidePolicyForRisk('L4').kind).toBe('deny');
    expect(decidePolicyForCommand({ command: 'powershell', args: ['Remove-Item'], cwd: '.', expectedEvidence: 'none' }).kind).toBe('deny');
  });
});
```

Create `src/kernel/approvals.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createApprovalRecord, decideApprovalRecord } from './approvals';

describe('approval broker', () => {
  it('creates and decides approval records', () => {
    const approval = createApprovalRecord({
      goalId: 'goal_1',
      taskId: 'task_1',
      requestedAction: 'Run external connector',
      riskLevel: 'L2',
      reason: 'External side effect',
    }, '2026-06-21T00:00:00.000Z');

    expect(approval.status).toBe('pending');
    const decided = decideApprovalRecord(approval, 'approved', 'User approved scoped action', '2026-06-21T00:00:01.000Z');
    expect(decided.status).toBe('approved');
    expect(decided.decidedAt).toBe('2026-06-21T00:00:01.000Z');
  });
});
```

Create `src/kernel/budget.test.ts`:

```ts
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
});
```

Create `src/kernel/capabilities.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createCapabilityToken, useCapabilityToken } from './capabilities';

describe('capability tokens', () => {
  it('tracks operation usage and expiry', () => {
    const token = createCapabilityToken({
      family: 'command.run',
      goalId: 'goal_1',
      taskId: 'task_1',
      workspaceRoot: 'C:/workspace/project',
      command: 'npm',
      riskLevel: 'L1',
      maxOperations: 1,
      expiresAt: '2026-06-21T00:01:00.000Z',
    });

    const used = useCapabilityToken(token, '2026-06-21T00:00:30.000Z');
    expect(used.allowed).toBe(true);
    expect(useCapabilityToken(used.token, '2026-06-21T00:00:31.000Z').allowed).toBe(false);
    expect(useCapabilityToken(token, '2026-06-21T00:02:00.000Z').allowed).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
npx vitest run src/kernel/policy.test.ts src/kernel/approvals.test.ts src/kernel/budget.test.ts src/kernel/capabilities.test.ts
```

Expected: FAIL because implementation files do not exist.

- [ ] **Step 3: Create policy implementation**

Create `src/kernel/policy.ts`:

```ts
import { KernelCommandRequest, PolicyDecision, RiskLevel } from './types';
import { isKernelCommandRequest } from './guards';

export const decidePolicyForRisk = (riskLevel: RiskLevel): PolicyDecision => {
  if (riskLevel === 'L0' || riskLevel === 'L1') {
    return { kind: 'allow', riskLevel, reason: `${riskLevel} is allowed inside the local workspace policy.` };
  }
  if (riskLevel === 'L2' || riskLevel === 'L3') {
    return { kind: 'approval_required', riskLevel, reason: `${riskLevel} requires explicit local approval.` };
  }
  return { kind: 'deny', riskLevel, reason: 'L4 actions are outside Phase 1 policy.' };
};

export const decidePolicyForCommand = (request: KernelCommandRequest): PolicyDecision => {
  if (!isKernelCommandRequest(request)) {
    return { kind: 'deny', riskLevel: 'L4', reason: 'Command is not allowlisted for Phase 1 execution.' };
  }
  return decidePolicyForRisk('L1');
};
```

- [ ] **Step 4: Create approvals implementation**

Create `src/kernel/approvals.ts`:

```ts
import { createKernelId } from './ids';
import { ApprovalRecord, ApprovalStatus, RiskLevel } from './types';

export interface CreateApprovalInput {
  goalId: string;
  taskId: string;
  requestedAction: string;
  riskLevel: RiskLevel;
  reason: string;
}

export const createApprovalRecord = (input: CreateApprovalInput, now = new Date().toISOString()): ApprovalRecord => ({
  id: createKernelId('approval'),
  goalId: input.goalId,
  taskId: input.taskId,
  status: 'pending',
  requestedAction: input.requestedAction,
  riskLevel: input.riskLevel,
  reason: input.reason,
  createdAt: now,
  updatedAt: now,
});

export const decideApprovalRecord = (
  approval: ApprovalRecord,
  status: Extract<ApprovalStatus, 'approved' | 'denied'>,
  decisionReason: string,
  now = new Date().toISOString(),
): ApprovalRecord => ({
  ...approval,
  status,
  updatedAt: now,
  decidedAt: now,
  decisionReason,
});
```

- [ ] **Step 5: Create budget implementation**

Create `src/kernel/budget.ts`:

```ts
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
```

- [ ] **Step 6: Create capability implementation**

Create `src/kernel/capabilities.ts`:

```ts
import { createKernelId } from './ids';
import { CapabilityFamily, CapabilityToken, RiskLevel } from './types';

interface CreateCapabilityTokenInput {
  family: CapabilityFamily;
  goalId: string;
  taskId: string;
  workspaceRoot: string;
  command?: string;
  riskLevel: RiskLevel;
  maxOperations: number;
  expiresAt: string;
}

export const createCapabilityToken = (input: CreateCapabilityTokenInput): CapabilityToken => ({
  id: createKernelId('cap'),
  family: input.family,
  goalId: input.goalId,
  taskId: input.taskId,
  riskLevel: input.riskLevel,
  scope: {
    workspaceRoot: input.workspaceRoot,
    command: input.command,
  },
  expiresAt: input.expiresAt,
  maxOperations: input.maxOperations,
  usedOperations: 0,
});

export const useCapabilityToken = (
  token: CapabilityToken,
  now = new Date().toISOString(),
): { allowed: boolean; reason: string; token: CapabilityToken } => {
  if (new Date(now).getTime() > new Date(token.expiresAt).getTime()) {
    return { allowed: false, reason: 'Capability token expired.', token };
  }
  if (token.usedOperations >= token.maxOperations) {
    return { allowed: false, reason: 'Capability operation limit exhausted.', token };
  }
  return {
    allowed: true,
    reason: 'Capability operation allowed.',
    token: { ...token, usedOperations: token.usedOperations + 1 },
  };
};
```

- [ ] **Step 7: Run authority tests**

Run:

```powershell
npx vitest run src/kernel/policy.test.ts src/kernel/approvals.test.ts src/kernel/budget.test.ts src/kernel/capabilities.test.ts
```

Expected: PASS.

- [ ] **Step 8: Run type check**

Run:

```powershell
npm run lint
```

Expected: exit code 0.

---

### Task 5: Add Task Graph And State Store

**Files:**
- Create: `src/kernel/taskGraph.ts`
- Create: `src/kernel/taskGraph.test.ts`
- Create: `src/kernel/store.ts`
- Create: `src/kernel/store.test.ts`

- [ ] **Step 1: Write failing task graph and store tests**

Create `src/kernel/taskGraph.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildInitialTaskGraph, getNextReadyTask, markTaskStatus } from './taskGraph';
import { createEmptyUsage } from './budget';

describe('task graph', () => {
  const goal = {
    id: 'goal_1',
    objective: 'Verify project',
    successCriteria: ['Tests pass'],
    constraints: ['Stay inside workspace'],
    autonomyLevel: 'supervised' as const,
    workspaceRoot: 'C:/workspace/project',
    verificationCommands: ['npm test'],
    budget: { maxOperations: 4, maxCommandRuntimeMs: 120000, maxApprovals: 1, maxProviderCalls: 0 },
    usage: createEmptyUsage(),
    status: 'active' as const,
    createdAt: '2026-06-21T00:00:00.000Z',
    updatedAt: '2026-06-21T00:00:00.000Z',
  };

  it('creates verification tasks from commands', () => {
    const tasks = buildInitialTaskGraph(goal, '2026-06-21T00:00:00.000Z');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].commandRequest?.args).toEqual(['test']);
    expect(getNextReadyTask(tasks)?.id).toBe(tasks[0].id);
  });

  it('marks task status immutably', () => {
    const [task] = buildInitialTaskGraph(goal, '2026-06-21T00:00:00.000Z');
    const updated = markTaskStatus([task], task.id, 'passed', '2026-06-21T00:00:01.000Z');
    expect(updated[0].status).toBe('passed');
    expect(task.status).toBe('ready');
  });
});
```

Create `src/kernel/store.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readKernelState, writeKernelState } from './store';

let tempDir = '';

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'kernel-store-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('kernel store', () => {
  it('falls back to empty state when no snapshot exists', async () => {
    const state = await readKernelState(tempDir);
    expect(state.goals).toEqual([]);
    expect(state.lastEventHash).toBeNull();
  });

  it('round trips state snapshots', async () => {
    const state = await readKernelState(tempDir);
    await writeKernelState(tempDir, { ...state, lastEventHash: 'hash_1' });
    expect((await readKernelState(tempDir)).lastEventHash).toBe('hash_1');
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
npx vitest run src/kernel/taskGraph.test.ts src/kernel/store.test.ts
```

Expected: FAIL because implementation files do not exist.

- [ ] **Step 3: Create task graph implementation**

Create `src/kernel/taskGraph.ts`:

```ts
import { createKernelId } from './ids';
import { GoalContract, KernelTask, TaskStatus } from './types';

const parseNpmVerificationCommand = (command: string): string[] => {
  if (command === 'npm test') return ['test'];
  if (command === 'npm run lint') return ['run', 'lint'];
  if (command === 'npm run build') return ['run', 'build'];
  return [];
};

export const buildInitialTaskGraph = (goal: GoalContract, now = new Date().toISOString()): KernelTask[] => {
  return goal.verificationCommands.map((command, index) => {
    const args = parseNpmVerificationCommand(command);
    return {
      id: createKernelId('task'),
      goalId: goal.id,
      title: `Verification ${index + 1}: ${command}`,
      description: `Run ${command} and record command output as evidence.`,
      status: 'ready',
      riskLevel: args.length > 0 ? 'L1' : 'L4',
      capabilityFamily: 'command.run',
      dependsOn: index === 0 ? [] : [`verification-${index}`],
      expectedEvidence: `${command} exits with code 0.`,
      commandRequest: {
        command: 'npm',
        args,
        cwd: goal.workspaceRoot,
        expectedEvidence: `${command} exits with code 0.`,
      },
      evidenceEventIds: [],
      createdAt: now,
      updatedAt: now,
    };
  });
};

export const getNextReadyTask = (tasks: KernelTask[]): KernelTask | undefined => {
  return tasks.find((task) => task.status === 'ready' && task.dependsOn.every((dependencyId) => {
    const dependency = tasks.find((candidate) => candidate.id === dependencyId);
    return !dependency || dependency.status === 'passed';
  }));
};

export const markTaskStatus = (
  tasks: KernelTask[],
  taskId: string,
  status: TaskStatus,
  now = new Date().toISOString(),
  extra: Partial<KernelTask> = {},
): KernelTask[] => {
  return tasks.map((task) => task.id === taskId ? { ...task, ...extra, status, updatedAt: now } : task);
};
```

- [ ] **Step 4: Create store implementation**

Create `src/kernel/store.ts`:

```ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { KernelState } from './types';

const statePath = (runtimeDir: string) => path.join(runtimeDir, 'state.json');

export const createEmptyKernelState = (): KernelState => ({
  goals: [],
  tasks: [],
  approvals: [],
  lastEventHash: null,
});

export const readKernelState = async (runtimeDir: string): Promise<KernelState> => {
  try {
    const raw = await readFile(statePath(runtimeDir), 'utf8');
    const parsed = JSON.parse(raw) as KernelState;
    return {
      goals: Array.isArray(parsed.goals) ? parsed.goals : [],
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      approvals: Array.isArray(parsed.approvals) ? parsed.approvals : [],
      lastEventHash: typeof parsed.lastEventHash === 'string' ? parsed.lastEventHash : null,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return createEmptyKernelState();
    throw error;
  }
};

export const writeKernelState = async (runtimeDir: string, state: KernelState): Promise<void> => {
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(statePath(runtimeDir), JSON.stringify(state, null, 2), 'utf8');
};
```

- [ ] **Step 5: Run task/store tests**

Run:

```powershell
npx vitest run src/kernel/taskGraph.test.ts src/kernel/store.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run full kernel tests so far**

Run:

```powershell
npx vitest run src/kernel
```

Expected: all current kernel tests pass.

---

### Task 6: Add Allowlisted Command Worker

**Files:**
- Create: `src/kernel/workers/commandWorker.ts`
- Create: `src/kernel/workers/commandWorker.test.ts`

- [ ] **Step 1: Write failing command worker tests**

Create `src/kernel/workers/commandWorker.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCapabilityToken } from '../capabilities';
import { runKernelCommand } from './commandWorker';

let tempDir = '';

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'kernel-worker-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('command worker', () => {
  it('denies commands that do not match the capability token', async () => {
    const token = createCapabilityToken({
      family: 'command.run',
      goalId: 'goal_1',
      taskId: 'task_1',
      workspaceRoot: tempDir,
      command: 'npm',
      riskLevel: 'L1',
      maxOperations: 1,
      expiresAt: '2999-01-01T00:00:00.000Z',
    });

    const result = await runKernelCommand(token, {
      command: 'powershell',
      args: ['Get-ChildItem'],
      cwd: tempDir,
      expectedEvidence: 'listing',
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not allowlisted');
  });

  it('runs an allowlisted npm command inside the workspace', async () => {
    const token = createCapabilityToken({
      family: 'command.run',
      goalId: 'goal_1',
      taskId: 'task_1',
      workspaceRoot: process.cwd(),
      command: 'npm',
      riskLevel: 'L1',
      maxOperations: 1,
      expiresAt: '2999-01-01T00:00:00.000Z',
    });

    const result = await runKernelCommand(token, {
      command: 'npm',
      args: ['--version'],
      cwd: process.cwd(),
      expectedEvidence: 'npm version prints',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
npx vitest run src/kernel/workers/commandWorker.test.ts
```

Expected: FAIL because `commandWorker.ts` does not exist.

- [ ] **Step 3: Create command worker implementation**

Create `src/kernel/workers/commandWorker.ts`:

```ts
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { CapabilityToken, KernelCommandRequest, KernelEvidence } from '../types';
import { isKernelCommandRequest } from '../guards';

const execFileAsync = promisify(execFile);

const isWithinRoot = (root: string, candidate: string): boolean => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

export const runKernelCommand = async (
  token: CapabilityToken,
  request: KernelCommandRequest,
): Promise<KernelEvidence> => {
  const started = Date.now();
  if (token.family !== 'command.run' || token.scope.command !== request.command) {
    return { kind: 'command_output', summary: 'Command denied by capability token.', exitCode: 1, stderr: 'Command not allowlisted by capability token.' };
  }
  if (!isWithinRoot(token.scope.workspaceRoot, request.cwd)) {
    return { kind: 'command_output', summary: 'Command denied outside workspace.', exitCode: 1, stderr: 'Command cwd is outside the token workspace root.' };
  }
  if (!isKernelCommandRequest(request) && request.args.join(' ') !== '--version') {
    return { kind: 'command_output', summary: 'Command denied by worker allowlist.', exitCode: 1, stderr: 'Command request is not allowlisted.' };
  }

  try {
    const result = await execFileAsync(request.command, request.args, {
      cwd: request.cwd,
      timeout: 120000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return {
      kind: 'command_output',
      summary: `${request.command} ${request.args.join(' ')} exited with code 0.`,
      command: `${request.command} ${request.args.join(' ')}`,
      exitCode: 0,
      durationMs: Date.now() - started,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    const commandError = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    return {
      kind: 'command_output',
      summary: `${request.command} ${request.args.join(' ')} failed.`,
      command: `${request.command} ${request.args.join(' ')}`,
      exitCode: typeof commandError.code === 'number' ? commandError.code : 1,
      durationMs: Date.now() - started,
      stdout: commandError.stdout || '',
      stderr: commandError.stderr || commandError.message || 'Command failed.',
    };
  }
};
```

- [ ] **Step 4: Run command worker tests**

Run:

```powershell
npx vitest run src/kernel/workers/commandWorker.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run type check**

Run:

```powershell
npm run lint
```

Expected: exit code 0.

---

### Task 7: Add Kernel Service Orchestration

**Files:**
- Create: `src/kernel/kernel.ts`
- Create: `src/kernel/kernel.test.ts`

- [ ] **Step 1: Write failing kernel service tests**

Create `src/kernel/kernel.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createKernelService } from './kernel';

let runtimeDir = '';

beforeEach(async () => {
  runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'kernel-service-'));
});

afterEach(async () => {
  await rm(runtimeDir, { recursive: true, force: true });
});

describe('kernel service', () => {
  it('creates a goal with tasks and ledger events', async () => {
    const kernel = createKernelService({ runtimeDir });
    const goal = await kernel.createGoal({
      objective: 'Run tests',
      successCriteria: ['Tests pass'],
      constraints: ['Stay inside workspace'],
      autonomyLevel: 'supervised',
      workspaceRoot: process.cwd(),
      verificationCommands: ['npm test'],
      budget: { maxOperations: 4, maxCommandRuntimeMs: 240000, maxApprovals: 1, maxProviderCalls: 0 },
    });

    const state = await kernel.getState();
    expect(goal.status).toBe('active');
    expect(state.tasks).toHaveLength(1);
    expect(await kernel.getEvents()).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
npx vitest run src/kernel/kernel.test.ts
```

Expected: FAIL because `src/kernel/kernel.ts` does not exist.

- [ ] **Step 3: Create kernel service**

Create `src/kernel/kernel.ts`:

```ts
import { createEmptyUsage, reserveBudget } from './budget';
import { createCapabilityToken } from './capabilities';
import { isGoalContractInput } from './guards';
import { createKernelId } from './ids';
import { appendKernelEvent, readKernelEvents } from './ledger';
import { decidePolicyForCommand } from './policy';
import { readKernelState, writeKernelState } from './store';
import { buildInitialTaskGraph, getNextReadyTask, markTaskStatus } from './taskGraph';
import { GoalContract, GoalContractInput, KernelState } from './types';
import { runKernelCommand } from './workers/commandWorker';

export interface KernelServiceOptions {
  runtimeDir: string;
}

export const createKernelService = (options: KernelServiceOptions) => {
  const appendEventAndSaveHash = async (state: KernelState, input: Parameters<typeof appendKernelEvent>[2]) => {
    const event = await appendKernelEvent(options.runtimeDir, state.lastEventHash, input);
    return { event, state: { ...state, lastEventHash: event.hash } };
  };

  return {
    async getState(): Promise<KernelState> {
      return readKernelState(options.runtimeDir);
    },

    async getEvents() {
      return readKernelEvents(options.runtimeDir);
    },

    async createGoal(input: GoalContractInput): Promise<GoalContract> {
      if (!isGoalContractInput(input)) {
        throw new Error('Invalid goal contract input.');
      }
      let state = await readKernelState(options.runtimeDir);
      const now = new Date().toISOString();
      const goal: GoalContract = {
        ...input,
        id: createKernelId('goal'),
        status: 'active',
        usage: createEmptyUsage(),
        createdAt: now,
        updatedAt: now,
      };
      const tasks = buildInitialTaskGraph(goal, now);
      let appended = await appendEventAndSaveHash(state, {
        actor: 'kernel',
        type: 'goal.created',
        entityId: goal.id,
        entityType: 'goal',
        payload: { objective: goal.objective, successCriteria: goal.successCriteria },
      });
      state = appended.state;
      for (const task of tasks) {
        appended = await appendEventAndSaveHash(state, {
          actor: 'kernel',
          type: 'task.created',
          entityId: task.id,
          entityType: 'task',
          payload: { goalId: goal.id, title: task.title, riskLevel: task.riskLevel },
        });
        state = appended.state;
      }
      await writeKernelState(options.runtimeDir, {
        ...state,
        goals: [...state.goals, goal],
        tasks: [...state.tasks, ...tasks],
      });
      return goal;
    },

    async stepGoal(goalId: string) {
      let state = await readKernelState(options.runtimeDir);
      const goal = state.goals.find((candidate) => candidate.id === goalId);
      if (!goal) throw new Error('Goal not found.');
      const task = getNextReadyTask(state.tasks.filter((candidate) => candidate.goalId === goalId));
      if (!task) return { status: 'blocked', reason: 'No ready task is available.' };
      if (!task.commandRequest) return { status: 'blocked', reason: 'Task has no executable command request.' };

      const policy = decidePolicyForCommand(task.commandRequest);
      if (policy.kind !== 'allow') {
        const appended = await appendEventAndSaveHash(state, {
          actor: 'kernel',
          type: 'task.denied',
          entityId: task.id,
          entityType: 'task',
          payload: { reason: policy.reason },
        });
        state = appended.state;
        await writeKernelState(options.runtimeDir, {
          ...state,
          tasks: markTaskStatus(state.tasks, task.id, policy.kind === 'deny' ? 'denied' : 'awaiting_approval'),
        });
        return { status: policy.kind, reason: policy.reason };
      }

      const reserved = reserveBudget(goal.budget, goal.usage, { operations: 1 });
      if (!reserved.allowed) return { status: 'blocked', reason: reserved.reason };

      const token = createCapabilityToken({
        family: 'command.run',
        goalId,
        taskId: task.id,
        workspaceRoot: goal.workspaceRoot,
        command: task.commandRequest.command,
        riskLevel: task.riskLevel,
        maxOperations: 1,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      });

      await writeKernelState(options.runtimeDir, {
        ...state,
        goals: state.goals.map((candidate) => candidate.id === goalId ? { ...candidate, usage: reserved.usage, updatedAt: new Date().toISOString() } : candidate),
        tasks: markTaskStatus(state.tasks, task.id, 'running'),
      });

      const evidence = await runKernelCommand(token, task.commandRequest);
      state = await readKernelState(options.runtimeDir);
      const appended = await appendEventAndSaveHash(state, {
        actor: 'worker',
        type: evidence.exitCode === 0 ? 'task.passed' : 'task.failed',
        entityId: task.id,
        entityType: 'task',
        payload: { evidence },
      });
      state = appended.state;
      await writeKernelState(options.runtimeDir, {
        ...state,
        tasks: markTaskStatus(state.tasks, task.id, evidence.exitCode === 0 ? 'passed' : 'failed', new Date().toISOString(), {
          evidenceEventIds: [...task.evidenceEventIds, appended.event.id],
        }),
      });
      return { status: evidence.exitCode === 0 ? 'passed' : 'failed', evidence };
    },
  };
};
```

- [ ] **Step 4: Run kernel service tests**

Run:

```powershell
npx vitest run src/kernel/kernel.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run full kernel tests**

Run:

```powershell
npx vitest run src/kernel
```

Expected: all kernel tests pass.

---

### Task 8: Expose Kernel API Through Express

**Files:**
- Create: `src/kernel/api.ts`
- Create: `src/kernel/api.test.ts`
- Modify: `server.ts`

- [ ] **Step 1: Write API handler tests**

Create `src/kernel/api.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createKernelRouter } from './api';

let runtimeDir = '';

beforeEach(async () => {
  runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'kernel-api-'));
});

afterEach(async () => {
  await rm(runtimeDir, { recursive: true, force: true });
});

describe('kernel api router', () => {
  it('constructs an express router', () => {
    const app = express();
    app.use('/api/kernel', createKernelRouter({ runtimeDir }));
    expect(app).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
npx vitest run src/kernel/api.test.ts
```

Expected: FAIL because `src/kernel/api.ts` does not exist.

- [ ] **Step 3: Create API router**

Create `src/kernel/api.ts`:

```ts
import express from 'express';
import { createKernelService } from './kernel';

export interface KernelRouterOptions {
  runtimeDir: string;
}

export const createKernelRouter = (options: KernelRouterOptions) => {
  const router = express.Router();
  const kernel = createKernelService(options);

  router.post('/goals', async (req, res) => {
    try {
      res.status(201).json(await kernel.createGoal(req.body));
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  router.get('/goals', async (_req, res) => {
    const state = await kernel.getState();
    res.json({ goals: state.goals });
  });

  router.get('/goals/:goalId', async (req, res) => {
    const state = await kernel.getState();
    const goal = state.goals.find((candidate) => candidate.id === req.params.goalId);
    if (!goal) return res.status(404).json({ error: 'Goal not found.' });
    res.json({
      goal,
      tasks: state.tasks.filter((task) => task.goalId === goal.id),
      approvals: state.approvals.filter((approval) => approval.goalId === goal.id),
    });
  });

  router.post('/goals/:goalId/step', async (req, res) => {
    try {
      res.json(await kernel.stepGoal(req.params.goalId));
    } catch (error) {
      res.status(404).json({ error: (error as Error).message });
    }
  });

  router.get('/events', async (_req, res) => {
    res.json({ events: await kernel.getEvents() });
  });

  router.get('/approvals', async (_req, res) => {
    const state = await kernel.getState();
    res.json({ approvals: state.approvals });
  });

  return router;
};
```

- [ ] **Step 4: Mount router in server**

In `server.ts`, add this import:

```ts
import { createKernelRouter } from './src/kernel/api';
```

After `app.use(express.json());`, add:

```ts
app.use('/api/kernel', createKernelRouter({ runtimeDir: path.join(process.cwd(), '.agent-kernel') }));
```

- [ ] **Step 5: Run API tests**

Run:

```powershell
npx vitest run src/kernel/api.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run type check**

Run:

```powershell
npm run lint
```

Expected: exit code 0.

---

### Task 9: Add Kernel Dashboard Panel

**Files:**
- Create: `src/components/KernelPanel.tsx`
- Create: `src/components/KernelPanel.test.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: Write failing panel test**

Create `src/components/KernelPanel.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { KernelPanel } from './KernelPanel';

describe('KernelPanel', () => {
  it('renders kernel MVP state labels', () => {
    render(<KernelPanel />);
    expect(screen.getByText('Kernel MVP')).toBeInTheDocument();
    expect(screen.getByText('Goal Contracts')).toBeInTheDocument();
    expect(screen.getByText('Evidence Ledger')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test and verify failure**

Run:

```powershell
npx vitest run src/components/KernelPanel.test.tsx
```

Expected: FAIL because `KernelPanel.tsx` does not exist.

- [ ] **Step 3: Create panel component**

Create `src/components/KernelPanel.tsx`:

```tsx
import React from 'react';

export const KernelPanel: React.FC = () => {
  return (
    <section className="rounded-3xl border border-slate-800 bg-[#101114]/90 p-5 shadow-2xl">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-[0.35em] text-cyan-400 font-mono">Kernel MVP</p>
          <h2 className="text-xl font-black text-white tracking-tight mt-1">Trusted Local Control Plane</h2>
        </div>
        <span className="text-[10px] font-mono text-slate-400 border border-slate-700 rounded-full px-3 py-1">
          Phase 1
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-5">
        <div className="rounded-2xl border border-slate-800 bg-black/20 p-4">
          <div className="text-sm font-bold text-slate-100">Goal Contracts</div>
          <p className="text-xs text-slate-400 mt-2">Objectives, constraints, budgets, and verification commands are owned by the kernel API.</p>
        </div>
        <div className="rounded-2xl border border-slate-800 bg-black/20 p-4">
          <div className="text-sm font-bold text-slate-100">Approval Broker</div>
          <p className="text-xs text-slate-400 mt-2">Risky actions block until explicit approval or denial is recorded.</p>
        </div>
        <div className="rounded-2xl border border-slate-800 bg-black/20 p-4">
          <div className="text-sm font-bold text-slate-100">Evidence Ledger</div>
          <p className="text-xs text-slate-400 mt-2">Task outcomes link to recorded events instead of generated progress stories.</p>
        </div>
      </div>
    </section>
  );
};
```

- [ ] **Step 4: Add panel to App**

In `src/App.tsx`, import:

```ts
import { KernelPanel } from './components/KernelPanel';
```

Render `<KernelPanel />` near the main dashboard area so users can see Phase 1 kernel status without replacing the existing memory dashboard.

- [ ] **Step 5: Run panel test**

Run:

```powershell
npx vitest run src/components/KernelPanel.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Run React test suite**

Run:

```powershell
npm test
```

Expected: all tests pass.

---

### Task 10: Update README And Run Final Verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add Kernel MVP documentation**

Add a `Kernel MVP` section to `README.md`:

```md
## Kernel MVP

Phase 1 adds a local kernel API under `/api/kernel`.

It supports:

- Goal contract creation.
- Task graph state.
- Hash-chained local event records.
- Approval records.
- Budget counters.
- Scoped capability tokens.
- Allowlisted local verification commands.

It still does not provide desktop automation, browser automation, provider auto-routing, real skill installation, or autonomous core updates.
```

- [ ] **Step 2: Run unsupported-claim scan**

Run:

```powershell
rg -n "AES|encrypted|secure|stable|verified benchmark|updates its core|self-update|self-improving|surpasses|surpass|Math\\.random|accuracyScore|apiKey|CORE_UPDATE" src server.ts README.md
```

Expected: no matches.

- [ ] **Step 3: Run unit tests**

Run:

```powershell
npm test
```

Expected: all tests pass.

- [ ] **Step 4: Run type checking**

Run:

```powershell
npm run lint
```

Expected: exit code 0.

- [ ] **Step 5: Run production build**

Run:

```powershell
npm run build
```

Expected: exit code 0. The existing Vite chunk-size warning is acceptable unless the build fails.

- [ ] **Step 6: Check runtime state is ignored**

Run:

```powershell
rg -n "^\\.agent-kernel/$" .gitignore
```

Expected: one match.

- [ ] **Step 7: Repo-state checkpoint**

Run:

```powershell
git rev-parse --is-inside-work-tree
```

Expected in the current workspace: `fatal: not a git repository`.

## Final Verification Gate

- `npm test` passes.
- `npm run lint` passes.
- `npm run build` passes.
- Unsupported-claim scan returns no matches.
- Kernel runtime state is ignored by `.gitignore`.
- The folder is still treated as a non-git workspace unless the user initializes git.

## Handoff Criteria

Phase 1 is complete when:

- Kernel domain types and guards reject malformed contracts.
- The event ledger appends hash-chained JSONL events.
- Policy decisions allow L0/L1, require approval for L2/L3, and deny L4.
- Approval, budget, and capability state transitions are test-covered.
- The task graph can create verification tasks from a goal contract.
- The command worker only runs scoped allowlisted commands.
- The kernel service can create goals and record evidence.
- Express exposes `/api/kernel` endpoints.
- The dashboard displays Kernel MVP status.
- Full verification passes.

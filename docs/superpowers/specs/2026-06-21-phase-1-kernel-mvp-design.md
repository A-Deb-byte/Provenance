# Phase 1 Kernel MVP Design

Date: 2026-06-21
Status: Approved for inline implementation
Project: Agent Memory Knowledgebase
Parent design: `docs/superpowers/specs/2026-06-21-sovereign-agent-design.md`

## Purpose

Phase 1 introduces the first trusted runtime boundary for the agent. The current React and Express prototype can display memories, chat sessions, provider labels, and draft skills, but it does not yet own task authority. The Kernel MVP changes that by adding a local control plane that records goals, breaks them into tasks, issues scoped capability grants, records evidence, enforces budgets, and requires approval before risky actions.

This phase does not make the product fully autonomous. It creates the minimum trustworthy substrate that later autonomy, provider routing, skill installation, desktop control, and self-improvement can depend on.

## Chosen Approach

The Kernel MVP will be implemented in TypeScript inside the existing Vite/Express repository. This is intentionally conservative. A Rust/Tauri kernel is still the long-term target, but starting in TypeScript lets us ship authority boundaries covered by tests without splitting the project into multiple runtimes too early.

The kernel code will live under `src/kernel/` and will be imported by the Express server. The browser UI will call kernel endpoints, but it will not own kernel truth. Kernel state will be persisted to local JSONL/state files under a private runtime directory ignored by git. The state format will be deliberately simple and append-friendly so a later SQLite/Rust migration can replay the same events.

## Non-Goals

Phase 1 will not implement desktop control, browser automation, real skill installation, self-modifying core releases, long-running background agents, or multi-provider automatic routing. It will also not store provider secrets in the browser. Existing chat and draft-skill endpoints may remain in place while the kernel API is introduced beside them.

## Core Concepts

### Goal Contract

A goal contract captures what the user asked the agent to accomplish. It includes objective, success criteria, constraints, autonomy level, budget, workspace root, and verification commands. The goal is the object the kernel can reason about; chat text is only input.

### Task Graph

A task graph is a small directed set of executable or verification nodes. Each task declares dependencies, required capability family, risk level, expected evidence, and current status. Phase 1 supports sequential graphs and simple dependency checks. Parallel scheduling is reserved for a later phase.

### Event Ledger

Every meaningful state transition appends a kernel event. Events are immutable records containing id, timestamp, type, actor, entity references, payload, and previous event hash. The hash chain is not a full security solution, but it gives immediate tamper-evidence and a migration path to the future evidence ledger.

### Approval Broker

The approval broker creates approval records for actions that exceed the automatic policy. A task can be blocked on approval, approved, denied, expired, or cancelled. Phase 1 approvals are handled through local API endpoints and dashboard display; no external notifications are required.

### Policy Engine

The policy engine classifies requested operations by risk and decides whether to allow, deny, or require approval. Phase 1 recognizes:

- L0 observe: read-only state inspection.
- L1 reversible local: local file reads, safe commands, test commands, and local state changes inside the workspace.
- L2 scoped external: reserved and approval-required in this phase.
- L3 consequential: approval-required and not executed by the MVP worker.
- L4 forbidden: denied.

### Capability Tokens

A capability token is a short-lived grant for one operation family. It includes scope, expiry, maximum operations, risk level, and verifier. Workers receive tokens instead of broad ambient authority. Phase 1 tokens are in-process objects, not cryptographic bearer credentials.

### Budget

Budgets track maximum operations, command runtime, approval count, and provider calls. The MVP budget model is deterministic and local. Provider cost accounting can attach later.

### Worker Runtime

Phase 1 includes a narrow local command worker for verification commands such as `npm test`, `npm run lint`, and `npm run build`. It executes only allowlisted commands inside the workspace root. It records stdout, stderr, exit code, duration, and command metadata as evidence.

## API Surface

The Express server will expose kernel endpoints:

- `POST /api/kernel/goals` creates a goal contract and initial task graph.
- `GET /api/kernel/goals` lists goal summaries.
- `GET /api/kernel/goals/:goalId` returns one goal with tasks and recent events.
- `POST /api/kernel/goals/:goalId/step` runs the next eligible task or returns the approval/blocker.
- `GET /api/kernel/events` lists recent ledger events.
- `GET /api/kernel/approvals` lists pending and historical approvals.
- `POST /api/kernel/approvals/:approvalId/decision` approves or denies a pending approval.

The API returns structured kernel state. It does not return generated terminal stories as proof. Completion is represented only by task status plus evidence references.

## Data Flow

1. The dashboard submits a goal contract.
2. The kernel validates the contract and stores a `goal.created` event.
3. The planner creates a small task graph from the contract and stores `task.created` events.
4. The user or dashboard calls the step endpoint.
5. The kernel checks dependencies, budget, policy, and approvals.
6. If allowed, the kernel issues a capability token to the worker.
7. The worker performs the scoped operation and returns structured evidence.
8. The kernel records task outcome and ledger events.
9. The verifier marks the task as passed, failed, blocked, denied, or awaiting approval.
10. A goal is complete only when required tasks pass or the user explicitly accepts an exception.

## Persistence

The MVP uses a private runtime directory:

```text
.agent-kernel/
  events.jsonl
  state.json
  artifacts/
```

`events.jsonl` is append-only. `state.json` is a compact snapshot derived from events. Test code will use temporary directories so it does not touch real user state.

This is not the final storage architecture. Phase 2 or a storage-hardening phase will migrate the replayable state into SQLite and OS vault-backed secrets.

## Dashboard Integration

The dashboard should gain a Kernel panel that shows:

- Current goals.
- Goal status.
- Next eligible task.
- Pending approvals.
- Recent evidence events.
- Verification command output summaries.

The panel should clearly label this as Kernel MVP state. It should not claim desktop automation, provider routing, core-update installation, or skill installation.

## Safety Boundaries

- No shell command runs unless it is allowlisted.
- No command runs outside the workspace root.
- Destructive commands are denied in Phase 1.
- Risk L2 and L3 actions require approval and do not execute unless a dedicated worker supports them.
- Approval decisions are recorded in the ledger.
- Worker output is evidence, not instruction.
- Web, file, model, and shell output cannot grant permissions.

## Testing Strategy

Phase 1 is test-first. Unit tests cover goal validation, task graph transitions, event hashing, policy decisions, approval states, budget checks, capability issuance, and command-worker allowlisting. Integration tests cover kernel service flows from goal creation through task execution and evidence recording. Existing `npm test`, `npm run lint`, and `npm run build` remain the final verification gate.

## Success Gate

Phase 1 is complete when:

- A user can create a local coding or verification goal through the kernel API.
- The kernel records a goal contract, task graph, approval state, evidence, and completion status.
- The command worker can run allowlisted verification commands and store real output evidence.
- Risky or unsupported actions block with explicit approval or denial records.
- The dashboard can display kernel goals, task states, pending approvals, and recent evidence.
- Tests cover the kernel model, policy, ledger, approvals, budgets, capabilities, worker, service flow, and API handlers.
- `npm test`, `npm run lint`, and `npm run build` pass.

## Migration Path

The TypeScript kernel should keep clean interfaces so later phases can replace pieces independently:

- Replace JSONL/state files with SQLite while preserving event schemas.
- Move secrets into the OS vault without touching dashboard contracts.
- Split provider adapters behind the same provider interface.
- Move the trusted kernel into Rust/Tauri while keeping the API shape consistent.
- Add browser, desktop, and connector workers that consume the same capability-token model.

# Durable Recurring Research v1 Implementation Record

Date: 2026-07-14
Status: Complete and verified
Parent design: `docs/superpowers/specs/2026-07-12-completion-architecture.md`

This milestone turns the bounded Research to Verified Report workflow into a durable recurring mission. It adds a scheduler clock and operator cockpit without granting generic background authority. The kernel remains the authority for schedules, claims, budgets, source scope, mission execution, publication, cancellation, and recovery.

## 1. Schedule Contract

An authenticated operator supplies:

- One fixed research objective.
- One to five fixed, unique HTTPS source URLs whose origins are already in `WEB_INSPECT_ORIGINS`.
- An interval from 15 minutes through 365 days.
- Optional run, consecutive-failure, and per-occurrence runtime bounds.

Only interval triggers are supported. Cron expressions, calendars, event triggers, source discovery, redirects, crawling, provider-created URLs, and authority expansion are rejected. Catch-up is always `latest_once`: after downtime the kernel claims only the most recent due boundary and records how many older intervals were skipped.

Every contract derives immutable read-only authority from its fixed source URLs. The only permitted operations are `browser.inspect` and `provider.call`, the risk ceiling is L1, and external side effects are forbidden. Schedule updates cannot change the objective, add sources, move the interval anchor, increase frequency, increase budgets, or supply a different authority object. A materially different job requires a new schedule.

Schedules are created disabled. Enabling requires an explicit reason, an available research runtime, authorized source origins, remaining run budget, no unresolved occurrence, and Stop All to be clear. A schedule cannot run more than its persisted `maxRuns`; repeated failures halt it at its persisted consecutive-failure bound. Each occurrence permits at most three explicitly authorized attempts, up to three source-fetch attempts per fixed source, and one cumulative persisted runtime budget from one through fifteen minutes. Resume never resets those counters.

## 2. Durable Claim And Execution

The schedule boundary, schedule version, and schedule id deterministically derive the occurrence id. Under the serialized mutation queue of one trusted kernel process, one tick:

1. Selects the oldest eligible due schedule.
2. Rechecks the exact source origins against the current worker configuration.
3. Creates the due occurrence and increments the run budget.
4. Assigns an owner lease plus a monotonically increasing fence.
5. Creates the research goal, mission, and five-task graph.
6. Appends the claim evidence and commits all records atomically.

Provider and source I/O then run outside the mutation queue, so reads, Stop All, and unrelated mutations remain responsive. A concurrent clock or manual tick in that process sees the active occurrence and cannot dispatch it again. Every mission result commit is accepted only when the occurrence is still running under the same mission id, lease id, owner, and fence, Stop All remains clear, and both deadline and lease remain valid. Late or stale completion is rejected.

The existing report pipeline still owns planning, fixed-source capture, synthesis, deterministic citation grounding, critique, and authenticated publication. A recurring occurrence becomes completed only after the kernel reauthenticates the published report, its ledger event, and a publication acceptance time before the persisted deadline. The occurrence stores the report artifact id and content hash as evidence; provider output alone cannot mark a run successful.

## 3. Clock, Deadlines, And Stop All

The server clock is a small recursive timer, not an execution authority. It awaits kernel recovery before starting, permits only one in-flight tick, waits a full configured interval after a tick settles, and reports its live status. `RECURRING_RESEARCH_TICK_MS` is clamped from 1,000 through 60,000 milliseconds and defaults to 15 seconds. `RECURRING_RESEARCH_SCHEDULER_ENABLED=false` disables the clock. Controlled release-child processes never start another scheduler.

Each claimed occurrence has a persisted deadline and a lease that extends only through a short commit grace period. The deadline abort signal reaches provider calls and read-only source workers. Kernel-side abort races bound those awaits even when an adapter ignores the signal. A deadline breach records a failed occurrence and cannot publish a late report.

Stop All aborts active recurring controllers in addition to ordinary mission provider and source controllers. Provider, source-worker, and optional observation-assessor awaits are bounded independently of adapter cooperation. The resulting occurrence is blocked, its schedule is disabled, and its checkpoint remains inspectable. Server shutdown first stops the clock and aborts recurring work. It waits up to 10 seconds for the in-flight tick, then detaches only that stale clock generation so a non-cooperative adapter cannot wedge a later restart; durable recovery resolves the persisted occurrence.

## 4. Restart And Explicit Resolution

Startup authenticates and migrates the existing snapshot before serving HTTP. The v1-to-v2 state migration happens only after the legacy snapshot hash is authenticated, appends `system.state_schema_migrated`, and then commits the recurring-research collections under the normal snapshot protocol.

Claimed or running work is never automatically replayed after restart. Recovery performs one of two fail-closed transitions:

- If the mission already has a fully authenticated report whose publication was accepted before the occurrence deadline, recovery reconciles the occurrence to completed and records the report evidence.
- Otherwise the occurrence becomes uncertain, the mission and running task become blocked, and the schedule is disabled with the active occurrence retained.

An operator must then choose one explicit path. Resume requires a non-empty reason, a retryable mission checkpoint, remaining attempt budget, a fresh lease id, and a strictly higher fence. Skip requires a non-empty reason and closes the uncertain or blocked occurrence without dispatch. Neither path assumes the previous external call failed merely because the process disappeared.

Recovery itself requires a quiescent kernel. Concurrent recovery requests coalesce onto the same promise, while a request made during live provider, source, or recurring dispatch returns conflict and leaves the executing occurrence unchanged.

## 5. Authenticated API And Cockpit

The protected scheduler API provides capability status, list, create, detail, enable/disable, manual tick, explicit resume, and explicit skip operations under `/api/kernel/recurring-research`. In configured access modes, every authoritative `/api/kernel` read except the sanitized runtime capability report requires a bearer. Authenticated viewers may inspect scheduler state, while mutations require admin/operator authority. Operator-token mode requires its bearer; loopback-only open mode remains available only when no access mechanism is configured. Sanitized auth, provider, core-model, and runtime status surfaces remain public for login-time availability reporting.

The Schedules cockpit uses `authenticatedFetch` and server state only. It shows runtime availability, configured origins, contract version and bounds, next due time, run/failure counters, active occurrence, lease/fence/deadline metadata, catch-up evidence, mission/report references, and status reasons. It can create a disabled schedule, enable or disable it with a reason, request a tick, and explicitly resume or skip blocked work. Viewer sessions render mutations disabled. No schedule or occurrence state is stored in browser storage.

## 6. Verification And Boundaries

Focused coverage includes:

- Canonical contracts, immutable authority, interval calculations, latest-once catch-up, deterministic occurrence ids, leases, fences, resume, skip, and invalid transitions.
- Single-process atomic run claiming, deadline-bound authenticated report completion, concurrent tick deduplication, Stop All cancellation, explicit resume, restart-to-uncertain recovery, live-recovery refusal, explicit skip, origin revocation before dispatch, non-cooperative adapter cancellation, and cumulative runtime/source budgets.
- Clock recovery-before-start, non-overlap, start/stop race fencing, error status, abort, bounded shutdown, timed-out generation detachment, and clean restart.
- Authenticated API reads and role-scoped mutations.
- Runtime capability reporting, server configuration, cockpit actions, viewer restrictions, and application tab integration.

This milestone is not a generic job scheduler. It does not add arbitrary commands, desktop control, email, communications, MCP/OAuth connectors, downloads, cron, provider failover, source discovery, or autonomous self-modification. It also does not provide multi-process coordination: exactly one trusted parent process may own a given `.agent-kernel` runtime directory. Those remain separate capability and deployment milestones with their own authority and verification requirements.

Final verification on 2026-07-15: `npm run lint`, the complete **410-test / 70-file** `npm test` suite, `npm run build`, `npm run verify-ledger` against **252 hash-chained events**, `npm audit --audit-level=high`, `git diff --check`, a repository secret-marker scan, and live compiled-server health, authentication, scheduler, and static-bundle checks all passed. The two protected cockpit suites pass **14 component tests** covering creation, controls, viewer restrictions, logout, and action-time `401` revocation. The in-app browser automation bridge failed before page inspection with `Cannot redefine property: process`; no automated visual-browser pass is claimed. Test and ledger totals are timestamped evidence; the ledger count grows with normal use.

# Current State - Capability Matrix

Date: 2026-07-15
Purpose: the authoritative concise answer to "what does this product do, and what is still missing?"

Verification note: the pre-hardening baseline was **242 tests across 51 files**, and the trust-boundary pass closed at **297 tests across 62 files**. Durable Recurring Research v1 is `npm run lint` clean, **410 tests across 70 files**, `npm run build` clean, and `npm run verify-ledger` clean against **252 hash-chained events** on 2026-07-15. The ledger count is timestamped runtime evidence and will grow with use.

## What This Product Is

Provenance is a local-first agent control plane with a browser dashboard and a trusted TypeScript kernel. The kernel owns goals, evidence, budgets, approvals, memory, skills, provider calls, capability dispatch, automations, research mission checkpoints, authenticated report artifacts, recovery, snapshot commits, and release records. Models propose content and actions; deterministic policy and explicit human authority decide what can persist or execute.

Multi-user authentication exists, but users share one local kernel state. The product is therefore a loopback-oriented local deployment, not a hardened multi-tenant service.

## Capability Matrix

Legend: **Implemented** = present with focused tests; **Live** = also verified against the real local runtime; **Partial** = useful within a documented boundary; **Boundary** = deliberately unavailable rather than simulated.

| Capability | State | Current boundary |
| --- | --- | --- |
| Goal contracts and evidence-gated tasks | Implemented | Planner executes only allowlisted verification commands. |
| Budgets and Stop All | Implemented | Budgets are local counters; Stop All is a persisted kernel control. |
| Provider gateway for chat/extract/mutate/skill draft | Implemented | Uses configured providers only; no direct legacy Gemini bypass. |
| Provider routing | Partial | Automatic, pinned, and ensemble routes exist; live availability depends on credentials and upstream service. Bedrock remains unavailable without its runtime. |
| Research to Verified Report | Implemented | One objective plus 1-5 explicit allowlisted HTTPS seed URLs; L0 read-only capture, authenticated chunks/artifacts, provider plan/synthesis/critic, exact-citation checks, and a hash-bound Markdown report. No generic search or source discovery. "Verified" means citation-grounded, not guaranteed truth. |
| Durable recurring research | Implemented | Disabled-by-default fixed-source interval schedules; latest-once catch-up, single-process atomic occurrence/mission claims, cumulative run/failure/runtime/source/attempt bounds, lease fences, Stop All cancellation, deadline-bound authenticated report completion, and no-replay restart recovery. Not a generic cron or command scheduler. |
| Durable memory lifecycle | Implemented | Promotion requires explicit reason plus independent source-backed ledger evidence; candidate creation cannot attest itself. |
| Bounded skill foundry | Implemented | Executes only `pure-transform-v1`; canary runs use kernel-generated fixtures and a separate reference interpreter, with no caller oracle at run time. |
| Authenticated dashboard | Implemented | Supports status, operator token, first-admin bootstrap, login, logout, and revoked-session handling. Authoritative kernel reads require a bearer outside open mode; viewers are read-only. |
| Loopback request protection | Implemented | Host/origin and `Sec-Fetch-Site` checks protect mutations; security headers are applied. This is not remote-service hardening. |
| Browser inspect worker | Partial | L0, origin-allowlisted, bounded read-only fetch. |
| Playwright browser worker | Live | Navigate/click/type are minimum L2, approval-gated, and origin-checked before and after navigation. Downloads are unavailable. |
| Approval continuation | Implemented | L2/L3 runs persist an approval; a matching approved record can authorize a later execution. |
| Capability dispatch gate | Implemented | Grant is persisted and consumed before I/O; a one-use opaque authorization must be claimed immediately before dispatch. |
| Hash-addressed artifact store | Implemented | Text entry resolves a pre-staged value and verifies the intent-declared hash; payload content is not ledgered. |
| Docker command sandbox | Live | No network, read-only root, bounded resources, workspace mount. Trusted-host fallback is reported when Docker is absent. |
| Parallel goal execution | Implemented | Up to eight goal steps; worker commands overlap while kernel state mutations remain serialized. |
| Event ledger and snapshot integrity | Implemented | Hash-chained ledger plus ledger-authenticated canonical snapshot hash, recovery replica, interrupted-commit repair, and abandoned-tail evidence. Not full event-sourced reconstruction. |
| Controlled staged releases | Implemented | Canonical authorization signature, evaluation/artifact verification, controlled install, supervised Node readiness, atomic process switch, failure rollback, and startup restoration. Does not rewrite source or hot-replace the trusted parent control plane. |
| OS secret vault | Partial | Windows DPAPI is live-verified; macOS Keychain and Linux Secret Service are implemented but need target-OS live validation. Values are never returned. |
| Multi-user access control | Implemented | Scrypt password records, signed expiring/revocable sessions, admin/operator/viewer roles; no per-user data partitioning. |
| Kernel-backed dashboard state | Implemented | Authoritative memory/skill/provider state comes from APIs. `localStorage` retains presentation-only chat state and lens selection; `sessionStorage` may hold the transient active bearer, whose validity remains server-authoritative. |
| Optional on-device core model | Partial | Advisory tighten-only injection assessment; it cannot bypass provider routing or kernel authority. |

## Security-Critical Flows

### Application AI

`/api/chat`, `/api/extract`, `/api/mutate`, and `/api/self-improve` pass through the application AI router, the configured provider policy, kernel provider-call accounting, ledger evidence, and the unified mutation access guard. Provider results include route provenance. Extraction creates candidates; it does not promote memory.

### Research missions

The Research Missions cockpit creates a kernel-owned five-stage DAG: plan, collect, synthesize, verify, and publish. Seed URLs must be unique canonical HTTPS URLs whose origins are already in `WEB_INSPECT_ORIGINS`. The provider cannot add a URL, call a tool, or change mission authority. Collection uses only `browser.inspect` at L0, blocks redirects, pins the requested/final origin, and stores bounded source text in authenticated artifacts. Prompt-injection assessment may quarantine a source; a quarantined source is excluded from synthesis and critique.

Plan, synthesis, and a separate critique pass use the configured provider router, goal budget, structured schemas, route evidence, and a 60-second provider timeout. Separate means another request and stage, not necessarily another provider or model. Deterministic verification re-resolves artifact and chunk hashes, requires each quotation to be a specific exact excerpt of at least 20 characters and three words, and requires distinct origins and content hashes for high confidence. Publication occurs only after those checks and a passing critique; dynamic Markdown/HTML is escaped. The report endpoint rechecks the authenticated publication inputs, each source artifact and reconstructed chunk map, the cited source/provider/verification ledger events, and the final report artifact before returning content.

Each external step records an active checkpoint before dispatch. Concurrent step requests observe `in_progress` rather than dispatching twice. Stop All aborts active provider and source controllers and prevents result commit. On restart, uncertain in-flight work is recovered as blocked; only retryable failures can resume, and the operator must provide a reason recorded as mission and task evidence. Bounded grounding retries stop after three synthesis attempts.

When operator-token or multi-user access control is configured, every authoritative `/api/kernel` GET except the sanitized runtime capability report requires a valid bearer credential. Multi-user viewers may read mission state; mission mutations remain limited to admin/operator sessions. Sanitized auth, provider, core-model, and runtime status endpoints stay public for login-time availability reporting. In loopback-only `open` mode, reads and mutations are available without a bearer because no access mechanism is configured.

### Durable recurring research

The Schedules cockpit creates interval-only contracts for the bounded report mission. The objective and one to five canonical allowlisted HTTPS sources are fixed, authority is derived as read-only L1 with no side effects, schedules begin disabled, and updates cannot increase scope, frequency, or budgets. Intervals range from 15 minutes through 365 days. `latest_once` catch-up claims only the newest missed boundary and records the skipped count.

Under the mutation queue of one trusted kernel process, the kernel rechecks current source origins and atomically persists the deterministic occurrence id, run-budget charge, goal, mission, tasks, deadline, owner lease, and fence before dispatch. Provider and source I/O run outside that queue. Concurrent ticks see the active occurrence; stale owners and fences cannot commit. Every result write rechecks ownership, Stop All, deadline, and lease expiry. Completion requires the ordinary report authentication chain and a publication acceptance time before the persisted deadline; the occurrence stores its artifact id and content hash. Runtime and source-fetch usage accumulate across explicit retries.

Stop All and shutdown abort active recurring work; provider, worker, and optional observation-assessor awaits are abort-bounded even for non-cooperative adapters. Graceful scheduler shutdown waits at most 10 seconds before detaching a stale tick generation. Startup first authenticates and migrates the snapshot, then turns incomplete claimed/running occurrences into uncertain blocked checkpoints without replay. A fully authenticated report published before the occurrence deadline can instead be reconciled to completed. Recovery calls coalesce while recovery is already running and reject with conflict while any live external dispatch owns the process; they cannot reclassify an executing occurrence. Otherwise an operator must explicitly resume under a fresh lease/fence within the remaining cumulative budgets or skip with a reason. Protected schedule reads allow viewers; create, enable/disable, tick, resume, and skip require operator/admin authority. The main server clock is recursive and non-overlapping; release-child processes do not start it.

### Browser automation

`browser.inspect` remains L0. Navigation, clicking, typing, and downloads have an L2 minimum. Redirected or script-navigated pages are checked against the authorized origin before any click/type and again after the action. Approval-gated runs can resume only with their matching approved record. The persisted capability grant is consumed before the worker is allowed to perform I/O.

### Persistence

Every committed snapshot has a canonical content hash referenced by ledgered prepare/commit events. Startup accepts only a matching primary or authenticated recovery copy, completes interrupted publication, and marks abandoned ledger tails. The snapshot is authenticated by the ledger; domain-event payloads are not claimed to form a complete replay database.

### Releases

The Ed25519 signature binds target version, package hash, sorted evaluation references, and rollback instructions. Activation verifies the artifact and installed files, starts only the package's declared controlled `.cjs` entrypoint with a fixed Node invocation and minimal environment, then requires a nonce/version/hash IPC readiness proof and stability window. The previous supervised child remains active until commit; candidate failure terminates and removes only the candidate. Startup revalidates the complete authorization, artifact, installed hashes, and health before restoring the active child.

The trusted parent Express control plane remains stable and owns policy, signatures, and rollback. A signed child does not rewrite repository source, inherit arbitrary parent secrets, or hot-replace the parent listener.

## What Is Still Missing

- Rust/Tauri process isolation and authenticated desktop IPC.
- Native non-Docker command isolation.
- Desktop automation, OAuth connector workers, and browser downloads.
- Generic web search, source discovery, crawling, redirect following, and autonomous expansion beyond operator-supplied research seed URLs.
- Generic cron/event scheduling or recurring command, connector, email, communications, download, and desktop missions; the durable scheduler currently runs only fixed-source research reports.
- Multi-process ownership of one runtime directory; exactly one trusted parent server may own a given `.agent-kernel` because mutation and ledger queues are process-local.
- Live macOS/Linux vault verification.
- Per-user goal/memory partitioning and SSO/OIDC.
- Stable-port reverse proxying or an external blue/green cutover that replaces the trusted parent control-plane process.
- Arbitrary shell authority or arbitrary autonomous core self-modification; both are intentionally outside the security model.

## Configuration-Dependent Status

The public sanitized runtime capability report is the source of truth for local availability; it does not return credentials or authoritative stored kernel objects. Provider calls become available only when a supported server-side credential is configured. Research missions and their recurring scheduler additionally require the authenticated artifact store, the read-only inspection worker, and at least one `WEB_INSPECT_ORIGINS` entry; the cockpit reports the exact configured origins and five-source limit, while runtime status reports whether the clock is enabled, starting, running, or executing a tick. Browser write workers require an installed browser engine plus their separate origin allowlist. Docker isolation requires a reachable daemon. Release activation requires a verification key, signed authorization, evaluation references, and a staged matching executable package; the report distinguishes an idle supervisor from an active child. Unavailable integrations remain explicit instead of being simulated.

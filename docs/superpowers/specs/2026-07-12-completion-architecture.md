# Sovereign Agent Completion Architecture

Date: 2026-07-12
Status: Implemented and extended through the 2026-07-14 Durable Recurring Research v1 milestone. See `docs/superpowers/CURRENT_STATE.md` for the delivered capability matrix and remaining boundaries.
Parent design: `docs/superpowers/specs/2026-06-21-sovereign-agent-design.md`
Implementation records:
- `docs/superpowers/plans/2026-07-12-completion-implementation-record.md`
- `docs/superpowers/plans/2026-07-13-hardening-and-parallelism-record.md`
- `docs/superpowers/plans/2026-07-13-trust-boundary-hardening-record.md`
- `docs/superpowers/plans/2026-07-14-research-to-verified-report-record.md`
- `docs/superpowers/plans/2026-07-14-durable-recurring-research-record.md`

## Completion Definition

This repository is complete when it provides a coherent, test-covered local control plane for goals, evidence, memory, skills, providers, capabilities, automations, bounded research-to-report missions, durable recurring research schedules, recovery, benchmarks, and release proposals, with a dashboard that projects only recorded state.

Completion does not mean claiming unavailable isolation or external authority. The TypeScript/Express product can provide real local contracts, persistence, routing, evaluation, and bounded workers. The following remain deployment integrations until their required runtimes exist:

- Rust/Tauri process isolation and authenticated desktop IPC.
- Native non-Docker process isolation; Docker is the implemented sandbox backend and the trusted-host fallback is reported explicitly.
- Live target-OS validation for the macOS Keychain and Linux Secret Service adapters.
- Desktop, connector, browser-download, and external-identity workflows that do not have installed runtimes.
- Generic web search, source discovery, crawling, and autonomous research-scope expansion; the delivered report mission uses only explicit operator-supplied seed URLs.
- Stable-port reverse proxying or external blue/green replacement of the trusted parent control-plane process.

Those boundaries must be visible in runtime status and documentation. They may not be represented as completed actions.

## Unified Control Plane

The existing kernel remains the only writer of authoritative state. Its snapshot grows to contain:

- Goal contracts, tasks, approvals, budgets, and capabilities.
- Evidence-backed memory candidates and promoted/revoked memories.
- Skill manifests, evaluations, activation state, and rollback history.
- Provider configurations, routing telemetry, and invocation evidence.
- Capability registrations, connector status, and automation definitions.
- Mission checkpoints, recovery records, benchmark runs, and release proposals.

Every mutation is serialized with the kernel state queue and appended to the same verified event ledger. Browser local storage may retain presentation preferences and chat drafts, but it is not authoritative memory, skill, provider, or execution state.

## Phase 2: Memory And Skills

### Memory contract

Durable memory records include type, content, provenance, confidence, scope, sensitivity, retention, evidence references, contradiction links, lifecycle status, timestamps, and revocation metadata.

Memory enters as a candidate. Promotion requires an explicit reason and independent source-backed evidence; the candidate-creation event cannot attest its own truth. Revocation and supersession remain visible in the ledger.

### Skill contract

Skill packages include a manifest, declared permissions, side effects, deterministic tests, provenance, platform support, rate limits, activation state, evaluations, and rollback instructions.

Generated source remains untrusted. This repository executes only the bounded `pure-transform-v1` DSL; it does not execute arbitrary generated source as proof. Candidates bind their authenticated author and a pre-existing suite id/hash. A suite accepts no caller oracle: a separately configured, allowlisted evaluator resolver supplies hash-sealed held-out cases, the kernel attests that source before suite and candidate events, and same-author or training-overlap evidence is rejected. Evaluation and canary APIs expose metadata only. Without that evaluator trust root the feature fails unavailable.

## Phase 3: Provider Intelligence

Provider adapters implement one normalized request, response, error, usage, and telemetry contract. Google Gemini uses the installed SDK. OpenAI, OpenRouter, DeepSeek, and GLM share an OpenAI-compatible HTTP adapter with provider-specific endpoints and headers. AWS Bedrock is exposed through an adapter boundary and becomes callable only when its official runtime dependency and credentials are configured.

Routing supports automatic, pinned, and ensemble selection. It scores only configured providers and records the reason, latency, usage, failures, and estimated cost. Chat, extraction, mutation, and skill drafting use this same provider gateway, kernel accounting, and access guard. Provider output cannot modify kernel policy or grant capabilities.

Secrets are server-side only. Environment-backed credentials are supported immediately; a vault status must remain unavailable until a platform vault adapter is installed.

## Phase 4: Capabilities And Automations

The capability broker registers typed workers for code, browser, desktop, connectors, communications, and automations. A worker reports whether it is available, which scopes it accepts, and what evidence it returns.

Unavailable workers remain unavailable; the dashboard must not simulate them. Browser writes have a minimum L2 risk and require approval, including navigation and clicking. A matching approved record can authorize a subsequent run. Capability grants are persisted and consumed before I/O, and redirected/final browser origins are rechecked against the authorized scope. Automation definitions are persisted and can be evaluated deterministically, but background execution is enabled only for registered workers.

Untrusted content is tagged at ingestion. Prompt-injection heuristics can raise risk or block automatic execution, but they are defense-in-depth signals rather than proof that content is harmless.

## Phase 5: Measured Autonomy

Long-running missions use checkpoints, bounded retries, recovery records, and Stop All state. Interrupted running tasks are recovered into an inspectable blocked state rather than silently resumed. Snapshot contents are authenticated by ledgered state hashes and an authenticated recovery copy; this is content authentication, not a claim of complete event-sourced reconstruction.

### Research to Verified Report

The first closed-loop mission is intentionally narrow. An operator supplies one objective and one to five unique canonical HTTPS seed URLs. Every origin must already exist in `WEB_INSPECT_ORIGINS`. The kernel creates a sequential `planning -> collecting -> synthesizing -> verifying -> publish` task graph with bounded operations and provider calls. The mission cannot search, crawl, follow redirects, accept provider-suggested sources, invoke commands, use browser writes, or add authority from captured text.

Planning, synthesis, and critique go through the same configured provider router, kernel accounting, structured-output validation, and ledger evidence as other provider work. Calls run with a fixed bounded timeout and reject tool calls or ensemble disagreement. Source capture is an L0 `browser.inspect` intent scoped to the exact seed origin and URL. The worker blocks redirects and unsupported content, while the kernel stores normalized bounded text as a hash-addressed artifact, derives deterministic source chunks, and quarantines high-risk injection observations.

Deterministic citation verification is independent of provider judgment. The kernel re-resolves source artifacts, recomputes source and chunk hashes, requires every quotation to be a specific exact contiguous chunk excerpt of at least 20 characters and three words, and permits high confidence only with two eligible sources whose origins and content hashes are distinct. A separate critique request then evaluates whether claim breadth and confidence match those excerpts; routing may select the same provider and model used by another stage. Publication renders only escaped, passed structured claims plus kernel-owned citations and provenance; it does not publish free provider prose. Report retrieval reauthenticates the publication input hash, source artifacts and reconstructed chunk maps, cited source/provider/verification events, and final report artifact.

Before any external call, the mission persists an active-step checkpoint. Duplicate step requests return `in_progress`. Stop All aborts active provider and source work and prevents successful results from committing after the stop. Provider calls time out after 60 seconds, grounding/critique correction is bounded to three synthesis attempts, and restart recovery turns uncertain running work into a blocked mission. Retryable blocked work requires an explicit operator reason before the checkpoint becomes runnable again.

The dashboard cockpit exposes mission creation, configured origins, run/step controls, explicit resume, budgets, task status, source risk and hashes, grounded claims, critique results, evidence events, provider route/token/latency data, and the authenticated report. When access control is configured, mission configuration, list, detail, and report reads require a valid bearer; multi-user viewers remain read-only, while mutations require admin/operator authority. In loopback-only `open` mode, no bearer is required. In this architecture, **verified** means that the published claims are grounded in exact excerpts from the captured seed artifacts and passed the recorded checks. It is not a guarantee that those sources are truthful, current, complete, or independent.

### Durable Recurring Research v1

The first background scheduler is deliberately specific to the verified-report mission. An interval contract fixes its objective and one to five allowed HTTPS sources, derives read-only L1 authority, begins disabled, and cannot later add sources, move its anchor, increase frequency, increase a budget, invoke commands, or acquire side effects. Intervals are bounded from 15 minutes through 365 days and use only `latest_once` catch-up. Cron and generic event triggers are not accepted.

Within one trusted kernel process, one serialized claim transaction rechecks current origin authority and persists the deterministic occurrence, run charge, goal, mission, tasks, deadline, owner lease, and fence. External provider/source execution follows outside the queue. The active occurrence suppresses duplicate ticks in that process; only the current lease/fence can record an outcome; successful completion additionally authenticates the report artifact and a publication accepted before the durable deadline. Persisted max-run, consecutive-failure, cumulative runtime, cumulative source-fetch, and three-attempt limits halt rather than expand themselves. A runtime directory is owned by exactly one trusted parent process; the process-local mutation and ledger queues are not a multi-process coordination mechanism.

The server awaits recovery before exposing routes. The recursive clock never overlaps ticks and is absent in controlled release-child processes. Stop All and shutdown propagate cancellation; provider, worker, and observation-assessor awaits are abort-bounded, and graceful shutdown waits up to 10 seconds before detaching a non-settling tick generation. Recovery requires a quiescent kernel, coalesces concurrent recovery requests, and cannot sweep work owned by a live external-dispatch controller. Restart never automatically replays claimed/running work: recovery reconciles a fully authenticated preexisting report only when its publication was accepted before the occurrence deadline, or records an uncertain blocked occurrence and disables the schedule. Resume and skip are authenticated explicit-resolution actions; resume creates a new lease and higher fence without resetting cumulative budgets. The kernel-backed cockpit exposes contracts, counters, due state, occurrences, leases, deadlines, catch-up, linked missions, report hashes, and reasoned controls without using browser storage as authority.

Benchmark runs record task definitions, expected evidence, completion, intervention count, command runtime, provider-call count, and evidence event ids. A release authorization signature binds target version, package hash, evaluation references, and rollback instructions. Activation installs a matching package only beneath the controlled release directory, launches its fixed `.cjs` entrypoint under the process supervisor, requires IPC readiness and stability, and retains the previous child until commit. Failure restores the previous manifest/process, and startup revalidates and restores the active child. The signed child cannot rewrite source or replace the trusted parent control plane.

## Verification Gates

Each phase requires focused unit and integration tests before integration. Final completion requires:

- Full unit and API test suite.
- Type checking and production build.
- Ledger, snapshot, permission, recovery, and prompt-injection failure tests.
- Provider conformance tests using deterministic fake transports.
- Research mission tests for fixed seed authority, exact citations, source quarantine, bounded retries, duplicate-dispatch prevention, authenticated report retrieval, Stop All, provider timeout, and restart-safe blocked recovery.
- Recurring research tests for contract narrowing, latest-once catch-up, atomic deduplication, lease fences, authenticated completion, runtime/run/failure bounds, Stop All, origin revocation, restart uncertainty, explicit resume/skip, non-overlapping clocks, authenticated API roles, and cockpit state.
- Browser smoke testing of authoritative dashboard state.
- An unsupported-claim scan over source and documentation.
- A runtime capability report that distinguishes available, configured, unavailable, and blocked features.

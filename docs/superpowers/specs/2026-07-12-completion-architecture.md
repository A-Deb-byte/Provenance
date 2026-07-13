# Sovereign Agent Completion Architecture

Date: 2026-07-12
Status: Implemented and verified (2026-07-13). See `docs/superpowers/CURRENT_STATE.md` for the delivered capability matrix and remaining boundaries.
Parent design: `docs/superpowers/specs/2026-06-21-sovereign-agent-design.md`
Implementation records:
- `docs/superpowers/plans/2026-07-12-completion-implementation-record.md`
- `docs/superpowers/plans/2026-07-13-hardening-and-parallelism-record.md`

## Completion Definition

This repository is complete when it provides a coherent, test-covered local control plane for goals, evidence, memory, skills, providers, capabilities, automations, recovery, benchmarks, and release proposals, with a dashboard that projects only recorded state.

Completion does not mean claiming unavailable isolation or external authority. The TypeScript/Express product can provide real local contracts, persistence, routing, evaluation, and bounded workers. The following remain deployment integrations until their required runtimes exist:

- Rust/Tauri process isolation and authenticated desktop IPC.
- A true operating-system credential vault on every supported platform.
- An operating-system sandbox that confines arbitrary project scripts.
- Credentialed provider, connector, browser-session, or desktop workflows that cannot be exercised without user configuration.
- Signed production releases backed by a user-controlled signing key.

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

Memory enters as a candidate. Promotion requires source-backed evidence and an explicit reason. Revocation and supersession remain visible in the ledger.

### Skill contract

Skill packages include a manifest, declared permissions, side effects, deterministic tests, provenance, platform support, rate limits, activation state, evaluations, and rollback instructions.

Generated source remains untrusted. This repository validates manifests and records deterministic evaluation evidence; it does not execute arbitrary generated source as proof. Promotion requires a passing evaluation that beats its recorded baseline without expanding declared permissions.

## Phase 3: Provider Intelligence

Provider adapters implement one normalized request, response, error, usage, and telemetry contract. Google Gemini uses the installed SDK. OpenAI, OpenRouter, DeepSeek, and GLM share an OpenAI-compatible HTTP adapter with provider-specific endpoints and headers. AWS Bedrock is exposed through an adapter boundary and becomes callable only when its official runtime dependency and credentials are configured.

Routing supports automatic, pinned, and ensemble selection. It scores only configured providers and records the reason, latency, usage, failures, and estimated cost. Provider output cannot modify kernel policy or grant capabilities.

Secrets are server-side only. Environment-backed credentials are supported immediately; a vault status must remain unavailable until a platform vault adapter is installed.

## Phase 4: Capabilities And Automations

The capability broker registers typed workers for code, browser, desktop, connectors, communications, and automations. A worker reports whether it is available, which scopes it accepts, and what evidence it returns.

Unavailable workers remain unavailable; the dashboard must not simulate them. Side-effecting or externally visible actions require approvals according to the risk ladder. Automation definitions are persisted and can be evaluated deterministically, but background execution is enabled only for registered workers.

Untrusted content is tagged at ingestion. Prompt-injection heuristics can raise risk or block automatic execution, but they are defense-in-depth signals rather than proof that content is harmless.

## Phase 5: Measured Autonomy

Long-running missions use checkpoints, bounded retries, recovery records, and Stop All state. Interrupted running tasks are recovered into an inspectable blocked state rather than silently resumed.

Benchmark runs record task definitions, expected evidence, completion, intervention count, cost, latency, and provider route. Release proposals contain hashes, evaluation references, rollback instructions, and explicit activation state. Unsigned proposals cannot activate core changes.

## Verification Gates

Each phase requires focused unit and integration tests before integration. Final completion requires:

- Full unit and API test suite.
- Type checking and production build.
- Ledger, snapshot, permission, recovery, and prompt-injection failure tests.
- Provider conformance tests using deterministic fake transports.
- Browser smoke testing of authoritative dashboard state.
- An unsupported-claim scan over source and documentation.
- A runtime capability report that distinguishes available, configured, unavailable, and blocked features.

# Provenance

A local-first, self-hosted AI agent control plane with a trusted kernel. Models propose; policy, budgets, approvals, and capability grants decide what may execute; durable mutations leave hash-chained evidence.

The name is literal: promoted memory and privileged execution must trace to recorded evidence rather than a model's assertion.

## Current Status

Provenance now provides:

- A TypeScript kernel for goal contracts, task state, budgets, approvals, capabilities, automations, recovery, and a tamper-evident event ledger.
- A closed-loop Research to Verified Report mission that plans, captures operator-supplied sources, synthesizes exact-citation claims, runs a separate critique, and publishes an authenticated Markdown artifact.
- Durable recurring research schedules with fixed read-only authority, latest-once interval catch-up, single-process atomic claims, owner leases and fences, cumulative runtime/source/run/failure bounds, Stop All cancellation, and restart-safe explicit resolution.
- A shared application AI gateway for chat, extraction, mutation, and bounded skill drafting. These routes use the configured provider router, kernel provider-call budgets, ledger evidence, and the same mutation access guard as the cockpit.
- Normalized provider routing for Google Gemini, OpenAI, OpenRouter, DeepSeek, and GLM, plus an explicit unavailable boundary for AWS Bedrock when its runtime is absent.
- Evidence-backed memory and a bounded `pure-transform-v1` skill foundry that never executes model-generated source code.
- Read-only web inspection and a Playwright browser worker for navigation, clicking, and hash-addressed text entry.
- A Docker command sandbox when Docker is available, with an explicitly reported trusted-host fallback when it is not.
- Windows DPAPI, macOS Keychain, and Linux Secret Service vault adapters, selected and reported by platform.
- Dashboard authentication for operator-token, bootstrap, login, role-scoped sessions, logout, and session revocation.
- A Windows Native Desktop Runtime v1 source slice: a Tauri/Rust host owns and supervises the local Node control plane, an authenticated loopback bridge exposes bounded UI Automation, and the dashboard routes desktop work through kernel policy, approval, capability, and ledger boundaries.
- Controlled staged releases with canonical authorization signatures, evaluation gates, verified installation, supervised process readiness, restart restoration, and rollback on activation failure.

This is a substantial local control plane, not an unrestricted self-modifying agent. Remaining deployment boundaries are listed below.

## Trust Boundaries

### Application AI and providers

`POST /api/chat`, `/api/extract`, `/api/mutate`, and `/api/self-improve` share the provider contract under `src/app-ai/`. Calls are normalized, schema-constrained where appropriate, budgeted by the kernel, and recorded with provider/model route evidence. The skill-drafting endpoint may propose only bounded transform operations and deterministic cases; it cannot submit arbitrary JavaScript for execution.

Provider credentials stay server-side in environment variables or the OS vault. The browser receives provider status and routing metadata, never credentials. AWS Bedrock remains unavailable until its supported runtime and credentials are installed.

### Research to Verified Report

An authenticated operator can create a bounded report mission from one objective and one to five explicit HTTPS seed URLs. Every seed origin must already be present in `WEB_INSPECT_ORIGINS`. The mission does not search for sources, follow redirects, accept provider-created URLs, or widen its own scope. Capture uses the L0 `browser.inspect` worker only; browser writes, commands, downloads, cookies, and approval-bearing actions are outside this workflow.

Planning, synthesis, and a separate critique pass use the configured provider router, kernel provider-call budget, schema-constrained output, and ledger evidence. Separate means a distinct request and verification stage; routing may select the same provider and model for more than one stage. Captured text is treated as untrusted data, bounded and split into deterministic chunks, then stored as a hash-addressed artifact. High-risk prompt-injection observations are quarantined. A claim is eligible for publication only when its source artifact and chunk hashes resolve, its quotation is an exact contiguous excerpt of at least 20 characters and three words, its confidence satisfies deterministic rules, and the critique passes without an error. High confidence additionally requires two sources with distinct origins and content hashes. Dynamic report text is Markdown/HTML escaped. On every report read, the kernel revalidates the publication input hash, source artifacts and reconstructed chunks, source/provider/verification events, and the final authenticated artifact.

Mission checkpoints and active-step records prevent duplicate dispatch. Stop All aborts active provider and source work, provider calls have a bounded timeout, and an interrupted external step becomes blocked after restart instead of being silently replayed. A retryable blocked mission requires an explicit, ledgered operator resume reason. Here, **verified** means citation-grounded against the captured seed artifacts; it does not guarantee that the sources are true, complete, current, or mutually independent.

When operator-token or multi-user access control is configured, every authoritative `/api/kernel` read requires a valid bearer credential except the sanitized runtime capability report. Multi-user viewers may inspect mission state and reports; only admin/operator sessions may create, run, step, or resume a mission. The loopback-only `open` mode remains available when neither access mechanism is configured.

### Durable recurring research

The authenticated Schedules cockpit can turn the same bounded report workflow into an interval mission. A schedule fixes its objective and one to five allowlisted HTTPS sources, derives read-only L1 authority, and is always created disabled. Intervals range from 15 minutes through 365 days. Catch-up is `latest_once`, so downtime produces at most one new occurrence while recording the skipped boundaries. Cron, source discovery, redirects, commands, browser writes, downloads, and provider-created URLs remain outside the contract.

Within one trusted kernel process, the kernel atomically claims a deterministic occurrence together with its goal, mission, tasks, run-budget charge, deadline, lease, and fence before any I/O. Concurrent ticks in that process cannot duplicate dispatch. Source and provider work execute outside the mutation queue, while result commits require the current lease/fence, a clear Stop All state, remaining deadline, and authenticated report publication. Run, consecutive-failure, cumulative runtime, cumulative source-fetch, and attempt limits are persisted rather than advisory.

Stop All and server shutdown abort active occurrences. Provider and worker awaits are abort-bounded even when an adapter ignores its signal. Graceful scheduler shutdown waits up to 10 seconds, then detaches a non-settling tick and relies on durable restart recovery. Startup never silently replays a claimed or running occurrence: it reconciles a fully authenticated report only when publication was accepted before the persisted deadline, otherwise marks the outcome uncertain, blocks the mission, disables the schedule, and requires an operator to resume under a fresh fence or skip with a recorded reason. The main server clock is default-on and configurable; controlled release-child processes never start a second clock.

### Authentication and loopback access

All mutating application, provider, kernel, and vault routes pass the unified access guard. The active mode is:

- `multi_user` when accounts exist: admin/operator sessions may mutate; viewers are read-only.
- `operator_token` when no accounts exist and `KERNEL_API_TOKEN` is configured.
- `open` only when neither accounts nor an operator token exist, on the loopback-only deployment.

When an operator token is configured, it is also required to bootstrap the first administrator. The dashboard can bootstrap, log in, use an operator token, log out, and clear revoked credentials. Loopback host/origin checks reject cross-site mutations and security headers constrain browser embedding and content sources.

In `multi_user` and `operator_token` modes, authoritative kernel reads also require a bearer; viewers may read but cannot mutate. `/api/kernel/runtime-report`, `/api/providers/status`, `/api/core-model/status`, and `/api/auth/status` remain public sanitized status surfaces so the login screen can describe availability without exposing credentials or stored kernel objects. In loopback-only `open` mode, no bearer is required by design.

### Memory and skills

Memory records follow `candidate -> promoted -> superseded/revoked`. Promotion requires an explicit reason and at least one independent, source-backed ledger event; a candidate's own creation event is not acceptable evidence. Provider extraction creates candidates only and cannot silently promote or delete durable memory.

The skill foundry synthesizes an allowlisted text-transform DSL, compares it with a baseline, evaluates submitted replay cases, and then canaries kernel-generated fixtures against a separate reference interpreter. The canary-run endpoint accepts no caller input or expected output. Promotion requires every independent canary run to pass and remains reversible.

### Browser actions, approvals, and grants

`browser.inspect` is read-only L0. Browser navigation, clicking, typing, and downloads have a minimum L2 risk and require explicit approval. The browser driver checks the allowlisted origin before an action, after navigation, and after click/script-driven navigation; redirects cannot silently widen scope.

For approval-gated automations, the first run creates a persisted approval. A later run may consume the matching approved record and execute within that exact intent. Capability grants are persisted and consumed before worker I/O; the worker must claim the resulting opaque one-use dispatch authorization immediately before acting.

### Native desktop runtime v1

The Windows desktop source slice places a Tauri/Rust host above the existing TypeScript control plane. The host acquires exclusive ownership of the `.agent-kernel` runtime before Node opens it, supervises the fixed `dist/server.cjs` entrypoint under a kill-on-close Windows job, and accepts readiness only from a per-launch nonce-bound file. A standalone Node launch uses the same owner record and refuses to open a runtime already held by a live owner. This is single-owner fencing, not multi-process shared-state coordination.

The native bridge binds to an ephemeral `127.0.0.1` port. Requests and responses are HMAC-SHA256 authenticated with a per-launch secret; request ids, bounded timestamps, body hashes, response status, and nonce replay protection are part of the protocol. The Node process registers the Windows worker only after authenticated health reports the exact expected capabilities and application allowlist. Bridge credentials and runtime-owner nonces are generated for one supervised launch and are neither dashboard configuration nor persisted authority.

Desktop use requires `operator_token` or `multi_user` access control; it is blocked in loopback `open` mode. `desktop.discover` and `desktop.inspect` are L0 read-only operations. `desktop.click` and `desktop.type` are minimum L2 and execute only after the matching approval is consumed and a one-use capability dispatch is claimed. Every request remains scoped to an allowlisted executable identity; mutations additionally bind the discovered window, UI tree revision, and node id. Text is resolved from a hash-addressed artifact rather than accepted from an observation. UI Automation output is untrusted evidence and cannot grant authority.

The v1 worker does not expose shortcuts, elevation, arbitrary shell execution, plugins, downloads, an installer, or an updater. Native availability is health-gated and remains unavailable when the host, access mode, allowlist, or authenticated bridge is not ready.

### Snapshots and recovery

The JSONL ledger is hash-chained and independently verifiable with `npm run verify-ledger`. Snapshot content is authenticated by ledgered prepare/commit events containing the canonical state hash. Startup validates the primary and authenticated recovery copy, completes interrupted commits, and records abandoned ledger tails during recovery.

This authenticates a snapshot against the ledger. It is not a claim that every historical snapshot can be reconstructed solely from domain-event payloads.

### Controlled releases

A release signature covers the target version, package hash, sorted evaluation references, and rollback instructions. The matching staged package must declare a controlled `.cjs` entrypoint and pass path, size, and file-hash validation. Activation installs only beneath the controlled releases directory, performs the installed-file health check, launches the candidate with a fixed Node invocation and minimal environment, and requires a nonce/version/hash IPC readiness proof plus a stability window before committing the active manifest and stopping the previous child.

Candidate failure terminates and removes the candidate while leaving the previous process and manifest active. Startup revalidates the persisted proposal, signature, evaluations, artifact, installed files, and health before restoring the supervised child. This is a bounded operator-signed core service, not permission for a model to rewrite source or replace the trusted parent Express control plane.

Generate the operator release key outside the repository, then sign a proposal JSON document containing `targetVersion`, `contentHash`, `evaluationEventIds`, and `rollbackInstructions`:

```bash
node scripts/release-signing.mjs generate /secure/path/release-private.pem
node scripts/release-signing.mjs sign /secure/path/release-private.pem proposal.json
```

## Dashboard State

The right-hand memory view is kernel-backed and read-only. Legacy `localStorage` keys for memory, profile, provider-like configuration, and skill drafts are purged. `localStorage` is limited to presentation state such as local chat sessions, the selected chat lens, and the active session id. `sessionStorage` may hold the transient active bearer for the current tab, but its validity remains server-authoritative; neither store is authoritative memory, skill, provider configuration, approval, or release state.

## Optional Core Model

OpenBMB MiniCPM5-1B can run in-process through `node-llama-cpp` as an advisory, tighten-only prompt-injection assessor. It may raise risk above deterministic heuristics but cannot lower the heuristic floor, decide policy, issue capabilities, write the ledger, or promote memory.

Place a compatible GGUF file at `.agent-kernel/models/minicpm5-1b.gguf` or set `CORE_MODEL_PATH`. Application chat and extraction still use the provider gateway; the core model is not a bypass around routing, budgets, or access control.

## Setup

```bash
git clone https://github.com/A-Deb-byte/Provenance.git
cd Provenance
npm ci
```

Create `.env` from `.env.example`. For OpenRouter, configure a server-side key and model, for example:

```bash
AI_PROVIDER=openrouter
AI_MODEL=openrouter/free
OPENROUTER_MODEL=openrouter/free
OPENROUTER_API_KEY=your_server_side_value
```

Do not put provider keys in browser storage or commit them. The OS-vault API is the preferred local at-rest store where its platform adapter is available.

Enable read-only research capture by allowlisting only the origins that may host operator-supplied seed URLs:

```bash
WEB_INSPECT_ORIGINS=https://example.com,https://docs.example.org
```

The mission UI accepts full HTTPS URLs on those origins. This is a static capture allowlist, not permission for general crawling or search.

The recurring scheduler clock is enabled for the main server by default. Every schedule is still created disabled and needs an explicit authenticated enable action:

```bash
RECURRING_RESEARCH_SCHEDULER_ENABLED=true
RECURRING_RESEARCH_TICK_MS=15000
```

The clock interval is clamped to 1-60 seconds; durable mission intervals remain independently bounded to 15 minutes through 365 days.

On Windows, Native Desktop Runtime v1 additionally requires Rust stable MSVC 1.85 or newer, the Visual Studio 2022 Desktop development with C++ workload, a Windows 10/11 SDK, WebView2 Evergreen, and a canonical `node.exe`. Configure an operator token or bootstrap a multi-user account, then add a narrow executable allowlist to `.env`:

```dotenv
KERNEL_API_TOKEN=choose-a-long-random-value
DESKTOP_APP_ALLOWLIST='[{"appId":"windows.notepad","executablePath":"C:\\Windows\\System32\\notepad.exe"}]'
```

The JSON must contain 1-32 unique objects with only `appId` and `executablePath`. Application ids use lowercase letters, digits, `.`, `_`, or `-`; each path must already be an absolute normalized `.exe` path. `npm run desktop:dev` preloads `.env` before it starts Tauri; a directly launched host binary must receive `DESKTOP_APP_ALLOWLIST` in its process environment. `PROVENANCE_PROJECT_ROOT` and `PROVENANCE_NODE_EXECUTABLE` may override the canonical repository and Node paths for native development. Native runtime state is placed under Tauri's per-user local application-data directory, outside the repository command workspace; standalone Node retains the repository-local `.agent-kernel` default. The native host generates the bridge secret, a private runtime-owner proof, its expected host PID, runtime path, and readiness values for the supervised child. Only the owner's SHA-256 proof hash is written to disk. Do not place any per-launch value in `.env`.

Run the development server:

```bash
npm run dev
```

Build and start the compiled server:

```bash
npm run build
npm start
```

Build the web/server artifacts and launch or compile the native host on a prepared Windows machine:

```bash
npm run desktop:dev
npm run desktop:build
```

Bundling is intentionally disabled in v1. `desktop:build` verifies the host binary; it does not create an installer or configure automatic updates.

## Verification

```bash
npm run lint
npm test
npm run build
npm run verify-ledger
npm run desktop:test
npm run desktop:check
```

The last baseline before the 2026-07-13 trust-boundary hardening was **242 tests across 51 files**, and that hardening closed at **297 tests across 62 files**. Durable Recurring Research v1 closed at **410 tests across 70 files**. Native Desktop Runtime v1 currently passes **455 tests across 78 files**; `npm test` remains the source of truth as the suite evolves. The 2026-07-15 ledger check authenticated **252 events**; that count is timestamped runtime evidence, not a fixed product invariant.

Native Desktop Runtime v1 has TypeScript integration and focused tests in this source tree. Rust/Cargo produced the committed `Cargo.lock`; clean WSL formatting and locked cross-target `cargo check --all-targets` plus Clippy with warnings denied pass for `x86_64-pc-windows-msvc`. The prepared Windows runner then completed TypeScript lint/tests/build, Rust formatting, native Rust tests, all-target checking, and Clippy in [Native desktop verification run 29398628867](https://github.com/A-Deb-byte/Provenance/actions/runs/29398628867). This development machine still lacks the local MSVC/Windows SDK link environment and local Windows `rustfmt` remains blocked by Application Control; the passing CI run establishes compilation/link/test evidence, not live interactive UI Automation evidence.

## Deployment Boundaries

- The Rust/Tauri host and authenticated desktop IPC compile and pass native Rust tests on the prepared Windows CI runner, but have not driven a real allowlisted application in an interactive Windows session. Availability stays health-gated; the TypeScript kernel remains the policy authority.
- Docker supplies real command isolation when available. Without Docker, the runtime reports and uses a trusted-host fallback; the desktop host's child-process job does not provide a general command sandbox, and native Windows command isolation or Linux namespace/seccomp isolation is not implemented.
- Desktop v1 is limited to allowlisted discovery, inspection, click, and hash-bound typing. Typed text lives only in a bounded, expiring, consume-once in-memory store; it is not written to the general artifact directory. A timeout, Stop All, transport loss, executor loss, or failed post-write observation after native mutation dispatch is recorded as `automation.run_uncertain` and blocks retry of that automation. Stop All cannot undo an OS side effect already accepted by UI Automation.
- The host watches the Node child, bridge task, and UI Automation broker. Loss of any one clears web storage and closes the dashboard instead of leaving its loopback page active. The v1 browser-facing listener is still the supervised Node listener rather than a Rust-owned reverse proxy, so this is fail-closed monitoring rather than a formal proof against every same-user local port-rebinding race.
- Shortcuts, elevation, shell authority, downloads, OAuth connector runtimes, plugins, installers, automatic updates, and arbitrary desktop missions are not implemented.
- Research missions do not provide generic web search, source discovery, crawling, redirect following, or automatic expansion beyond the explicit seed URLs.
- Durable scheduling is currently limited to the fixed-source Research to Verified Report workflow; there is no generic cron, arbitrary command, connector, email, or desktop mission scheduler.
- Exactly one native host or standalone Node server may own a given `.agent-kernel` runtime directory. Mutation and ledger queues are process-local; multi-process or high-availability sharing of one runtime is not supported.
- macOS Keychain and Linux Secret Service adapters need live validation on their target operating systems.
- Accounts share one local kernel state. There is no per-user goal/memory partitioning or SSO/OIDC.
- Supervised releases do not hot-replace or proxy the trusted parent Express control plane; stable-port traffic switching remains a deployment concern.
- Provider availability and model behavior depend on operator configuration and the upstream provider.

For the concise capability matrix, see `docs/superpowers/CURRENT_STATE.md`. Design and implementation history live under `docs/superpowers/specs/` and `docs/superpowers/plans/`.

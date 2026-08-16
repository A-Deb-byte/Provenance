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
- A connector worker for read, draft, send, and delete, with hash-verified outbound content and an uncertain-not-failed rule for lost sends. Adapters are supplied per deployment; none ships, so the family is unavailable until one is configured.
- A tiered agent fleet: definitions, spawns, tier ceilings, domains, budgets, depth and fan-out caps, orchestrated fan-out, a model-driven planner that cannot introduce a destination the kernel does not already know, and a propose-approve-dispatch loop for anything above an agent ceiling. Execution is opt-in per deployment (`AGENT_FLEET_EXECUTION=1`); the authority model applies either way.
- Ledger anchoring that binds a head hash to an event count and locates where a rewrite began. A local-only anchor log detects a rewrite solely if that log survived it; external witnessing needs a transparency log or notary that is not supplied.
- A Docker command sandbox with exact workspace health checks and an operator-configurable command allowlist of exact command+args pairs. It is deliberately not a shell. Standalone source runs retain an explicitly reported trusted-host fallback; native desktop launches fail closed and disable command execution unless Docker and the configured image are healthy.
- Windows DPAPI, macOS Keychain, and Linux Secret Service vault adapters, selected and reported by platform.
- Dashboard authentication for operator-token, bootstrap, login, role-scoped sessions, logout, and session revocation.
- A responsive operator cockpit with a server-derived Live Operations inspector for current work, budgets, provider/worker status, recorded browser and desktop targets, pending and approved-but-not-executed actions, Stop All, and sanitized evidence activity.
- A Windows Production Desktop Release v1 implementation: a Tauri/Rust host owns and supervises the local Node control plane, first-run native dialogs establish the application allowlist and command workspace, and a one-time native launch secret authorizes first-admin creation. The desktop worker can then activate without a restart, but only with its pre-registered fixed application and action authority. Development, unsigned pilot, and protected production builds use separate compiled application identities and state roots.
- A two-stage release-only NSIS pipeline for a self-contained server bundle, exact Node/Rust/Tauri/license-tool contracts, the hash-bound application license, an exactly pinned Windows x64 Node runtime and adjacent license, Authenticode signing, Tauri updater signatures, and a digest-pinned Docker image. Producing or publishing an installer still requires protected production variables, external keys and certificates, hosted artifacts, and an explicit protected release run.
- Authenticated coded diagnostics and a redacted, hash-integrity support bundle. Diagnostic exports omit credentials, authoritative payload text, absolute paths, and updater authority.
- Controlled staged releases with canonical authorization signatures, evaluation gates, installed-file verification, supervised process readiness, restart restoration, and rollback on activation failure.

This is a substantial local control plane, not an unrestricted self-modifying agent. Remaining deployment boundaries are listed below.

## Trust Boundaries

### Application AI and providers

`POST /api/chat`, `/api/extract`, `/api/mutate`, and `/api/self-improve` share the provider contract under `src/app-ai/`. Calls are normalized, schema-constrained where appropriate, budgeted by the kernel, and recorded with provider/model route evidence. The skill-drafting endpoint may propose only bounded transform operations and deterministic cases; it cannot submit arbitrary JavaScript for execution.

Provider credentials stay server-side in environment variables or the OS vault. The browser receives provider status and routing metadata, never credentials. AWS Bedrock remains unavailable until its supported runtime and credentials are installed. A provider credential was previously exposed outside the vault during project work; it must be revoked or rotated before any pilot or release. Store only the replacement in the server-side vault or deployment secret store, and never reproduce either value in source, logs, screenshots, audit evidence, or documentation.

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

The skill foundry synthesizes only the allowlisted `pure-transform-v1` DSL. A caller may reference an evaluator source id, but cannot submit oracle cases, expected outputs, author identity, or evaluator authority. A configured, allowlisted evaluator resolver supplies hash-sealed held-out cases; the kernel attests that source before sealing the suite, binds the authenticated candidate author, rejects same-author evaluation and training overlap, and keeps oracle values out of the API. Evaluation, canary, promotion, and invocation recheck the source -> suite -> candidate ledger order and hashes. Production fails closed until an independent evaluator integration is configured.

### Browser actions, approvals, and grants

`browser.inspect` is read-only L0. Browser navigation, clicking, typing, and any future download operation have a minimum L2 risk and require explicit approval. The browser driver blocks off-origin top-level document requests before dispatch, rechecks the origin after navigation and click/script-driven navigation, closes unexpected pages, and rejects any download triggered by a write action. The current write worker does not implement `browser.download`.

For approval-gated automations, the first run creates a persisted approval. A later run may consume the matching approved record and execute within that exact intent. Capability grants are persisted and consumed before worker I/O; the worker must claim the resulting opaque one-use dispatch authorization immediately before acting.

### Production desktop release v1

The Windows desktop host places Tauri/Rust above the existing TypeScript control plane. It acquires exclusive ownership of the `.agent-kernel` runtime before Node opens it, supervises the fixed `dist/server.cjs` entrypoint under a kill-on-close Windows job, and accepts readiness only from a per-launch nonce-bound file. A standalone Node launch uses the same owner record and refuses to open a runtime already held by a live owner. This is single-owner fencing, not multi-process shared-state coordination.

Native acceptance is authenticated readiness, not a survival window. A fresh isolated profile must produce an HMAC proof bound to the acceptance nonce, compiled application identifier, Tauri application version, runtime-resource manifest, host and Node pids, and host-instance id. Before the proof is accepted, the harness logs in through the real multi-user API, verifies the returned session, performs a protected kernel read, observes the monitor-start handshake, requires authenticated bridge and healthy UI Automation state, and completes exact-origin native navigation plus a one-use challenge accepted by a Rust-owned loopback endpoint. The gate suppresses scheduler and updater network activity, then closes the real window through authenticated Node shutdown and proves that the attested Node pid, runtime owner, and proof are gone. A forced-kill fallback may contain the process but always fails acceptance; recovery mode cannot publish proof.

The production-profile guard requires caller-supplied CI markers and refuses any existing production profile. Those checks protect a developer's profile, but they do not authenticate GitHub Actions provenance. Production evidence comes from the retained protected-workflow run for the same candidate SHA, its environment approval, and the signed artifact hashes.

On the first packaged launch, native dialogs require the operator to choose and confirm both a 1-32 executable application allowlist and a project workspace containing a real `package.json`. The workspace must be disjoint from bundled resources, native configuration, and runtime state. Packaged releases ignore environment-provided application authority; invalid persisted selections are quarantined and require explicit reconfiguration. Development launches may still use the documented environment overrides. Rust generates a URL-safe one-launch first-admin secret, passes it to Node through the minimal child environment, and opens the webview with it in the URL fragment. The dashboard immediately removes the fragment from the visible URL/history, keeps it only in memory, and sends it only in the dedicated first-admin header. Node deletes the inherited environment value and consumes the authority only after the administrator record is durably created.

The native bridge binds to an ephemeral `127.0.0.1` port. Requests and responses are HMAC-SHA256 authenticated with a per-launch secret; request ids, bounded timestamps, body hashes, response status, and nonce replay protection are part of the protocol. While native first-admin bootstrap is pending, the shared API guard denies everything except the narrowly self-authorizing auth status/create routes. After bootstrap and automatic login, Node changes to `multi_user`, rechecks authenticated bridge health, and activates the already registered desktop runtime without a process restart. Registry activation is one-way availability only: it cannot change the configured worker id, operations, risk levels, or application allowlist. A failed activation stays unavailable and a later valid login may retry it. Bridge credentials, bootstrap authority, and runtime-owner nonces are generated for one supervised launch and are neither dashboard configuration nor persisted authority.

Desktop use requires `operator_token` or `multi_user` access control; it is blocked in loopback `open` mode. `desktop.discover` and `desktop.inspect` are L0 read-only operations. `desktop.click` and `desktop.type` are minimum L2 and execute only after the matching approval is consumed and a one-use capability dispatch is claimed. Every mutation revalidates the allowlisted executable, process, window, tree revision, path, and node identity immediately before acting. Typing discards the pre-focus value pattern, rebuilds and revalidates the tree after focus, then obtains a fresh value pattern immediately before `SetValue`. Text is resolved from a bounded consume-once payload store and checked against its intent hash. UI Automation output is untrusted evidence and cannot grant authority. Native UI Automation admission is bounded and nonblocking; queue-full, expired, or invalidated requests fail before a side effect. Windows COM work that has already started cannot be cancelled safely, so a mutation timeout or unverifiable post-write state records `OutcomeUncertain` and cannot be retried automatically. A broker-level timeout additionally marks UI Automation unhealthy.

Packaged command execution is a separate authority boundary. The release build embeds a digest-pinned Docker image reference and the Node server verifies Docker by running the configured image against the exact selected workspace. If the pinned image is absent, the daemon is unhealthy, or the workspace probe fails, command execution is reported unavailable and dispatch returns before consuming a capability. Native launches never fall back to host command execution. The trusted-host fallback remains limited to standalone source/development runs and is reported as degraded.

The release-only pipeline packages the self-contained `dist/server.cjs` and web assets with the complete root BUSL application `LICENSE`, both JavaScript and Rust third-party notices, an exactly versioned and SHA-256-pinned Windows x64 `node.exe`, and its independently hashed adjacent `LICENSE`. Application and runtime licenses are separate mandatory, hash-bound resources. A canonical resource manifest is embedded into the packaged native at build time; launch authenticates every declared resource by path, size, and hash, rejects undeclared, reparse-point, or non-regular entries in the exact `dist` inventory, and retains read handles for the supervised lifetime. Node accepts only the locked manifest copy published by Rust and serves only its authenticated `index.html` and asset entries; `server.cjs`, licenses, notices, and unknown paths are not static web content. The protected workflow separately verifies the complete installed inventory. The selected Node executable must also retain its expected vendor Authenticode signer and timestamp. The isolated unsigned pilot includes the same complete license/notice inventory and binds its hashes in the pilot sidecar, but it does not satisfy the protected Node-signer, Authenticode, updater-key custody, command-sandbox, or release-attestation gates and remains non-distributable. Installer v1 deliberately does not bundle optional Playwright browser engines or a `node-llama-cpp` native runtime/model, so browser-write and local-model features report unavailable unless a future audited package adds those resources. This boundary does not affect provider-backed chat or read-only web inspection.

The trusted Rust updater checks one configured public HTTPS `latest.json`, verifies Tauri signatures, and asks the user before installation. A network, manifest, or signature-check failure installs no candidate, records coded diagnostic state, and leaves the current trusted version running. Once the user accepts a valid update, the host requests authenticated graceful Node shutdown before updater exit; a forced containment fallback is diagnosable and is not a successful acceptance result. The dashboard receives no updater or dialog invoke capability. Automatic rollback of an already installed trusted Tauri parent is not implemented. The separate signed Node-child release supervisor below retains its own pre-commit candidate rollback behavior.

`GET /api/kernel/diagnostics` is a coded health snapshot available to authenticated viewers/operators in protected modes. `POST /api/kernel/diagnostics/support-bundle` requires operator/admin mutation authority in protected modes and persists a bounded JSON attachment with SHA-256 integrity. Loopback `open` mode follows the same documented no-bearer trust model as the rest of the kernel. The safe schema and correlation redaction remove tokens, keys, cookies, nonces, content/prompt/input/output text, unsupported values, and raw filesystem paths. The checksum detects accidental bundle modification; it is not a digital signature or proof of authenticity.

### Snapshots and recovery

The JSONL ledger is hash-chained and independently verifiable. Candidate evidence uses `npm run verify-ledger:strict -- <populated-evidence-runtime>` so a missing or empty ledger cannot pass. Capability policy and grant-consumption events carry raw-value-omitting schema-2 decision commitments. Raw URLs and other policy inputs are not copied into the ledger, but exact URL and relation commitments remain susceptible to guessing when their source values have low entropy. `npm run replay-ledger:gate` drives real kernel approvals and dispatch through an isolated persisted runtime, then requires the standalone replayer to derive every recorded decision with separately implemented logic, no warnings, and no legacy outcome-only authorization records. Snapshot content is authenticated by ledgered prepare/commit events containing the canonical state hash. Startup validates the primary and authenticated recovery copy, completes interrupted commits, and records abandoned ledger tails during recovery. This is local consistency and tamper evidence, not non-repudiation: replacing the complete ledger together with every retained head reference is outside the claim.

This authenticates a snapshot against the ledger. It is not a claim that every historical snapshot can be reconstructed solely from domain-event payloads.

### Controlled releases

A release signature covers the target version, package hash, sorted evaluation references, and rollback instructions. The matching staged package must declare a controlled `.cjs` entrypoint and pass path, size, and file-hash validation. Activation installs only beneath the controlled releases directory and performs the installed-file health check. On Windows, the trusted Tauri executable launches the exact Node/candidate pair suspended, assigns it to a nested kill-on-close Job Object before its first instruction, resumes it, and holds the job until exit; activation fails closed when that native authority is absent. POSIX uses a detached process group. A nonce/version/hash readiness proof plus a stability window must pass before the active manifest changes.

Candidate failure terminates the owned process group/job and removes the candidate while leaving the previous process and manifest active. Cleanup failure remains tracked and makes the lifecycle report `rollback_failed`; it is never converted into successful activation. Startup revalidates the persisted proposal, signature, evaluations, artifact, installed files, and health before restoring the supervised child. This is a bounded operator-signed core service, not permission for a model to rewrite source or replace the trusted parent Express control plane.

Generate the operator release key outside the repository, then sign a proposal JSON document containing `targetVersion`, `contentHash`, `evaluationEventIds`, and `rollbackInstructions`:

```bash
node scripts/release-signing.mjs generate /secure/path/release-private.pem
node scripts/release-signing.mjs sign /secure/path/release-private.pem proposal.json
```

## Dashboard State

The dashboard opens on a responsive operator Overview. A persistent wide-screen inspector, or keyboard-contained drawer on smaller screens, polls the authenticated `GET /api/kernel/observatory` projection for current work, global controls, goal budgets, pending approvals, approved authority still waiting for separate execution, recorded browser/desktop/connector targets, provider/worker availability, and bounded evidence summaries. Protected panels and observatory requests remain unmounted until dashboard access is available. The projection is server-derived from a last-authenticated state snapshot, invalidated whenever the kernel records new authority or evidence, plus a bounded hash-verified ledger tail; it is marked `no-store`. It structurally omits raw provider prompts and responses, typed payloads, credentials, observations, command output, arbitrary event payloads, and private model reasoning. Operator-authored goal, task, approval, and control labels remain visible in bounded form and therefore must not be used to store secrets. Browser and desktop cards are explicitly last-recorded execution evidence rather than a live video feed. See [`docs/operator-cockpit.md`](docs/operator-cockpit.md).

Promoted memory remains kernel-backed and read-only in the Knowledge workspace. Legacy `localStorage` keys for memory, profile, provider-like configuration, and skill drafts are purged. Local presentation-only chat state is never treated as authenticated evidence and is cleared or withheld from persistence when an authenticated principal is active. `sessionStorage` may hold the transient active bearer for the current tab, but its validity remains server-authoritative; neither browser store is authoritative memory, skill, provider configuration, approval, or release state.

## Optional Core Model

OpenBMB MiniCPM5-1B can run in-process through `node-llama-cpp` as an advisory, tighten-only prompt-injection assessor. It may raise risk above deterministic heuristics but cannot lower the heuristic floor, decide policy, issue capabilities, write the ledger, or promote memory.

Place a compatible GGUF file at `.agent-kernel/models/minicpm5-1b.gguf` or set `CORE_MODEL_PATH`. Application chat and extraction still use the provider gateway; the core model is not a bypass around routing, budgets, or access control.

## License

The Provenance application is source-available under BUSL-1.1, with no Additional Use Grant and a four-year per-version change to Apache-2.0 as stated in [`LICENSE`](LICENSE). Non-production use is permitted under that text; production use, including internal production use, requires a commercial license until the applicable Change Date. Third-party dependencies, the bundled Node runtime, and generated notice inventories retain their own licenses. This summary is not a substitute for the license text or legal advice.

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

Native desktop candidate verification on Windows uses the pinned Rust `1.97.0` MSVC toolchain, the Visual Studio 2022 Desktop development with C++ workload, a Windows 10/11 SDK, WebView2 Evergreen, and a canonical `node.exe`. Invoke direct Rust gates as `cargo +1.97.0 ...`. Configure an operator token or bootstrap a multi-user account. Development launches may provide a narrow executable allowlist and workspace in `.env`:

```dotenv
KERNEL_API_TOKEN=choose-a-long-random-value
DESKTOP_APP_ALLOWLIST='[{"appId":"windows.notepad","executablePath":"C:\\Windows\\System32\\notepad.exe"}]'
PROVENANCE_WORKSPACE_ROOT="C:\\path\\to\\a\\project"
```

The JSON must contain 1-32 unique objects with only `appId` and `executablePath`. Application ids use lowercase letters, digits, `.`, `_`, or `-`; each path must already be an absolute normalized `.exe` path. `npm run desktop:dev` preloads `.env` before it starts Tauri. `PROVENANCE_PROJECT_ROOT` and `PROVENANCE_NODE_EXECUTABLE` may override the canonical resource and Node paths for development.

A packaged host ignores `DESKTOP_APP_ALLOWLIST` and `PROVENANCE_WORKSPACE_ROOT`. Its first-run native dialogs create per-user persisted selections only after confirmation. On a fresh per-user runtime, bootstrap the first administrator from that native launch. The dashboard consumes the one-time fragment authority, automatically logs in, and the server activates the health-checked, fixed-authority desktop worker in the same process; no restart is required. Native runtime state is placed under Tauri's per-user local application-data directory, outside both the packaged resource root and selected command workspace; standalone Node retains the repository-local `.agent-kernel` default. The native host generates the bootstrap secret, bridge secret, a private runtime-owner proof, its expected host PID, runtime path, and readiness values for the supervised child. Only the owner's SHA-256 proof hash is written to disk. Do not place per-launch values in `.env`.

For the packaged first-run walkthrough, desktop approval flow, operating
limits, and recovery steps, see the
[`Native Desktop Operator Guide`](docs/native-desktop-operator-guide.md).

Run the development server:

```bash
npm run dev
```

Build and start the compiled server:

```bash
npm run build
npm start
```

Build the web/server artifacts and launch or compile the native development host on a prepared Windows machine:

```bash
npm run desktop:dev
npm run desktop:build
```

`desktop:build` remains a development build with bundling disabled. The production NSIS pipeline is intentionally split across unsigned construction and protected signing:

```bash
npm run desktop:release:plan
npm run desktop:release:build-unsigned
npm run desktop:release:verify-unsigned -- <unsigned-payload>
# Protected Windows environment only:
npm run desktop:release:bundle-signed-native -- <unsigned-payload>
```

The public plan and unsigned build require an exact Node executable/version/hash/vendor signer, exact adjacent Node license/hash, a pinned and hashed `cargo-about`, Tauri updater public policy, a credential-free HTTPS `latest.json` endpoint, and a digest-pinned Docker image. The signing job additionally requires the protected certificate thumbprint, timestamp service, PFX, and updater private key. `desktop:release:plan` emits sanitized metadata only. The unsigned CI job explicitly fetches only `Cargo.lock`-resolved dependencies with `cargo +1.97.0 fetch --locked` before frozen Rust-notice generation. `build-unsigned` builds the self-contained server, generates JavaScript and Rust notices, runs clean-resource smoke, compiles an unsigned native executable, and writes an exact-manifest-only payload. It has no certificate or private updater authority.

The manual `Verified Windows desktop release` workflow preserves that unsigned payload, then allows a separate `production` environment job on `main` or a `v*` tag to re-download and revalidate it against distinct `PROVENANCE_PRODUCTION_*` values before exposing signing authority. It imports the PFX only for Authenticode bundling, removes the certificate and PFX before exposing the Tauri updater key, and publishes only for a matching `v*` tag when the protected `publish` input is selected.

The protected job copies every manifest resource into a fresh release target and rehashes the exact tree before and after Tauri runs. Its hash-pinned custom sign command allows mutation only for the native executable, the constrained NSIS temporary uninstaller, and the exact final setup executable; the already vendor-signed Node runtime and five exact NSIS build plugins are verified no-op callbacks. Tauri 2.11.4 intentionally changes the native marker from `__TAURI_BUNDLE_TYPE_VAR_UNK` to `__TAURI_BUNDLE_TYPE_VAR_NSS` before its signing callback and restores the original unsigned target after bundling. The callback therefore captures the signed/patched native with create-new semantics. Verification permits only that one marker change, PE checksum/security-directory changes, zero alignment padding, and one aligned EOF `WIN_CERTIFICATE`; its hashes, marker offset, certificate digest, signer, timestamp, unsigned payload hash, and installer hash are bound into a signed bundle record.

After the Authenticode certificate is removed, the workflow silently installs into a fresh path, checks the installer, installed native, and uninstaller signer/timestamp, requires the installed native to be byte-identical to the callback capture, rehashes every installed resource against the unsigned manifest, and rejects extra files and reparse points. It then runs the nonce-bound authenticated native acceptance gate against that exact installed executable, requires graceful shutdown and runtime cleanup, and silently uninstalls. The updater key then signs both the installer and bundle record. The exact public set is only the setup executable, its `.sig`, `latest.json`, and `release-attestation.json`; the canonical signed bundle record is embedded into the two JSON evidence documents. Repository code does not supply production variables, certificates, private updater keys, hosted artifacts, protected-environment approval, telemetry operations, or an external audit. No installer is considered produced or published merely because this pipeline exists.

The verification/release toolchain is exact where it matters: CI uses Node.js `22.23.1` and Rust MSVC `1.97.0`; `@tauri-apps/cli` is fixed at `2.11.4` in both manifests and the installed tree; `cargo-about` is fixed at `0.9.1` with archive and executable SHA-256 pins; `spdx-expression-parse` is fixed at `5.0.0`; and the release record binds `package-lock.json`, `Cargo.lock`, the Rust notices, the runtime license, and the production Node binary. The bundled production Node version remains an explicit protected release variable, not an implicit use of the CI orchestration runtime.

## Verification

```bash
npm run lint
npm test
npm run build
npm run verify-ledger:strict -- <populated-evidence-runtime>
npm run replay-ledger:gate
npm run desktop:release:test
npm run desktop:resource-smoke
npm run desktop:acceptance
npm run desktop:acceptance-host
npm audit --audit-level=high
npm audit --omit=dev --audit-level=high
cargo +1.97.0 fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo +1.97.0 test --manifest-path src-tauri/Cargo.toml
cargo +1.97.0 check --manifest-path src-tauri/Cargo.toml --all-targets
cargo +1.97.0 clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

Strict ledger verification must point at a populated runtime retained from the candidate evidence run; the non-strict command can legitimately report zero events and is not a release gate. `npm audit --audit-level=high` covers the JavaScript dependency tree used by build and test tooling, while `npm audit --omit=dev` covers the production subset. Record a separate independent advisory review of `Cargo.lock`, the pinned Rust/Tauri toolchain, and release-build dependencies because npm audit does not cover them.

Historical baselines were **242 tests across 51 files** before the 2026-07-13 trust-boundary hardening, **297 tests across 62 files** after it, **410 tests across 70 files** for Durable Recurring Research v1, and **455 tests across 78 files** for Native Desktop Runtime v1. The local Production Desktop Release v1 suite passed **532 tests across 85 files** on 2026-07-19. Those numbers describe earlier trees, not the current candidate. Record the output of `npm test` for the exact commit under review; it is the only current total. The 2026-07-15 ledger check authenticated **252 events**, also timestamped runtime evidence rather than a product invariant.

The 2026-07-22 working tree subsequently passed 570 TypeScript tests across 90 files, 50 Rust tests, authenticated development-native acceptance, and acceptance against an exact silently installed unsigned pilot binary. See [`docs/Prd_Dev/2026-07-22-release-hardening-evidence.md`](docs/Prd_Dev/2026-07-22-release-hardening-evidence.md). These are local mutable results, not a signed production candidate or independent acceptance; the exact committed SHA must pass ordinary and protected workflows again.

The July 27 working tree passed **635 TypeScript tests across 96 files**, **68 Rust tests**, an **83-test release contract**, full and production JavaScript dependency audits, replay and strict-ledger gates, authenticated development-native acceptance, and a fresh license-complete silently installed/uninstalled unsigned pilot. See [`docs/Prd_Dev/2026-07-27-final-local-evidence.md`](docs/Prd_Dev/2026-07-27-final-local-evidence.md). The repair commit passed ordinary same-SHA Windows CI; protected signing, credential rotation, independent audit, and external pilot acceptance are still required.

The July 29 operator-cockpit working tree passed **668 TypeScript tests across 99 files**, TypeScript lint, the production build, and an authenticated browser pass against the built `dist/server.cjs` at desktop and mobile breakpoints. See [`docs/Prd_Dev/2026-07-29-operator-cockpit-evidence.md`](docs/Prd_Dev/2026-07-29-operator-cockpit-evidence.md). The subsequent native-desktop activation tree passed **678 TypeScript tests across 99 files**, **69 Rust tests**, the production build, and repeatable authenticated Tauri acceptance that matched its exact randomized controlled UIA window and cleaned up gracefully. The acceptance identity builds in its own Cargo target directory and does not replace the ordinary development executable. See [`docs/Prd_Dev/2026-07-29-native-desktop-activation-evidence.md`](docs/Prd_Dev/2026-07-29-native-desktop-activation-evidence.md). These are local development-native results; they do not replace protected signing, installed signed-binary acceptance, representative application pilots, audit, or remote CI evidence.

`desktop:acceptance` is deterministic TypeScript evidence: it uses the real kernel and desktop worker but replaces the native bridge with a fixed fixture to cover health, discovery, inspection, approval continuation, click, hash-bound typing, payload consumption, and uncertain-outcome retry blocking. The ordinary Windows Rust test job now also creates a real temporary Win32 window and drives its checkbox and edit controls through UI Automation. That live fixture proves the broker against controlled Windows controls; it is not equivalent to product acceptance across arbitrary third-party applications or an external interactive security evaluation.

The `Native desktop verification` workflow runs TypeScript lint/tests, release-policy tests, kernel-persisted decision replay, the production build, both locked third-party notice generators, clean packaged-server readiness smoke, the production dependency audit, Rust formatting, tests, all-target checking, and Clippy with warnings denied on `windows-latest`. It then builds the native development host and exercises it through the isolated authenticated readiness gate. Local commands shorten the feedback loop, but the workflow run for the exact commit is the remote authority. The protected release workflow adds the exact signed, silently installed production-binary gate. This working tree does not claim either remote workflow is green, and neither workflow counts as an independent external security audit or pilot.

## Deployment Boundaries

- Windows CI drives a deterministic native Win32 UI Automation fixture, but representative third-party application acceptance and an external interactive security evaluation remain undone. Availability stays health-gated; the TypeScript kernel remains the policy authority.
- Docker supplies command isolation only after daemon, digest-pinned image, and exact selected-workspace health checks pass. Native desktop command execution is disabled otherwise. Standalone source runs retain an explicitly reported trusted-host fallback; native Windows command isolation or Linux namespace/seccomp isolation is not implemented.
- Desktop v1 is limited to allowlisted discovery, inspection, click, and hash-bound typing. Typed text lives only in a bounded, expiring, consume-once in-memory store; it is not written to the general artifact directory. A timeout, Stop All, transport loss, executor loss, or failed post-write observation after native mutation dispatch is recorded as `automation.run_uncertain` and blocks retry of that automation. Stop All cannot undo an OS side effect already accepted by UI Automation.
- The host watches the Node child, bridge task, and UI Automation broker. Loss of any one clears web storage and closes the dashboard instead of leaving its loopback page active. The v1 browser-facing listener is still the supervised Node listener rather than a Rust-owned reverse proxy, so this is fail-closed monitoring rather than a formal proof against every same-user local port-rebinding race.
- The unsigned-to-protected NSIS, Authenticode, silent install/uninstall, and signed-updater evidence pipeline is implemented, but the repository supplies no protected production values, certificate, updater key, actual signed installer, hosted `latest.json`, or published release. A failed updater check installs no candidate and leaves the current trusted version running with coded diagnostics; automatic rollback of an already installed trusted Tauri parent is not implemented.
- Shortcuts, elevation, unrestricted shell authority, downloads, OAuth connector runtimes, plugins, and arbitrary desktop missions are not implemented.
- The independent skill-evaluator resolver and evaluator allowlist are integration points with no production default. Skill suite creation fails unavailable until a release owner supplies that separate trust root.
- Research missions do not provide generic web search, source discovery, crawling, redirect following, or automatic expansion beyond the explicit seed URLs.
- Durable scheduling is currently limited to the fixed-source Research to Verified Report workflow; there is no generic cron, arbitrary command, connector, email, or desktop mission scheduler.
- Exactly one native host or standalone Node server may own a given `.agent-kernel` runtime directory. Mutation and ledger queues are process-local; multi-process or high-availability sharing of one runtime is not supported.
- macOS Keychain and Linux Secret Service adapters need live validation on their target operating systems.
- Accounts share one local kernel state. There is no per-user goal/memory partitioning or SSO/OIDC.
- Supervised releases do not hot-replace or proxy the trusted parent Express control plane; stable-port traffic switching remains a deployment concern.
- Provider availability and model behavior depend on operator configuration and the upstream provider.
- Installer v1 omits Playwright browser engines and the optional local `node-llama-cpp` runtime/model. Those capabilities remain unavailable in the installed build unless a future audited package includes them.
- Authenticode certificate custody, updater private-key custody, production publication and hosted-manifest operations, representative-machine installer/update/UIA testing, telemetry policy and operations, and an independent external security audit remain release-owner responsibilities.

## Documentation

| Document | What it covers |
| --- | --- |
| [`CURRENT_STATE.md`](docs/superpowers/CURRENT_STATE.md) | **Start here.** The authoritative capability matrix: what works, what is a boundary |
| [`agent-fleet-architecture.md`](docs/agent-fleet-architecture.md) | Tiered agents, selectable authority, orchestration, the model planner, and the proposal loop |
| [`connectors-and-anchoring.md`](docs/connectors-and-anchoring.md) | Writing a connector adapter, the uncertain rule, ledger anchoring, and the command allowlist |
| [`desktop-automation-field-notes.md`](docs/desktop-automation-field-notes.md) | What is true in practice about UI Automation, including three limits that will bite an operator |
| [`eu-ai-act-article-mapping.md`](docs/eu-ai-act-article-mapping.md) | Article 12/14/26 mapping with gaps stated rather than buried |
| [`operator-cockpit.md`](docs/operator-cockpit.md) | The authenticated dashboard and Live Operations projection |
| [`native-desktop-operator-guide.md`](docs/native-desktop-operator-guide.md) | Running the Windows native host |
| [`provenance-technical-analysis.md`](docs/provenance-technical-analysis.md) | Source-anchored architecture analysis |

Design and implementation history lives under `docs/superpowers/specs/` and `docs/superpowers/plans/`. The candidate evidence, rollback, external security review, pilot, and independent sign-off contract is [`docs/Prd_Dev/external-security-audit-and-pilot-runbook.md`](docs/Prd_Dev/external-security-audit-and-pilot-runbook.md); those external obligations remain pending until performed.

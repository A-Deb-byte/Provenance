# Provenance: Technical Analysis and Release Posture

- Analysis date: 2026-07-26
- Scope: the current `codex/production-desktop-release-v1` working tree
- Status: implementation analysis, not an external audit or release approval

This document separates implemented controls from evidence that still has to be produced. A file in the repository can prove that a gate exists; only a successful run against an identified commit and artifact proves that the gate passed for that candidate.

## 1. What Provenance is

Provenance is a local-first agent control plane with three cooperating layers:

1. A TypeScript/Express application and trusted kernel own goals, tasks, budgets, approvals, capabilities, automations, memory, skills, and the hash-chained ledger.
2. A React dashboard exposes authenticated operator workflows without storing authoritative memory, skill, provider, approval, or release state in browser storage.
3. On Windows, a Tauri/Rust host owns the native runtime, supervises the Node control plane, authenticates the native bridge, and brokers bounded UI Automation.

The defensible design principle is: **models propose; deterministic policy grants authority; workers consume one-use dispatch authorization; the ledger records the result.** This is not unrestricted self-modification, generic remote administration, or proof that model output is true.

Authentication and vault persistence have their own server-owned stores. Therefore, the precise claim is that the kernel is the authoritative writer for agent goals, actions, approvals, capability state, memory, skills, automations, and controlled releases, not that every byte written by the application goes through one kernel queue.

## 2. Authority and evidence

Consequential worker actions are intent-hash bound. Capability grants are persisted and consumed before worker I/O, then converted into an opaque, one-use dispatch authorization that the selected worker must claim immediately before acting. Browser and desktop writes have a minimum L2 risk and require a matching approved record before dispatch.

The JSONL event ledger is hash chained and can be checked independently. A release gate must use `npm run verify-ledger:strict -- <populated-evidence-runtime>`; the non-strict default can validly report zero events and therefore is not candidate evidence. Capability authorization events additionally retain raw-value-omitting schema-2 semantic commitments. Raw values are not copied into those records, but exact URL and relation commitments can still be guessed when their source values have low entropy. `npm run replay-ledger:gate` drives the real kernel through approvals and dispatch in an isolated persisted runtime, then requires the separately implemented replayer to derive every decision under strict mode. This covers capability policy and grant consumption, not every kernel decision. Snapshots are authenticated by ledgered prepare and commit events containing the canonical state hash, and startup validates both the primary and recovery copy. This authenticates the saved snapshot against the ledger; it does not mean every historical state can be reconstructed solely from domain-event payloads. The chain is local tamper evidence rather than non-repudiation because replacing the complete ledger and every retained head reference is outside its claim.

Memory promotion rejects a candidate's own creation event as evidence. The bounded skill foundry accepts only the `pure-transform-v1` DSL, and production canaries depend on an independently configured evaluator resolver rather than caller-supplied oracle outputs.

## 3. Access control

The server supports three explicit modes:

- `multi_user`: signed, expiring sessions with persisted session versions; admin and operator roles may mutate, while viewers are read-only.
- `operator_token`: a configured bearer token protects authoritative reads and mutations and is required to bootstrap the first administrator.
- `open`: available only when neither accounts nor an operator token exist, on the loopback-only deployment.

Mutating application, provider, kernel, and vault routes share the access guard. Sanitized auth, provider, core-model, and runtime capability surfaces remain public so an unauthenticated dashboard can render a login or availability screen. Logout and explicit session revocation advance the persisted session version, while deleting an account makes its outstanding sessions fail user lookup. Password and role editing are not implemented.

The native acceptance path does not treat process survival as readiness. It pre-seeds an isolated multi-user runtime, logs in through the actual API, verifies the returned session, and proves an authenticated kernel read before accepting readiness. The Node record must also assert kernel readiness, `multi_user` access, authenticated bridge health, a valid host-instance id, disabled scheduler state, and available desktop authority.

## 4. Browser and command boundaries

`browser.inspect` is read-only L0 work. `browser.navigate`, `browser.click`, and `browser.type` are minimum L2 writes. The Playwright driver checks the allowed origin before dispatch, intercepts off-origin top-level requests, rechecks after navigation or click-driven navigation, closes unexpected pages, and rejects downloads caused by a write. `browser.download` is not implemented.

This is bounded browser automation, not unrestricted browsing. Research missions accept only explicit HTTPS seed URLs on configured origins; they do not search, crawl, follow redirects, or let a provider widen the source set.

Command isolation depends on Docker plus an exact selected-workspace health probe and a digest-pinned image. Native desktop launches fail closed when that boundary is unhealthy and never fall back to host command execution. Standalone source/development runs can retain a separately reported trusted-host fallback; that is a degraded execution mode, not an OS sandbox.

## 5. Native desktop boundary

The Windows host uses separate compiled application identities:

| Profile | Identifier | Purpose |
| --- | --- | --- |
| Development | `dev.provenance.desktop.development` | Local and ordinary CI native verification |
| Pilot | `dev.provenance.desktop.pilot` | Isolated unsigned local pilot only |
| Production | `dev.provenance.desktop` | Protected signed release workflow |

The host exclusively owns its per-user runtime, launches a fixed Node entrypoint under a kill-on-close Windows Job Object, and monitors the Node child, bridge, and UI Automation broker. Packaged builds embed a canonical resource manifest; launch authenticates declared paths, sizes, and hashes, rejects undeclared, reparse-point, or non-regular entries in the exact `dist` inventory, and retains the opened files for the supervised lifetime. Node accepts the locked manifest copy published by Rust and exposes only its authenticated index and asset entries as static content; the protected workflow separately verifies the complete installed inventory. Acceptance requires an explicit monitor-start handshake rather than inferring monitoring from later process state. The bridge uses per-launch HMAC-SHA256 authentication with request ids, timestamps, body hashes, and replay protection. The frontend mount challenge is separate one-use authority accepted only by a Rust-owned loopback endpoint after exact Host, Origin, and body validation; Node does not receive that token. Desktop authority is fixed by a persisted executable allowlist and registered operations; model output cannot expand it.

Desktop discovery and inspection are L0. Clicking and hash-bound typing are at least L2, consume approval and one-use capability authority, and revalidate the process, window, tree revision, path, and node identity immediately before mutation. UI Automation admission uses a bounded nonblocking queue and per-request generation and deadline checks. Queue-full, expired, or invalidated work fails before mutation; once a Windows COM mutation starts it cannot be cancelled safely, so timeout or failed post-write verification becomes `OutcomeUncertain` and blocks automatic retry. A broker-level timeout additionally marks UI Automation unhealthy. UI Automation output is evidence, never authority.

The native host remains a local userspace boundary. The browser-facing listener is the supervised Node listener rather than a Rust-owned reverse proxy, so monitoring reduces but does not formally eliminate every same-user loopback port-rebinding race. Stop All also cannot undo an OS side effect already accepted by UI Automation.

## 6. Authenticated native acceptance

`scripts/native-host-smoke.mjs` now implements an authenticated acceptance gate rather than a liveness check. Each run:

1. Reserves fresh identity-specific local and roaming profiles and a fresh scratch project.
2. Creates an isolated multi-user account store, fixed Notepad allowlist, and workspace.
3. Starts the native binary with a random 32-byte acceptance nonce, recurring scheduling disabled, and updater network activity suppressed.
4. Logs in through the real multi-user API, verifies the session, performs a protected kernel read, and waits for the monitor-start handshake.
5. Waits for a bounded HMAC attestation that binds the nonce, compiled application identifier, Tauri application version, runtime-resource manifest, host and Node pids, and host-instance id.
6. Requires runtime ownership, authenticated bridge health, healthy UI Automation, available desktop authority, exact-origin native navigation, and a fresh Rust-owned mount challenge.
7. Closes the real window through authenticated Node graceful shutdown, requires a clean zero exit, proves the attested Node pid is dead, and verifies that the owner record and acceptance proof are removed. Forced containment is a failure, even when cleanup succeeds.

Development, pilot, and production profiles are not interchangeable. The production guard requires caller-provided CI markers and refuses an existing production profile, which prevents accidental reuse in the intended workflow. Those markers are not authenticated GitHub provenance; the protected workflow URL, same candidate SHA, environment approval, and signed artifact hashes supply the release evidence.

The ordinary native workflow builds and exercises the development binary through this gate. The protected Windows release workflow silently installs the signed NSIS artifact into a fresh path, proves the installed executable is byte-identical to the captured signed native, verifies the exact installed resource inventory, revalidates the preserved unsigned payload immediately before startup, and supplies the immutable unsigned-job resource digest to the same authenticated gate. Only then may it silently uninstall.

These controls are implemented in the current working tree. They become release evidence only after the applicable workflow succeeds on the exact candidate commit and its run URL and hashes are retained.

## 7. Packaging, updater, and licensing

Production packaging is split between unsigned construction and protected signing. It pins the orchestration versions, Node runtime identity and license hash, Rust notice generator, updater policy, and sandbox image; embeds a canonical resource-manifest digest; rehashes resources after native compilation and protected staging; applies Authenticode and updater signatures in separate authority phases; and emits signed release evidence.

The application license contract is consistently declared as BUSL-1.1 in `package.json`, `package-lock.json`, and `src-tauri/Cargo.toml`. The complete root `LICENSE` is a mandatory, hash-bound top-level production resource. It is distinct from the adjacent Node runtime `LICENSE` and generated JavaScript and Rust third-party notices.

The isolated pilot installer includes the application `LICENSE`, JavaScript and Rust third-party notices, and the Node runtime `LICENSE`. Its bounded non-secret evidence sidecar records the exact license inventory and hashes, the bundled Node hash, and the installer and resource-manifest digests needed by packaged acceptance. That complete notice inventory does not make the pilot distributable: the application, installer, and local Node runtime are not authenticated under the protected production signing policy; the updater uses a local pilot key and credential-free HTTPS `.invalid` endpoint; the sandbox image is deliberately unresolvable; and no protected release attestation exists.

BUSL-1.1 is source-available, not an OSI open-source license. With no Additional Use Grant, the repository text permits non-production use; production use, including internal production use, requires a commercial license until the applicable Change Date. Licensing and attribution conclusions still require counsel, not an engineering test.

The trusted Tauri updater verifies its configured HTTPS manifest and Tauri signatures and asks before installation. A failed network, manifest, or signature check installs no candidate and leaves the current trusted version running with coded diagnostics. It does not implement automatic rollback of an already installed trusted Tauri parent. The separate controlled Node-child release lifecycle has pre-commit health checks and rollback, but that does not substitute for installer rollback.

## 8. Verification status

Do not copy an old test total into a release claim. The historical Production Desktop Release v1 baseline was 532 TypeScript tests across 85 files on 2026-07-19. The current count changes as hardening tests are added; the output of `npm test` on the exact candidate commit is the only current total.

The repository-defined local gates include:

```powershell
npm ci
npm run lint
npm test
npm run build
npm run verify-ledger:strict -- <populated-evidence-runtime>
npm run replay-ledger:gate
npm run desktop:release:test
npm run desktop:acceptance
npm run desktop:resource-smoke
npm audit --audit-level=high
npm audit --omit=dev --audit-level=high
cargo +1.97.0 fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo +1.97.0 test --manifest-path src-tauri/Cargo.toml
cargo +1.97.0 check --manifest-path src-tauri/Cargo.toml --all-targets
cargo +1.97.0 clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

The ledger path must contain candidate-generated events; a missing or empty runtime fails strict verification. The npm audit is deliberately production-only and does not review Rust, Tauri, native build tools, NSIS, or WebView2. An independent advisory review of `Cargo.lock` and the release/build dependency chain must be attached to the candidate evidence.

Windows native and protected release workflows add pinned dependency provisioning, third-party notice generation, operational decision replay, actual native startup, installed-file verification, Authenticode verification, installed-binary acceptance, uninstall verification, and updater evidence.

This document does **not** claim that the current local gates or remote workflows are green. Record those results, the commit, workflow URL, artifact hashes, and any waivers in the external audit and pilot packet.

## 9. Remaining product and release boundaries

- No independent external security audit, penetration test, certification, external-user pilot, or soak period has been completed by this repository work.
- No release is distributable until the protected workflow produces and validates a signed installer using real release-owner keys and certificate custody.
- The installed package deliberately omits Playwright browser engines and the optional local-model runtime/model; those features are unavailable in that artifact unless a later audited package adds them.
- Desktop v1 is limited to allowlisted discover, inspect, click, and type operations. Shortcuts, elevation, arbitrary shell authority, downloads, email, OAuth connectors, and generic desktop missions are absent.
- The scheduler is limited to fixed-source Research to Verified Report missions, not arbitrary commands, connectors, email, or desktop jobs.
- Accounts share one local kernel state; there is no per-user data partitioning, SSO/OIDC, multi-process shared runtime, or high-availability mode.
- macOS Keychain and Linux Secret Service adapters still require live validation on their own platforms.
- Provider availability and output quality remain operator and upstream dependencies. Citation grounding proves correspondence to captured text, not truth.
- A provider credential was previously exposed outside the vault during project work. It must be revoked or rotated before pilot or release, and neither the old nor replacement value may appear in source, logs, screenshots, documentation, or retained evidence.
- Telemetry policy, incident response ownership, updater hosting, key custody, representative third-party UI Automation testing, and manual installer rollback must be established operationally.

## 10. Release decision

The project now has a credible, testable release architecture: authenticated readiness instead of liveness, isolated identities, fail-closed desktop and command authority, exact installed-binary verification, and license-bound artifacts. That is materially stronger than a conventional agent demo.

It is still a release candidate, not an externally accepted product. Completion requires all local and remote gates to pass on one immutable candidate, followed by independent security review and a bounded pilot whose evidence and sign-offs are recorded in [`Prd_Dev/external-security-audit-and-pilot-runbook.md`](./Prd_Dev/external-security-audit-and-pilot-runbook.md).

# External Security Audit and Pilot Acceptance Runbook

- Document version: 1.0
- Prepared: 2026-07-22
- Applies to: `codex/production-desktop-release-v1` release candidates
- Current disposition: **external audit and pilot acceptance pending**

This is the acceptance contract for a release candidate. It does not certify the product, and its existence is not evidence that any test passed. A project maintainer may prepare evidence but cannot fill the independent auditor or pilot-owner approval fields.

## 1. Candidate record

Complete this section before testing. Do not continue if any artifact can change during review.

| Field | Required value |
| --- | --- |
| Git commit SHA | `________________________________________` |
| Branch or tag | `________________________________________` |
| Application version | `________________________________________` |
| Package-lock SHA-256 | `________________________________________` |
| Cargo.lock SHA-256 | `________________________________________` |
| Signed installer filename | `________________________________________` |
| Signed installer SHA-256 | `________________________________________` |
| Signed native SHA-256 | `________________________________________` |
| Runtime resource manifest SHA-256 | `________________________________________` |
| Release attestation SHA-256 | `________________________________________` |
| `latest.json` SHA-256 | `________________________________________` |
| Replayed decisions and policy versions | `________________________________________` |
| Native CI run URL | `________________________________________` |
| Protected release run URL | `________________________________________` |
| Test machine/VM snapshot id | `________________________________________` |
| Evidence archive location and SHA-256 | `________________________________________` |

Acceptance is invalid if the tested commit, installer, manifest, or evidence archive differs from these values.

## 2. Scope

The independent review must cover:

- The Rust/Tauri native host, runtime ownership, child supervision, Job Object containment, exact-origin page navigation, the Rust-owned one-use frontend mount challenge, updater boundary, and fail-closed monitor startup handshake.
- The build-embedded runtime resource manifest, launch-time hash/size/path authentication, exact `dist` inventory with extra/reparse/non-regular rejection, held resource handles, Node's manifest-only static allowlist, complete protected-workflow installed inventory, and acceptance binding to the independently retained manifest digest.
- Node readiness schema, nonce, compiled-identifier, Tauri-version, resource-manifest and host-instance binding, bridge authentication, real login/session/protected-read checks, scheduler/updater-network suppression during acceptance, authenticated graceful shutdown, attested-Node-pid termination, and cleanup.
- Windows UI Automation discovery, inspection, click, hash-bound typing, allowlist enforcement, one-use text payloads, bounded nonblocking admission, deadline/generation checks before side effects, stale-tree checks, and uncertain outcomes after an already-started COM mutation.
- The TypeScript access guard, operator-token and multi-user modes, session revocation, role boundaries, approval continuation, capability consumption, Stop All, budgets, and ledger evidence.
- Browser origin enforcement before and after navigation, redirect behavior, unexpected-page handling, download rejection, and L2 approval requirements.
- Docker sandbox health, exact workspace binding, pinned-image enforcement, and native fail-closed behavior when Docker or the image is unavailable.
- Provider and OS-vault secret handling, redaction, support bundles, prompt-injection handling, and provider failure modes.
- Snapshot authentication, ledger verification, recovery, controlled Node-child release rollback, and native updater failure behavior.
- Unsigned construction, protected signing, Authenticode timestamps, installed resource inventory, updater signatures, uninstallation, license inventory, and release evidence.
- Pilot consent, local data handling, diagnostic sharing, provider disclosure, support, rollback, and incident response.

Explicitly out of scope unless separately contracted:

- Proving the truth, completeness, or independence of third-party sources.
- Auditing an upstream model/provider, Docker, Windows, WebView2, or Notepad itself.
- Capabilities the runtime reports as absent, including email, OAuth connectors, downloads, elevation, arbitrary shell control, and generic desktop scheduling.
- Certification against a named regulatory standard. A standards mapping requires a separate scope and evidence plan.

## 3. Threat model

### Assets

- Provider credentials, operator tokens, session keys, bootstrap authority, bridge secrets, updater keys, and signing certificates.
- Kernel state, ledger and authenticated snapshots, promoted memory, approvals, capability grants, schedules, and release records.
- Selected command workspace, allowlisted applications, typed text, captured sources, reports, and support bundles.
- Release artifacts, resource manifests, updater metadata, and audit evidence.

### Adversaries and failures

- Untrusted model or provider output attempting to grant itself authority, expand scope, inject instructions, or forge completion.
- Malicious web content attempting origin drift, redirects, popups, downloads, prompt injection, or data exfiltration.
- A same-user local process racing the loopback service, editing runtime files, replaying bridge messages, substituting resources, or forging readiness.
- A compromised or stale release input, dependency archive, Node runtime, updater manifest, installer, certificate, or signing environment.
- A lower-role user attempting protected reads/mutations, session reuse after revocation, or privilege escalation.
- Operator error, interrupted mutation, child crash, bridge/UIA loss, forced shutdown, stale approval, expired grant, Docker outage, or partial update.

### Trust assumptions to challenge

- The Windows user account and operating system are trusted enough to host this local userspace boundary.
- Signing and updater private keys remain outside the repository and are exposed only to their protected phases.
- The selected workspace and executable allowlist are deliberate operator choices.
- Provider endpoints receive only data the operator intended to send under that provider's terms.
- One native host owns one runtime; multi-process or adversarial same-user isolation is not claimed.

## 4. Local source gates

Run from a clean checkout of the candidate SHA with no provider credentials in the repository or captured output. The provider credential previously exposed outside the vault during project work must be revoked or rotated before this stage; store only the replacement in the protected server-side vault or deployment secret store, and do not record either value. Record command, exit code, duration, tool versions, and the full redacted log as a separate evidence file.

```powershell
npm ci
npm run lint
npm test
npm run build
npm run verify-ledger:strict -- <populated-evidence-runtime>
npm run replay-ledger:gate
npm run desktop:release:test
npm run desktop:acceptance
cargo +1.97.0 fetch --manifest-path src-tauri/Cargo.toml --locked
npm run desktop:licenses
npm run desktop:resource-smoke
npm audit --omit=dev --audit-level=high
cargo +1.97.0 fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo +1.97.0 test --manifest-path src-tauri/Cargo.toml
cargo +1.97.0 check --manifest-path src-tauri/Cargo.toml --all-targets
cargo +1.97.0 clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo +1.97.0 build --manifest-path src-tauri/Cargo.toml
npm run desktop:startup-smoke -- --binary src-tauri/target/debug/provenance-desktop.exe --profile development
git diff --check
```

Pass criteria:

- Every command exits zero on the same source tree.
- `<populated-evidence-runtime>` is an archived candidate runtime with at least one real event; a missing or empty ledger fails strict verification.
- The replay gate must report at least one kernel-persisted schema-2 decision, zero outcome-only authorization events, zero divergences, and zero warnings.
- The full TypeScript and Rust totals are recorded from output rather than copied from an older document.
- No test is skipped, retried into green, or waived without a written finding and release-owner decision.
- The native acceptance output proves login, session verification, protected kernel read, monitor startup, HMAC-bound identity/version/process fields, exact-origin navigation, frontend mount, `desktopAuthority: available`, scheduler/updater suppression, authenticated graceful shutdown, attested Node-pid death, and runtime cleanup.
- A forced kill, recovery window, surviving process, stale profile, owner record, or attestation file is a failure, not degraded success.
- `npm audit --omit=dev` covers production npm dependencies only. Its configured high-severity gate must pass and lower findings require disposition, while an independent reviewer separately records advisories for `Cargo.lock`, Rust/Tauri, native build tools, NSIS, WebView2, and other release-chain dependencies.

## 5. Remote and installed-artifact gates

### Ordinary native workflow

The `Native desktop verification` workflow must complete successfully for the candidate SHA. It must include TypeScript gates, locked Rust dependency fetching, notice generation, clean packaged-server smoke, dependency audit, formatting, Rust tests/check/Clippy, a native build, and authenticated development-profile startup.

Record the immutable run URL, attempt number, runner image, commit SHA, job result, and retained logs. A green run for a different SHA is not evidence.

### Protected Windows release workflow

Run `Verified Windows desktop release` only with approved protected inputs. The release owner must verify that the workflow:

1. Revalidates the unsigned payload before any signing authority is exposed.
2. Limits Authenticode mutation to the documented PE and NSIS outputs.
3. Removes the certificate and PFX before updater private-key use.
4. Silently installs into a fresh canonical path on an ephemeral runner.
5. Verifies installer, installed native, and uninstaller signatures and RFC3161 timestamps.
6. Proves the installed native is byte-identical to the captured signed-native evidence.
7. Rehashes every installed resource, rejects extras and reparse points, and confirms the mandatory application and runtime licenses/notices.
8. Revalidates the immutable unsigned payload immediately before startup and passes the unsigned job's resource-manifest digest, rather than a mutable installed value, to acceptance.
9. Runs `desktop:startup-smoke` against that exact installed executable with the production identity and packaged flag.
10. Requires the authenticated readiness and clean-shutdown result, then silently uninstalls and proves removal.
11. Emits only the documented public artifact set and binds its hashes into release evidence.

The production acceptance guard requires caller-provided `GITHUB_ACTIONS=true` and `PROVENANCE_EPHEMERAL_ACCEPTANCE=1` markers and refuses any existing production profile. This is a safety interlock, not authenticated GitHub provenance. Do not bypass it to test a developer's real production profile; retain the protected-workflow run, environment approval, candidate SHA, and signed artifact hashes as provenance evidence.

### Unsigned pilot installer

The pilot installer is useful only for pre-release usability work on machines
controlled by the project. Provision the native workflow's hash-pinned
`cargo-about`, and use a Windows x64 Node distribution with its adjacent
`LICENSE`:

```powershell
npm run desktop:pilot-installer -- `
  --updater-public-key <pilot-public-key-outside-repo> `
  --node <node-distribution>\node.exe `
  --node-license <node-distribution>\LICENSE
$pilotEvidence = Get-Content -Raw `
  src-tauri/target/pilot-installer/cargo/release/bundle/nsis/provenance-pilot-evidence.json |
  ConvertFrom-Json
npm run desktop:startup-smoke -- --binary <fresh-installed-pilot-executable> `
  --profile pilot --packaged `
  --expected-resource-manifest-sha256 $pilotEvidence.runtimeResourceManifestSha256
```

The builder persists the bounded, non-secret evidence sidecar shown above next
to the installer. Retain its hash with the local pilot evidence; it binds the
installer, the exact resource-manifest digest required by packaged acceptance,
the bundled Node hash, and the exact application, JavaScript, Rust, and Node
license inventory. It also records the validated `cargo-about` version and
executable hash plus the `Cargo.lock` hash used to generate the Rust notices.

The pilot uses `dev.provenance.desktop.pilot`, a separate build target, and a
credential-free HTTPS updater endpoint under the RFC 2606 reserved `.invalid`
domain. Acceptance suppresses updater network activity. It includes a complete
hash-bound application/runtime license and notice inventory, but the
application, installer, and local Node runtime are not authenticated by the
protected production signing policy. The local updater key, unavailable command
sandbox, and absence of protected release attestation remain explicit blockers.
It must not be distributed or treated as a production artifact.

## 6. Independent security test cases

For each case record preconditions, action, expected result, actual result, evidence reference, and finding id. Test with synthetic data only.

### Authentication and request integrity

- Protected reads and mutations reject a missing, invalid, expired, logged-out, or version-revoked bearer.
- A viewer can read permitted state but cannot create, approve, configure, or mutate.
- Bootstrap requires the operator token when configured; the last administrator cannot be deleted.
- Cross-site mutation attempts fail Host/Origin/Fetch-Metadata checks.
- Public status routes expose no secrets, stored kernel objects, absolute private paths, or mutation authority.
- Native acceptance never publishes proof while access remains open, login/session verification or the protected kernel read fails, bridge authentication fails, or the desktop worker is unavailable.

### Approval and capability boundary

- A browser or desktop write first returns `approval_required` and performs no external side effect.
- Only a matching approved intent can continue; changed parameters, expired approvals, and reused approvals fail.
- Capability grants are consumed before worker I/O and one-use dispatch authorization cannot be replayed, used by another worker, or used for a changed intent.
- Stop All prevents new dispatch and produces an uncertain/blocking outcome when a side effect may already have occurred.

### Browser boundary

- Off-allowlist initial URLs, server redirects, script navigation, click navigation, popups, and origin drift are blocked and unexpected pages are closed.
- `browser.inspect` remains read-only; navigate/click/type never become L0/L1 through caller input.
- A download initiated by a write is rejected and no file is retained.
- Research capture never follows a redirect or accepts provider-created URLs.
- Native webview navigation must remain at the exact expected loopback origin, and a stale or foreign page cannot answer the per-launch challenge accepted only by the Rust-owned endpoint.

### Desktop and native boundary

- A fresh pilot profile requires explicit application/workspace choices; invalid, empty, duplicate, relative, or resource-overlapping selections fail.
- Discovery exposes only allowlisted executables. A process/window/tree/node change between inspection and mutation fails closed.
- Queue-full, expired, or generation-invalidated UI Automation work fails before a side effect. Once a COM mutation has started, timeout or failed post-write verification returns an uncertain outcome and cannot be retried automatically; a broker-level timeout additionally makes UI Automation unavailable.
- Typing uses a synthetic document, a consume-once text payload, a fresh value pattern after focus, and post-write observation. Reuse and stale intent hashes fail.
- Killing Node, the bridge, or the UIA broker triggers fail-closed host behavior and cannot leave an active dashboard claiming readiness.
- A second host cannot own the same runtime. A recovery page, process survival, owner record, or log phrase alone cannot satisfy acceptance.
- The monitor must complete its explicit startup handshake before acceptance; merely spawning its task is insufficient.
- The acceptance proof cannot be replayed across nonces, host pids, Node pids, host-instance ids, compiled identifiers, Tauri application versions, or packaged/unpackaged modes.
- Window close requests authenticated graceful Node shutdown. A forced Job Object fallback is contained but fails acceptance, and the attested Node pid must be dead before cleanup passes.

### Sandbox and filesystem boundary

- Native command dispatch fails before capability consumption when Docker, the exact image, or exact workspace probe is unhealthy.
- Native mode never uses trusted-host fallback. Standalone fallback is clearly reported as degraded.
- Symlinks/reparse points, path traversal, case/normalization tricks, resource/workspace overlap, manifest extras, resource substitutions, and a digest differing from the compiled manifest are rejected.

### Release, update, and recovery boundary

- Tampering with the payload, application license, Node license, notices, native executable, installer, signed bundle record, or updater metadata fails verification.
- A wrong signer, missing timestamp, stale key, wrong endpoint, or signature from the wrong phase fails closed.
- Interrupted snapshot/release operations restore only authenticated state and record uncertain or rollback-failed outcomes without reporting success.
- Updater network, manifest, or signature-check failure installs no candidate, records coded diagnostics, and leaves the current trusted version running. Because automatic rollback of an already installed trusted parent is absent, separately execute and time the documented manual rollback.
- Uninstall removes the isolated install; shutdown removes the acceptance proof and runtime-owner record.

## 7. Evidence handling

The evidence archive must contain:

- Candidate record and hashes from section 1.
- Tool versions, machine/VM description, Windows build, WebView2 version, Docker version/status, and test timestamps in UTC.
- Full local and workflow logs, test reports, audit findings, release attestations, resource manifests, signature/timestamp output, installed inventory, and uninstall result.
- Screenshots or recordings for consent, approval, harmless Notepad mutation, Stop All, rollback, and pilot UX observations.
- Independently computed SHA-256 hashes for every retained artifact and one hash for the final evidence archive.
- A redaction manifest describing every removed field without replacing it with fabricated data.

Never retain provider keys, operator tokens, passwords, session bearers, bootstrap secrets, bridge secrets, raw acceptance nonces, signing private keys, PFX files/passwords, cookies, or participant content. Store audit evidence read-only with access logging and an agreed retention/deletion date.

The native acceptance proof is ephemeral by design. Retain the command output and workflow log, which identify the result without retaining the nonce or reusable authority.

## 8. Findings and release criteria

Use severities agreed with the independent auditor before testing:

- Critical: unauthorized code/action execution, signing/updater compromise, credential disclosure, or reliable escape from an asserted security boundary.
- High: approval/capability bypass, protected-state access, readiness forgery, origin escape, install/resource substitution, or fail-open native command execution.
- Medium: meaningful integrity, recovery, redaction, revocation, or denial-of-service defect requiring realistic preconditions.
- Low/Informational: hardening, documentation, usability, or defense-in-depth issue with no demonstrated boundary bypass.

Release acceptance requires:

- All local, ordinary CI, and protected installed-artifact gates green for the same candidate SHA.
- Zero open Critical or High findings.
- Every Medium finding remediated or explicitly accepted by the release owner with scope, expiry, and compensating control.
- Manual trusted-parent rollback successfully exercised on a representative machine.
- Representative harmless desktop and browser actions complete only after approval and leave expected ledger evidence.
- Independent auditor attestation and pilot-owner acceptance are both signed below.

Any altered candidate invalidates prior acceptance unless the independent auditor documents why narrowly scoped evidence remains applicable and reruns all affected gates.

## 9. Rollback and incident criteria

Immediately stop release or pilot access when any of the following occurs:

- A Critical/High finding, suspected key or credential exposure, authority bypass, unexplained external side effect, evidence mismatch, or artifact hash drift.
- A forced termination, lingering process/profile/proof, corrupted ledger/snapshot, unresolved uncertain action, or failed rollback/uninstall.
- Unexpected network destination, sensitive-data disclosure, provider use outside participant consent, or loss of audit evidence.
- Crash, startup failure, or material workflow failure above the pilot threshold agreed before enrollment.

Response sequence:

1. Stop publication and pilot enrollment; preserve volatile evidence without collecting secrets.
2. Disable the update manifest or distribution channel and record who acted and when.
3. Revoke or rotate only credentials/keys plausibly exposed; do not destroy evidence.
4. Uninstall the candidate or reinstall the last accepted signed version using the documented manual rollback.
5. Verify runtime ownership, child termination, ledger/snapshot integrity, and artifact hashes.
6. Open an incident record with severity, scope, affected users/data, timeline, containment, remediation, and notification decision.
7. Build a new immutable candidate and rerun affected gates; never relabel the failed artifact as accepted.

## 10. Bounded pilot plan

The pilot is for usability and operational evidence, not permission to explore arbitrary authority.

### Enrollment prerequisites

- Use an internally controlled, non-production Windows machine or disposable VM with a tested rollback snapshot.
- Enroll a small named cohort in phases; record the participant count and roles before each phase.
- Use synthetic or explicitly approved low-sensitivity data only. Exclude secrets, regulated data, production credentials, and privileged business systems.
- Allowlist only the pilot application(s) and one disposable project workspace. Notepad with synthetic text is the default desktop target.
- Explain which prompts/source text go to the selected AI provider and obtain informed consent.
- Confirm support contact, pilot window, expected availability, diagnostic procedure, retention/deletion date, and withdrawal method.
- No centralized telemetry is assumed. Diagnostic or support-bundle sharing must be explicit, operator initiated, redacted, and logged.

### Pilot measures

- Successful clean starts, graceful shutdowns, and restart recovery.
- Time to authenticate, understand authority, configure allowlist/workspace, approve an action, and locate evidence.
- Browser/desktop task success, blocked unsafe attempts, uncertain outcomes, crashes, forced kills, and rollback time.
- False approvals, confusing authority language, support volume, provider failures, and participant-reported privacy concerns.
- Evidence completeness: the participant can identify what was authorized, executed, observed, and retained.

Set numeric success/failure thresholds before enrollment:

| Measure | Pre-agreed threshold | Observed |
| --- | --- | --- |
| Participants and duration | `________________` | `________________` |
| Clean startup rate | `________________` | `________________` |
| Approved task success rate | `________________` | `________________` |
| Unexplained side effects | `0` | `________________` |
| Authority bypasses | `0` | `________________` |
| Data/security incidents | `0` | `________________` |
| Crash/forced-kill threshold | `________________` | `________________` |
| Rollback recovery time | `________________` | `________________` |

At pilot close, revoke test credentials, remove test profiles and artifacts according to the agreed retention policy, verify uninstallation/rollback, and publish a redacted findings summary. A maintainer's successful self-test is not an external pilot.

## 11. Independent sign-off

### Security auditor

- Organization: `____________________________________________________________`
- Auditor name and role: `___________________________________________________`
- Independence/conflicts statement: `_________________________________________`
- Scope completed and evidence archive hash: `_______________________________`
- Open findings/accepted risks: `_____________________________________________`
- Decision: `[ ] accept  [ ] accept with conditions  [ ] reject`
- Signature: `__________________________________` Date (UTC): `_____________`

### Pilot owner

- Organization/team: `_______________________________________________________`
- Owner name and role: `_____________________________________________________`
- Cohort, dates, and environment: `__________________________________________`
- Incident/rollback summary: `_______________________________________________`
- Decision: `[ ] accept  [ ] extend  [ ] stop/reject`
- Signature: `__________________________________` Date (UTC): `_____________`

### Release owner

- Name and role: `___________________________________________________________`
- Candidate SHA and installer hash rechecked: `[ ]`
- All conditions and risk acceptances reviewed: `[ ]`
- Decision: `[ ] release  [ ] hold  [ ] reject`
- Signature: `__________________________________` Date (UTC): `_____________`

Until all required fields are completed by the named independent parties for one immutable candidate, the external audit and pilot remain **pending obligations**, not completed milestones.

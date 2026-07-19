# Production Desktop Release v1 Implementation Record

Date: 2026-07-17
Updated: 2026-07-19
Status: Production Desktop Release v1 source and fail-closed workflow implemented; current full-suite and Windows CI evidence remain authoritative; no protected signed run, hosted manifest, production installer, or publication claimed
Predecessor: `docs/superpowers/plans/2026-07-15-native-desktop-runtime-v1-record.md`

This milestone turns the native Windows source slice into a production-release boundary without treating packaging as new model authority. The trusted Tauri/Rust host still owns runtime supervision and native configuration. The TypeScript kernel still owns policy, budgets, approvals, grants, worker dispatch, persistence, and evidence. Models and the remote dashboard cannot invoke the installer, updater, native dialogs, or configuration APIs.

## 1. Scope And Non-Claims

Implemented in source:

- Release-only NSIS packaging and updater-artifact configuration.
- A two-job unsigned-payload then protected-signing workflow with sanitized release planning and external-input validation.
- A self-contained built server plus exact bundled Node/runtime-license and JavaScript/Rust notice pinning.
- Native first-run executable-allowlist and project-workspace onboarding, one-time first-admin launch authority, and same-process fixed-authority desktop activation.
- Digest-pinned Docker command isolation with native fail-closed behavior.
- A Rust-owned signed-update check and explicit native install prompt.
- Authenticated coded diagnostics and operator-only redacted support bundles.
- Deterministic TypeScript desktop acceptance and controlled live Win32 UI Automation coverage.
- Exact Tauri callback signing constraints, signed-native capture, UNK-to-NSS transform attestation, and signed bundle evidence.
- Protected silent install/resource verification/uninstall acceptance and an exact four-file public release contract.
- Windows CI gates for TypeScript, clean packaged resources, Rust, release policy, and locked license evidence.

Not supplied or claimed by this repository:

- A production Authenticode certificate or Tauri updater private key.
- Protected production variables selecting the Node archive/license, Node vendor signer, Docker image, updater endpoint/key, timestamp service, or certificate identity.
- A produced, installed, hosted, or published NSIS artifact.
- A populated production `latest.json` endpoint.
- A completed protected signing workflow or representative installer/update acceptance on target fleets.
- Automatic rollback of an already installed trusted Tauri parent.
- Telemetry operations, an external penetration test, or an independent security audit.

Those are external release-owner and security-review responsibilities. The workflow fails when required inputs are absent rather than generating an unsigned or mutable substitute.

## 2. Release Trust Contract

`scripts/desktop-release.mjs` separates public policy and payload construction from private signing authority. Planning and unsigned construction require:

- `PROVENANCE_BUNDLED_NODE`: canonical absolute `node.exe`.
- `PROVENANCE_BUNDLED_NODE_SHA256`: exact executable digest.
- `PROVENANCE_BUNDLED_NODE_VERSION`: exact runtime-reported version.
- `PROVENANCE_BUNDLED_NODE_SIGNER_THUMBPRINT`: expected vendor Authenticode signer retained with a timestamp.
- `PROVENANCE_BUNDLED_NODE_LICENSE`: canonical bounded license file.
- `PROVENANCE_BUNDLED_NODE_LICENSE_SHA256`: exact license digest.
- `PROVENANCE_CARGO_ABOUT`: canonical absolute `cargo-about.exe`.
- `PROVENANCE_CARGO_ABOUT_SHA256` and `PROVENANCE_CARGO_ABOUT_VERSION`: exact generator identity.
- `PROVENANCE_UPDATER_PUBLIC_KEY`: canonical base64 transport of the bounded two-line Tauri minisign public key.
- `PROVENANCE_UPDATER_ENDPOINT`: credential-free public HTTPS static `latest.json`.
- `PROVENANCE_SANDBOX_IMAGE`: immutable `registry/repository@sha256:<digest>` reference.

Protected native/NSIS bundling additionally requires:

- `PROVENANCE_PRODUCTION_BUNDLED_NODE_SIGNER_THUMBPRINT`: distinct protected-job pin for the same timestamped vendor signer.
- `PROVENANCE_WINDOWS_CERTIFICATE_THUMBPRINT`: certificate-store Authenticode identity.
- `PROVENANCE_WINDOWS_TIMESTAMP_URL`: credential-free public HTTPS timestamp service.
- `PROVENANCE_WINDOWS_SIGN_COMMAND_SHA256`: exact repository signing-helper digest.
- `PROVENANCE_UNSIGNED_PAYLOAD_MANIFEST_SHA256` and `PROVENANCE_UNSIGNED_NATIVE_SHA256`: cross-job payload attestations.
- A PFX exposed only while Authenticode signing runs.

The external `TAURI_SIGNING_PRIVATE_KEY` is deliberately withheld until the PFX and imported certificate have been erased. It signs the final installer and the canonical bundle record; it is not passed to Tauri's NSIS bundling subprocess.

The planner also requires the version in `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` to match. Its public output contains only release metadata and digests. The release contract fixes `@tauri-apps/cli` `2.11.4` in `package.json`, `package-lock.json`, and the installed tree; records the JavaScript and Cargo lock hashes; and requires exact generated Rust-notice evidence. Private-key and PFX variables are rejected or removed from unsigned/build subprocess environments.

The base Tauri configuration remains a non-bundled development target. `src-tauri/tauri.release.conf.json` is merged only by the release script and enables current-user NSIS output, an embedded WebView2 bootstrapper, and LZMA compression. Updater artifacts are not implicitly generated by bundling. Dynamic release configuration maps only freshly staged, manifest-bound copies of the complete built `dist` resources, pinned runtime, and runtime license. It injects updater public policy and a fixed custom Authenticode callback without writing protected values into tracked configuration.

`npm run desktop:release:build-unsigned` performs the production web/server build, JavaScript and Rust notice generation, clean-resource server smoke, and unsigned native compilation. It stages an exact-manifest-only payload containing the unsigned native, web/server resources, both notice files, the production Node runtime, and its license. Symlinks/reparse points, extra files, path escapes, mutable markers, and hash/size mismatches are rejected. `verify-unsigned` independently authenticates the full payload before the protected job may use it.

Protected `bundle-signed-native` copies the verified resources again into a fresh release target and rehashes that exact tree before and after Tauri bundling. The hash-pinned `scripts/windows-sign-command.ps1` callback may mutate only three identities: the exact native executable, the constrained NSIS temporary uninstaller, and the exact final setup executable. The already vendor-signed manifest-bound Node runtime and five exact copied NSIS build plugins are verified no-op callbacks. Any other path, reparse traversal, unbounded file, signer, timestamp, certificate, or signing-tool identity fails closed.

Tauri 2.11.4 changes the native bundle marker from `__TAURI_BUNDLE_TYPE_VAR_UNK` to `__TAURI_BUNDLE_TYPE_VAR_NSS` immediately before the native signing callback. The callback signs that file and captures it to a create-new attestation path before Tauri restores the original unsigned/unpatched target after bundling. The verifier requires that restored target to remain byte-identical and unsigned. For the capture, it permits only the single marker replacement, the PE checksum/security-directory changes, zero alignment padding, and one aligned EOF `WIN_CERTIFICATE`. It records the unsigned/signed hashes, exact marker offset/from/to values, certificate offset/size/hash, Authenticode signer, and timestamp.

The canonical bundle record binds that transform and signed-native capture to the preserved unsigned manifest/native, fixed signing helper, lock/license policy, Rust notices, and exact NSIS installer. The updater key separately signs both the installer and record. `latest.json` and `release-attestation.json` carry the record hash, its signature, and its canonical base64 bytes so public verification does not depend on an unbound side file. The updater signature remains authorization; SHA-256 values and Authenticode records are additional identity/evidence checks.

## 3. Protected Windows Workflow

`.github/workflows/windows-release.yml` is manual and has three authority stages. The `build-unsigned` job has no signing secrets. It:

1. Uses exact CI Node.js `22.23.1` and Rust MSVC `1.97.0`.
2. Installs locked JavaScript dependencies, fetches only `Cargo.lock`-resolved Rust dependencies, and provisions `cargo-about` `0.9.1` only after matching the fixed archive and executable hashes.
3. Downloads the configured Node archive and checks its archive digest, exact x64/win32 version, vendor Authenticode signer/timestamp, executable hash, adjacent `LICENSE`, and license hash.
4. Proves no certificate, PFX, or updater private key is present.
5. Runs TypeScript, Rust, desktop acceptance, release, packaged-resource, and JavaScript/Rust license gates.
6. Builds, independently verifies, and uploads an untouched exact unsigned payload for 14 days, together with cross-job manifest/native/sign-helper hashes.

The `sign-and-verify` job runs only for `main` or a `v*` tag and requires the protected `production` environment. Before secrets, it checks out the exact revision, uses the same exact toolchain, re-provisions license tooling, re-downloads Node under distinct `PROVENANCE_PRODUCTION_*` variables, verifies its vendor signature again, downloads the untouched payload, and requires every production policy/hash and the signing helper to match. It then imports exactly one expected code-signing certificate, constrains `signtool.exe` to a valid Microsoft-signed Windows SDK binary, runs the exact callback-time signing/bundling operation, and erases the PFX and every newly imported certificate in a `finally` path.

With Authenticode private authority gone, the workflow verifies the installer and capture, silently installs to a fresh temporary root, checks installed native/uninstaller signatures and timestamps, requires the installed native hash to equal the callback capture, verifies every installed resource against the unsigned payload, rejects extra entries and reparse points, and silently uninstalls. Only then does it expose the Tauri updater key to sign the installer and bundle record. It publicly re-verifies the complete chain and uploads exactly four files: the setup `.exe`, its `.sig`, `latest.json`, and `release-attestation.json`.

Publication is a separate job with `contents: write`, the protected `production` environment, an explicit `publish` input, and a required immutable tag exactly matching `v<manifest version>`. It rechecks the four-file shape before creating the GitHub release. The code path does not imply that the environment, variables, secrets, certificate, keys, hosted manifest, or release assets exist. A successful ordinary pull-request CI run does not publish anything. Protected-environment review and certificate/key custody remain external organizational controls; repository code running after secret exposure cannot prove those controls by itself.

## 4. Self-Contained Runtime Resources

The server build uses esbuild to produce `dist/server.cjs` and emits a dependency metafile plus `THIRD_PARTY_NOTICES.txt`. JavaScript licenses are parsed with exact `spdx-expression-parse` `5.0.0` under the repository allowlist and generated deterministically from the installed `package-lock.json` tree. CI first acquires only `Cargo.lock`-resolved crates with `cargo fetch --locked`; Rust notices are then generated offline from frozen `Cargo.lock` metadata under `about.toml` with hash-pinned `cargo-about` `0.9.1`. CI pins its archive SHA-256 to `318893aff6b9efd60f70470f5827b9577ae20a805cf9732d5612862a78508581` and executable SHA-256 to `e15e1af0b7c671bac972b21916b86726d0bf183ae121c85fb645bc618e911d3f`. Both notice files and the exact adjacent Node license are payload resources whose hashes are bound into release evidence. License-policy output is compliance evidence, not legal advice.

`scripts/packaged-server-smoke.mjs` copies only `dist` and a selected Node executable into a clean temporary resource root, clears `NODE_PATH`, audits external imports, launches the server, and probes auth status, diagnostics, and the public runtime report. Release planning independently verifies the selected Node executable version/platform/architecture, vendor signature/timestamp, and exact Node/license hashes.

The clean server bundle permits only Node built-ins, a development-only dynamic Vite import, and three audited optional fallbacks: `supports-color`, `bufferutil`, and `utf-8-validate`. Installer v1 intentionally does not bundle repository `node_modules`, a Playwright browser engine, or the optional `node-llama-cpp` native runtime and model. The smoke therefore requires local-core-model and browser-write workers to report unavailable rather than pretending those optional resources exist. Provider-backed application AI and read-only web inspection remain separate capabilities.

## 5. Native First-Run Authority

Packaged releases no longer require environment-provided application authority. On first run, `src-tauri/src/onboarding.rs` asks the user to select up to 32 `.exe` files, canonicalizes them, derives deterministic path-bound application ids, shows the selected file names, and requires a second confirmation before writing `desktop-allowlist.json` under Tauri's per-user configuration directory. A packaged launch ignores `DESKTOP_APP_ALLOWLIST`. Invalid persisted data is never silently repaired: the user must approve quarantine and reconfiguration.

The host separately asks the user to select and confirm a project command workspace. The workspace must be a canonical directory with a real, non-symlink `package.json`, and it must be disjoint from packaged resources, native runtime state, and native configuration. The selected path is persisted as `project-workspace.json`; invalid state receives the same explicit quarantine flow. A packaged launch ignores `PROVENANCE_WORKSPACE_ROOT`, while development mode retains explicit environment overrides for reproducibility.

A fresh per-user packaged runtime has no account. Rust generates a 256-bit URL-safe first-admin authority for that launch, passes it only in the supervised Node environment, and opens the webview with it in the URL fragment. The dashboard immediately strips that fragment from URL/history, stores the value only in module memory, and sends it only in `x-provenance-first-admin-bootstrap` on account creation. Node deletes the environment value after constructing the bootstrap authority. While it is pending, the shared access guard denies all other API traffic; the auth router exposes only status and first-admin creation. The secret is one-use and is consumed only after durable account persistence.

Successful bootstrap immediately logs the administrator in and invokes a same-process desktop-authority refresh. The server changes to `multi_user`, authenticates bridge health, and activates the existing unavailable worker registration. The registry allows only a one-way availability transition with byte-for-byte equivalent configured authority; worker id, supported operations, risk levels, and application allowlist cannot expand. If refresh fails, the account remains committed but desktop stays unavailable, and a later valid login may retry. No application restart is required or used as an authority transition.

The native host executable itself cannot appear in the desktop application allowlist. This prevents the control plane from being granted authority over its own trusted window/process identity.

## 6. Command Isolation And Workspace Health

The release build embeds only a digest-pinned sandbox image reference. The Tauri supervisor passes that value, the exact confirmed workspace, and a packaged-release marker to the minimal Node environment. It does not pass general inherited command authority.

At Node startup, `resolveCommandSandbox` probes the Docker daemon and actually starts the configured image with the selected workspace mounted at `/workspace`. The probe and later commands use the same no-network, read-only-root, bounded-resource policy. If the image reference is absent or mutable, Docker is unreachable, the image cannot start, or the exact workspace mount/probe fails, the native runtime installs a disabled sandbox. The runtime report and diagnostics identify command execution as unavailable, and the command worker returns before consuming its one-use capability.

The existing allowlisted trusted-host runner remains only for a standalone source checkout. It is reported as degraded and never selected when any native desktop launch marker is present. The Windows job object supervises the Node child but is not described as a command sandbox.

## 7. Signed Updater And Recovery Boundary

`src-tauri/src/updater.rs` is started only for a packaged release. It uses Tauri's updater plugin with a bounded timeout, checks the configured HTTPS manifest, verifies updater signatures under the configured public key, and writes only a small diagnostic status record containing schema version, phase, current version, and optional candidate version. Endpoint URLs, public keys, private keys, signatures, tokens, and raw errors are omitted.

When an update is available, the host displays a native Yes/No dialog. Declining records `deferred`. Accepting records `installing`; the updater callback shuts down the supervised Node child before process exit. Check/build/download/install errors become coded `check_failed` or `install_failed` state without widening authority. The remote dashboard has neither `updater:*` nor `dialog:*` Tauri capability.

This is early, signed, user-approved, fail-closed recovery. It is not an automatic rollback supervisor for the installed Tauri parent. If a newly installed host cannot launch correctly, restoration of the prior installer remains an operator/deployment responsibility. The existing controlled Node-child release lifecycle is separate: it keeps its previous child active until a candidate proves readiness and can remove a failed candidate before commit. That child rollback must not be used to claim Tauri-parent rollback.

## 8. Diagnostics And Redaction

`GET /api/kernel/diagnostics` follows the unified access guard and returns `Cache-Control: no-store`. In protected modes it requires authenticated read authority; loopback `open` mode retains the product's documented no-bearer contract. It reports bounded build/runtime metadata and coded aggregate health for kernel snapshot, ledger, workers, access control, command sandbox, desktop bridge, provider router, and the recurring-research scheduler. It does not return provider credentials, user records, goals, task content, ledger payloads, absolute paths, or update authority.

`POST /api/kernel/diagnostics/support-bundle` requires operator/admin mutation authority in protected modes. It creates a bounded canonical JSON document through the kernel artifact store and returns it as an attachment with artifact id and SHA-256 headers. Protected-mode viewers cannot create it; loopback `open` mode follows the same no-bearer mutation contract as the rest of the kernel. The safe schema allows coded component/event identifiers, bounded numeric/boolean metrics, and a narrow context vocabulary. Sensitive keys such as authorization, cookies, credentials, passwords, API keys, private keys, sessions, nonces, payloads, content, prompts, input/output, messages, and text are replaced by redaction markers. Other strings become keyed correlation hashes; unsupported values, deep structures, and excessive items receive coded markers.

`verifyDiagnosticSupportBundle` checks the exact safe schema, canonical JSON encoding, size bounds, and SHA-256 integrity. That checksum detects modification; it is not signer authentication and must not be presented as an attested forensic archive.

## 9. Final Trust-Boundary Closure

The final regression pass closed four runtime gaps adjacent to packaging. Browser write contexts now block off-origin top-level document requests before dispatch, reject unexpected pages, disable accepted downloads, and cancel/delete any click-triggered download before closing the context. UI Automation revalidates the exact executable/PID/window/tree/path/node before mutation; typing discards its pre-focus value pattern, rebuilds the authoritative tree after focus, and acquires a fresh pattern immediately before `SetValue`.

Skill evidence now comes from a separately configured evaluator trust root. The API accepts only a source id. An allowlisted resolver supplies hash-sealed held-out cases, the kernel records source attestation before the suite and candidate, binds the authenticated candidate author, and rejects caller authority claims, legacy/raw expectations, same-author evaluation, and training overlap. Oracle values remain kernel-private and APIs return metadata. The standard server has no default evaluator resolver, so this capability is unavailable rather than self-attested until an independent integration is supplied.

Controlled Windows Node-child activation no longer relies on post-launch `taskkill` as its containment proof. The canonical Tauri executable has a private runner mode that validates the exact Node executable, release root, and `.cjs` entrypoint, creates the candidate suspended, assigns it to a nested kill-on-close Job Object, and only then resumes it. The trusted Node parent authenticates a nonce/version/hash/PID readiness file and fails closed if the native runner or runtime directory is absent. POSIX retains detached process-group ownership. Cleanup failures remain retryable/tracked and surface as `rollback_failed`.

## 10. Acceptance And CI Evidence

`npm run desktop:acceptance` runs the actual TypeScript kernel, artifact/payload stores, approval continuation, capability dispatch, and desktop worker against a deterministic authenticated-bridge fixture. It covers native health registration, discovery, exact-revision inspection, click approval/consumption, typed-payload consumption and non-persistence, uncertain mutation recording, and automatic retry blocking. Its report says `liveUiAutomation: false` by design.

The Rust Windows test suite separately creates a temporary real Win32 top-level window with edit and checkbox controls, allowlists the current test executable, discovers and inspects it through the real UI Automation broker, invokes the checkbox, types into the edit, and re-observes native control state. That is live UIA evidence against controlled Windows controls. It is not representative application acceptance and does not test arbitrary vendor accessibility trees, elevation boundaries, production installer behavior, or update replacement.

`.github/workflows/native-desktop.yml` uses exact CI Node.js `22.23.1`, Rust MSVC `1.97.0`, and the same hash-pinned `cargo-about` `0.9.1`. It runs:

- `npm run lint`
- `npm test`
- `npm run desktop:release:test`
- `npm run build`
- `cargo fetch --manifest-path src-tauri/Cargo.toml --locked`
- `npm run desktop:licenses`
- `npm run desktop:resource-smoke`
- `cargo fmt --check`
- `npm run desktop:test`
- `npm run desktop:check`
- Clippy across all targets with warnings denied

The completed local TypeScript suite passed **532 tests across 85 files** on 2026-07-19, and the release-policy subset passed **24 tests across 4 files**. Later runs remain authoritative as the suite evolves. Local lint/build, deterministic desktop acceptance, release-policy tests, audit, and clean-resource smoke can be verified on this workstation. Windows Application Control blocks local Cargo linking, and a failed rustup rollback left the local rustfmt component unavailable, so Rust format/test/check/Clippy and native compilation are not claimed as passing locally; the pinned Windows CI job is the source of truth for those gates.

## 11. Remaining Production Gates

Before a production release can be called complete, the release owner still needs to:

1. Establish certificate and updater-key custody, rotation, revocation, and incident procedures.
2. Populate and independently review every protected production variable, including Node distribution/license/vendor signer, sandbox-image provenance, updater endpoint/public key, certificate thumbprint, and timestamp service.
3. Run the protected release workflow with the real PFX/updater key and retain the unsigned payload, signed-native capture, bundle record, installer/signature, four public files, and workflow evidence.
4. Install, upgrade, downgrade/recover, uninstall, and reboot-test on representative supported Windows versions and user policies.
5. Exercise Docker present/absent/unhealthy/image-missing/workspace-denied paths on installed builds.
6. Validate representative third-party applications through the UIA approval and uncertain-outcome paths.
7. Supply and review an independent skill-evaluator resolver, evaluator allowlist, held-out source custody, and rotation process.
8. Decide and implement a trusted-parent rollback strategy or document manual recovery as the supported contract.
9. Define telemetry collection, retention, consent, redaction, and operational ownership before enabling telemetry.
10. Complete an independent external security audit and resolve or explicitly accept its findings.
11. Publish only through the protected production environment, operate the hosting path, and independently fetch and verify the hosted `latest.json` and all four downloadable artifacts from a clean machine.

Until those gates are evidenced, the accurate status is: production-release source, deterministic gates, and protected workflow implemented; an independent skill-evaluator integration, external signed release, hosted update operation, representative-machine acceptance, telemetry operation, trusted-parent automatic rollback, and independent assurance remain pending.

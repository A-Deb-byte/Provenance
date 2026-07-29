# Release-Hardening Handoff - 2026-07-27

- Branch: `codex/production-desktop-release-v1`
- Baseline commit at the start of this milestone: `c319180`
- Status: The July 27 working tree passed the 635-test TypeScript matrix, 68 Rust tests, the 83-test release contract, full and production JavaScript dependency audits, replay and strict-ledger gates, development-native acceptance, and fresh license-complete installed unsigned-pilot acceptance. The first ordinary CI attempt then exposed a Windows test assertion and full-runtime test-budget issue; repair commit `ca482a47edbf9653e9bee85be2b83dc1e42414a6` subsequently passed same-SHA ordinary CI. Protected production signing, independent audit, and external pilot sign-off remain pending.

## Read this first

The previous startup handoff described a liveness smoke that used a real application profile and could pass while the host sat in recovery. That is no longer the intended acceptance boundary. Current code isolates state by compiled identity and requires a nonce-bound authenticated proof of full initialization.

Use [`external-security-audit-and-pilot-runbook.md`](./external-security-audit-and-pilot-runbook.md) as the release acceptance contract. The older session and pilot documents remain timestamped history.

## Current release-hardening scope

The working tree implements or is integrating:

- Separate identities for development (`dev.provenance.desktop.development`), unsigned pilot (`dev.provenance.desktop.pilot`), and protected production (`dev.provenance.desktop`).
- Fresh identity-specific local/roaming profiles and scratch workspaces for native acceptance. Existing profiles cause the gate to refuse rather than reuse state.
- Node readiness schema v3, bound to the launch nonce, Node pid and port, host-instance id, kernel readiness, authenticated access mode and native bridge, scheduler state, and desktop availability.
- A native HMAC-SHA256 acceptance attestation bound to the nonce, compiled identifier, Tauri application version, host and Node pids, and host-instance id. It additionally requires runtime ownership, healthy UI Automation, a monitor-start handshake, exact-origin native navigation, and a fresh frontend challenge.
- A build-embedded canonical runtime-resource manifest. Packaged startup authenticates declared paths, sizes, and hashes, rejects undeclared, reparse-point, and non-regular entries in the exact `dist` inventory, retains the opened files, and binds acceptance to the independently retained manifest digest. Node serves only manifest-authenticated index and asset entries; complete installed-tree verification remains a protected-workflow gate.
- A one-use frontend mount token accepted by a Rust-owned loopback endpoint after exact Host, Origin, and body checks; Node does not receive that authority.
- Raw-value-omitting schema-2 capability decision records plus an operational gate that drives the real kernel and requires separately implemented strict replay of the persisted ledger. Exact URL and relation commitments can remain guessable for low-entropy source values, and the ledger has no external non-repudiation anchor.
- Authenticated Node graceful shutdown plus proof that the attested Node pid, runtime owner record, and ephemeral acceptance proof clean up. Forced containment may stop a failed run but never passes the gate.
- A protected release step that launches the exact installed, signed native executable after signature, hash, resource, and reparse-point verification, then proves silent uninstall.
- Consistent BUSL-1.1 declarations in the Node package, lockfile, and Rust crate, with the complete application `LICENSE` required as a hash-bound top-level release resource.
- A complete hash-bound application/runtime notice inventory in the pilot package and evidence sidecar. The pilot remains non-distributable because it is unsigned, uses a local Node runtime/updater key and deliberately unavailable command sandbox, and has no protected release attestation.

## What the acceptance proof means

A passing `desktop:startup-smoke` result means all of these were established for one launch:

1. A fresh isolated profile and multi-user account store were created.
2. The harness logged in through the real API, verified the returned session, and completed a protected kernel read.
3. The native host owned the runtime, the bridge was authenticated, and the fixed-authority UI Automation worker was healthy and available.
4. The scheduler, repository `.env`, and updater network activity were not allowed to affect the acceptance run.
5. The monitor-start handshake completed, native navigation stayed at the exact expected origin, and the dashboard completed a fresh challenge through the Rust-owned endpoint.
6. The HMAC proof matched the launch nonce, compiled identifier, Tauri application version, resource-manifest digest, host pid, Node pid, host instance, and packaged/development identity.
7. Authenticated Node shutdown produced a clean exit, the attested Node pid was dead, and ephemeral owner/proof state was removed.

Process survival, a window title, an owner record, child processes, or a log line no longer count as acceptance on their own. Recovery mode cannot publish the proof.

## Browser, sandbox, and authentication boundaries

- Browser inspection is L0 read-only. Navigation, click, and typing are minimum L2 and require approval; top-level origin is checked before and after navigation, unexpected pages are closed, and write-triggered downloads are rejected. Browser download is not implemented.
- Native command execution requires healthy Docker, the exact selected workspace, and a digest-pinned image. Native mode never uses trusted-host fallback. The unsigned pilot intentionally pins an unresolvable image, so command execution is unavailable by construction.
- Protected desktop readiness requires `operator_token` or `multi_user` authority. The acceptance harness uses isolated multi-user state and never passes a reusable dashboard token to the native host.
- A provider credential was previously exposed outside the vault during project work. Revoke or rotate it before pilot or release, store the replacement only in the server-side vault or protected secret store, and never record either value in evidence.

## Verification rule

Do not carry forward the old 43-Rust-test, 528/529-TypeScript-test, or 532-test totals as current evidence. They describe earlier trees. Record totals from the exact candidate run.

The current local working-tree evidence is recorded in [`2026-07-27-final-local-evidence.md`](./2026-07-27-final-local-evidence.md): 635 TypeScript tests, 68 Rust tests, 83 release-contract tests, full and production JavaScript dependency audits, replay and strict-ledger gates, development-native acceptance, and exact installed acceptance for a fresh license-complete unsigned pilot passed. The source repair passed ordinary same-SHA CI; those results still do not make protected or independent gates green.

At minimum, the candidate needs:

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
cargo +1.97.0 build --manifest-path src-tauri/Cargo.toml
npm run desktop:startup-smoke -- --binary src-tauri/target/debug/provenance-desktop.exe --profile development
git diff --check
```

The strict verifier path must be a populated runtime retained from the candidate evidence run; the non-strict verifier can succeed with zero events. The replay gate separately requires at least one kernel-persisted schema-2 decision, zero legacy outcome-only authorization records, zero divergences, and zero warnings. The full JavaScript audit covers build/test dependencies and the `--omit=dev` audit covers the production subset. Attach a separate independent advisory review for `Cargo.lock`, the pinned Rust/Tauri toolchain, and release/build dependencies.

The ordinary native workflow and protected Windows release workflow must then be green for the same candidate SHA. The protected workflow is the authority for the signed, silently installed production binary. Its smoke script's `GITHUB_ACTIONS` and `PROVENANCE_EPHEMERAL_ACCEPTANCE` values are caller-provided guard markers, not authenticated GitHub provenance; retain the workflow URL, environment approval, SHA, and artifact hashes. Do not claim remote green from local results.

## Licensing status

The application license is BUSL-1.1. With no Additional Use Grant, it permits non-production use; it does not generally permit internal production use. Production use requires a commercial license until the applicable Change Date. The production resource contract includes:

- Root application `LICENSE`.
- JavaScript third-party notices.
- Rust third-party notices.
- Exact Node `node.exe` and its adjacent `LICENSE`.

Engineering checks can prove declarations, file presence, and hashes. They cannot resolve source provenance, attribution ownership, commercial terms, or trademark questions; those remain legal-review items.

## Pending external obligations

Even after all repository and workflow gates are green, these remain incomplete until performed by the named parties:

- Independent security architecture review and penetration testing.
- Representative desktop/browser abuse testing and manual trusted-parent rollback.
- A bounded external or independent-user pilot with consent, data handling, support, incident, and withdrawal procedures.
- Auditor, pilot-owner, and release-owner sign-off for one immutable candidate.
- Production certificate/updater-key custody, hosted manifest operations, telemetry policy, and incident-response ownership.

No project contributor or AI agent should self-certify those obligations. Use the sign-off fields and evidence requirements in the runbook.

## Historical evidence

The following remain useful as dated observations, not current release verdicts:

- [`2026-07-20-session-record.md`](./2026-07-20-session-record.md): licensing, packaged Node/browser pilot, and access-control checks.
- [`installer-and-startup-verification.md`](./installer-and-startup-verification.md): three original native startup defects and the first unsigned pilot build.
- [`native-host-startup-defect.md`](./native-host-startup-defect.md): first startup panic diagnosis.
- [`pilot-and-verification-evidence.md`](./pilot-and-verification-evidence.md): browser L2 continuation and multi-user observations.
- [`windows-native-build-runbook.md`](./windows-native-build-runbook.md): Windows toolchain and current build/acceptance commands.

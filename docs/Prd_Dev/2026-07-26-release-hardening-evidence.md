# Release-Hardening Evidence - 2026-07-26

## Scope

This is historical local mutable evidence for the July 26 working tree on
`codex/production-desktop-release-v1`, based on `c319180`. It is not protected
CI evidence, a signed production release, an external security audit, or
representative-user pilot acceptance.

The current mutable evidence is recorded in
[`2026-07-27-final-local-evidence.md`](./2026-07-27-final-local-evidence.md).

## Source And Native Gates

| Gate | Result |
| --- | --- |
| TypeScript | Historical composite evidence: the full run reached 626/627; after fixing the only DesktopPanel required-reason ordering failure, that file passed 5/5 and the App integration passed 3/3. This was not one clean 627/627 post-fix run. |
| TypeScript compile | `tsc --noEmit` passed. |
| Release contract | 75 tests across 10 files passed. |
| Rust | 67/67 tests passed, including the live controlled Win32 UIA test and fragmented graceful-shutdown response tests. |
| Rust static gates | `cargo fmt --check`, `cargo check --all-targets`, and clippy with `-D warnings` passed under Rust 1.97.0. |
| Decision replay | Operational gate replayed 8 kernel-persisted schema-2 decisions from 92 events with 0 outcome-only decisions and 11 acceptance checks. |
| Existing local ledger | Strict verification passed for 282 hash-chained events. |
| Desktop fixture acceptance | 11/11 deterministic kernel/bridge checks passed. |
| Production dependency audit | `npm audit --omit=dev --audit-level=high` reported 0 vulnerabilities. |
| Build and resource smoke | Production build and clean-resource server smoke passed. |

## Native Runtime Evidence

The freshly built development host passed authenticated readiness, unauthenticated
kernel-read denial, session login, protected kernel read, real
`worker.desktop.windows_uia` discovery, direct-child supervision, scheduler and
updater suppression, graceful shutdown, Node-process cleanup, and runtime cleanup.

During this run the real native dispatch exposed an outdated smoke assertion: Rust
correctly returned the canonical discovery reference
`desktop:windows.notepad:windows`, while the harness expected the older abbreviated
form. The harness and its tests were corrected, then development-native acceptance
passed.

## Installed Pilot Evidence

> Superseded pilot boundary: the artifact hashes below describe the earlier
> July 26 run, before the pilot builder required the Node `LICENSE` and
> hash-pinned Rust notice inventory. Current code rejects that incomplete
> package. A fresh install/smoke/uninstall run must replace these hashes before
> this section can serve as evidence for the current working tree.

A fresh unsigned pilot was built from an empty dedicated target, verified against
its evidence sidecar, silently installed to a new per-user directory, and exercised
through the installed `provenance-desktop.exe`. The installed binary passed the
same authenticated readiness, protected access, real UIA discovery, supervision,
graceful shutdown, and cleanup checks. Silent uninstall then removed the install
root.

| Evidence | Value |
| --- | --- |
| Pilot identity | `dev.provenance.desktop.pilot` |
| Pilot version | `0.1.0-pilot.1` |
| Installer SHA-256 | `6ed8fe7d49f9c5cabb2540367951b47e0411234d831052c2261428a78dcdc627` |
| Runtime-resource manifest SHA-256 | `21ffbc1ca78d30c35594609f089e72d16d0e160651fe6d434baaae7afcc7705b` |
| Evidence-sidecar SHA-256 | `eb0ace33d7091afc1afb2c29e2f2ef0ff16cbf2fde48cec12b5a6df2a4b21a91` |
| Bundled pilot Node | `v24.15.0` Windows x64 |
| Application license | BUSL-1.1, hash bound in the sidecar |
| Command sandbox | Permanently unavailable in this pilot by construction |

That superseded pilot was deliberately non-distributable: it was unsigned,
locally keyed, omitted the bundled Node license and Rust third-party notices,
and did not use the protected production Node policy. The disposable updater
private/public keypair was deleted after uninstall. The current builder includes
and hash-binds both previously omitted resources, but remains non-distributable
because it is unsigned, uses a local Node runtime and updater key, deliberately
disables command execution, and has no protected release attestation.

## Pending Gates

- Push the final commit and require ordinary remote CI for that exact SHA.
- Execute the protected workflow with production Node, Docker, certificate,
  timestamp, updater-key, environment-approval, and publication authorities.
- Rotate the provider credential previously exposed during project work before
  any further pilot or release; store the replacement only in the encrypted vault
  or protected secret store.
- Complete independent security review, representative third-party UIA/browser
  abuse testing, and an external consented pilot with named sign-off.

No repository contributor or AI agent can self-certify those external obligations.

# Release-Hardening Evidence - 2026-07-22

This record captures local evidence from the working tree on branch `codex/production-desktop-release-v1`, based on commit `c31918042bad0d9bb5eb6d1efbb4004fe4387b08`. It is not an immutable release attestation. The source must be committed, pushed, and rerun by ordinary and protected CI before any production claim.

## Implemented boundaries

- Development, pilot, and production use distinct compiled identifiers and AppData roots.
- Native acceptance requires a nonce-and-identifier pair, Tauri application version, exact host and Node process identities, authenticated bridge and dashboard mount, exact-origin navigation, multi-user kernel readiness, monitor startup, disabled scheduler/updater activity, and available UIA authority.
- The harness logs in as a fresh isolated administrator, verifies the session, reads the protected worker registry, confirms the attested Node pid is a direct child, performs a bounded liveness soak, closes the real window, and requires graceful Node and runtime cleanup.
- Clean shutdown is an authenticated Node request with a nonce-bound receipt. Forced Job termination remains containment only and cannot pass acceptance.
- The root `LICENSE` is BUSL-1.1 and is bound to SHA-256 `a1795552d1786d8f443187ac3de2b4a869bc94c706cfdc74b5825cbc13a5327b` across package, lockfile, Cargo, pilot, and production release policy.
- Protected release preflight rejects refs other than `main` and immutable `v*` tags before secret-bearing jobs. Strict ledger verification rejects missing or empty evidence.

## Local results

| Gate | Observed result |
| --- | --- |
| TypeScript | 570/570 tests across 90 files, executed as four serialized Vitest shards: 165, 135, 124, and 146 tests |
| Type checking | `npm run lint` passed |
| Web/Node build | `npm run build` passed; npm notices covered 459 packages |
| Release policy | 59/59 tests passed across seven focused release files, including the NSIS uninstall regression |
| Rust | 50/50 tests passed sequentially, including the real Win32 UIA fixture |
| Rust static gates | `cargo +1.97.0 fmt --all -- --check`, `cargo +1.97.0 check --all-targets`, and Clippy with `-D warnings` passed after the final native changes |
| Dependency audit | `npm audit --omit=dev --audit-level=high`: 0 vulnerabilities |
| Ledger | Strict verification passed for 282 hash-chained events; head prefix `46d0db1006b81f74` |
| Documentation links | 35 local targets across 27 Markdown files checked; 0 missing targets |
| Packaged resources | Clean-resource startup smoke passed with bundled Node v24.15.0 x64 |
| Deterministic desktop | Approval, continuation, payload, and uncertain-outcome acceptance passed |
| Development native | Authenticated startup against the exact debug executable passed, including login, protected read, direct child, graceful exit, pid death, and owner/proof cleanup |

Vitest initially allowed two process-owning suites to run concurrently. Under local Windows load, that delayed `taskkill` and recurring-mission cleanup beyond their finite bounds. Both suites passed alone (10/10 and 21/21), and the project runner now uses one worker so real process-tree ownership is serialized.

The live UIA fixture exposed asynchronous Windows accessibility state after `Toggle()` and `SetValue()`. Mutation verification now re-observes for at most 750 ms rather than assuming immediate state propagation; two focused live runs and the full 50-test Rust suite passed afterward.

## Installed pilot evidence

An isolated unsigned NSIS pilot was built with identity `dev.provenance.desktop.pilot` and version `0.1.0-pilot.1`.

- Installer: `Provenance Pilot_0.1.0-pilot.1_x64-setup.exe`
- Installer SHA-256: `ceb6f9a032667ef31bd7884fd0a1d52b930d16f0c973de6d5204b79c9834c534`
- Installed native SHA-256: `bfd90e61dcc4ae34e470d99d8675a93a840682237424e4c6b38c44a98948557b`
- Exact installed native acceptance: passed
- Authenticated readiness/session/protected worker read: passed
- Direct-child and graceful-shutdown evidence: passed
- Node pid and runtime proof/owner cleanup: passed
- Standard NSIS silent uninstall and installation-directory removal: passed

The first uninstall attempt reproduced a release-workflow defect: `_?=<install-root>` tells NSIS to keep the original uninstaller in place, contradicting the workflow's directory-removal assertion. The workflow now invokes the standard self-removing `/S` mode, and a regression test rejects `_?=`. The remaining `uninstall.exe` was then removed successfully by the corrected command.

This pilot is not a release artifact. It is unsigned, its ephemeral updater keypair was deleted after the run, command execution is disabled by an unresolvable digest-pinned sandbox image, and it omits the Node license and Rust notice payload required for redistribution. Production packaging must obtain those exact resources through the protected hash-bound workflow.

## Still pending

- Source diff and secret scan, and the final post-commit candidate rerun.
- Commit and push of the exact candidate, then ordinary remote CI for that SHA.
- Protected production execution with the real Authenticode certificate, RFC3161 timestamp service, updater key, pinned Node archive/license, cargo-about binary, environment approval, installed-resource inventory, and exact signed installed-binary acceptance.
- Rotation of the provider credential previously exposed outside the vault. No provider credential is recorded here.
- Independent security review, penetration testing, representative third-party application testing, bounded external pilot, and signed auditor/pilot/release-owner acceptance.

No maintainer or AI-generated evidence can satisfy the final independent sign-off fields in the external audit and pilot runbook.

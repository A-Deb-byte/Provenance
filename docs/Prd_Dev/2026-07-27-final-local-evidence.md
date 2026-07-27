# Final Local Evidence - 2026-07-27

## Scope

This is local, mutable evidence for `codex/production-desktop-release-v1` after
the July 27 hardening changes. It is not same-SHA remote CI evidence, a signed
production release, an independent security audit, or external pilot acceptance.

## Current Source Gates

| Gate | Result |
| --- | --- |
| TypeScript | `npm test` passed **635 tests across 96 files**. |
| TypeScript compile | `npm run lint` (`tsc --noEmit`) passed. |
| Release contract | `npm run desktop:release:test` passed **83 tests across 11 files**. |
| Dependency audit | `npm audit --audit-level=high` reported 0 vulnerabilities; the production-only audit remains a separate CI gate. |
| Bundle boundary | Production bundle and hostile-sibling packaged smoke passed: no non-builtin external require is permitted and packaged mode does not load `.env`. |
| Rust | `cargo test --all-targets` passed **68 tests**, including the controlled live Win32 UI Automation test. |
| Rust static gates | Pinned Rust `1.97.0` passed format check, all-target check, and Clippy with `-D warnings`. |
| Decision replay | The operational gate replayed 8 schema-2 decisions from 92 events, with 0 outcome-only decisions and 11 acceptance checks. |
| Existing ledger | Strict verification passed for 282 hash-chained events. |
| Desktop fixture acceptance | All 11 deterministic kernel/bridge checks passed. |
| Development-native acceptance | The newly built debug host passed authenticated readiness, 401 unauthenticated protected-read denial, login, protected read, UIA discovery, supervision, graceful shutdown, and runtime cleanup. |

All listed local gates ran after the final code hardening. They remain mutable
working-tree evidence, not proof for the final commit or remote release.

## Fresh License-Complete Installed Pilot

The pilot was built from an empty dedicated target using an official Node
`v24.15.0` Windows x64 archive whose SHA-256 matched the official checksum list
(`cc5149eabd53779ce1e7bdc5401643622d0c7e6800ade18928a767e940bb0e62`) and a
hash-pinned `cargo-about 0.9.1` executable
(`e15e1af0b7c671bac972b21916b86726d0bf183ae121c85fb645bc618e911d3f`).

| Evidence | Value |
| --- | --- |
| Pilot identity | `dev.provenance.desktop.pilot` |
| Pilot version | `0.1.0-pilot.1` |
| Installer SHA-256 | `2f23764009ab4313e828406785d04604ce60d63a11355d014732b5def1417688` |
| Runtime-resource manifest SHA-256 | `cd2cab2be2aedcb18d1e67eb435c66fe3741c31b348f03e42772adc9e6b3ce33` |
| Evidence-sidecar SHA-256 | `ec44acd89b1b612a03dea98592a202c762728d47c9c802800b7c153ad3d0c0e8` |
| Bundled Node | `v24.15.0` Windows x64 |
| Node `LICENSE` SHA-256 | `8efdacdc1cfa3460aeb7fe98e3c54337b971d5da70e6eee292b73b981acb220c` |
| Application `LICENSE` SHA-256 | `a1795552d1786d8f443187ac3de2b4a869bc94c706cfdc74b5825cbc13a5327b` |
| Rust notice SHA-256 | `350709aa412b23cead1af77f456fa714ab4f990a39051f591e12def6583d4d0a` |
| JavaScript notice SHA-256 | `cd6b4ced9673cb33795794831b02c0233fe539f0d81f054f2ea192e45f93e27f` |

The installer was silently installed into a fresh per-user directory. Its four
license/notice resources were rehashed against the sidecar, then its exact
installed `provenance-desktop.exe` passed nonce-bound authenticated readiness,
unauthenticated protected-read denial (401), session login and protected read,
desktop broker discovery, direct child supervision, scheduler/updater
suppression, graceful shutdown, Node cleanup, and runtime cleanup. The prior
pilot profile was isolated for the run and restored afterward. Silent uninstall
removed the fresh install root.

This pilot remains unsigned and non-distributable. It uses a local updater key,
has no protected release attestation, and deliberately disables sandboxed command
execution with an unresolvable pinned image. The disposable pilot keypair was
deleted after a second isolated install/smoke/uninstall cleanup check.

## Remaining Release Gates

- Commit this candidate and require ordinary remote CI for its exact SHA.
- Run the protected release workflow with protected production Node, Docker,
  certificate, timestamp, updater-key, environment-approval, and publication
  authority.
- Rotate the provider credential previously exposed during project work before
  any further pilot or release; retain only the replacement in the encrypted
  vault or protected secret store.
- Complete independent security review, representative UIA/browser abuse tests,
  and a consented external pilot with named sign-off.

No repository contributor or AI agent can self-certify the remote, protected, or
external obligations.

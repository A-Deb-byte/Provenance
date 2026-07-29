# Native Desktop Activation Evidence - 2026-07-29

## Scope

This record covers the Desktop Shell IPC / Windows UI Automation activation
work on `codex/production-desktop-release-v1`.

The dashboard at `127.0.0.1:3012` was a standalone `dist/server.cjs` preview.
Its missing native-host status was correct: a browser-started server has no
Rust-owned bridge, per-launch HMAC credential, host identity, or confirmed
application allowlist. This work does not copy those authorities into the
browser process or simulate availability.

## Changes

- Runtime reports now use sanitized desktop reason codes and remediation,
  distinguishing an absent native host, incomplete/invalid launch authority,
  access-control blocking, bridge health failure, and ready UIA state.
- The dashboard label is **Native host bridge**, not the overbroad
  **Desktop shell IPC**, and browser-only mode explains the native launch
  requirement.
- Desktop observations are discarded when worker/application authority
  changes. An uncertain mutation is shown as potentially executed,
  non-retryable, and requires fresh discovery and inspection.
- Failed desktop projections discard stale windows and controls and disable
  mutations until a complete authenticated refresh succeeds. Runtime and
  desktop polling are abortable, bounded, and non-overlapping.
- Windows UI Automation reports available only when the authenticated native
  bridge and the registered UIA worker both agree that it is executable.
- Rust UIA discovery skips PID-zero or unqueryable unrelated windows instead
  of aborting the complete allowlisted discovery. Executable-path matching is
  unchanged.
- Rust is pinned to `1.97.0` with Rustfmt, Clippy, and the Windows MSVC target.
- `npm run desktop:acceptance-host` builds a fixed acceptance-only Tauri
  identity in `src-tauri/target/acceptance`. It owns and removes only its fresh
  test profile, so repeatable native acceptance does not reuse or delete
  development or installed state and does not replace the ordinary development
  executable.
- Native acceptance launches a controlled visible WinForms fixture and now
  requires the exact randomized fixture title in the real UIA-discovered
  top-level-window projection. Another window from the same executable cannot
  satisfy the proof.
- The packaged-user workflow and recovery boundaries are documented in
  `docs/native-desktop-operator-guide.md`.

## Verification

All commands ran from the repository root on Windows:

| Gate | Result |
| --- | --- |
| `npm run lint` | Passed |
| `npm test` | 99 files, 678 tests passed |
| `npm run build` | Passed; production web and `dist/server.cjs` built |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | Passed |
| `cargo test --manifest-path src-tauri/Cargo.toml` | 69 tests passed |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | Passed |
| `node --check scripts/native-host-smoke.mjs` | Passed |
| `npm run desktop:acceptance-host` | Passed |
| `git diff --check` | Passed |

The authenticated native result reported:

```text
identity=dev.provenance.desktop.acceptance
desktopAuthority=available
authenticatedReadiness=passed
unauthenticatedKernelReadStatus=401
sessionAuthenticated=passed
protectedKernelRead=passed
desktopDiscovery=passed
desktopDiscoveryWindows=1
directChildSupervision=passed
shutdown=graceful
nodeProcessCleanup=passed
runtimeCleanup=passed
```

Rust's real Windows fixture also passed discover, inspect, click, and type
against a temporary Win32 checkbox and edit control.

## Remaining Boundaries

Desktop v1 controls already-running, visible, explicitly allowlisted
applications. It does not launch/close applications, provide arbitrary shell
or elevation authority, capture screenshots/live video, or automatically retry
an uncertain mutation. A valid saved application allowlist still has no
in-place native reconfiguration command; changing authority requires a
controlled fresh profile until a separately confirmed Rust-owned settings flow
is implemented.

The native acceptance harness seeds an isolated administrator record so it can
prove protected bridge and UIA execution deterministically. First-admin
bootstrap and hot desktop-worker activation have separate coverage, but a
single fresh-profile native smoke that performs both remains a test gap.

This is local development-native evidence. It does not replace protected
production signing, installed signed-binary acceptance, representative
third-party application pilots, or an external security audit.

# Native Desktop Runtime v1 Implementation Record

Date: 2026-07-15
Status: TypeScript integration and Rust/Tauri source implemented; Windows native CI passing; live interactive UI Automation validation pending
Parent design: `docs/superpowers/specs/2026-07-12-completion-architecture.md`

This milestone adds a bounded Windows desktop path without moving policy authority into a model, a webview, or UI Automation. The TypeScript kernel still owns intent validation, risk floors, approvals, budgets, one-use capability dispatch, transient payload staging, Stop All, and ledger evidence. The native host owns one local runtime process and performs only the desktop operations admitted by that control plane.

## 1. Authority And Scope

Native desktop execution is disabled in loopback `open` mode. It requires either a configured `KERNEL_API_TOKEN` or a bootstrapped multi-user deployment. Dashboard requests use the existing authenticated API; viewers may inspect returned kernel state but cannot start desktop automations or approve mutations.

V1 exposes four operations:

- `desktop.discover`: L0 enumeration of windows belonging to one allowlisted application identity.
- `desktop.inspect`: L0 bounded UI Automation tree capture for one discovered window.
- `desktop.click`: L2 invocation of one node in the exact inspected tree revision.
- `desktop.type`: L2 text entry into one node in the exact inspected tree revision, with text destructively resolved from a one-use in-memory record whose SHA-256 hash matches the intent.

Click and type cannot be labeled below L2. Their first automation run persists an approval request; execution occurs only after an operator approves that exact intent and a later run consumes the matching approval. The kernel then persists and consumes the capability grant before issuing an opaque one-use dispatch authorization to the worker. Window and control observations remain untrusted data and can never create an approval, widen a scope, or grant a capability.

Shortcuts, elevation, arbitrary shell execution, downloads, plugins, generic desktop scheduling, installers, and automatic updates are not part of this milestone.

## 2. Runtime Ownership And Supervision

The Tauri/Rust source host selects a runtime under Tauri's per-user local application-data directory, outside the repository command workspace, and acquires `runtime-owner.json` before launching Node. On Windows it also takes a named single-instance/runtime mutex. A bounded owner record contains the host process id and SHA-256 hash of a random private launch proof; the proof itself exists only in host memory and the child environment. The supervised Node child must present that proof, match the expected host PID, and verify that the host remains alive before it opens kernel state. Supplying the public hash as though it were the proof fails. A standalone Node server retains the repository-local default, atomically publishes its own owner record, and refuses a runtime held by another live owner; stale complete records may be recovered without overwriting a live or malformed owner.

The host launches only a canonical `node.exe` and the canonical `dist/server.cjs` beneath the selected working directory. It clears the inherited environment, restores only a small OS/runtime subset plus explicit Provenance launch values, redirects logs into the runtime directory, and assigns the child to a kill-on-close Windows job. This is process-lifetime containment for the supervised server, not a general command sandbox.

Readiness is not inferred from an open port. The host creates a fresh per-launch readiness filename and nonce; Node atomically publishes a bounded JSON record containing that nonce, its process id, and its ephemeral loopback port. The host validates the record, confirms the child id, removes the readiness file, and requires a stability window before navigating the Tauri webview to the Node dashboard. A timeout, malformed proof, early exit, or unstable child fails the launch.

The bundled startup view receives only Tauri's core default capability. There is no application invoke command. The subsequently loaded loopback dashboard receives no Tauri remote capability, so browser content cannot call the native host directly. A 25 ms host monitor checks the Node child, bridge task, and UIA broker; loss clears session/local storage, navigates away, and closes the webview. The browser-facing port remains Node-owned in v1, so a Rust-owned reverse proxy and exhaustive same-user port-rebinding analysis remain external-audit work.

## 3. Authenticated Loopback IPC

The host binds its desktop bridge to an ephemeral `127.0.0.1` port and creates a random per-launch secret. That URL and secret are passed only to the supervised Node child. Every bounded request authenticates its method, path, request id, timestamp, and SHA-256 body hash with HMAC-SHA256. The host enforces a narrow timestamp window, consumes request ids once, bounds the replay cache, rejects unknown headers/contracts, and signs the response status and body hash. Node verifies the response signature before parsing or trusting the payload.

Worker registration is health-gated. Node enables `worker.desktop.windows_uia` only when all launch settings are complete, configured access is not `open`, authenticated bridge health succeeds, all four v1 operations are reported, and the bridge's sorted application-id set exactly matches Node's configured set. Secrets, executable paths, and authoritative kernel objects are omitted from the public runtime report.

## 4. Executable Allowlist And UI Automation

The operator configures one static JSON array in `DESKTOP_APP_ALLOWLIST`:

```json
[
  {
    "appId": "windows.notepad",
    "executablePath": "C:\\Windows\\System32\\notepad.exe"
  }
]
```

The contract accepts 1-32 unique objects and no additional properties. Each `appId` begins with a lowercase letter or digit and then uses at most 64 lowercase letters, digits, dots, underscores, or hyphens. Each `executablePath` is an absolute, already-normalized `.exe` path with no `..` segment; application ids and case-folded paths must both be unique. The allowlist is configuration, not a discovery hint: callers submit only an application id and cannot select an arbitrary executable path.

Discovery returns only windows attributed to the selected allowlisted executable. Inspection returns a bounded tree and an opaque tree revision. Click and type must echo the exact application id, window id, tree revision, and node id from that snapshot. The broker retains the exact element from the freshly rebuilt tree and revalidates its identity immediately before mutation. A stale or mismatched revision fails closed rather than rediscovering or acting on a best-effort target. Typed payloads are length-bounded, reject NUL, carry only their hash across the intent/native wire boundary, and are not included in source references or ledger event payloads.

The bridge and TypeScript worker use strict tagged JSON contracts with unknown-field rejection and bounded strings, arrays, timestamps, and response sizes. Native output is still treated as an untrusted observation by the kernel.

## 5. Kernel And Cockpit Integration

The existing worker registry now has a concrete Windows desktop registration when authenticated health passes and an explicit unavailable placeholder otherwise. The runtime report distinguishes unavailable, configured-but-unhealthy, blocked-by-open-auth, and available states. Registration declares the exact allowed application scopes; each automation narrows that scope to a live window/tree target before dispatch.

The Desktop cockpit is server-backed. It shows native readiness, configured application ids, workers, discovered windows, inspected controls, pending approvals, and ledger evidence. Discovery and inspection execute recorded L0 automations. Click and type stage the exact intent, show the pending L2 approval, allow an authorized operator to approve or deny it, and require a separate execution action after approval. No desktop authority, UI tree, approval, payload, or bridge credential is persisted in browser storage.

Stop All, worker availability, policy risk floors, exact scope checks, approval matching, pre-dispatch grant consumption, one-use dispatch claiming, transient payload hash resolution, abort signals, and event recording remain in the ordinary kernel path. There is no direct desktop mutation endpoint that bypasses those controls. A desktop payload is removed before bridge I/O, so transport failure cannot replay it. If cancellation, timeout, transport loss, executor loss, or failed post-write observation leaves a mutation outcome ambiguous, the terminal event is `automation.run_uncertain`; that automation cannot run again. Stop All bounds kernel waiting and prevents a stale result commit, but it cannot reverse a UIA side effect already accepted by Windows.

## 6. Build And Operator Configuration

Native development requires Windows x64, Rust stable MSVC 1.85 or newer, the `x86_64-pc-windows-msvc` target, Visual Studio 2022 Desktop development with C++, a Windows 10/11 SDK, WebView2 Evergreen, Node.js, and npm dependencies installed with `npm ci`.

Configure access authority and the executable allowlist in `.env`:

```dotenv
KERNEL_API_TOKEN=choose-a-long-random-value
DESKTOP_APP_ALLOWLIST='[{"appId":"windows.notepad","executablePath":"C:\\Windows\\System32\\notepad.exe"}]'
```

Multi-user accounts may be used instead of `KERNEL_API_TOKEN`. `DESKTOP_BRIDGE_URL`, `DESKTOP_BRIDGE_TOKEN`, `DESKTOP_RUNTIME_OWNER_NONCE`, `DESKTOP_RUNTIME_OWNER_PID`, `DESKTOP_HOST_NONCE`, and `DESKTOP_HOST_READY_FILE` are generated per launch by the native host and must not be configured or reused by the operator.

The repository exposes these commands:

```bash
npm run desktop:dev
npm run desktop:build
npm run desktop:test
npm run desktop:check
```

The development and build commands first produce `dist` so the host can supervise the fixed CommonJS server entrypoint. `desktop:dev` preloads `.env` through the installed `dotenv` package before invoking the Tauri CLI, allowing the native host to read the allowlist before Node exists. A directly launched binary instead needs `DESKTOP_APP_ALLOWLIST` in its process environment. `PROVENANCE_PROJECT_ROOT` and `PROVENANCE_NODE_EXECUTABLE` provide canonical-path overrides for development. Tauri bundling is deliberately disabled; `desktop:build` compiles the host binary but does not create an installer.

## 7. Verification Status

The TypeScript integration includes focused tests for configuration parsing, loopback-only IPC, HMAC response authentication, worker translation and payload hashing, risk floors, worker availability, kernel approval continuation, runtime ownership/readiness, runtime reporting, API behavior, and cockpit flows. The complete suite passes 455 tests across 78 files; lint, production build, dependency audit, ledger verification, diff checking, and scoped secret scanning also pass.

Rust/Cargo 1.97 generated the committed dependency lock. A clean WSL target directory passes `rustfmt` verification, locked `cargo check --all-targets`, and Clippy with warnings denied for `x86_64-pc-windows-msvc`, type-checking the Windows modules and test targets. This development machine still lacks the local MSVC/Windows SDK link environment, and Windows Application Control blocks its locally installed Windows `rustfmt`. Those local constraints do not substitute for the prepared Windows runner, which supplies the native link environment.

`.github/workflows/native-desktop.yml` adds a `windows-latest` verification job that runs `npm ci`, TypeScript lint, the npm test suite, the production web/server build, Rust formatting, Rust tests, Cargo checking across all targets, and Clippy with warnings denied. [Native desktop verification run 29398628867](https://github.com/A-Deb-byte/Provenance/actions/runs/29398628867) completed that entire job successfully on commit `bafb660`. This establishes native compilation, linking, and unit-test evidence; the hosted job does not drive a real allowlisted application in an interactive desktop session.

## 8. Remaining Boundaries

Native Desktop Runtime v1 is a bounded vertical slice, not general computer autonomy. It has no signed installer, updater supervisor, OS elevation broker, arbitrary process launcher, shell plugin, browser download handoff, OAuth/MCP connector, email/communications runtime, desktop recurrence contract, accessibility fallback beyond Windows UI Automation, macOS/Linux desktop implementation, remote-control service, or external security audit.

The runtime owner prevents concurrent ordinary owners of one local state directory, but kernel mutation and ledger queues are still process-local. High availability, multi-host coordination, remote tenancy, and cross-user data partitioning remain outside this design.

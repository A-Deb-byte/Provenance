# Current State - Capability Matrix

Date: 2026-07-13
Purpose: the authoritative concise answer to "what does this product do, and what is still missing?"

Verification note: the pre-hardening baseline was **242 tests across 51 files**. The completed trust-boundary pass is `npm run lint` clean, **297 tests across 62 files**, `npm run build` clean, and `npm run verify-ledger` clean.

## What This Product Is

Provenance is a local-first agent control plane with a browser dashboard and a trusted TypeScript kernel. The kernel owns goals, evidence, budgets, approvals, memory, skills, provider calls, capability dispatch, automations, recovery, snapshot commits, and release records. Models propose content and actions; deterministic policy and explicit human authority decide what can persist or execute.

Multi-user authentication exists, but users share one local kernel state. The product is therefore a loopback-oriented local deployment, not a hardened multi-tenant service.

## Capability Matrix

Legend: **Implemented** = present with focused tests; **Live** = also verified against the real local runtime; **Partial** = useful within a documented boundary; **Boundary** = deliberately unavailable rather than simulated.

| Capability | State | Current boundary |
| --- | --- | --- |
| Goal contracts and evidence-gated tasks | Implemented | Planner executes only allowlisted verification commands. |
| Budgets and Stop All | Implemented | Budgets are local counters; Stop All is a persisted kernel control. |
| Provider gateway for chat/extract/mutate/skill draft | Implemented | Uses configured providers only; no direct legacy Gemini bypass. |
| Provider routing | Partial | Automatic, pinned, and ensemble routes exist; live availability depends on credentials and upstream service. Bedrock remains unavailable without its runtime. |
| Durable memory lifecycle | Implemented | Promotion requires explicit reason plus independent source-backed ledger evidence; candidate creation cannot attest itself. |
| Bounded skill foundry | Implemented | Executes only `pure-transform-v1`; canary runs use kernel-generated fixtures and a separate reference interpreter, with no caller oracle at run time. |
| Authenticated dashboard | Implemented | Supports status, operator token, first-admin bootstrap, login, logout, and revoked-session handling. Viewers are read-only. |
| Loopback request protection | Implemented | Host/origin and `Sec-Fetch-Site` checks protect mutations; security headers are applied. This is not remote-service hardening. |
| Browser inspect worker | Partial | L0, origin-allowlisted, bounded read-only fetch. |
| Playwright browser worker | Live | Navigate/click/type are minimum L2, approval-gated, and origin-checked before and after navigation. Downloads are unavailable. |
| Approval continuation | Implemented | L2/L3 runs persist an approval; a matching approved record can authorize a later execution. |
| Capability dispatch gate | Implemented | Grant is persisted and consumed before I/O; a one-use opaque authorization must be claimed immediately before dispatch. |
| Hash-addressed artifact store | Implemented | Text entry resolves a pre-staged value and verifies the intent-declared hash; payload content is not ledgered. |
| Docker command sandbox | Live | No network, read-only root, bounded resources, workspace mount. Trusted-host fallback is reported when Docker is absent. |
| Parallel goal execution | Implemented | Up to eight goal steps; worker commands overlap while kernel state mutations remain serialized. |
| Event ledger and snapshot integrity | Implemented | Hash-chained ledger plus ledger-authenticated canonical snapshot hash, recovery replica, interrupted-commit repair, and abandoned-tail evidence. Not full event-sourced reconstruction. |
| Controlled staged releases | Implemented | Canonical authorization signature, evaluation/artifact verification, controlled install, supervised Node readiness, atomic process switch, failure rollback, and startup restoration. Does not rewrite source or hot-replace the trusted parent control plane. |
| OS secret vault | Partial | Windows DPAPI is live-verified; macOS Keychain and Linux Secret Service are implemented but need target-OS live validation. Values are never returned. |
| Multi-user access control | Implemented | Scrypt password records, signed expiring/revocable sessions, admin/operator/viewer roles; no per-user data partitioning. |
| Kernel-backed dashboard state | Implemented | Authoritative memory/skill/provider state comes from APIs. `localStorage` retains presentation-only chat state and lens selection; `sessionStorage` may hold the transient active bearer, whose validity remains server-authoritative. |
| Optional on-device core model | Partial | Advisory tighten-only injection assessment; it cannot bypass provider routing or kernel authority. |

## Security-Critical Flows

### Application AI

`/api/chat`, `/api/extract`, `/api/mutate`, and `/api/self-improve` pass through the application AI router, the configured provider policy, kernel provider-call accounting, ledger evidence, and the unified mutation access guard. Provider results include route provenance. Extraction creates candidates; it does not promote memory.

### Browser automation

`browser.inspect` remains L0. Navigation, clicking, typing, and downloads have an L2 minimum. Redirected or script-navigated pages are checked against the authorized origin before any click/type and again after the action. Approval-gated runs can resume only with their matching approved record. The persisted capability grant is consumed before the worker is allowed to perform I/O.

### Persistence

Every committed snapshot has a canonical content hash referenced by ledgered prepare/commit events. Startup accepts only a matching primary or authenticated recovery copy, completes interrupted publication, and marks abandoned ledger tails. The snapshot is authenticated by the ledger; domain-event payloads are not claimed to form a complete replay database.

### Releases

The Ed25519 signature binds target version, package hash, sorted evaluation references, and rollback instructions. Activation verifies the artifact and installed files, starts only the package's declared controlled `.cjs` entrypoint with a fixed Node invocation and minimal environment, then requires a nonce/version/hash IPC readiness proof and stability window. The previous supervised child remains active until commit; candidate failure terminates and removes only the candidate. Startup revalidates the complete authorization, artifact, installed hashes, and health before restoring the active child.

The trusted parent Express control plane remains stable and owns policy, signatures, and rollback. A signed child does not rewrite repository source, inherit arbitrary parent secrets, or hot-replace the parent listener.

## What Is Still Missing

- Rust/Tauri process isolation and authenticated desktop IPC.
- Native non-Docker command isolation.
- Desktop automation, OAuth connector workers, and browser downloads.
- Live macOS/Linux vault verification.
- Per-user goal/memory partitioning and SSO/OIDC.
- Stable-port reverse proxying or an external blue/green cutover that replaces the trusted parent control-plane process.
- Arbitrary shell authority or arbitrary autonomous core self-modification; both are intentionally outside the security model.

## Configuration-Dependent Status

The runtime capability report is the source of truth for local availability. Provider calls become available only when a supported server-side credential is configured. Browser workers require an installed browser engine plus origin allowlists. Docker isolation requires a reachable daemon. Release activation requires a verification key, signed authorization, evaluation references, and a staged matching executable package; the report distinguishes an idle supervisor from an active child. Unavailable integrations remain explicit instead of being simulated.

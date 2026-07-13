# Current State — Capability Matrix

Date: 2026-07-13
Purpose: The single authoritative answer to "what does this product do, and what is still missing."
Verification basis: `npm run lint` clean, 204 tests across 45 files passing, `npm run build` clean, `npm run verify-ledger` clean, and a live runtime capability report.

## What This Product Is

A **local-first, single-user sovereign-agent control plane** with a browser dashboard. A trusted TypeScript kernel owns goals, evidence, memory, skills, provider routing, capability grants, and an append-only hash-chained ledger. Models — cloud providers or an embedded on-device model — *propose*; the deterministic kernel and the human *decide*. The dashboard projects only recorded kernel state, never generated narrative.

It is **not** a hardened, multi-user, isolated production runtime. The boundaries below are reported honestly at runtime rather than simulated.

## Capability Matrix

Legend: **Done** = implemented and test-covered · **Partial** = works within stated limits · **Boundary** = deliberately not built, reported unavailable with a reason.

| Capability | State | Notes |
| --- | --- | --- |
| Goal contracts + evidence-gated task lifecycle | Done | Completion requires verifier exit-code evidence, not model claims. |
| Hash-chained tamper-evident ledger | Done | Verified on every read; independently replayable via `npm run verify-ledger`. |
| Budgets, approvals, capability tokens | Done | Per-goal operation/runtime/approval/provider caps; single-use exact-scoped tokens. |
| Durable memory lifecycle | Done | candidate → promoted → superseded/revoked, provenance + evidence refs; content hashes in ledger. |
| Skill foundry (bounded DSL) | Done | Synthesize/evaluate/canary/promote/rollback; never executes generated code. |
| Provider routing (6 providers) | Partial | Adapters + automatic/pinned/ensemble routing built; live calls need credentials. Bedrock is an unavailable boundary. |
| On-device core model (MiniCPM5-1B) | Done | In-process via `node-llama-cpp`; local extraction, chat fallback, tighten-only injection assessment. |
| Web-inspect worker + executable automations | Partial | Read-only, origin-allowlisted `browser.inspect` only; full policy→grant→observation→ledger pipeline. |
| Parallel multi-goal execution | Done | Up to 8 goals; worker commands run in parallel OS processes, state stays serialized. |
| Recovery + Stop All | Done | Interrupted tasks recover to an inspectable blocked state; Stop All halts execution. |
| Release proposals + Ed25519 signing | Done | Correctly signed proposals activate; unsigned/keyless/forged stay blocked with reasons. |
| OS secret vault (Windows DPAPI) | Partial | Platform-native at-rest protection; **Windows only**, boot-time env injection, values never returned. |
| Operator access control | Partial | Optional shared bearer token on mutating routes; **not** per-user accounts/roles. |
| Auto-refreshing dashboard | Done | Four panels poll recorded state every 5s. |

## What Is Still Missing (Boundaries, With Reasons)

- **OS process sandbox** — verification commands and the web-inspect fetch run on the trusted host. Real isolation needs OS primitives (namespaces/job objects/seccomp) or a compiled runtime; allowlists and capability tokens bound blast radius but are not isolation.
- **Session-authenticated / desktop / connector workers** — the "hands" that carry a logged-in session or touch a desktop. They require isolation and per-action permissioning infrastructure before they are safe to ship; only the read-only web-inspect worker exists today.
- **Cross-platform vault** — macOS Keychain and Linux Secret Service adapters are not implemented; those platforms report the vault unavailable.
- **Multi-user access control** — the operator token is one shared secret, not accounts, roles, or sessions. Single-user, loopback-only by design.
- **Rust/Tauri kernel** — the TypeScript kernel is the reference implementation. Its validated contracts and the zero-import ledger verifier (`npm run verify-ledger`) are the concrete migration path to a compiled kernel.
- **Live cloud provider execution** — requires operator-supplied credentials (env or vault); no keys ship with the repo.

## Live Runtime Report (representative)

With core-model weights installed, the web-inspect origin allowlist set, an operator token configured, and no cloud provider key:

| Feature | Status |
| --- | --- |
| verificationCommands | available |
| coreModel | available |
| secretVault | available (windows_dpapi) |
| accessControl | available |
| backgroundAutomation | configured (web-inspect worker) |
| providerCalls | unavailable (no credentials) |
| osSandbox | unavailable (boundary) |
| releaseSigning | unavailable until a public key is configured |
| desktopIpc | unavailable (boundary) |

Statuses move with configuration: add a provider key and `providerCalls` becomes available; set `RELEASE_SIGNING_PUBLIC_KEY` and `releaseSigning` becomes configured. Nothing here is hardcoded — it is all derived from recorded state.

## One-Line Summary

The **trust substrate is complete and verified**: contracts, evidence, memory, skills, routing, capabilities, recovery, an embedded local model, at-rest secret protection, access control, and parallel execution — everything feasible in a local TypeScript workspace. What remains is **isolation and reach**: the OS-level sandbox and the session-carrying "hands," which need a compiled/OS-native runtime to ship honestly.

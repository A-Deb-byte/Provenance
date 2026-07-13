# Current State — Capability Matrix

Date: 2026-07-13
Purpose: The single authoritative answer to "what does this product do, and what is still missing."
Verification basis: `npm run lint` clean, 234 tests across 50 files passing, `npm run build` clean, `npm run verify-ledger` clean, and a live runtime capability report.

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
| Web-inspect worker + executable automations | Partial | Read-only, origin-allowlisted `browser.inspect`; full policy→grant→observation→ledger pipeline. |
| Write-capable browser worker (Playwright) | Partial | navigate/click through the approval pipeline; gated on Playwright + browser install; text-entry/download await an artifact store. |
| OS process sandbox (Docker) | Partial | Verification commands run in an ephemeral container (no network, read-only root, bounded resources) when Docker is present; honest host fallback otherwise. |
| Parallel multi-goal execution | Done | Up to 8 goals; worker commands run in parallel OS processes, state stays serialized. |
| Recovery + Stop All | Done | Interrupted tasks recover to an inspectable blocked state; Stop All halts execution. |
| Release proposals + Ed25519 signing | Done | Correctly signed proposals activate; unsigned/keyless/forged stay blocked with reasons. |
| Cross-platform OS secret vault | Partial | Windows DPAPI, macOS Keychain, Linux Secret Service, selected by platform; each reports unavailable off-target. Values never returned. |
| Multi-user access control | Done | File-backed accounts (scrypt), signed expiring session tokens, admin/operator/viewer roles; shared-token and open-loopback fallbacks. |
| Auto-refreshing dashboard | Done | Four panels poll recorded state every 5s. |

## What Is Still Missing (Boundaries, With Reasons)

- **Sandbox depends on Docker being installed** — when no container runtime is present, verification falls back to the trusted host (reported honestly). Native OS-primitive isolation (job objects/namespaces/seccomp) without Docker still needs a compiled/native runtime.
- **Desktop and connector workers** — the browser "hand" now writes (navigate/click), but desktop automation (UIA/AX/AT-SPI) and OAuth connectors remain unbuilt; browser text-entry and downloads await an artifact store for typed payloads.
- **Cross-platform vault is unverified off-Windows** — the macOS Keychain and Linux Secret Service adapters are implemented and platform-gated but were validated only by construction/unit tests on Windows; they need a real run on those OSes.
- **Multi-user is single shared deployment** — accounts, roles, and sessions exist, but there is no per-user data partitioning of goals/memory yet, and no external identity provider (SSO/OIDC).
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

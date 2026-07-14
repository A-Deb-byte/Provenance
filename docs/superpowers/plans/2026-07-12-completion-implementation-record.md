# Completion Implementation Record

Date: 2026-07-12
Status: Implemented and verified
Parent design: `docs/superpowers/specs/2026-07-12-completion-architecture.md`

> Historical slice: this record describes the July 12 implementation. The July 13 trust-boundary hardening replaced direct application AI handlers, added dashboard auth and pre-dispatch grants, authenticated snapshot contents, and changed release activation from metadata-only state to controlled staged installation. See `2026-07-13-trust-boundary-hardening-record.md` for current behavior.

This document records what was implemented, verified, and deliberately left out during the completion session of 2026-07-12. Every claim below is backed by tests or by live evidence recorded in `.agent-kernel/events.jsonl`.

## 1. Starting State And Repair

The session began with the repository interrupted mid-implementation from earlier Phase 3 work:

- `src/providers/api.ts` and `src/components/ProviderPanel.tsx` were missing while their test files existed; typecheck and two test files failed.
- `src/providers/runtime.test.ts` had a mock typing error (async generator where the SDK interface expects `Promise<AsyncIterable>`).
- `server.ts` never constructed a provider runtime, so the kernel's provider-call endpoint always returned 503.

Repairs: implemented `createProviderApi` (sanitized `/status`, strict key-allowlisted `/plan` that rejects secret- or endpoint-bearing requests before the router is consulted, no invoke endpoint), implemented `ProviderPanel` (status, capabilities, routing preview, no credential editing), fixed the mock, and wired `createProviderRuntime()` plus the provider router and statuses into `server.ts` and `App.tsx`.

## 2. Phase 4 Integration: Capabilities And Automations

The previously library-only `src/capabilities/` modules were integrated into the kernel:

- Kernel state extended with `automations`; ledger entity types extended with `automation`, `control`, `release`, `benchmark`.
- A worker registry is built at kernel creation. Default registrations report browser/desktop/connector families as unavailable with explicit reasons (`src/kernel/autonomy.ts`).
- `createAutomation` validates contracts (risk floor per action, budgets, triggers) and persists them disabled. Enabling requires an available registered worker and an operator reason; every transition is a ledger event.
- `evaluateAutomation` runs a deterministic dry-run policy decision (`decideActionPolicy`) against a kernel-built intent whose authority is `kernel_policy`; untrusted observations can never grant authority.

## 3. Phase 5: Measured Autonomy

- **Stop All** (`POST /api/kernel/controls/stop-all` / `resume`): a persisted control that blocks task execution, provider calls, automation enablement, and automation runs until resumed with a reason. Both transitions are ledger events.
- **Recovery**: at router startup and via `POST /api/kernel/recovery`, tasks stuck in `running` are recovered into an inspectable `blocked` state (goals block too) with `task.recovered` events — never silently resumed.
- **Benchmarks**: `POST /api/kernel/benchmarks` projects a finished goal's recorded evidence (task definitions, intervention count, command runtime, provider-call count, evidence event ids) into a benchmark record.
- **Release proposals**: content hash, ledger-verified evaluation references, rollback instructions, explicit activation state.
- **Runtime capability report** (`GET /api/kernel/runtime-report`) and a dashboard panel distinguishing available / configured / unavailable / blocked, from recorded state only.

## 4. Core Model: MiniCPM5-1B In-Process

`node-llama-cpp` embeds llama.cpp directly in the Express process — no Ollama, LM Studio, or sidecar daemon. Weights (`MiniCPM5-1B-Q4_K_M.gguf`, 656 MB, from `openbmb/MiniCPM5-1B-GGUF`) live at `.agent-kernel/models/minicpm5-1b.gguf` (override with `CORE_MODEL_PATH`).

Design rules, enforced by construction and tests (`src/core-model/`):

- The transport is loaded lazily through an indirect dynamic import (survives esbuild CJS bundling; a broken native binding degrades to `unavailable`, never a crash).
- All generation is grammar-constrained to a JSON schema, temperature 0, bounded context (4096) and output caps.
- **Tighten-only**: for injection assessment, the deterministic regex heuristics are the floor; the model may add signals or raise risk, never lower it; on model failure the floor stands (`assessedBy: 'heuristic_only'`).
- The core model never decides policy, issues capabilities, writes the ledger, or promotes memory.

Capabilities delivered:

- **Local memory extraction (historical)**: this slice let `/api/extract` run through the core model when weights were installed. The hardened application routes now use the shared provider gateway so extraction cannot bypass provider routing, kernel budgets, or access control.
- **Local chat fallback (historical)**: this slice used the core model when Gemini was absent. The hardened `/api/chat` route now uses the shared provider gateway; the core model remains advisory rather than an authority bypass.
- **Observation assessment**: automation-run observations pass through the tighten-only assessor.

## 5. Final Slice: Giving It One Careful Hand

- **Web-inspect worker** (`src/kernel/workers/webInspectWorker.ts`): the only worker runtime that ships. Read-only `browser.inspect` (L0) over plain fetch — manual redirect blocking, origin pinning, 64 KB stripped-text cap, bounded timeout, no clicks/typing/downloads/cookies. Disabled until the operator sets the `WEB_INSPECT_ORIGINS` allowlist.
- **Automation execution (historical)**: this slice validated and consumed the grant after dispatch. The hardened path persists and consumes the grant before I/O, then requires the worker to claim an opaque one-use authorization. L2/L3 runs can continue after their matching approval is granted.
- **Release signing (historical)**: Ed25519 verification changed proposal state to `activated`, but did not install software. The hardened release lifecycle additionally resolves the staged hash-matching package, installs beneath a controlled directory, switches an atomic active manifest, health-checks it, and restores the previous manifest on failure.
- **Dashboard liveness**: all four panels poll every 5 s with unmount cleanup; the provider panel keeps array identity stable so polling does not refire the routing preview.

## 6. Verification

- `npm run lint` clean; `npm test` green across the full suite; `npm run build` (Vite client + esbuild CJS server bundle) succeeds.
- Live session evidence recorded in the kernel ledger: a goal contract that ran `npm run lint` on this repository through a scoped capability token (passed, exit 0, ~10 s); a full skill-foundry lifecycle (synthesized `trim → collapse_whitespace → lowercase`, evaluation 100% vs 0% baseline, promotion refused until all 3 canary runs passed, then promoted and invoked); memory candidate → promotion with reason; Stop All / resume; a benchmark record; on-device extraction and chat.

## 7. Boundaries At The End Of This Historical Slice

- **OS credential vault** was missing in this slice. Later passes added Windows DPAPI, macOS Keychain, and Linux Secret Service adapters; the latter two still need target-OS live validation.
- **OS sandbox** was missing in this slice. Docker isolation was added later with an explicitly reported trusted-host fallback when Docker is absent.
- **Session-authenticated browser workers** were missing in this slice. Later passes added dashboard sessions and Playwright navigation/click/type with L2 approval and origin rechecks. Desktop and connector workers remain out.
- **Multi-user access control** was missing in this slice. Roles and revocable sessions were added later; per-user data partitioning and SSO remain out.
- **Rust/Tauri kernel**: the TypeScript kernel remains the reference implementation; its contracts and replayable ledger are the migration path.

These appear in the runtime capability report as unavailable, with reasons, rather than being simulated.

# Completion Implementation Record

Date: 2026-07-12
Status: Implemented and verified
Parent design: `docs/superpowers/specs/2026-07-12-completion-architecture.md`

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

- **Local memory extraction**: `/api/extract` runs fully on-device when weights are installed, with no silent cloud fallback. A few-shot system prompt materially improved 1B extraction quality (distilled facts instead of copied sentences; assistant lines ignored). Measured ~18–29 s per extraction on CPU.
- **Local chat fallback**: `/api/chat` is served on-device when `GEMINI_API_KEY` is absent (`servedBy: 'core_model'`).
- **Observation assessment**: automation-run observations pass through the tighten-only assessor.

## 5. Final Slice: Giving It One Careful Hand

- **Web-inspect worker** (`src/kernel/workers/webInspectWorker.ts`): the only worker runtime that ships. Read-only `browser.inspect` (L0) over plain fetch — manual redirect blocking, origin pinning, 64 KB stripped-text cap, bounded timeout, no clicks/typing/downloads/cookies. Disabled until the operator sets the `WEB_INSPECT_ORIGINS` allowlist.
- **Automation execution** (`POST /api/kernel/automations/:id/run`): policy decision → intent-hash-bound single-use capability grant → dispatch → untrusted observation with injection assessment → grant consumption → `automation.run_completed`/`run_failed` ledger evidence. Run budgets and consecutive-failure halts are enforced by counting recorded events, and goal operation budgets are reserved per run.
- **Release signing**: Ed25519 verification (`RELEASE_SIGNING_PUBLIC_KEY`, PEM or base64 SPKI DER). Correctly signed proposals now reach `activated` (`release.activated` event); unsigned, unverifiable, or keyless activation stays blocked with recorded reasons. Operator tooling: `scripts/release-signing.mjs` (generate / sign).
- **Dashboard liveness**: all four panels poll every 5 s with unmount cleanup; the provider panel keeps array identity stable so polling does not refire the routing preview.

## 6. Verification

- `npm run lint` clean; `npm test` green across the full suite; `npm run build` (Vite client + esbuild CJS server bundle) succeeds.
- Live session evidence recorded in the kernel ledger: a goal contract that ran `npm run lint` on this repository through a scoped capability token (passed, exit 0, ~10 s); a full skill-foundry lifecycle (synthesized `trim → collapse_whitespace → lowercase`, evaluation 100% vs 0% baseline, promotion refused until all 3 canary runs passed, then promoted and invoked); memory candidate → promotion with reason; Stop All / resume; a benchmark record; on-device extraction and chat.

## 7. Deliberately Not Implemented (And Why)

- **OS credential vault**: requires platform-native keychain integration; faking it with an encrypted file would misrepresent the protection boundary. Credentials remain environment variables the operator must protect.
- **OS sandbox**: verification commands and the web-inspect fetch run on the trusted host; a real sandbox needs OS-level primitives (or the Rust runtime) that a TypeScript workspace cannot honestly provide.
- **Session-authenticated browser / desktop / connector workers**: these are the "hands" that require explicit permissioning infrastructure and isolation before they are safe to ship.
- **Multi-user access control**: the API is single-user and loopback-only by design.
- **Rust/Tauri kernel**: the TypeScript kernel remains the reference implementation; its contracts and replayable ledger are the migration path.

These appear in the runtime capability report as unavailable, with reasons, rather than being simulated.

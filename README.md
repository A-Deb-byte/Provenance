# Warrant

A local-first, self-hosted AI agent with a trusted kernel — models propose, the kernel decides, and every action leaves verifiable evidence.

> A *warrant* is both an authorization and a justification: the kernel authorizes every action, and the hash-chained ledger justifies it with recorded evidence.

## Current Status

The memory and chat workspace began as a Phase 0 prototype and now sits on a test-covered local control plane. It provides:

- A trusted local kernel that owns goal contracts, an evidence-gated task lifecycle, budgets, approvals, and a hash-chained tamper-evident event ledger.
- Evidence-backed durable memory (candidate → promoted → superseded/revoked) and a bounded, non-executing skill foundry.
- Normalized routing across six AI providers (Gemini SDK plus an OpenAI-compatible adapter; Bedrock as an unavailable boundary).
- An in-process advisory core model (MiniCPM5-1B via `node-llama-cpp`) for fully on-device memory extraction, chat fallback, and tighten-only prompt-injection assessment.
- A read-only web-inspect worker with executable, budgeted automations; parallel multi-goal execution; recovery and a Stop All control.
- Ed25519-verified release proposals, a Windows DPAPI secret vault, and an optional operator API token.
- Four auto-refreshing dashboard panels that project only recorded state.

Boundaries that remain deployment integrations (reported as unavailable, never simulated) are listed under "Deployment Integrations Still Outstanding" below.

## Kernel MVP

Phase 1 adds a loopback-only local kernel API under `/api/kernel` and stores its runtime state under `.agent-kernel/`.

It supports:

- Validated goal contracts with objectives, success criteria, constraints, autonomy level, workspace scope, verification commands, and budgets.
- Sequential task graph state with dependency and status tracking.
- Hash-chained local JSONL event records with link/hash verification on read. The chain is tamper-evident bookkeeping, not encryption or a complete protection boundary.
- Local policy decisions, approval record state, and an approval decision endpoint. The current planner creates only allowlisted local verification tasks.
- Deterministic operation, command-runtime, approval, and provider-call budget counters.
- Short-lived, single-use, exact-command-scoped in-process capability tokens. These are not cryptographic bearer credentials.
- Allowlisted local verification commands (`npm test`, `npm run lint`, and `npm run build`) inside the server-configured workspace, with bounded structured command evidence.

The verification worker executes project-defined npm scripts on the host. Phase 1 does not provide an OS sandbox, so verification must be limited to a trusted local workspace.

It does not yet provide:

- Desktop or browser automation.
- Automatic routing across AI providers.
- OS secret-vault integration, at-rest data protection, or SQLite persistence.
- Automatic snapshot replay or repair after an interrupted ledger/state write.
- Long-running background agents.
- Real skill installation or execution.
- Arbitrary shell access.
- Autonomous modification or installation of core updates.

## Evidence Memory And Skill Foundry

Phase 2 moves durable learning into the kernel snapshot and event ledger.

Memory records now support:

- Candidate, promoted, superseded, and revoked lifecycle states.
- Provenance, confidence, scope, sensitivity, retention, contradictions, supersession, and evidence references.
- Explicit promotion and revocation reasons.
- Content hashes in the ledger instead of raw memory text.
- Candidate-only ingestion from model extraction. Provider output cannot silently promote, delete, or rewrite durable memory.

The Skill Foundry uses a bounded `pure-transform-v1` text DSL. It can synthesize only allowlisted transformations, compare them with an identity baseline, evaluate held-out replay cases, run a bounded canary, promote a passing package, and roll it back. It does not execute generated JavaScript, load dependencies, access files, use the network, or request capability tokens.

The browser-local memory and draft-skill views remain legacy presentation workspaces. Chat context is assembled from promoted kernel memory at request time, and authoritative memory/skill state appears in the Learning Cockpit.

## Provider Intelligence

Phase 3 adds a normalized provider layer under `src/providers/`.

It supports:

- One request/response/error/usage contract across Google Gemini (SDK), and OpenAI, OpenRouter, DeepSeek, and GLM through a shared OpenAI-compatible HTTP adapter.
- Automatic, pinned, and ensemble routing over configured providers only, scored by deterministic operational telemetry, with ensemble disagreement recorded.
- Server-side-only credentials resolved from environment variables and held behind non-serializable secret handles.
- Kernel-budgeted provider calls (`POST /api/kernel/goals/:goalId/provider-calls`) recorded in the ledger with request/result hashes.
- A sanitized status and routing-preview API (`/api/providers/status`, `/api/providers/plan`) and a read-only dashboard panel.

AWS Bedrock is an adapter boundary only: it reports itself unavailable until its official runtime dependency and credentials are configured. No provider can modify kernel policy or grant capabilities.

## Capabilities, Automations, And Measured Autonomy

Phases 4 and 5 add capability and autonomy contracts to the kernel snapshot and ledger.

They support:

- Typed browser/desktop/connector action contracts, worker registrations, intent-hash-bound single-consume capability grants, and prompt-injection tagging of untrusted observations (`src/capabilities/`).
- Persisted automation definitions with deterministic policy evaluation (`POST /api/kernel/automations/:id/evaluate`). Automations are created disabled; enabling one requires an available registered worker.
- A Stop All control (`/api/kernel/controls/stop-all`, `/resume`) that halts task execution, provider calls, and automation enablement until explicitly resumed, with both transitions recorded.
- Startup and on-demand recovery (`POST /api/kernel/recovery`): interrupted `running` tasks are recovered into an inspectable blocked state rather than silently resumed.
- Benchmark records projected from finished goals' recorded evidence (`/api/kernel/benchmarks`).
- Release proposals with content hashes, ledger-verified evaluation references, rollback instructions, and explicit activation state. Activation is always blocked in this deployment: unsigned proposals cannot activate, and no signing verification key is installed to validate signed ones.
- A runtime capability report (`GET /api/kernel/runtime-report`) and dashboard panel that distinguish available, configured, unavailable, and blocked features from recorded state only.

One worker runtime ships with this repository: a **read-only web-inspect browser worker** (`browser.inspect`, risk L0). It is disabled until the operator allowlists origins through `WEB_INSPECT_ORIGINS`. When enabled, `POST /api/kernel/automations/:id/run` executes an automation end to end: policy decision, intent-hash-bound single-use grant, bounded fetch (no redirects, no clicks, no typing, 64 KB text cap), an untrusted observation with prompt-injection assessment, grant consumption, and ledger evidence. Run counts and consecutive-failure halts are enforced from recorded events.

**Release proposals can now genuinely activate** when the operator installs an Ed25519 verification key (`RELEASE_SIGNING_PUBLIC_KEY`, keypair via `node scripts/release-signing.mjs generate <file>`) and the proposal's signature over its content hash verifies. Unsigned proposals, missing keys, and failed verification remain blocked with recorded reasons.

Desktop and connector worker runtimes do not ship here. Their placeholder registrations exist so those families are reported honestly as unavailable; the dashboard does not simulate them, and automations targeting them cannot be enabled. Dashboard panels poll every five seconds, so recorded state appears without manual reloads.

## Core Model (In-Process Advisory Inference)

The server can embed OpenBMB MiniCPM5-1B directly through `node-llama-cpp` — no Ollama, LM Studio, or separate inference daemon. The weights run inside the Express process as a strictly advisory, tighten-only component:

- **Local memory extraction**: when weights are installed, `/api/extract` runs fully on-device and conversation text never leaves the machine. There is deliberately no silent cloud fallback from this path.
- **Local chat fallback**: when no `GEMINI_API_KEY` is configured and weights are installed, `/api/chat` is served by the core model entirely on-device (responses carry `servedBy: "core_model"`). Expect noticeably slower, simpler answers than a frontier model.
- **Prompt-injection assessment**: the model can add signals and raise risk above the deterministic heuristics, never lower or clear them. The regex heuristics remain the floor, and a model failure falls back to heuristics alone. Automation-run observations are assessed through this path.
- The core model never decides policy, issues capabilities, writes the ledger, or promotes memory. Deterministic kernel code and human approvals keep that authority.

To enable it, download a GGUF quantization of [openbmb/MiniCPM5-1B-GGUF](https://huggingface.co/openbmb/MiniCPM5-1B-GGUF) (Q4_K_M, ~688 MB, is recommended) and place it at:

```
.agent-kernel/models/minicpm5-1b.gguf
```

or point `CORE_MODEL_PATH` at the file. Until then, the runtime capability report and `GET /api/core-model/status` list the core model as unavailable with download guidance; nothing is simulated.

## Secrets, Access Control, And Parallel Work

- **OS secret vault (Windows DPAPI)**: `PUT /api/vault/secrets/:name` stores a secret protected at rest by the operating system's user-scoped DPAPI master key — platform-native protection, not an application-managed key. Values are never returned over the API; only names and status are exposed. At startup the server injects allowlisted vault secrets (`GEMINI_API_KEY`, `RELEASE_SIGNING_PUBLIC_KEY`, `KERNEL_API_TOKEN`) into its environment, so credentials need not live in a plaintext `.env`. On non-Windows hosts the vault reports itself unavailable rather than substituting a weaker file-based scheme.
- **Operator access control**: set `KERNEL_API_TOKEN` to require an `Authorization: Bearer <token>` header on every mutating (non-GET) kernel and vault request. GET reads stay open on loopback so the dashboard keeps working. Unset by default (single-user loopback).
- **Parallel goal execution**: `POST /api/kernel/goals/step-parallel` steps several goals at once. State mutations remain serialized on the kernel queue for consistency, but the verification commands themselves run in parallel OS processes — one worker per goal — bounded to eight concurrent steps.
- **Independent ledger verification**: `npm run verify-ledger` replays `.agent-kernel/events.jsonl` with no project imports, recomputing every hash and link and checking the snapshot head. It is the reference for a future Rust verifier and proves the ledger format is replayable outside the TypeScript kernel.

## Setup

Install dependencies:

```bash
npm ci
```

Create `.env` from `.env.example` and set:

```bash
GEMINI_API_KEY="your_server_side_value"
```

Run development server:

```bash
npm run dev
```

Build production assets:

```bash
npm run build
```

Run the compiled server:

```bash
npm start
```

## Verification

Run type checking:

```bash
npm run lint
```

Run tests:

```bash
npm test
```

Run a production build:

```bash
npm run build
```

## Deployment Integrations Still Outstanding

The following remain deployment integrations until their required runtimes exist, and are reported as unavailable in the runtime capability report rather than simulated:

- **Rust/Tauri process isolation and authenticated desktop IPC.** The TypeScript kernel remains the reference implementation; its validated contracts and independently replayable ledger (`npm run verify-ledger`) are the migration path to a compiled kernel.
- **An operating-system sandbox confining project scripts.** Verification commands and the web-inspect fetch run on the trusted host. A real sandbox needs OS-level primitives (namespaces/jobs/seccomp) or the Rust runtime that a TypeScript workspace cannot honestly provide; the allowlists and capability tokens bound blast radius but are not isolation.
- **Session-authenticated browser, desktop, and connector workers.** The shipped web-inspect worker is intentionally read-only and origin-allowlisted. Workers that carry a logged-in session or touch a desktop are the "hands" that require isolation and per-action permissioning infrastructure before they are safe to ship.
- **A cross-platform OS vault.** The DPAPI vault is Windows-only; macOS Keychain and Linux Secret Service adapters are not yet implemented and report unavailable on those platforms.
- **Multi-user access control.** The optional operator token is a single shared secret, not per-user accounts, roles, or sessions. The API remains single-user and loopback-only by design.

## Architecture Direction

For the delivered capability matrix and what remains, see **`docs/superpowers/CURRENT_STATE.md`** — the single authoritative status document.

The approved target design and implementation history are documented in:

- `docs/superpowers/specs/2026-06-21-sovereign-agent-design.md` (target architecture)
- `docs/superpowers/specs/2026-07-12-completion-architecture.md` (completion definition)
- `docs/superpowers/plans/2026-07-12-completion-implementation-record.md`
- `docs/superpowers/plans/2026-07-13-hardening-and-parallelism-record.md`

Phase 0 established the honest memory/chat prototype; Phase 1 introduced the TypeScript Kernel MVP; Phase 2 moved durable memory and the bounded skill foundry into the kernel; Phase 3 added normalized provider routing; Phases 4 and 5 added capability/automation contracts, Stop All, recovery, benchmarks, and release proposals; a final hardening pass added parallel execution, the Windows DPAPI vault, operator access control, and the independent ledger verifier — all within the boundaries listed above.

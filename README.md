# Provenance

A local-first, self-hosted AI agent control plane with a trusted kernel. Models propose; policy, budgets, approvals, and capability grants decide what may execute; durable mutations leave hash-chained evidence.

The name is literal: promoted memory and privileged execution must trace to recorded evidence rather than a model's assertion.

## Current Status

Provenance now provides:

- A TypeScript kernel for goal contracts, task state, budgets, approvals, capabilities, automations, recovery, and a tamper-evident event ledger.
- A shared application AI gateway for chat, extraction, mutation, and bounded skill drafting. These routes use the configured provider router, kernel provider-call budgets, ledger evidence, and the same mutation access guard as the cockpit.
- Normalized provider routing for Google Gemini, OpenAI, OpenRouter, DeepSeek, and GLM, plus an explicit unavailable boundary for AWS Bedrock when its runtime is absent.
- Evidence-backed memory and a bounded `pure-transform-v1` skill foundry that never executes model-generated source code.
- Read-only web inspection and a Playwright browser worker for navigation, clicking, and hash-addressed text entry.
- A Docker command sandbox when Docker is available, with an explicitly reported trusted-host fallback when it is not.
- Windows DPAPI, macOS Keychain, and Linux Secret Service vault adapters, selected and reported by platform.
- Dashboard authentication for operator-token, bootstrap, login, role-scoped sessions, logout, and session revocation.
- Controlled staged releases with canonical authorization signatures, evaluation gates, verified installation, supervised process readiness, restart restoration, and rollback on activation failure.

This is a substantial local control plane, not an unrestricted self-modifying agent. Remaining deployment boundaries are listed below.

## Trust Boundaries

### Application AI and providers

`POST /api/chat`, `/api/extract`, `/api/mutate`, and `/api/self-improve` share the provider contract under `src/app-ai/`. Calls are normalized, schema-constrained where appropriate, budgeted by the kernel, and recorded with provider/model route evidence. The skill-drafting endpoint may propose only bounded transform operations and deterministic cases; it cannot submit arbitrary JavaScript for execution.

Provider credentials stay server-side in environment variables or the OS vault. The browser receives provider status and routing metadata, never credentials. AWS Bedrock remains unavailable until its supported runtime and credentials are installed.

### Authentication and loopback access

All mutating application, provider, kernel, and vault routes pass the unified access guard. The active mode is:

- `multi_user` when accounts exist: admin/operator sessions may mutate; viewers are read-only.
- `operator_token` when no accounts exist and `KERNEL_API_TOKEN` is configured.
- `open` only when neither accounts nor an operator token exist, on the loopback-only deployment.

When an operator token is configured, it is also required to bootstrap the first administrator. The dashboard can bootstrap, log in, use an operator token, log out, and clear revoked credentials. Loopback host/origin checks reject cross-site mutations and security headers constrain browser embedding and content sources.

### Memory and skills

Memory records follow `candidate -> promoted -> superseded/revoked`. Promotion requires an explicit reason and at least one independent, source-backed ledger event; a candidate's own creation event is not acceptable evidence. Provider extraction creates candidates only and cannot silently promote or delete durable memory.

The skill foundry synthesizes an allowlisted text-transform DSL, compares it with a baseline, evaluates submitted replay cases, and then canaries kernel-generated fixtures against a separate reference interpreter. The canary-run endpoint accepts no caller input or expected output. Promotion requires every independent canary run to pass and remains reversible.

### Browser actions, approvals, and grants

`browser.inspect` is read-only L0. Browser navigation, clicking, typing, and downloads have a minimum L2 risk and require explicit approval. The browser driver checks the allowlisted origin before an action, after navigation, and after click/script-driven navigation; redirects cannot silently widen scope.

For approval-gated automations, the first run creates a persisted approval. A later run may consume the matching approved record and execute within that exact intent. Capability grants are persisted and consumed before worker I/O; the worker must claim the resulting opaque one-use dispatch authorization immediately before acting.

### Snapshots and recovery

The JSONL ledger is hash-chained and independently verifiable with `npm run verify-ledger`. Snapshot content is authenticated by ledgered prepare/commit events containing the canonical state hash. Startup validates the primary and authenticated recovery copy, completes interrupted commits, and records abandoned ledger tails during recovery.

This authenticates a snapshot against the ledger. It is not a claim that every historical snapshot can be reconstructed solely from domain-event payloads.

### Controlled releases

A release signature covers the target version, package hash, sorted evaluation references, and rollback instructions. The matching staged package must declare a controlled `.cjs` entrypoint and pass path, size, and file-hash validation. Activation installs only beneath the controlled releases directory, performs the installed-file health check, launches the candidate with a fixed Node invocation and minimal environment, and requires a nonce/version/hash IPC readiness proof plus a stability window before committing the active manifest and stopping the previous child.

Candidate failure terminates and removes the candidate while leaving the previous process and manifest active. Startup revalidates the persisted proposal, signature, evaluations, artifact, installed files, and health before restoring the supervised child. This is a bounded operator-signed core service, not permission for a model to rewrite source or replace the trusted parent Express control plane.

Generate the operator release key outside the repository, then sign a proposal JSON document containing `targetVersion`, `contentHash`, `evaluationEventIds`, and `rollbackInstructions`:

```bash
node scripts/release-signing.mjs generate /secure/path/release-private.pem
node scripts/release-signing.mjs sign /secure/path/release-private.pem proposal.json
```

## Dashboard State

The right-hand memory view is kernel-backed and read-only. Legacy `localStorage` keys for memory, profile, provider-like configuration, and skill drafts are purged. `localStorage` is limited to presentation state such as local chat sessions, the selected chat lens, and the active session id. `sessionStorage` may hold the transient active bearer for the current tab, but its validity remains server-authoritative; neither store is authoritative memory, skill, provider configuration, approval, or release state.

## Optional Core Model

OpenBMB MiniCPM5-1B can run in-process through `node-llama-cpp` as an advisory, tighten-only prompt-injection assessor. It may raise risk above deterministic heuristics but cannot lower the heuristic floor, decide policy, issue capabilities, write the ledger, or promote memory.

Place a compatible GGUF file at `.agent-kernel/models/minicpm5-1b.gguf` or set `CORE_MODEL_PATH`. Application chat and extraction still use the provider gateway; the core model is not a bypass around routing, budgets, or access control.

## Setup

```bash
git clone https://github.com/A-Deb-byte/Provenance.git
cd Provenance
npm ci
```

Create `.env` from `.env.example`. For OpenRouter, configure a server-side key and model, for example:

```bash
AI_PROVIDER=openrouter
AI_MODEL=openrouter/free
OPENROUTER_MODEL=openrouter/free
OPENROUTER_API_KEY=your_server_side_value
```

Do not put provider keys in browser storage or commit them. The OS-vault API is the preferred local at-rest store where its platform adapter is available.

Run the development server:

```bash
npm run dev
```

Build and start the compiled server:

```bash
npm run build
npm start
```

## Verification

```bash
npm run lint
npm test
npm run build
npm run verify-ledger
```

The last baseline before the 2026-07-13 trust-boundary hardening was **242 tests across 51 files**. The completed hardening passes **297 tests across 62 files**; `npm test` remains the source of truth as the suite evolves.

## Deployment Boundaries

- No Rust/Tauri kernel or authenticated desktop IPC channel ships yet; the TypeScript kernel remains the reference implementation.
- Docker supplies real command isolation when available. Without Docker, the runtime reports and uses a trusted-host fallback; native Windows job-object or Linux namespace/seccomp isolation is not implemented.
- Desktop automation, OAuth connector runtimes, and browser downloads are not implemented.
- macOS Keychain and Linux Secret Service adapters need live validation on their target operating systems.
- Accounts share one local kernel state. There is no per-user goal/memory partitioning or SSO/OIDC.
- Supervised releases do not hot-replace or proxy the trusted parent Express control plane; stable-port traffic switching remains a deployment concern.
- Provider availability and model behavior depend on operator configuration and the upstream provider.

For the concise capability matrix, see `docs/superpowers/CURRENT_STATE.md`. Design and implementation history live under `docs/superpowers/specs/` and `docs/superpowers/plans/`.

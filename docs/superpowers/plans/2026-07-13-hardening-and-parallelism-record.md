# Hardening, Parallelism, And Rebrand Record

Date: 2026-07-13
Status: Implemented and verified
Parent: `docs/superpowers/plans/2026-07-12-completion-implementation-record.md`

This session removed the last of the origin boilerplate, gave each agent framework a project-native identity, added parallel worker execution, and implemented the platform-native security layers that were previously documented as out of scope. Every claim is backed by tests (204 across 45 files) or the live capability report.

## 1. De-branding

Removed all AI Studio / Google origin references: page title and package name (`agent-memory-knowledgebase`), the `metadata.json` and `assets/.aistudio` artifacts, the `aistudio-build` User-Agent, and the AI-Studio comments in `vite.config.ts` and `.env.example`. The skill-draft system prompt no longer references third-party systems.

## 2. Framework Renames

The four selectable chat personalities were renamed from names of real external products to project-native identities, across `src/types.ts`, `src/lib/persistence.ts`, `server.ts` prompts, and `MemoryDashboard.tsx`:

| Old | New | Emphasis |
| --- | --- | --- |
| Vellum Cognitive System | **Cartographer Memory Mapper** | Taxonomic structure |
| Hermes Reasoning Agent | **Prover Stepwise Reasoner** | Proofs and traces |
| Perplexity Research Computer | **Archivist Evidence Synthesizer** | Grounded synthesis |
| ZeroClaw Adversarial Engine | **Sentinel Adversarial Verifier** | Skeptical pressure |

The default framework is `cartographer`. A persistence test asserts the old `vellum` id is now rejected.

## 3. Parallel Worker Execution

`stepGoal` was refactored into three phases so worker commands run outside the mutation lock:

- **prepare** (locked): policy, budget reservation, capability token issuance, and the `running` mark.
- **execute** (unlocked): `runKernelCommand` in its own OS process.
- **record** (locked): outcome events, task/goal status, runtime usage. Because the goal is re-read under the lock in the record phase, concurrent steps never clobber each other's usage.

`stepGoalsInParallel` (and `POST /api/kernel/goals/step-parallel`) fan out up to eight goals with `Promise.all`. A test with two ~1.2s sleep commands asserts both tasks emit `task.started` before either emits `task.passed` — proving genuine overlap, not serialized execution.

## 4. Windows DPAPI Secret Vault

`src/vault/dpapi.ts` protects secrets at rest with the OS user-scoped DPAPI master key via `System.Security.Cryptography.ProtectedData` (CurrentUser scope), invoked through PowerShell with the payload passed by environment variable (never the command line). This is platform-native protection, not an application-managed encryption key over a file — which is why it is honest to call it an OS vault.

- `PUT/GET/DELETE /api/vault/secrets` and `/api/vault/status`. Values are never returned; only names and status.
- At startup, allowlisted secrets (`GEMINI_API_KEY`, `RELEASE_SIGNING_PUBLIC_KEY`, `KERNEL_API_TOKEN`) are injected into the environment before the provider runtime and auth guard read them; an already-set environment value always wins.
- Non-Windows platforms report `unavailable` with an honest reason and refuse to store — no weaker fallback is substituted.
- The runtime capability report now shows real vault status instead of a hardcoded "unavailable".

Verified live on this Windows host: store → list → retrieve → env-inject → remove round-trip passed.

## 5. Operator Access Control

`src/auth/operatorToken.ts` adds an optional bearer-token guard (`KERNEL_API_TOKEN`) on mutating kernel and vault requests, using constant-time comparison. GET reads stay open on loopback. Unset by default, so the single-user loopback experience is unchanged. Surfaced in the capability report as `accessControl`.

## 6. Independent Ledger Verifier

`scripts/verify-ledger.mjs` (`npm run verify-ledger`) replays the JSONL ledger with zero project imports, recomputing each event hash and link and checking the snapshot head. It is the reference artifact for a future Rust verifier and demonstrates the ledger is replayable outside the TypeScript kernel — the concrete first step of the Rust migration path.

## 7. What Is Still Honestly Out (And Why)

- **OS sandbox**: needs OS-level isolation primitives or the Rust runtime; allowlists and tokens bound blast radius but are not isolation. Not faked.
- **Session-authenticated / desktop / connector workers**: the "hands" that need isolation and per-action permissioning first. The shipped web-inspect worker stays read-only and origin-allowlisted.
- **Cross-platform vault**: macOS Keychain / Linux Secret Service adapters are not implemented; those platforms report unavailable.
- **Multi-user accounts**: the operator token is one shared secret, not roles or sessions. Single-user, loopback-only by design.
- **Rust/Tauri kernel**: the TypeScript kernel remains the reference; the verifier and replayable ledger are the migration path.

## 8. Verification

`npm run lint` clean; `npm test` 204/204 across 45 files; `npm run build` succeeds; `npm run verify-ledger` validates the live ledger. Dashboard confirmed rebranded with the four new framework identities and the two new capability-report rows (OS secret vault, Operator access control).

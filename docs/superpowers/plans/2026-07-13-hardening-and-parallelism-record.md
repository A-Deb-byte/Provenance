# Hardening, Parallelism, And Rebrand Record

Date: 2026-07-13
Status: Implemented and verified
Parent: `docs/superpowers/plans/2026-07-12-completion-implementation-record.md`

> Historical slice: this record preserves what was true at the end of the parallelism pass. Docker/Playwright, cross-platform vault adapters, multi-user auth, dashboard auth, provider-gateway consolidation, approval continuation, snapshot authentication, and staged releases were delivered in later 2026-07-13 records.

This session removed the last of the origin boilerplate, gave each agent framework a project-native identity, added parallel worker execution, and implemented the Windows security layers that were previously documented as out of scope. The 204-test count below is the result for this historical slice; the later pre-hardening baseline is 242 tests across 51 files.

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
- At startup, allowlisted secrets are injected into the environment before the provider runtime and auth guard read them; an already-set environment value always wins. Later provider hardening expanded this allowlist to the supported provider credentials, including OpenRouter.
- Non-Windows platforms report `unavailable` with an honest reason and refuse to store — no weaker fallback is substituted.
- The runtime capability report now shows real vault status instead of a hardcoded "unavailable".

Verified live on this Windows host: store → list → retrieve → env-inject → remove round-trip passed.

## 5. Operator Access Control

`src/auth/operatorToken.ts` adds an optional bearer-token guard (`KERNEL_API_TOKEN`) on mutating kernel and vault requests, using constant-time comparison. GET reads stay open on loopback. Unset by default, so the single-user loopback experience is unchanged. Surfaced in the capability report as `accessControl`.

## 6. Independent Ledger Verifier

`scripts/verify-ledger.mjs` (`npm run verify-ledger`) replays the JSONL ledger with zero project imports, recomputing each event hash and link and checking the snapshot head. It is the reference artifact for a future Rust verifier and demonstrates the ledger is replayable outside the TypeScript kernel — the concrete first step of the Rust migration path.

## 7. Boundaries At The End Of This Historical Slice

- **OS sandbox** was still missing here. A later pass added Docker isolation with an honestly reported trusted-host fallback.
- **Browser writes and session auth** were still missing here. Later passes added Playwright navigation/click/type, L2 approval gates, redirect rechecks, and dashboard bearer-token integration. Desktop and connector workers remain out.
- **Cross-platform vault** was Windows-only here. macOS Keychain and Linux Secret Service adapters were added later and still need target-OS live validation.
- **Multi-user accounts** were still missing here. Roles and revocable sessions were added later; per-user state partitioning and SSO remain out.
- **Rust/Tauri kernel**: the TypeScript kernel remains the reference; the verifier and replayable ledger are the migration path.

## 8. Verification

`npm run lint` clean; `npm test` 204/204 across 45 files; `npm run build` succeeds; `npm run verify-ledger` validates the live ledger. Dashboard confirmed rebranded with the four new framework identities and the two new capability-report rows (OS secret vault, Operator access control).

## 9. Repository And Naming

The project was placed under version control and pushed to `https://github.com/A-Deb-byte/warrant` (branch `main`). Secrets are excluded by `.gitignore` (`.env*`, `.agent-kernel/` including the DPAPI vault, `.claude/`, `.superpowers/`); only `.env.example` is tracked.

**Naming note (resolved):** the project was briefly named `warrant`, which collided with `warrant-dev/warrant` — a 1.3k-star, Apache-2.0, Go authorization service (Google Zanzibar-style, associated with WorkOS) — in an *adjacent* domain (both concern authorization/access decisions). To avoid discoverability and brand confusion it was renamed to **Provenance**, which also better names the project's core differentiator: every memory and action traces to recorded, hash-chained evidence. Repository: `https://github.com/A-Deb-byte/Provenance`. The local working directory name is cosmetic and left unchanged.

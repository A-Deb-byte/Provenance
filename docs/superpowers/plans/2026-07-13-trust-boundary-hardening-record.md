# Trust-Boundary Hardening Record

Date: 2026-07-13
Status: Implemented in source; final integrated command and live-provider verification belongs to the completion run
Parent: `docs/superpowers/CURRENT_STATE.md`

This pass closed eleven authority and evidence gaps without expanding the model's intrinsic authority. It also made OpenRouter a first-class configurable provider route. Credentials remain outside tracked files and are never recorded here.

## 1. One Application AI Gateway

The legacy chat, extraction, mutation, and skill-drafting handlers are replaced by `src/app-ai/router.ts`. Each channel creates a normalized, schema-constrained provider request and delegates execution through the configured provider policy and kernel provider-call accounting. Responses carry provider, model, route, and ledger-evidence metadata.

All mutating application, provider, kernel, and vault paths use the unified access guard. Provider extraction remains candidate-only, and skill drafting returns a bounded transform proposal rather than executable source code.

## 2. Dashboard Authentication

The dashboard now exposes access mode and account count, first-admin bootstrap, username/password login, operator-token mode, logout, and credential clearing. The shared authenticated fetch transport attaches the active bearer token to protected cockpit mutations.

Sessions include a persisted per-user version. Logout increments that version, so an old signed token is rejected even if its cryptographic expiry has not elapsed. Deleted users and role changes also invalidate stale claims. If an operator token is configured, it is required to bootstrap the first administrator; the last administrator cannot be removed.

Loopback middleware checks the `Host`, mutating `Origin`, and `Sec-Fetch-Site` headers and applies browser security headers. This reduces cross-site request risk; it is not a substitute for remote-service hardening.

## 3. Browser Authority

`browser.inspect` remains L0. `browser.navigate`, `browser.click`, `browser.type`, and `browser.download` have a minimum L2 policy risk and therefore require explicit approval. The Playwright driver checks the authorized origin after every navigation, before click/type, and again after page scripts or a click may have navigated. Redirects cannot silently widen the authorized origin.

## 4. Approval Continuation and Pre-Dispatch Grants

An L2/L3 automation run persists an approval request and stops. A subsequent run can consume only a matching approved record and rebuild the intent with approval authority. Denied, stale, unrelated, or already-consumed approvals cannot authorize dispatch.

Capability grants use a serialized persistent store. The grant is validated and moved out of `active` before an opaque one-use dispatch authorization is minted. The worker must claim that authorization, bound to the exact intent hash and worker id, immediately before I/O. Authorization reuse or post-dispatch validation is rejected.

## 5. Non-Circular Memory Evidence

Memory promotion filters evidence references through an allowlist of source-bearing event types. It rejects the candidate's own `memory.candidate_created` event and any event whose entity is the candidate itself. Direct user/source ingestion emits a separate `memory.source_attested` event containing provenance and content hashes; provider extraction can reference the independent `provider.call.completed` event.

Promotion still requires an explicit human reason and contradiction/supersession checks.

## 6. Sealed Skill Canary

The canary-run API no longer accepts an input or expected output. Canary activation seals the evaluated replay suite by evaluation id, suite hash, and deterministic replay-case ids. Each run recomputes the transform over the next held-out input and compares it with the stored evaluated result; ledger evidence contains hashes rather than raw values.

Submitted replay cases still inform pre-canary evaluation, but they are not the canary oracle. Canary activation now seals kernel-generated fixtures, and each run compares the executable runtime with a separate bounded reference interpreter.

## 7. Ledger-Authenticated Snapshots

Snapshot commits use a prepare/pending/commit protocol. The ledger records the canonical state hash, the pending snapshot is checked against it, and both the primary and authenticated recovery copy must match a ledgered commit. Startup can finish an interrupted commit or publication and records hashes for an abandoned uncommitted ledger tail before restoring the latest authenticated snapshot.

This authenticates snapshot contents against ledger events. It deliberately does not claim complete state reconstruction from every domain-event payload.

## 8. Local Storage Is Presentation-Only

The right-hand memory view now reads promoted memory from the kernel and is not editable. Startup purges legacy `localStorage` keys for memory, profile, skill drafts, improvement logs, and provider-like configuration. Remaining `localStorage` persistence is limited to chat-session presentation, active-session selection, and the selected chat lens. `sessionStorage` may contain the transient active bearer for the current tab; its validity remains server-authoritative.

## 9. Controlled Staged Releases

Release activation now consumes a staged hash-addressed executable package rather than changing proposal metadata alone. Its Ed25519 signature binds the target version, package hash, sorted evaluation references, and rollback instructions. Before installation the lifecycle verifies that authorization, each evaluation reference, the staged artifact hash, bounded file count/size, per-file hashes, declared `.cjs` entrypoint, and controlled relative paths.

Files are installed only under a versioned controlled release directory. After installed-file health checks, the supervisor launches the declared entrypoint with a fixed Node invocation and minimal environment. A candidate must return a nonce/version/hash IPC readiness proof and survive a stability window. The previous child remains active until manifest/process commit; failure terminates and removes the candidate. Startup revalidates the persisted proposal, signature, evaluations, artifact, installed hashes, and health before restoring the child.

This is not arbitrary self-improvement. The model cannot bypass signing, evaluation, path, health, readiness, or access gates. The trusted parent control plane supervises the signed child and remains the policy authority; stable-port hot replacement of that parent is still outside this mechanism.

## 10. OpenRouter Configuration

OpenRouter is selectable through the normalized provider runtime. The documented default free route is `openrouter/free`; availability, model selection, rate limits, and data policy remain controlled by OpenRouter. The API key is server-side only and may be loaded from the OS vault. No credential is committed or repeated in documentation.

## 11. Verification Discipline

The baseline before this pass was 242 tests across 51 files. The completed pass is 297 tests across 62 files. New focused tests cover application routing, dashboard auth transport, server-verified operator tokens and operator-authorized bootstrap, session revocation, post-login provider preview, loopback request checks, browser origin drift, L2 approval continuation, pre-dispatch grant persistence, independent memory evidence, independent canary runs, authenticated snapshot recovery, canonical release signing, supervised process rollback, and restart restoration.

The completion total above comes from the final live `npm test` inventory. Completion also requires live clean results from `npm run lint`, `npm run build`, and `npm run verify-ledger`.

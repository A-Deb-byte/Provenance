# Provenance — A Technical Analysis of an Evidence-Gated Local Agent Control Plane

Author of system: A. Deb (github.com/A-Deb-byte)
Analysis date: 2026-07-14
Scope: `github.com/A-Deb-byte/Provenance` (this repository)

> Every claim in this document is anchored to a file or module in the repository and was checked against the source and the test suite. Where a capability is partial, unverified, or deliberately absent, this document says so. That discipline — *state only what the code does, report the rest as unavailable rather than simulated* — is itself a core design property of the system, so an analysis of it should hold to the same standard.

---

## 1. What Provenance is (and is not)

Provenance is a **local-first, single-tenant agent control plane**: a TypeScript/Express server and a React/Vite dashboard in which a *deterministic trusted kernel* mediates every action a language model proposes. Its guiding thesis is that agent safety is a **systems-engineering problem**, not a model-alignment problem — safe behaviour is enforced by kernel code, capability tokens, and a tamper-evident ledger, not by prompt wording or trained-in refusals.

It is **not** an Electron application, a desktop-client launcher, an ASAR/packaging wrapper, or a supply-chain signer for third-party binaries. It ships no bundled browser client, performs no cryptographic pinning of external runtimes, and contains no Claude Desktop / ChatGPT packaging logic. Its dependency set is `express, react, vite, @google/genai, node-llama-cpp, playwright-core` and testing tooling — a web service plus an in-process kernel, across ~159 TypeScript source files.

The operative slogan, implemented rather than asserted, is: **models propose; the kernel decides; the ledger proves.**

---

## 2. Architecture at a glance

```
Browser dashboard (React/Vite)
        │  authenticated fetch (bearer)
        ▼
Express API  ──  access guard (open | operator-token | multi-user)
        │
        ▼
Trusted kernel (single serialized mutation queue)
  ├─ goal contracts + evidence-gated task graph
  ├─ policy engine (risk ladder L0–L4) + approval broker
  ├─ capability grants (single-use, exact-scoped, pre-dispatch authorization)
  ├─ hash-chained event ledger + authenticated snapshots
  ├─ budgets (operations / runtime / approvals / provider calls)
  └─ evidence-backed memory + bounded skill foundry
        │
        ▼
Workers (receive short-lived capability authorizations, mint none)
  ├─ command worker  → Docker sandbox (no-network, read-only) or host fallback
  ├─ web-inspect worker (read-only, L0)   ├─ Playwright browser worker (write, min L2)
  ├─ provider router (6 providers, server-side secrets)
  └─ in-process core model (MiniCPM5-1B via node-llama-cpp)
```

The kernel is the **only writer of authoritative state**. All mutations pass through one serialized queue in a single trusted process; workers never mint authority, only consume scoped, one-use authorizations.

---

## 3. The tamper-evident event ledger

Every authoritative action appends a record to an append-only JSONL ledger under `.agent-kernel/`. Each event carries `previousHash` and `hash`, where the hash is `SHA-256(JSON(event-without-hash))`, chaining events so that altering any past record breaks every subsequent link.

Two properties make this more than logging:

- **Verified on read.** The kernel re-checks the chain head against the persisted snapshot before serving state; a mismatch refuses the read rather than returning divergent state.
- **Independently replayable.** `scripts/verify-ledger.mjs` (`npm run verify-ledger`) recomputes every hash and link and confirms the snapshot head, using **zero project imports**. This is a deliberate portability proof: the ledger format can be validated by a future compiled/Rust verifier without trusting the TypeScript kernel. In live testing it verified 71 events after a session of real activity, and larger counts after mission runs.

Snapshots use a **prepare / pending / commit** protocol: the ledger records the canonical state hash, the pending snapshot is checked against it, and both the primary and an authenticated recovery copy must match a ledgered commit. Startup can finish an interrupted commit and records hashes for an abandoned tail before restoring the latest authenticated snapshot. This authenticates snapshot *contents* against ledger events; it does not claim full state reconstruction from every event payload, and says so.

---

## 4. The capability model

Authority to act is never ambient. When the kernel schedules an action it mints a **capability grant** that is:

- **Exact-scoped** — bound to a specific command + args + working directory (for command execution) or a specific action type + origin/URL (for browser actions).
- **Single-use** — an operation counter and expiry; reuse is rejected.
- **Pre-dispatch and hash-bound** — the grant is validated and moved out of `active` state in a serialized persistent store (`src/capabilities/grantStore.ts`, `dispatch.ts`) *before* an opaque one-use dispatch authorization is minted. The worker must claim that authorization, bound to the exact intent hash and worker id, immediately before performing I/O. Authorization reuse or post-dispatch validation is rejected.

This closes the common agent-runtime gap where a broad, reusable permission is granted once and then replayed. Here a worker holds only a hash-pinned, one-shot token valid for exactly one intent.

---

## 5. Policy, the risk ladder, and approvals

Actions are classified L0–L4 (`src/capabilities/policy.ts`):

- **L0** (e.g. `browser.inspect`) — read-only, auto-allowed inside scope.
- **L1** — bounded local execution (e.g. allowlisted verification commands).
- **L2 / L3** — require an explicit, recorded human approval before dispatch. All browser *writes* — `browser.navigate`, `browser.click`, `browser.type`, `browser.download` — carry a **minimum L2** risk and therefore cannot run without approval.
- **L4** — forbidden by policy.

Approvals are durable and continuation-based: an L2/L3 automation run **persists an approval request and stops**. A later run may consume only a matching *approved* record and rebuild the intent with approval authority; denied, stale, unrelated, or already-consumed approvals cannot authorize dispatch. Untrusted content (web pages, tool output) is tagged at ingestion and **cannot grant authority** — it can inform a proposal, never authorize an action.

---

## 6. Execution isolation

Verification commands run through a `SandboxRunner` boundary (`src/kernel/sandbox/`). When a Docker daemon is reachable, commands execute in an ephemeral container with `--network none`, a read-only root filesystem, a writable tmpfs, bounded memory/pids/cpu, `--cap-drop ALL`, `--security-opt no-new-privileges`, and a workspace-only mount. When Docker is absent the runner falls back to the trusted host and **reports that honestly** in the runtime capability report — it never presents host execution as isolation.

This was verified live: a kernel goal ran `npm run lint` inside the container to a clean exit with `platform=linux` on a Windows host (proving real isolation) and a DNS lookup failing under `--network none` (proving network isolation). Live testing also surfaced — and fixed — a configuration trap in which a mis-escaped Docker path silently disabled the sandbox; the fix and the class of bug are documented in the implementation records.

---

## 7. Browser workers and keystroke-injection resistance

Two browser workers exist. The **web-inspect** worker is strictly read-only (L0): a bounded `fetch` with manual redirect handling, origin re-checks, content-type limits, markup stripping, and size/time caps. The **Playwright** worker is write-capable (navigate / click / type), gated at minimum L2, and re-checks the authorized origin *after every navigation and before every click/type* so a redirect cannot silently widen authority.

Text entry is the notable design point. A `browser.type` intent carries **not the text** but a `payloadArtifactId` + `payloadHash`. The value to be typed is staged separately in a **content-addressed artifact store** (`src/kernel/artifacts/artifactStore.ts`, SHA-256), and the worker refuses to type unless the resolved artifact's hash equals the hash the intent declares. Consequently a compromised or malicious page **cannot inject keystrokes** — an intent can only cause a *pre-staged, hash-matched* value to be entered, and the typed value is never echoed into the observation (only its length and target selector are recorded). Verified live: the driver typed a staged value into a form field and the page reflected exactly that value.

---

## 8. Provider layer and secret handling

A normalized adapter contract (`src/providers/`) spans six providers — Gemini (SDK), OpenAI/OpenRouter/DeepSeek/GLM (shared OpenAI-compatible HTTP), and a Bedrock boundary that reports unavailable until its runtime exists. OpenRouter is a first-class configured route. Routing supports automatic/pinned/ensemble selection scored by recorded telemetry, and every provider call is budgeted and recorded in the ledger by request/result hash.

Secrets are **server-side only**, held behind a non-serializable handle that renders as `[REDACTED]`, and may be loaded at boot from the OS secret vault. No credential is written to tracked files. Provider output can never modify kernel policy or grant capabilities.

---

## 9. The in-process core model — and an honest negative result

Provenance can embed OpenBMB MiniCPM5-1B directly via `node-llama-cpp` (no Ollama/LM Studio), running fully on-device for memory extraction and a chat fallback when no cloud key is present. Generation is grammar-constrained to strict JSON schemas at temperature zero.

Live testing produced a candid finding worth recording: the 1B model is **not reliable for prompt-injection classification** — it flagged benign web text with every injection signal at high risk, even after few-shot prompting. Because the assessor is *tighten-only* (it may raise risk but never lower the deterministic floor), an over-flagging model would cause alarm fatigue. The system therefore **defaults the live observation assessor to the deterministic heuristics** and makes the model path opt-in. This is the design ethos applied to itself: a capability that did not hold up under real use was demoted rather than shipped as a feature.

---

## 10. Evidence-gated memory and the skill foundry

Durable memory follows a `candidate → promoted → superseded/revoked` lifecycle with provenance, confidence, scope, sensitivity, retention, and evidence references. Promotion requires an explicit human reason, contradiction/supersession checks, and — after hardening — **non-circular evidence**: a candidate cannot cite its own creation event; direct ingestion emits a separate `memory.source_attested` event, and provider-extracted candidates reference an independent `provider.call.completed` event. Provider output enters as *candidates only* and can never silently become durable memory. The ledger stores content **hashes**, not raw memory text.

The skill foundry synthesizes bounded text-transform programs (a five-operation DSL), evaluates them against a baseline, runs a **sealed canary** whose oracle is kernel-generated (the operator cannot supply the expected output), then promotes or rolls back — **never executing generated JavaScript**.

---

## 11. Verified-report and recurring-research missions

The higher-level workflow turns a fixed set of operator-supplied HTTPS sources (whose origins must already be allowlisted) into reports via a five-task graph: plan → capture (read-only L0) → synthesize → critique → publish. The distinguishing control is **deterministic citation grounding**: before any claim publishes, the kernel resolves the cited source artifact, recomputes its chunk hashes, and requires each quotation to be an *exact contiguous excerpt* (≥20 characters, ≥3 words) of an authenticated source; unknown, quarantined, or high-risk sources are rejected, and a `high`-confidence claim needs corroborating distinct-origin sources.

"Verified" is scoped precisely and honestly: it means *every claim is citation-grounded in exact excerpts of the authenticated captured sources and the deterministic + critic gates passed*. It does **not** assert a source is true, current, complete, or unbiased, and it performs no general search, crawling, or redirect following.

The recurring layer schedules such missions on an interval with durable leases, monotonic fences, latest-once catch-up, per-occurrence deadlines that abort provider/source I/O, Stop-All cancellation, and **fail-closed restart recovery** — an interrupted run becomes *uncertain* and requires an explicit operator resume or skip; it is never silently replayed.

---

## 12. Access control and request integrity

Access has three modes (`src/auth/`): open loopback (only when nothing is configured), a shared operator token, and multi-user accounts. Accounts use scrypt-hashed passwords; sessions are signed, expiring bearer tokens carrying a **persisted per-user version** so that logout, deletion, or a role change revokes an outstanding token *before* its cryptographic expiry. The last administrator cannot be removed; if an operator token is configured, it is required to bootstrap the first admin. A loopback guard inspects `Host`, mutating `Origin`, and `Sec-Fetch-Site` and sets browser security headers to reduce cross-site request risk — explicitly a local-hardening measure, not a substitute for remote-service security.

---

## 13. Controlled, signed releases

Release activation consumes a **staged, hash-addressed executable package**, not just metadata. An Ed25519 signature binds the target version, package hash, sorted evaluation references, and rollback instructions; before installation the lifecycle verifies authorization, each evaluation reference, the artifact hash, bounded file count/size, per-file hashes, the declared `.cjs` entrypoint, and controlled relative paths. Files install only under a versioned release directory, and a supervised child process must return an IPC readiness proof and survive a stability window before commit; the previous child stays live until then. This is *supervised, signed, evaluated* release of a child process — not arbitrary self-modification, and the trusted parent remains the policy authority.

---

## 14. Verification discipline (as of this analysis)

Measured directly, not quoted from prior records:

- `npm run lint` (tsc `--noEmit`): **clean**.
- `npm test`: **410 tests across 70 files, 409 passing**. One test (`apiAutonomy.test.ts` → "exposes recovery as an explicit endpoint") is **stale**, not a code defect: the `/recovery` contract was deliberately tightened to return `409` unless the kernel is quiescent, and this single test still asserts the old `200`. It should be reconciled before the suite is called fully green.
- `npm run build`: produces the Vite client and the esbuild CJS server bundle.
- `npm run verify-ledger`: passes on the live ledger.

The test surface covers the security-relevant paths specifically: ledger tamper cases, capability scoping and pre-dispatch grants, browser origin drift, L2 approval continuation, non-circular memory evidence, sealed canaries, authenticated snapshot recovery, signed release + supervised rollback, session revocation, and loopback request checks.

---

## 15. Honest limitations and boundaries

A credible analysis states what the system does **not** do; the runtime capability report reflects these as `unavailable`/`blocked` rather than simulating them:

- **Single trusted process, single tenant.** Exactly one process may own a `.agent-kernel` directory; there is no multi-process coordination and no per-user data partitioning or SSO/OIDC.
- **Reference kernel is TypeScript.** A compiled/Rust kernel with OS-level isolation and authenticated IPC is a migration target, not a current fact; the ledger verifier is its first concrete artifact.
- **Sandbox depends on Docker.** Without a container runtime, verification runs on the trusted host (reported honestly). Allowlists and capability tokens bound blast radius but are not isolation.
- **Vault is platform-native but only Windows DPAPI is verified.** The macOS Keychain and Linux Secret Service adapters are implemented and platform-gated but validated only by construction/unit tests, not on their own OSes.
- **Sources are read-only and allowlisted.** There is deliberately no general web search, crawling, redirect following, desktop control, email, or OAuth connectors.
- **"Verified" ≠ "true."** Citation grounding proves a quote is a faithful excerpt of a captured source, not that the source is correct.
- **The 1B core model is advisory and weak at injection classification** (see §9); it never holds allow/deny authority.

---

## 16. Where Provenance sits

| System | Layer | Primary mechanism | Objective |
| --- | --- | --- | --- |
| **Provenance** | Application control plane (userspace) | Evidence-gated kernel, hash-chained ledger, single-use capability grants, deterministic citation grounding | Make an agent's actions *authorized, bounded, and provable* rather than *trusted* |
| Model-alignment guardrails | Prompt / model | Training, system prompts, RLHF | Discourage unsafe outputs (fragile to jailbreaks/injection) |
| Kernel LSM enforcement (e.g. eBPF-LSM) | Kernel space | Syscall-time allow/deny hooks | Real-time OS-level action prevention |
| Provenance-graph auditing (e.g. whole-system provenance) | Kernel space | System-wide data-lineage capture | Forensic reconstruction of data flow |

Provenance occupies the **application/agent** tier: it does not replace OS-level enforcement, and it does not pretend to. Its contribution is a *deterministic authority-and-evidence substrate for a single local agent* — every action gated by a typed policy and a one-use capability, and every outcome anchored to a tamper-evident ledger and, where applicable, to exact source excerpts.

---

## 17. Conclusion

The core claim Provenance can defend, and that a reader can confirm by opening the source, is narrow and strong: **an autonomous agent whose every consequential action is authorized by deterministic policy, executed under a single-use hash-bound capability, and recorded in an independently verifiable ledger — with model output confined to *proposing*, never to granting authority or defining "done."** The verified-report and recurring-research layers extend that to *evidence*: a published claim is a checkable excerpt of an authenticated source, not model prose.

Its honesty about limits — reporting unavailable features rather than faking them, demoting its own local model when it proved unreliable, and marking one stale test rather than rounding the suite up to green — is not incidental. It is the same property that makes the system's stronger claims trustworthy.

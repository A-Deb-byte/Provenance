# Research To Verified Report Implementation Record

Date: 2026-07-14
Status: Complete and verified
Parent design: `docs/superpowers/specs/2026-07-12-completion-architecture.md`

This milestone delivers the first complete, dashboard-driven mission loop. It is a bounded evidence workflow, not a general web-search agent. The kernel remains the authority for scope, budgets, dispatch, checkpoints, verification, publication, and recovery.

## 1. Mission Contract And Authority

An authenticated operator supplies:

- One research objective, bounded to 2,000 characters.
- One to five unique HTTPS seed URLs with no embedded credentials or fragments.

Every seed origin must already appear in `WEB_INSPECT_ORIGINS`. Mission creation fails when the provider router, artifact store, read-only web worker, or origin configuration is unavailable. The seed list is immutable during execution: source text and provider output cannot add a URL, follow a redirect, request a tool, invoke a command, or widen browser authority.

The kernel creates one goal and a sequential five-task graph:

1. Plan the evidence-backed report.
2. Capture the operator-supplied sources.
3. Synthesize citation-grounded claims.
4. Critique the grounded claims.
5. Publish the verified report artifact.

The goal reserves `source count + 8` operations, at most eight provider calls, no approvals, and no command runtime. Collection uses only `browser.inspect` at L0. This mission does not reuse the L2 browser-write path.

## 2. Read-Only Source Capture

Each source dispatch is an exact-origin, exact-URL `browser.inspect` intent with user-request authority bound to the mission revision. Policy must auto-allow the L0 intent, and a persisted one-use capability grant is consumed before worker I/O. The fetch worker uses manual redirect handling, rejects redirects, rechecks the final response origin, accepts only bounded textual content types, strips markup, and enforces time and response-size limits.

The kernel treats returned text as an untrusted observation. It normalizes and caps the evidence text at 12,000 characters, stores it in the authenticated artifact store, and derives stable 1,600-character chunks with SHA-256 hashes. Ledger events contain artifact, observation, source, and content hashes rather than the source body. Deterministic and optional tighten-only injection assessment can raise a source to high risk; high-risk sources are quarantined and never enter synthesis or critique. At least one eligible captured source is required to proceed.

## 3. Provider Plan, Synthesis, And Critic

All three model stages use the configured provider router and the mission goal's provider budget:

- `plan` produces bounded research questions and a report outline without changing the source list.
- `synthesis` receives only eligible authenticated source chunks and must return structured claims with exact quotations.
- `critique` runs as a separate provider request after deterministic checks and judges whether claim breadth and confidence match the supplied excerpts. Routing may select the same provider and model used for planning or synthesis.

Requests use strict JSON schemas, temperature zero, bounded output tokens, a 60-second timeout, and metadata identifying the mission purpose. Tool calls and ensemble disagreement fail the step. Each successful call must have a matching `provider.call.completed` ledger event before its provider/model/usage record is attached to the mission.

## 4. Deterministic Citation Verification

Provider output is not its own proof. Before a claim can publish, the kernel:

- Resolves the source artifact and compares its content hash with the checkpoint.
- Recomputes each cited chunk hash.
- Requires each quotation to be an exact contiguous excerpt of at least 20 characters and three words.
- Rejects unknown, unavailable, quarantined, or high-risk sources.
- Requires sources with distinct origins and content hashes for a `high` confidence claim.

Failed grounding returns the issue list to another bounded synthesis attempt. The mission stops after three synthesis attempts. A failed separate critique pass can also return the workflow to synthesis while attempts remain. Exhaustion blocks the mission as requiring revision rather than permitting an unbounded retry loop.

Only a deterministic pass plus a critic `pass` with no error-severity issue permits publication. The renderer uses escaped verified claims, exact citations, kernel-owned verification limits, source hashes, and provider provenance. It deliberately excludes unstructured provider prose and escapes dynamic Markdown/HTML. The Markdown report is stored as a new hash-addressed artifact; `mission.report_published` binds its hash and complete publication-input hash to source evidence, provider evidence, and the verification event. On every read, the report API re-resolves each cited source artifact, reconstructs and compares its chunk map, checks the source/provider/verification ledger events, and authenticates the final report artifact.

## 5. Checkpoints, Stop All, And Recovery

The kernel persists an active-step record before every provider or source dispatch. A concurrent request observes `in_progress` and cannot dispatch the same step twice. State checkpoints advance only after the matching external result is committed.

Provider requests are wrapped in abort controllers and a bounded timeout. Source work has its own abort controller and bounded fetch timeout. Stop All aborts both controller sets, blocks new mission work, and rejects an otherwise successful external result if the stop became active before commit.

Startup recovery never assumes that an interrupted external call succeeded or failed safely. A persisted running task and active mission step become blocked, the uncertain step is cleared, and `task.recovered` plus `mission.interrupted` evidence is recorded. A retryable mission can resume only after Stop All is cleared and an operator supplies a non-empty reason; the reason hash is recorded in both mission and task resume events.

## 6. Dashboard Cockpit

The new Research Missions tab is kernel-backed. It exposes:

- Runtime availability, maximum sources, and configured read-only origins.
- Mission creation, bounded-loop execution, one-step execution, and reasoned resume.
- Goal budgets, checkpoints, task status, and evidence counts.
- Captured-source status, injection signals, chunk counts, and SHA-256 hashes.
- Grounded claims, exact excerpts, deterministic issues, and critic verdict.
- Mission ledger events and provider/model/token/latency records.
- The authenticated report content and its checkpointed hash.

When access control is configured, mission configuration, list, detail, and report GETs require a valid bearer. Multi-user viewer sessions can inspect this state but cannot create, run, step, or resume a mission; those mutations require admin/operator authority. Loopback-only `open` mode requires no bearer because neither an operator token nor user accounts are configured. The cockpit polls recorded server state and does not make browser storage authoritative.

## 7. Verification Boundary

The label "verified report" has a narrow meaning: every published claim is citation-grounded in exact excerpts from the authenticated artifacts captured for the operator's seed URLs, and the recorded deterministic and critic gates passed. It does not establish that a source is truthful, current, complete, unbiased, or independent. It also does not perform generic search, source discovery, crawling, redirect following, external fact checking, or automatic source expansion.

Focused coverage lives in:

- `src/kernel/missions/research.test.ts`
- `src/kernel/researchMissionIntegration.test.ts`
- `src/components/ResearchMissionPanel.test.tsx`
- `src/App.test.tsx`
- `src/kernel/api.test.ts`
- `src/kernel/workers/webInspectWorker.test.ts`

Fresh completion evidence on 2026-07-14: `npm run lint` passed, `npm test` passed **347 tests across 66 files**, `npm run build` produced the production client and server bundles, and `npm run verify-ledger` verified **249 hash-chained events**.

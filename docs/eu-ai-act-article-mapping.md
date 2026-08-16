# EU AI Act — Article 12, 14 and 26 Mapping

- Version: 1.0
- Date: 2026-08-16
- Applies to: Provenance at commit `4d4b4e7`, branch `codex/production-desktop-release-v1`

---

## 0. What this document is, and what it is not

**This is an engineering mapping, not a compliance attestation and not legal
advice.** It states which Article 12, 14 and 26 obligations Provenance provides
technical capability for, which it partially supports, and which it does not
address at all. Every claim cites source. A qualified legal adviser must decide
whether any given deployment meets the Regulation.

**Provenance is not itself a high-risk AI system.** It is a local-first agent
runtime — a control plane that mediates what an AI agent is permitted to do and
records what it did. It performs no biometric identification, credit scoring,
employment screening, or any other Annex III function on its own.

That distinction determines how this document reads:

| Role | Who holds the obligation | What Provenance does |
| --- | --- | --- |
| **Provider** of a high-risk system built on Provenance | You | Provenance supplies the Art. 12 logging capability and the Art. 14 oversight interfaces your system must have |
| **Deployer** of a high-risk system | Your customer, or you | Provenance produces and retains the evidence Art. 26 requires them to keep and monitor |

Obligations that are organisational — training, worker notification, registration,
incident reporting to authorities — cannot be discharged by software. They are
marked as such rather than quietly omitted.

**Legend**

| Mark | Meaning |
| --- | --- |
| ● **Provided** | A technical control exists and is verifiable in source |
| ◐ **Partial** | A control exists but does not fully satisfy the clause; the gap is stated |
| ○ **Not addressed** | No technical control; deployer responsibility or out of scope |
| ✕ **Not supported** | Explicitly outside the system's design |

---

## 1. Article 12 — Record-keeping

### 12(1) — Automatic recording of events over the system's lifetime — ● Provided

Every state-changing kernel operation appends an event to an append-only,
hash-chained ledger. There is no code path that mutates kernel state without an
event: `appendKernelEvent` re-reads the chain head and **refuses to append if it
does not match**, so a fork or an out-of-band write is rejected rather than
silently accepted.

- `src/kernel/ledger.ts` — `appendKernelEvent`, head-mismatch refusal
- `src/kernel/ledger.ts` — `readKernelEvents` re-verifies the whole chain on every read

**Integrity is independently verifiable.** The digest is canonical (key-sorted),
so a verifier written in another language reproduces it:

```bash
npm run verify-ledger        # hash-chain integrity
npm run replay-ledger        # re-derives the recorded authorization decisions
```

`scripts/verify-ledger.mjs` imports no project code by design. This was tested,
not assumed: an independent Python implementation (`json` with `sort_keys=True`,
zero shared code) reproduced every hash of a kernel-produced chain, and failed on
the pre-canonical chain. See `docs/Prd_Dev/canonical-ledger-hashing.md`.

> **Why this matters for Art. 12:** the Article requires the *capability* to
> record. Tamper-evidence and third-party verifiability are not required by
> 12(1) — they exceed it, and they are what makes the record credible to an
> auditor who does not trust the operator.

### 12(2)(a) — Events that may cause risk or indicate substantial modification — ● Provided

Every action intent carries a risk level (L0–L4) assigned by a policy engine
that **fails closed**: a malformed or absent risk level is treated as L4
(forbidden), and the risk floor per action type is an exhaustive compile-time
switch, so an unassigned action type is a build error rather than a silent
default.

- `src/capabilities/policy.ts` — `decideActionPolicy`, `minimumRiskForAction`

Refusals are recorded as first-class evidence, with the inputs that forced them:

| Event | Meaning |
| --- | --- |
| `automation.run_blocked` | Refused pending human approval |
| `automation.run_denied` | Refused by policy |
| `capability.grant_consumed` | Authorised, with the decision record |

Content arriving from outside the trust boundary is recorded as an untrusted
observation carrying prompt-injection signal codes and a content hash, and
structurally **cannot** confer authority (`canGrantAuthority: false`).

- `src/capabilities/injection.ts`
- `src/capabilities/policy.ts` — authority is validated before anything else

### 12(2)(b) — Facilitating post-market monitoring (Art. 72) — ● Provided

The ledger is exportable JSONL with a verifiable chain, plus a structured
runtime capability report distinguishing *available* / *configured* /
*unavailable* per subsystem (`GET /api/kernel/runtime-report`).

### 12(2)(c) — Supporting the monitoring in Art. 26(5) — ● Provided

Same evidence, plus `GET /api/kernel/diagnostics`. See §3.5.

### 12(3) — Biometric-specific logging (Annex III 1(a)) — ✕ Not supported

Provenance performs no biometric identification and records no reference
database, match data, or verifier identity. **If your system falls under Annex
III point 1(a), Provenance does not provide the 12(3) logging capability and you
must obtain it elsewhere.** See also Art. 14(5) in §2.

---

## 2. Article 14 — Human oversight

### 14(1) — Human-machine interface enabling effective oversight — ● Provided

An authenticated operator cockpit surfaces pending approvals, kernel state,
runtime capability, and ledger evidence. Approval decisions are made through
`GET /api/kernel/approvals` and `POST /api/kernel/approvals/:approvalId/decision`.

### 14(3)(a) — Oversight measures built in by the provider — ● Provided

Oversight is enforced by the kernel, not requested of the model. The
architectural claim is *"models propose, the kernel decides"*: a model can emit
an intent, but the intent is evaluated by deterministic policy it cannot
influence.

Concretely:

- **L4 is refused outright.** `policy.ts`
- **L2 and L3 cannot proceed without an explicit approval** bound to that
  specific intent, not a general permission. `policy.ts`
- **Authorisation is single-use and consumed before dispatch**, via a
  compare-and-set that pins every security-relevant field, so a grant cannot be
  replayed or widened. `src/capabilities/grantStore.ts`,
  `src/capabilities/dispatch.ts`

### 14(4)(a) — Understand capacities and limitations; monitor; detect anomalies — ● Provided

The runtime report deliberately distinguishes *available*, *configured* and
*unavailable* rather than presenting everything as ready, so an overseer is not
misled about what the system can currently do. Anomalies surface as recorded
refusals and injection signals (§1, 12(2)(a)).

### 14(4)(b) — Remain aware of automation bias — ◐ Partial (organisational)

Approval requests present the **specific action, its risk level, and the
kernel's stated reason for stopping**, rather than a bare accept/reject prompt,
and a free-text reason is **mandatory** on every decision — a decision cannot be
recorded without the overseer articulating one
(`requiredAuditReason`, `src/kernel/api.ts`).

That discourages rubber-stamping; it does not discharge the obligation.
Automation-bias awareness is a **training duty** on the deployer.

### 14(4)(c) — Correctly interpret system outputs — ● Provided

Payloads are hash-addressed rather than inlined, so what was acted upon is
identifiable and verifiable rather than paraphrased
(`src/kernel/artifacts/artifactStore.ts`). Research outputs additionally require
deterministic citation grounding — a claim is publishable only if its quotation
is an exact contiguous excerpt of an authenticated source artifact.

### 14(4)(d) — Decline to use, or override, the system's output — ● Provided

The default for consequential actions is **refusal**, not permission: an L2/L3
automation run stops and persists an approval request, and only a later run
carrying a matching approval may dispatch. An overseer may approve or deny, with
a mandatory reason, and both outcomes are ledgered.

This was verified end-to-end against a real browser: run 1 returned
`approval_required` and did nothing; after an operator approval, run 2 dispatched.
See `docs/Prd_Dev/pilot-and-verification-evidence.md`.

### 14(4)(e) — Intervene, or halt via a stop button — ● Provided

A global **Stop All** control sets `state.controls.stopAll`, checked at every
consequential entry point in the kernel — provider calls, mission creation and
execution, source inspection, automation dispatch — each of which refuses while
it is active. Activation and resumption are ledgered (`control.stop_all`,
`control.resumed`).

- `src/kernel/kernel.ts` — `controls.stopAll` checked at **20** independent call sites; state transition ledgered at `kernel.ts:4933`

> Enforcement is distributed across call sites rather than centralised in a
> single chokepoint. It is comprehensive today; a new entry point that omits the
> check would not fail any existing test. Treat that as a maintenance risk.

### 14(5) — Two-person verification for biometric identification — ✕ Not supported

Two independent reasons: Provenance performs no biometric identification, and —
more fundamentally — **it cannot currently demonstrate that two *distinct*
natural persons acted**, because approvals are not attributed to an identity.
See Gap 1.

---

## 3. Article 26 — Obligations of deployers

### 26(1) — Use in accordance with the instructions for use — ● Provided

Technical constraints are enforced rather than documented: origin allowlists for
browser actions, an application allowlist for desktop automation, per-worker
configured scopes, and a two-level containment check (action ⊆ intent scope ⊆
worker configured scope). An action outside the configured envelope is refused.

- `src/capabilities/validators.ts` — `isActionWithinScope`, `isScopeWithinScope`

### 26(2) — Assign oversight to competent persons with authority — ◐ Partial

**Provided:** authenticated multi-user access control with three roles
(`admin` / `operator` / `viewer`), scrypt-hashed credentials, signed expiring
session tokens with persisted revocation, and last-administrator protection.
Viewers can read but cannot mutate. Verified 10/10 including logout revoking an
unexpired token.

- `src/auth/users.ts`, `src/auth/session.ts`, `src/auth/accessControl.ts`

**Gap:** the ledger records `actor: 'user'` — a role category — **not which
natural person decided**. You can prove an approval happened and why; you cannot
prove *who* exercised oversight. See Gap 1. Competence and training remain
organisational.

### 26(3) — Ensure input data is relevant and representative — ○ Not addressed

Provenance does not train models or curate training data. This obligation
attaches to the high-risk system you build, not to the control plane.

### 26(5) — Monitor operation; inform the provider; suspend; report incidents — ◐ Partial

**Provided:** continuous monitoring evidence (ledger, runtime report,
diagnostics) and an immediate suspension mechanism (Stop All, §2 14(4)(e)).

**Not provided:** notification to providers and market-surveillance authorities,
and serious-incident reporting. These are organisational duties with legal
deadlines; no technical control in this repository performs them.

### 26(6) — Keep logs for at least six months — ◐ Partial

**Provided:** the ledger is append-only. Nothing in the codebase deletes,
rotates, prunes, or truncates events — verified by inspection of
`src/kernel/ledger.ts` and `src/kernel/store.ts`. Retained events remain
verifiable indefinitely.

**Gap:** append-only by construction is not the same as an *enforced retention
policy*. There is no retention configuration, no deletion protection, no
guarantee against an operator removing the file at OS level, and no external
anchoring. See Gap 3.

### 26(7) — Inform workers and their representatives — ○ Not addressed (organisational)

### 26(8) — Public authorities: use only registered systems — ○ Not addressed (organisational)

### 26(9) — Use provider information for a DPIA — ● Supports

The ledger, decision records, and runtime reports supply concrete material for a
GDPR DPIA. Note that decision records store **one-way commitments** rather than
raw URLs, paths, selectors, connector resources, or typed content — a data
minimisation property that is usually favourable under GDPR, and which the
records' own tests assert (`src/capabilities/decisionRecord.test.ts`).

> **Trade-off to raise with counsel:** because resources are hashed, an auditor
> cannot directly cross-reference ledger entries against external evidence such
> as proxy or DNS logs — they can only confirm a guess. Commitments over
> low-entropy identifiers are also guessable by anyone holding the ledger. This
> favours confidentiality over external corroborability; some regulated buyers
> will want the opposite.

### 26(10) — Post-remote biometric identification authorisation — ✕ Not supported

### 26(11) — Inform natural persons subject to decisions — ○ Not addressed (organisational)

### 26(12) — Cooperate with competent authorities — ● Supports

The evidence is exportable and verifiable **without Provenance's own software or
cooperation**: `verify-ledger.mjs` and `replay-ledger.mjs` import no project code,
and the canonical format has been demonstrated reproducible from an independent
implementation in a second language. An authority does not have to trust the
vendor's tooling to check the record.

---

## 4. Gaps — stated plainly

Ranked by how much they affect the Articles above.

### Gap 1 — Approvals are not attributed to a natural person **(highest impact)**

`decideApproval` writes `actor: 'user'` and a mandatory reason, but no principal
identity. This directly weakens **Art. 26(2)** (demonstrating which competent
person exercised oversight) and makes **Art. 14(5)** four-eyes verification
impossible, since two decisions cannot be shown to come from two distinct people.

**The fix is small and the pattern already exists in this codebase.** The
authenticated principal is computed at the API boundary
(`getRequestAccessPrincipal`, `src/auth/accessControl.ts`) and is already threaded
into the kernel for skill authorship (`server.ts:579`). The same needs doing for
approval decisions.

**Close this before any regulated pilot.**

### Gap 2 — Biometric systems are out of scope

Art. 12(3), 14(5) and 26(10) are unsupported by design. If your use case is
Annex III point 1(a), Provenance is not a sufficient control plane on its own.

### Gap 3 — Retention and anchoring are not enforced

Append-only is a property of the code, not an enforced retention policy, and
hash-chaining proves internal consistency only: a party with full write access
can rewrite the chain from genesis. External transparency-log anchoring is not
implemented. For Art. 26(6) durability, pair the ledger with write-once or
externally anchored storage.

### Gap 4 — Replay covers authorization decisions only

`replay-ledger.mjs` re-derives capability policy and grant-consumption decisions.
Budget reservation, scheduler leasing, memory promotion, and skill promotion are
recorded but not independently re-derivable. Replay also establishes that
recorded inputs imply the recorded outcome — it does not establish that a worker's
external side effect occurred exactly as reported.

### Gap 5 — No independent audit or certification

No external security audit, no ISO 42001 certification, no third-party
attestation. All evidence in this document is repository tests and local
verification. **Enterprise procurement increasingly requires ISO 42001; that
remains outstanding.**

---

## 5. What a deployer must still do

No software discharges these. Listed so they are not mistaken for covered:

1. Determine whether your system is high-risk under Annex III at all.
2. Appoint named, competent overseers and record their training (Art. 26(2)).
3. Complete a Fundamental Rights Impact Assessment where Art. 27 requires one.
4. Complete a GDPR DPIA (Art. 26(9)) — Provenance supplies evidence, not the assessment.
5. Notify workers and their representatives (Art. 26(7)).
6. Register, where a public authority (Art. 26(8)).
7. Inform affected natural persons (Art. 26(11)).
8. Establish incident-reporting procedures to provider and authorities (Art. 26(5)).
9. Set and enforce a log retention period of at least six months (Art. 26(6)).

---

## 6. Summary

| Article | Obligation | Status |
| --- | --- | --- |
| 12(1) | Automatic lifetime logging | ● Provided — hash-chained, independently verifiable |
| 12(2)(a) | Risk-relevant events | ● Provided — fail-closed risk ladder; refusals recorded |
| 12(2)(b)(c) | Post-market and operational monitoring | ● Provided |
| 12(3) | Biometric logging | ✕ Not supported |
| 14(1) | Oversight interface | ● Provided |
| 14(3)(a) | Provider-built oversight measures | ● Provided — kernel-enforced, not model-requested |
| 14(4)(a) | Understand and monitor | ● Provided |
| 14(4)(b) | Automation-bias awareness | ◐ Partial — mandatory reasons; training is organisational |
| 14(4)(c) | Interpret outputs | ● Provided — hash-addressed evidence |
| 14(4)(d) | Decline or override | ● Provided — default-refuse, verified end-to-end |
| 14(4)(e) | Intervene / stop | ● Provided — global Stop All, ledgered |
| 14(5) | Two-person biometric verification | ✕ Not supported — see Gap 1 |
| 26(1) | Use per instructions | ● Provided — enforced allowlists and scopes |
| 26(2) | Competent overseers with authority | ◐ **Partial — no natural-person attribution (Gap 1)** |
| 26(3) | Input data relevance | ○ Not addressed |
| 26(5) | Monitor, suspend, report | ◐ Partial — suspension provided; reporting organisational |
| 26(6) | Six-month log retention | ◐ Partial — append-only, but no enforced policy |
| 26(9) | DPIA support | ● Supports |
| 26(12) | Cooperate with authorities | ● Supports — vendor-independent verification |

**The strongest claim available today**, and it is unusual: an authority or
auditor can verify this system's records **without trusting the vendor's
software** — the format is canonical, the verifiers share no code with the
kernel, and reproducibility has been demonstrated from a second language.

**The most important thing to fix before selling into a regulated pilot** is
Gap 1. Until approvals carry a natural-person identity, Art. 26(2) can be
argued but not demonstrated.

---

*Prepared as an engineering mapping against commit `4d4b4e7`. Not legal advice.
Verify against the current source before relying on any claim herein.*

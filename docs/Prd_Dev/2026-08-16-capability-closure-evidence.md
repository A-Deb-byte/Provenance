# Capability Closure — 2026-08-16

Branch: `codex/production-desktop-release-v1`

A working session that closed six of seven named capability gaps, plus the agent
fleet built earlier the same day. This is a factual record: every result below
was observed, and the two things that were not done say why.

---

## What was closed

| # | Gap | Outcome | Commit |
| --- | --- | --- | --- |
| 1 | No connector integrations | Connector worker implemented; adapters still deployment-supplied | `07968a1` |
| 2 | Command execution is 4 fixed strings | Operator-configurable allowlist, still an allowlist | `07968a1` |
| 5 | Planner vocabulary is 2 actions | Full browser + connector + desktop-discovery vocabulary | `f447b72` |
| 7 | No external anchoring | Anchor records and verification; witness still unconnected | `f447b72` |
| 3 | Desktop UIA never drove a real app | Notepad driven end to end, 5/5 runs | `6ce339d` |
| — | Agent fleet | Foundation → execution → orchestrator → proposal loop → model planner | `974fab0`…`c00ea79` |

Test totals moved from **739 across 103 files** to **800 across 108 files**, plus
**70 Rust tests**.

---

## What was not closed, and why

### Gap 4 — signed installer: **cannot be done here**

Requires a purchased Authenticode certificate tied to a verified identity. No
code substitutes for it. Azure Trusted Signing (~$10/month) is the cheapest
route; the release pipeline already accepts it. This is a procurement step, not
an engineering one.

### Gap 2 — "not a general shell": **deliberately not done as stated**

The request was to remove the four-command limit. Only the *hardcoding* was
removed. An arbitrary shell inside a capability runtime voids the containment
claim the rest of the system rests on, so the allowlist remains an allowlist:
exact `command`+`args` pairs, no globbing, shell metacharacters rejected rather
than sanitised.

If arbitrary execution is ever wanted, it should be an explicit recorded
decision, not a configuration default drifted into.

### Gap 6 — replay coverage: **remaining**

`replay-ledger.mjs` still covers capability policy and grant consumption only.
Budget reservation, scheduler leasing, memory promotion, and skill promotion are
recorded but not independently re-derivable.

---

## Findings that came out of the work

These were discovered by running things, not by reading code, and each one
changes what an operator should expect.

### A Windows 11 Store app cannot be allowlisted by its System32 path

`System32\notepad.exe` is a launcher stub. The window is owned by a different
process under `WindowsApps`, so an allowlist naming the System32 path produces
**silent non-discovery** — no error, just nothing found, indefinitely.

The first live test run failed exactly this way. Full detail and the diagnostic
command: [`../desktop-automation-field-notes.md`](../desktop-automation-field-notes.md).

### A live application races every revision-pinned call

A modern app re-renders continuously, so `treeRevision` goes stale between any
two calls. Retrying the failed step does not converge; a client must retry the
whole `discover → inspect → act` sequence. Three consecutive test iterations
failed at three different steps before this was understood.

The contract is correct — refusing a stale revision is what stops an action
landing on a changed window. The cost is that clients must be written for it.

### Typed desktop content cannot be read back

`ControlNode` exposes the UIA **Name** property, not control text. Applications
keep editable text behind Value/Text patterns the broker does not serialize.

An early version of the live test grepped the tree for the typed payload and
passed **1 run in 3** — the text was surfacing in a node name by accident. That
assertion was removed rather than retried into looking dependable. A desktop
mutation is currently *fire and verify externally*.

### The proposal path was unreachable when first written

The deterministic planner only ever produced `browser.inspect` (L0), so no
action could exceed a ceiling and `requiresProposal` was dead code. Every unit
test passed because they called it directly with hand-built actions. Adding
`targetAction` made the path reachable. Found by an integration test, not review.

### Two fleet defects found by testing

Spawn targets were not persisted, so every agent completed instantly with
nothing to do. And `runAgentStep` planned before checking status, so a **revoked
agent would have been marked completed** — silently erasing the revocation.

---

## Checks that were not merely asserted

| Claim | How it was verified |
| --- | --- |
| Canonical ledger hashing is portable | An independent Python verifier (`json`, `sort_keys=True`, zero shared code) reproduced every hash of a kernel-produced chain, and **failed** on the pre-change chain |
| Desktop UIA drives a real third-party app | 5 consecutive passes against Notepad; skipped-not-passed without `PROVENANCE_LIVE_DESKTOP=1` |
| The startup gate catches the defect it exists for | Run against the pre-fix binary before the fix was written; failed with the exact panic |
| The fleet authority boundary holds | Integration tests against a real `createKernelService`, including Stop All blocking spawns and fleet events not breaking the hash chain |

---

## Unreachable checks, retained and labelled

Three defensive checks are kept in the code but cannot be driven through the
authorized path, and are documented as such rather than given tests that
manufacture their own preconditions:

- **Connector worker scope checks** — `isActionIntent` rejects a scope-mismatched
  intent before a grant can be minted, and an authorization cannot be forged.
- **Proposal re-derivation binding** — spawn targets cannot drift through any
  API today; the check guards a future planner or state corruption.
- **`minimumRiskForAction` runtime default** — TypeScript exhaustiveness covers
  it, and `isActionIntent` guards the runtime path.

Each is retained because a future caller constructing intents differently would
otherwise be unchecked.

---

## Honest position after this session

The engineering gap list is nearly empty. What has not changed is that **no one
outside this machine has used any of it.** Every capability closed here is a
hypothesis about what someone will pay for, and all of them remain unfalsified.

The remaining blockers are external rather than architectural: a code-signing
certificate, an anchoring witness, at least one connector adapter with real
credentials, an independent security review, and a pilot operator.

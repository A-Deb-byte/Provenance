# Decision Replay

- Updated: 2026-07-26
- Status: implemented with standalone replay tests and an operational kernel-to-ledger gate
- Boundary: capability policy and grant-consumption decisions only

## Purpose

`scripts/verify-ledger.mjs` authenticates the JSONL hash chain. It proves that
the retained events have not changed, but it does not prove that an
authorization decision was correct.

`scripts/replay-ledger.mjs` is a separate implementation of the capability
policy and grant-consumption rules. It first verifies the event chain, validates
the decision-evidence schema, reconstructs the policy-relevant relations, and
compares its result with the exact recorded outcome. It intentionally imports
no project code from `src/`.

## Evidence Contract

`src/capabilities/decisionRecord.ts` emits schema-2 semantic commitments for:

- policy decisions, including approval-required and denied outcomes;
- grant consumption before worker dispatch;
- the policy and grant-policy versions used for that decision;
- the injected decision time and operation count;
- the exact recorded reason code, risk level, grant status, usage, and
  consumption time;
- the intent-to-approval authority binding; and
- policy-relevant equality, containment, prefix, basename, and presence
  relations.

The record does not copy the live intent, worker, grant, raw URL, selector,
local path, connector resource, typed payload, or observation identifier into
the ledger. URLs retain one-way commitments to the exact URL and origin plus
whether credentials were present. Paths and resource identifiers use one-way
commitments sufficient for the relations the policy evaluates.

These commitments reduce disclosure; they do not make low-entropy identifiers
impossible to guess. Audit exports remain sensitive integrity evidence and need
access control and retention limits.

Every record carries a canonical `inputsHash`. The replayer also checks the
surrounding event history, including:

- exact event/entity/grant/intent/status binding;
- approval request, decision, authority binding, and ordering;
- one-use grant consumption;
- policy and grant-policy version support;
- strict decision timestamps and outcome fields; and
- rejection of legacy authorization events without replay evidence.

Unknown schemas or policy versions fail closed. Historical authorization events
cannot be backfilled because their original decision inputs were not retained.

## Commands

Replay a retained candidate runtime:

```powershell
npm run replay-ledger -- --strict <populated-decision-runtime>
```

The default already requires at least one replayable decision and rejects
legacy outcome-only authorization events. `--strict` additionally converts
warnings into failures. `--allow-empty` is an inspection-only escape hatch for
pre-rollout ledgers and is never a release gate.

Run the operational source gate:

```powershell
npm run replay-ledger:gate
```

That command creates an isolated runtime, drives approvals, persisted grants,
successful desktop dispatches, and an uncertain outcome through the real
kernel and deterministic desktop worker harness, then invokes the independent
CLI with `--strict` before deleting the temporary state. It fails unless the
ledger contains replayable schema-2 decisions, zero outcome-only authorization
events, zero divergences, and zero warnings.

Both Windows workflows run this operational gate. Unit and adversarial tests
remain separate so malformed schemas, forged outcomes, approval mismatches,
legacy records, and privacy regressions fail during ordinary test execution.

## Release Evidence

For an immutable candidate, retain:

- command and exit status;
- candidate commit SHA and workflow URL;
- event and replayed-decision counts from the operational gate;
- policy versions present in the retained decision records; and
- the separate strict hash-chain verification result for the archived runtime.

Do not treat an empty historical ledger, a unit-test fixture alone, or a replay
from a different commit as candidate evidence.

## Limitations

- Replay currently covers capability policy and grant consumption, not every
  budget reservation, scheduler lease, memory promotion, or skill decision.
- The event chain has no external transparency-log anchor. A party able to
  replace the complete ledger and every retained head reference is outside this
  local integrity claim.
- Replay establishes that recorded inputs imply the recorded authorization
  outcome. It does not establish that an external worker side effect happened
  exactly as reported.
- Independent security review remains pending; repository tests cannot provide
  auditor or pilot-owner acceptance.

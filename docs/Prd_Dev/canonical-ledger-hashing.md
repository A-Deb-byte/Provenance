# Canonical Ledger Hashing

- Updated: 2026-08-01
- Status: implemented, cross-language verified, ledger reset
- Scope: the event chain digest only; decision-record hashing was already canonical

## The defect

`hashKernelEvent` digested each event with `JSON.stringify`, which emits keys in
**property-insertion order**. The resulting hash was therefore a function of how
the object happened to be constructed, not of its value.

That is reproducible inside one V8 process and nowhere else. It directly
contradicted the stated purpose of `scripts/verify-ledger.mjs`, whose own header
describes it as "the reference for a future Rust/other-runtime verifier": any
verifier written in a language whose JSON serializer sorts keys — Rust's
`BTreeMap`, Python's `sort_keys=True`, Go's `encoding/json` for maps — would
have failed on the first event.

The variable holding the serialized form was even named `canonical` while being
the non-canonical one.

This was the last gap between the project's portability claim and reality.
Decision records already hashed canonically via `stableSha256`; only the chain
carrying them did not.

## The fix

`src/kernel/ledger.ts` now hashes with `stableJson` (key-sorted), through a
deliberate JSON round-trip:

```ts
const canonical = stableJson(JSON.parse(JSON.stringify(event)) as unknown);
return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
```

**The round-trip is not redundant.** The writer holds live objects; every
verifier only ever sees `JSON.parse` output. Those are different value domains,
and hashing them differently would desynchronize the chain:

| Value in a payload | `JSON.stringify` writes | `stableJson` on the live object |
| --- | --- | --- |
| `Date` | ISO string | `{}` — no own enumerable keys |
| `NaN` / `Infinity` | `null` | throws |

Normalizing first makes the digest a function of the **persisted bytes' value**,
which is precisely what an independent verifier can reproduce. Pinned by
`hashes the persisted value, so JSON-lossy inputs cannot desynchronize the chain`.

## Changes

| File | Change |
| --- | --- |
| `src/kernel/ledger.ts` | Canonical hashing; imports `stableJson`; misleading `canonical` naming now accurate |
| `scripts/verify-ledger.mjs` | Own key-sorted `canonicalJson`, reimplemented rather than imported |
| `scripts/replay-ledger.mjs` | Chain digest switched to its existing `canonicalHash` |
| `src/kernel/ledger.test.ts` | +3 tests |
| `scripts/verify-ledger.test.ts` | Fixture now uses `hashKernelEvent` |
| `scripts/replay-ledger.test.ts` | Fixture builder now uses `hashKernelEvent` |

Both standalone verifiers keep their own implementations. A verifier that
imports the code it verifies proves less; that discipline is the point.

Test fixtures went the opposite way — they now call the kernel's real
`hashKernelEvent`, so a fixture can never encode a format the kernel no longer
produces. The `verify-ledger.test.ts` fixture failed on the first run after the
change, which is exactly the drift this is meant to surface.

## Cross-language verification

The claim was tested rather than asserted. An independent verifier in **Python**
— different language, different JSON library, `sort_keys=True`, zero shared code
— was run against a ledger produced by the real kernel:

```
PYTHON VERIFIER OK: 5 events, head 291a655d2f649bae...
```

The same Python verifier against the archived **pre-change** ledger:

```
FAIL: hash mismatch at event 1
  stored   a8d1487cd1870f73410afd921431de8d66eb6d0512b371414eb6984d52f46d36
  computed 4c413938f7f02ffc6152c881a68b3d181ec0f2fc642ff7f9197679f8cb5f59f0
PYTHON_EXIT_OLD=1
```

Before: unverifiable outside Node. After: verifiable from any language that can
sort keys and compute SHA-256. That before/after pair is the evidence that the
change did what it claims.

## Ledger reset

The format change invalidates every previously written event, so the chain was
reset rather than migrated. **Archived, not deleted** —
`.agent-kernel/pre-canonical-hash-20260801/`:

- `events.jsonl` (282 events, old format)
- `state.json`, `state.authenticated.json` (snapshots referencing the old head)
- `capability-grants.json`
- `runtime-owner.json` (stale lock, pid 22340 from 2026-07-29)

Preserved untouched: `models/`, `vault/`, `artifacts/`, `browser-profile/`,
logs, and `users.json.pilotbak-20260720175826`.

No process held the runtime lock at reset time; this was checked first.

The archived events are historical pilot evidence only. They **cannot** be
verified by the current verifier and must not be presented as release evidence.

## Verification

| Check | Result |
| --- | --- |
| `npm run lint` | clean |
| `npm test` | **681 passed across 99 files** |
| `npm run verify-ledger` (fresh runtime) | 0 events, exit 0 |
| `npm run replay-ledger:gate` | **92 events, 8 decisions replayed, 0 outcome-only, 11 acceptance checks** |
| Independent Python verifier, kernel-produced chain | **5/5 events, head matched** |
| Independent Python verifier, pre-change chain | **failed at event 1, as expected** |

## Known gaps

- **No format version marker on events.** This reset was a clean break, so none
  was needed. A *future* format change would hit the same wall. Add a
  `hashVersion` field and have verifiers dispatch on it before the next change —
  deliberately not done here to avoid widening the event schema beyond the
  requested scope.
- **Non-ASCII escaping is untested across runtimes.** `stableJson` uses
  `JSON.stringify` for strings (JS escaping); Python matched with
  `ensure_ascii=False`. A Rust verifier should be checked against non-ASCII
  payloads before the portability claim is made unconditionally.
- **`src/diagnostics/supportBundle.ts:521` still hashes with `JSON.stringify`.**
  Out of scope here and self-consistent within the app, but it carries the same
  portability limitation if a third party is ever asked to verify a support
  bundle.
- External transparency-log anchoring remains open. Canonical hashing makes the
  chain portable; it does not stop a party with full write access from rewriting
  it from genesis.

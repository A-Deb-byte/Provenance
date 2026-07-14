# Browser Text Entry And Form Submission Record

Date: 2026-07-13
Status: Implemented and verified
Parent: `docs/superpowers/CURRENT_STATE.md`

> Historical slice: the subsequent trust-boundary hardening raised every browser write to a minimum L2 risk, added approval continuation and pre-dispatch grant consumption, and rechecked redirected/final origins. See `2026-07-13-trust-boundary-hardening-record.md`.

Adds `browser.type` (form text entry) to the write-capable browser worker, completing the primitive set for form filling: navigate → type → click (submit).

## Design: hash-addressed payloads

The core safety requirement was that untrusted page content must never be able to inject keystrokes. This is enforced by a hash-addressed artifact store:

- `src/kernel/artifacts/artifactStore.ts` — a file-backed store (`.agent-kernel/artifacts/`) where each staged payload is addressed by id and a sha256 content hash. `resolve()` re-verifies the stored hash so a tampered file cannot smuggle content. Metadata (id/hash/length) is listable; content is never returned in listings.
- A `browser.type` ActionIntent carries `payloadArtifactId` + `payloadHash`, not inline text. The worker resolves the artifact and refuses unless `resolved.contentHash === action.payloadHash`. So an intent can only cause a *known, pre-staged* value to be typed.
- `kernel.createArtifact` ledgers an `artifact.created` event with the hash (never the raw content); `POST/GET /api/kernel/artifacts` expose staging and listing.

## Worker + driver

- `createBrowserWorker(driver, artifactResolver)` handles `browser.type`: origin recheck, artifact resolution, hash verification, then a driver `fill`. The hardened driver rejects redirected origins before typing and rechecks the final origin afterward. The typed value is never echoed into the summary/observation - only its character count and target selector.
- The Playwright driver gained `fill(selector, value)`; the write-worker registration scope now includes `browser.type`.
- Form submission is the composition of `browser.type` (fill fields) plus `browser.click` (submit). Each action is minimum L2, explicitly approved, scoped, and ledgered.

## Verification

- `npm run lint` clean; `npm test` **242 tests across 51 files**; `npm run build` clean. This is the recorded pre-hardening baseline, not the final post-hardening total.
- New tests: artifact store (create/resolve/hash/list, tampered-file rejection, malformed id); browser worker type path (hash match types the value, hash mismatch and missing-artifact and no-store all refused, typed value never in summary); kernel `createArtifact` ledgers the hash and refuses without a store.
- **Live**: the real Playwright driver typed a staged value into a form field and the page reflected `FIELD:provenance-demo-value`, proving end-to-end text entry against a real browser.

## Still out

Browser file downloads, desktop automation, and OAuth connectors remain unbuilt. Navigation, clicking, typing, and downloads now have an approval-gated L2 minimum; origin drift is rejected before and after browser actions.

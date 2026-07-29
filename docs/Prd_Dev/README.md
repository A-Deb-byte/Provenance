# Prd_Dev - Product and Development Records

Working documentation for Provenance: what was done, how to reproduce it, and what was actually verified versus merely claimed.

These documents follow the same discipline as the rest of the repository: **state only what was observed, and label everything else as pending, blocked, or unverified.** Dated session records are historical evidence, not current release status. The current acceptance contract is the external audit and pilot runbook.

## Contents

| Document | Purpose |
| --- | --- |
| [`external-security-audit-and-pilot-runbook.md`](./external-security-audit-and-pilot-runbook.md) | **Current release acceptance contract.** Threat model, exact source/CI/installed-binary gates, evidence handling, incident/rollback criteria, bounded pilot plan, and independent sign-off fields. External audit and pilot acceptance remain pending until those parties perform and sign them. |
| [`HANDOFF.md`](./HANDOFF.md) | Current release-hardening handoff and concise list of implemented controls, verification rules, and pending external obligations. It is not a candidate verdict. |
| [`2026-07-27-final-local-evidence.md`](./2026-07-27-final-local-evidence.md) | Current mutable local TypeScript, release-contract, dependency-audit, and license-complete installed-pilot evidence. Remote/protected/external gates remain pending. |
| [`2026-07-29-ordinary-ci-repair.md`](./2026-07-29-ordinary-ci-repair.md) | Ordinary Windows CI failure analysis and the narrow, locally rechecked repair. A new exact-SHA remote run remains required. |
| [`2026-07-26-release-hardening-evidence.md`](./2026-07-26-release-hardening-evidence.md) | Current local source, Rust, replay, development-native, exact installed unsigned-pilot, cleanup, and pending-gate evidence. |
| [`2026-07-22-release-hardening-evidence.md`](./2026-07-22-release-hardening-evidence.md) | Historical local test, authenticated native, installed pilot, uninstall-defect, and pending-gate evidence from that date. It is not evidence for the current candidate. |
| [`decision-replay.md`](./decision-replay.md) | Raw-value-omitting capability decision records, the separately implemented replayer, and the operational real-kernel persisted-ledger gate. Low-entropy commitments remain guessable and the local ledger has no external non-repudiation anchor. |
| [`installer-and-startup-verification.md`](./installer-and-startup-verification.md) | Historical startup defects, original liveness smoke, and first unsigned pilot installer. The current gate is authenticated and identity-isolated; see the runbook. |
| [`native-host-startup-defect.md`](./native-host-startup-defect.md) | Original diagnosis of the first startup defect, retained as a defect record. |
| [`2026-07-20-session-record.md`](./2026-07-20-session-record.md) | Chronological record of the 2026-07-20 licensing, packaging, live browser pilot, toolchain, and multi-user work. |
| [`windows-native-build-runbook.md`](./windows-native-build-runbook.md) | Windows Rust/Tauri prerequisites, build commands, authenticated development smoke, and isolated pilot guidance. |
| [`pilot-and-verification-evidence.md`](./pilot-and-verification-evidence.md) | Timestamped browser and access-control pilot evidence. It predates authenticated native acceptance and is not an external pilot. |
| [`licensing-decision.md`](./licensing-decision.md) | BUSL-1.1 decision, application/runtime packaging contract, and open legal questions. |

## Related records

- `docs/superpowers/CURRENT_STATE.md` - capability matrix and boundaries.
- `docs/provenance-technical-analysis.md` - current source-anchored technical analysis and release posture.
- `docs/superpowers/plans/` - dated implementation records for each milestone.

## Release status rule

The repository now defines isolated development, pilot, and production identities and an authenticated native acceptance proof bound to the nonce, compiled identifier, Tauri version, resource-manifest digest, and process identities. The gate also requires real login/session/protected-read checks, monitor startup, exact-origin navigation, a one-use Rust-owned frontend mount challenge, authenticated graceful shutdown, and attested Node-pid cleanup. That implementation is not, by itself, a green candidate. The production guard's caller-provided CI markers are safety interlocks, not authenticated GitHub provenance. Record the current TypeScript/Rust/replay results and workflow URLs for the exact commit under review; do not reuse historical test totals. A signed installer is not accepted until the protected workflow exercises the exact installed binary and the independent security auditor and pilot owner sign the runbook. Rotate the previously exposed provider credential before pilot or release without recording either the old or replacement value.

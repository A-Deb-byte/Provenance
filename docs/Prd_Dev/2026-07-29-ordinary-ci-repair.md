# Ordinary Windows CI Repair - 2026-07-29

## Scope

This note records a failed ordinary Windows CI attempt, the narrow source-test
repair that followed, and its ordinary remote CI result. It is not evidence of a
protected production release, an independent audit, or an external pilot.

## Observed Failure

Native desktop verification run 14 for commit
`ed035bc23536513f1e2cadcb24c4f537f938e152` failed in the TypeScript test step.
The public run and check annotations identified two test-only failures:

- `authenticatedStatic.test.ts` compared a temporary root's original Windows
  spelling with `loadAuthenticatedStaticResources`' canonical `realpath`
  result. On the hosted runner, the input used an 8.3-style user directory and
  `realpath` returned the long path. The resource loader itself had already
  correctly canonicalized both its root and resource paths.
- The positive unsigned-payload test reached its explicit 30-second Vitest
  deadline while it copied, hashed, and Authenticode-validated the full pinned
  Node runtime. The bounded production validator did not report a validation
  failure.

## Repair

- The static-resource test now compares against the canonical expected
  `realpath`, matching the loader's documented security identity.
- The full-runtime positive test has an explicit 90-second budget for both the
  child process and the test. This preserves all payload, hash, and
  Authenticode checks; it only accommodates the real signed runtime work on a
  shared Windows runner.

## Local Recheck

The repair working tree passed:

| Gate | Result |
| --- | --- |
| Focused CI regression suites | 18 tests across 2 files passed. |
| TypeScript | `npm test` passed 635 tests across 96 files. |
| TypeScript compile | `npm run lint` (`tsc --noEmit`) passed. |

## Same-SHA Ordinary CI Result

Repair commit `ca482a47edbf9653e9bee85be2b83dc1e42414a6` passed ordinary
[Native desktop verification run 15](https://github.com/A-Deb-byte/Provenance/actions/runs/30418134217).
The Windows job passed TypeScript lint and tests, release-policy tests,
deterministic acceptance, the packaged-server smoke, dependency audits, Rust
format/test/check/Clippy gates, native build, and native-host startup smoke.

This establishes ordinary CI evidence for the repair commit. The protected
signing workflow, credential rotation, independent review, and external pilot
remain separate release gates.

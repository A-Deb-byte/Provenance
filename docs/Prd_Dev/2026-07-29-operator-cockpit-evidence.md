# Operator Cockpit Local Evidence

Date: 2026-07-29

## Scope

This record covers the responsive Provenance dashboard and its authenticated Live Operations projection. It is local working-tree evidence for the TypeScript application and built browser surface. It is not evidence of a signed installer, a protected release run, a representative third-party desktop pilot, or an independent security audit.

The completed slice adds:

- a responsive Overview, workspace navigation, conversation drawer, and operations drawer;
- authenticated current work for tasks, mission actions, provider calls, recurring occurrences, and recovery;
- goal budgets, Stop All, approvals, browser/desktop/connector evidence, workers, providers, and a canonical activity timeline;
- bounded display fields with deterministic redaction for recognized credential shapes, while structurally omitting arbitrary event payloads, prompts, typed content, observations, command output, authority-owned credential fields, and private model reasoning;
- an authenticated-state cache invalidated by kernel ledger mutations plus a bounded hash-verified ledger suffix;
- authentication-epoch fencing for chat and Research Lab workflows, protected presentation-state isolation, and duplicate candidate-submission prevention;
- Stop/Resume-bound drafts, a priority Stop All request lane, pending-first approvals, and approved-but-not-executed truthfulness.

## Automated Gates

| Gate | Result |
| --- | --- |
| `npm run lint` | Passed. |
| `npm test` | Passed **668 tests across 99 files**. |
| `npm run build` | Passed; Vite web assets, `dist/server.cjs`, and JavaScript third-party notices were produced. |
| Observatory/API/provider focused set | Passed 30 tests. |
| Affected kernel lifecycle/integrity set | Passed 65 tests. |
| Agent Observatory component | Passed 10 tests. |
| App and persistence focused set | Passed 17 tests. |
| DesktopPanel timing regression | The five-test file passed in five fresh processes: **25/25 test executions**. |
| `git diff --check` | Passed; only Git's existing LF-to-CRLF notices were emitted. |

The serial Vitest worker now has an explicit 8 GiB heap ceiling. This prevents a late jsdom worker recycle from leaving the next file unassigned; it does not reserve that memory up front. Auth-race tests resolve their deferred status requests, and the DesktopPanel regression waits for asynchronous worker/goal authority before typing into an intentionally disabled control.

## Browser Evidence

The production build was started from `dist/server.cjs` against a fresh isolated runtime in operator-token mode. The browser then used the real authentication panel and protected observatory API.

Verified at `1600 x 1000` and `390 x 844`:

- desktop three-column layout and mobile single-column layout;
- real goal, budget, current-work, worker, provider, and evidence data;
- browser, desktop, and connector empty-state truthfulness;
- protected data absent before authentication and present after token verification;
- Live Operations and conversation navigation as modal drawers on mobile;
- close-control focus on open, Escape dismissal, inert background, and trigger-focus restoration;
- workspace-tab touch scrolling without exposed native scrollbar chrome;
- no warning or error entries originating from the packaged production page.

The surface deliberately reports recorded execution evidence rather than simulating a live browser frame, desktop video, cursor, or hidden chain of thought.

Operator-authored objectives, descriptions, and audit reasons remain visible in bounded, redacted form because they are operational context. They are not a credential-storage surface, and an unrecognized secret format placed in those fields is outside the redaction guarantee.

## Remaining External Gates

- same-SHA remote CI for the final commit;
- the protected signing workflow and real production credentials;
- signed installer and hosted updater publication;
- representative-machine installer, update, and third-party UI Automation pilots;
- independent external security and privacy review;
- rotation of any provider credential previously exposed outside the server-side vault.

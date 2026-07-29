# Provenance Operator Cockpit

## Purpose

The operator cockpit is an authenticated observation and control surface for the trusted kernel. It answers four questions without granting authority to the browser:

1. What work is queued, running, blocked, or waiting for approval?
2. Which browser, desktop, connector, provider, or mission target was recorded?
3. What evidence did the kernel append?
4. Which exact operator decision or global control is required?

The cockpit does not display private model reasoning. It reports operational phases, policy reasons, targets, state transitions, budgets, and evidence summaries.

## Layout

- **Overview** is the default workspace. It contains authentication, kernel, runtime, provider, and learning detail panels.
- **Agent Chat** is a focused conversation workspace. New assistant messages show the provider, model, and kernel evidence event returned by the application AI gateway. Locally retained response metadata is labeled as a presentation record rather than server-verified evidence.
- **Missions**, **Schedules**, and **Desktop** retain their existing server-authoritative workflows.
- **Knowledge** contains the read-only promoted-memory and framework lens that previously occupied the permanent right rail.
- **Dialogue Map** and **Research Lab** preserve the local conversation presentation tools.
- **Live Operations** is a persistent inspector on wide screens and an overlay drawer on smaller screens.

The shell uses the viewport height rather than a fixed `1400 x 768` canvas. Navigation scrolls horizontally when needed, the conversation rail becomes a drawer below the large breakpoint, and the operations inspector remains a drawer until the `2xl` breakpoint so a 1280-pixel viewport is not squeezed between two rails. Drawers move focus to their close control, contain keyboard focus, close on Escape, make the background inert, and restore focus to the opening control.

## Observatory Contract

`GET /api/kernel/observatory` returns schema version 1. The route is mounted behind the shared `/api` access guard and sets `Cache-Control: no-store`.

The kernel constructs one internally consistent projection from a last-authenticated state snapshot, a bounded hash-verified ledger tail committed to that state head, current runtime-controller ownership, the worker registry, and public provider status. The authenticated state snapshot is cached for passive polling and invalidated whenever the kernel appends authority or evidence. Each poll rereads only the bounded ledger suffix against that cached head, so an unchanged dashboard does not repeatedly scan the full ledger while holding the mutation queue. The response contains:

- generation time and ledger head;
- global Stop All state and its recorded reason;
- aggregate goal, task, approval, automation, and event counts;
- bounded goal and task summaries with budgets and usage;
- a bounded actionable approval queue that prioritizes pending decisions before approved authority still waiting for separate execution;
- current work derived from task state, mission active steps, live runtime-controller ownership, recurring occurrence ownership, recovery state, and the actionable approval queue;
- the most recent 100 sanitized activities;
- worker availability and provider/model availability.

The projection deliberately omits:

- provider prompts and responses;
- private model reasoning;
- typed payload contents and payload artifact identifiers;
- credentials, tokens, cookies, and vault data;
- raw browser page or desktop tree content;
- raw command stdout and stderr;
- arbitrary ledger payload fields.

Operator-authored objectives, task descriptions, approval reasons, and Stop All reasons remain useful only if the operator can read them, so the projection returns them in bounded, redacted form. They are not a secret-storage surface. Activity summaries come only from bounded summary, evidence-summary, and policy-reason fields or from a safe event-type label. Canonical ledger order, not wall-clock sorting, determines timeline order. Browser targets are joined from the kernel-owned automation contract or research source record only for actual execution evidence. Desktop targets contain application, window, and node identifiers, not a screenshot. Historical start events are not reported as live unless current runtime metadata still owns them.

## Refresh Model

The React inspector polls the aggregate endpoint every 5 seconds through `authenticatedFetch`.

- No protected observatory request is made until dashboard access is available.
- Requests do not overlap.
- A transient failure retains the last valid projection and marks it stale.
- A `401` clears protected projection data and suspends polling until authentication changes or the operator explicitly retries.
- An authentication change clears control and approval drafts, aborts and fences old requests, invalidates the current projection, and triggers an authorized refresh.
- Unmount aborts the active request and clears the timer.

This is near-live recorded state, not a streaming video or token-by-token trace. A future authenticated fetch-stream may reduce latency, but it must preserve bearer authentication, bounded replay, backpressure, and the same redaction contract.

## Operator Controls

### Stop All and Resume

The inspector calls the existing kernel endpoints:

- `POST /api/kernel/controls/stop-all`
- `POST /api/kernel/controls/resume`

Both require a non-empty audit reason. A draft is bound to the Stop or Resume transition that was visible when the operator started typing and is cleared if another actor changes that state. Stop All has an independent priority request path and cannot be disabled behind an approval decision. The UI does not optimistically change execution state; it waits for the server response and a refreshed projection. Viewer sessions are read-only.

### Approval Inbox

Each pending approval shows:

- a human-readable action summary;
- the exact authority-bound request string;
- risk level and policy reason;
- the recorded browser, desktop, or connector target when available;
- a required operator audit reason.

Approve and Deny call only:

`POST /api/kernel/approvals/:approvalId/decision`

Recording an approval does not dispatch an automation. A later kernel-governed run must match and consume the approved authority before one-use capability dispatch.

An approved record therefore stays visible as **Approved, not executed**. It has no second decision controls and remains in current work until the owning workflow separately executes or otherwise resolves it.

## Browser And Desktop Truth Boundary

The current browser worker records actions, target URLs/selectors, status, and sanitized evidence. It does not publish a live viewport or screenshot to the dashboard.

The Windows desktop worker records application/window/control identifiers and persists authenticated UI Automation tree evidence for its dedicated cockpit. It does not publish a live screen image.

The Live Operations cards therefore say **Last recorded evidence, not a live video feed**. Empty cards explicitly report that no activity was recorded. The UI must not simulate a cursor, screenshot, browser frame, pause control, or take-control mode without a corresponding kernel contract.

## Tests

Focused coverage verifies:

- redaction and target joining in the pure observatory projection;
- runtime-owned automation/provider derivation without false historical liveness;
- canonical same-timestamp ledger ordering, explicit uncertain outcomes, and execution-only surface cards;
- ledger-head mismatch rejection and authenticated bounded-tail verification;
- the protected aggregate API response;
- truthful browser/desktop empty and recorded states;
- pre-auth request suppression, authentication-epoch fencing, and approved-but-not-executed rendering;
- approval decisions without accidental automation dispatch;
- required Stop All reasons, state-flip protection, and the exact server contract;
- existing mission, schedule, desktop, persistence, and navigation behavior.

The completed July 29 working tree passed the full **668-test TypeScript matrix across 99 files**, TypeScript lint, and the production build. The built `dist/server.cjs` and web assets were also exercised in an isolated operator-token runtime at desktop and mobile breakpoints. The packaged-browser pass covered authenticated loading, real observatory data, both modal drawers, focus restoration, and a clean production console. See [`Prd_Dev/2026-07-29-operator-cockpit-evidence.md`](Prd_Dev/2026-07-29-operator-cockpit-evidence.md).

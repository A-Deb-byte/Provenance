# Pilot And Verification Evidence — 2026-07-20

> **Internal historical self-pilot, not external acceptance.** This run predates isolated native identities, authenticated full-readiness attestation, and installed-signed-binary acceptance. Its later title/process/owner inference is retained as a dated observation but is not acceptable readiness evidence under the current gate, which requires real login/session/protected-read checks, identifier/version-bound HMAC proof, monitor startup, exact-origin frontend mount, authenticated shutdown, and attested Node-pid cleanup. It does not complete the independent security audit or pilot obligations in [`external-security-audit-and-pilot-runbook.md`](./external-security-audit-and-pilot-runbook.md).

All results below were produced against the **production-mode built server bundle** (`node dist/server.cjs`, `NODE_ENV=production`) rather than the development server. This was not an installed native package. Values are timestamped observations, not standing guarantees; re-run the commands to reconfirm.

---

## 1. Runtime capability report at pilot start

Read from `GET /api/kernel/runtime-report`:

| Feature | Status |
| --- | --- |
| `verificationCommands` | available |
| `providerCalls` | available (OpenRouter configured, `openrouter/free`) |
| `coreModel` | available (MiniCPM5-1B weights present) |
| `secretVault` | available (Windows DPAPI) |
| `accessControl` | available |
| `verifiedResearchReports` | available |
| `recurringResearchScheduler` | available |
| `backgroundAutomation` | configured |
| `releaseDeployment` | configured |
| `osSandbox` | unavailable (no container runtime detected this run) |
| `releaseSigning` | unavailable (no verification key configured) |
| `desktopIpc`, `desktopAutomation` | unavailable (native host not running) |

Workers available: `worker.browser.playwright`, `worker.browser.web_inspect`.

The report distinguishing *available* from *configured* from *unavailable* — rather than presenting everything as ready — is the intended behaviour.

---

## 2. Live pilot: L2 approval gate against a real browser

The central claim of the product is that consequential actions stop for human approval and leave verifiable evidence. That was exercised end to end.

| Step | Action | Result |
| --- | --- | --- |
| 1 | Create goal + `browser.navigate` automation, scoped to `https://example.com` (allowlisted origin) | created, `enabled: false` |
| 2 | Enable automation | enabled |
| 3 | **Run 1** | **`decision: approval_required`** — kernel refused to act and persisted an approval request |
| 4 | Record operator approval (`riskLevel: L2`) | approved |
| 5 | **Run 2** | **`dispatch: succeeded`** — real Playwright/Chromium navigated the page |
| 6 | Observation | page text captured (`Example Domain…`), `risk: none` |

Ledger events recorded for the run:

```
capability.grant_consumed   (kernel)
automation.run_started      (kernel)
automation.run_completed    (worker)
system.snapshot_prepared / system.snapshot_committed   (system)
```

Independent verification in the dated run used `npm run verify-ledger` with zero project imports and a populated ledger. Current candidate evidence must use `npm run verify-ledger:strict -- <populated-evidence-runtime>` so a missing or empty ledger cannot pass:

```
Ledger verified: 279 hash-chained events, head 6cc0540149fb6acb...
```

**Also observed:** before authenticating, the dashboard returned `401 — kernel state unavailable`. That is the access guard working, not a fault.

**Not exercised:** desktop UI Automation (requires the native host). No real third-party desktop application has been driven.

---

## 3. Multi-user access control — 10/10

Ten behaviours exercised via the authenticated API. Every observed result matched its expectation.

| # | Behaviour | Expected | Observed |
| --- | --- | --- | --- |
| 1 | Bootstrap first admin **without** operator token | 401 | **401** |
| 2 | Bootstrap **with** operator token | 201, role `admin` | **201, admin, `bootstrap: true`** |
| 3 | Access mode after first account | `multi_user` | **`multi_user`, users 1** |
| 4 | Operator token used once accounts exist | 401 | **401** |
| 5 | Admin login + `session/verify` | success | **200, role admin** |
| 6 | Admin mutation with session | 200 | **200** |
| 7 | Admin creates viewer | role `viewer` | **viewer** |
| 8 | Viewer read / viewer mutate | 200 / 403 | **200 / 403** |
| 9 | **Logout revocation** — reuse old token | 401 | **401** (`session/verify` and mutation); re-login **200** |
| 10 | Delete the **only** admin | 409 | **409** (final-administrator protection) |

Wrong-password login correctly returned **401**.

The two properties that matter most both held:

- **Session revocation is real.** Logout increments a persisted per-user session version, so a still-unexpired signed token is rejected afterwards. Cryptographic expiry alone is not relied upon.
- **Lockout is prevented.** The last administrator cannot be removed.

**Cleanup:** test accounts (`pilot_admin`, `pilot_viewer`) were deleted. A pre-existing local account file was preserved as `.agent-kernel/users.json.pilotbak-20260720175826` rather than destroyed; the deployment returns to operator-token mode on next start.

---

## 4. Native toolchain validation

| Check | Result |
| --- | --- |
| `cargo --version` (after Smart App Control disabled) | runs |
| MSVC linker + Windows SDK present | `14.44.35207`, SDK `10.0.26100.0` |
| `cargo check --all-targets` (MSVC dev env) | **Finished in 8m 21s — 0 errors, 0 warnings** |
| `npm run desktop:build` (MSVC dev env) | **Finished release profile in 14m 43s — 0 errors** |
| Artifact | `src-tauri/target/release/provenance-desktop.exe`, **6,891,008 bytes** |
| Installer bundle | none produced — Tauri bundling deliberately disabled |

| Launch of built binary (2026-07-20, pre-fix) | **FAILED — panicked at startup** (updater plugin config was `null`) |

First successful native build on this workstation; previously this was possible only on the `windows-latest` CI runner.

**Superseded 2026-07-21.** The startup panic and two further startup defects behind it were fixed; see [`installer-and-startup-verification.md`](./installer-and-startup-verification.md) and §6 below.

---

## 5. What this evidence does and does not establish

**Established for that dated run:** the production-mode server bundle enforced the exercised approval and access-control paths, drove a real browser, and produced a hash chain that the standalone verifier accepted. The later native observations in section 6 showed startup progress only; they did not establish authenticated full readiness or installed-package acceptance.

**Does not establish:** that desktop automation has driven a real third-party application; that the system is stable under sustained real-world use; that any signed or distributable installer exists; or that any of it has been independently audited. Those remain open and are tracked in `docs/superpowers/CURRENT_STATE.md`.

---

## 6. Native host startup — 2026-07-21

After the three startup fixes, the release binary was launched directly with a development environment (project root, workspace root, Node executable, and a single-entry `notepad.exe` allowlist), then inspected after 70 seconds.

| Probe | Expected | Observed |
| --- | --- | --- |
| Process alive | yes | **yes** |
| Main window title | `Provenance` (not `Provenance recovery`) | **`Provenance`** |
| Child processes | webview + supervised kernel | **`msedgewebview2.exe`, `node.exe`** |
| `runtime-owner.json` | written and retained | **present** |
| Supervised server | listening | **`[Server] … running on http://localhost:63137`** |

Supervised kernel log from that launch:

```
[Sandbox] Runtime=native-desktop; mode=disabled; commandExecution=unavailable
          (native desktop mode requires a healthy Docker runtime and the configured image)
[Browser] Write-capable Playwright worker registered.
[Desktop] Authenticated Windows UI Automation worker registered.
[Server] Persistent Agent Knowledgebase running on http://localhost:63137
```

At the time, the `Provenance` title, child processes, and retained owner record showed that the host progressed beyond its earlier startup failures. Those observations did not authenticate which initialization stages completed. Under the current contract, title, process, log, and owner-record evidence are diagnostic liveness signals only; they cannot establish full readiness.

**First time the native host has run.** The runtime lock, supervised child, authenticated bridge, and UIA broker had never executed before this date.

**Still not exercised:** desktop UI Automation driving a real third-party application. The worker registers; no automation has been dispatched through it. Sandboxed command execution reports `unavailable` here by design — a container runtime is required, and the pilot build pins a deliberately unresolvable image.

### Startup cost

| Milestone | Elapsed |
| --- | --- |
| dotenv banner | +1.0 s |
| container-runtime probe completes | **+44.9 s** |
| Playwright write worker registered | +47.3 s |
| server listening | **+48.4 s** |

The container-runtime probe dominates and is the reason the readiness budget had to be raised to 120 s. Worth investigating on its own merits — Docker Desktop was running throughout, so ~45 s is unlikely to be inherent.

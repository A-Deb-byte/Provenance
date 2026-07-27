# Session Record — 2026-07-20

> **Historical session record.** This preserves observations from the named date. Current license packaging, native acceptance, workflow, and release status are documented in [`HANDOFF.md`](./HANDOFF.md) and [`external-security-audit-and-pilot-runbook.md`](./external-security-audit-and-pilot-runbook.md); do not promote older test totals or blockers into a current claim.

Branch: `codex/production-desktop-release-v1`
Scope: licensing, production packaging, first live self-pilot, Windows native toolchain unblocking, multi-user access-control verification.

This is a factual record. Every result below was observed directly; anything not observed is marked as pending or blocked.

---

## 1. Licensing

The repository had **no `LICENSE` file**, no `license` field in `package.json`, and five legacy source files carrying `SPDX-License-Identifier: Apache-2.0` headers inherited from the original template.

Changes made:

- Added **`LICENSE`** — Business Source License 1.1. Licensor: Anol Deb Sharma. Non-production use is free; production use requires a commercial license; each version converts to **Apache-2.0 four years** after its first public distribution.
- Set `"license": "BUSL-1.1"` in `package.json`.
- Flipped the five stale Apache headers (`server.ts`, `src/App.tsx`, `src/components/MemoryDashboard.tsx`, `src/lib/demoData.ts`, `src/types.ts`) to `BUSL-1.1` so the whole repository is internally consistent.

Committed as **`c319180`** and pushed to `origin/codex/production-desktop-release-v1` (fast-forward, no conflict with concurrent branch work). Rationale and open questions: [`licensing-decision.md`](./licensing-decision.md).

---

## 2. A fabricated third-party analysis was identified and replaced

An external "technical analysis of Provenance" was reviewed and found to describe **a different system entirely** — an Electron/ASAR launcher wrapper for Claude Desktop, with invented bug IDs, fabricated SHA-256 pins, and non-existent code offsets. Verified against the repository: there is no Electron, ASAR, or Claude Desktop/ChatGPT wrapper. Provenance's actual desktop path is the repository's Tauri/Rust native host around its TypeScript/Express control plane.

It was replaced by `docs/provenance-technical-analysis.md`, in which every mechanism cited is anchored to a real file or module, and limitations are stated explicitly.

---

## 3. Production packaging and the installer attempt

**Built:** `npm run build` → `dist/server.cjs` (3.3 MB self-contained server bundle) plus web assets and third-party notices. Clean.

**Installer: not produced.** `npm run desktop:release:build-unsigned` was attempted and stopped at two independent gates:

1. **Release inputs missing** — the pipeline requires `PROVENANCE_UPDATER_PUBLIC_KEY` and related protected values before it will proceed.
2. **Rust toolchain blocked** — at that time `cargo` returned `An Application Control policy has blocked this file (os error 4551)`.

Gate 2 was subsequently removed during this session (§5). Gate 1 remains: producing an installer still requires real release inputs.

---

## 4. First live self-pilot of the packaged product

The packaged server (`dist/server.cjs`, `NODE_ENV=production`) was run and driven end to end. Full evidence: [`pilot-and-verification-evidence.md`](./pilot-and-verification-evidence.md).

Headline result — the **L2 approval gate worked live against a real browser**:

1. Created a goal and a `browser.navigate` automation scoped to an allowlisted origin.
2. **Run 1 → `approval_required`.** The kernel refused to act and persisted an approval request.
3. An operator approval was recorded.
4. **Run 2 → dispatched** to real Playwright/Chromium, navigated `https://example.com`, captured the page text as an untrusted observation (`risk: none`).
5. The ledger recorded `capability.grant_consumed → automation.run_started → automation.run_completed`, and the independent verifier confirmed **279 hash-chained events, clean**.

Also observed: the dashboard correctly returned **401 / "kernel state unavailable"** before authentication — the access guard behaving as designed, not a defect.

**Not exercised:** desktop UI Automation. It requires the native Rust host, which could not run (§5). No third-party desktop application has been driven to date.

---

## 5. Windows native toolchain — both blockers removed

This machine had been unable to compile the native Rust/Tauri host at all. Two distinct blockers were diagnosed and cleared:

| Blocker | Symptom | Resolution |
| --- | --- | --- |
| Smart App Control | `cargo` → `os error 4551` (Application Control policy) | Disabled by the operator |
| No MSVC toolchain | Link step failed; Rust fell back to **Git's** `usr/bin/link.exe` (a coreutils hardlink tool), with `note: you may need to install Visual Studio build tools with the "C++ build tools" workload` | Installed VS 2022 Build Tools + "Desktop development with C++" (MSVC `14.44.35207`, Windows SDK `10.0.26100.0`) |

**Result:** `cargo check --manifest-path src-tauri/Cargo.toml --all-targets`, run inside the MSVC developer environment, **finished in 8m 21s with 0 errors and 0 warnings.** This is the first successful native validation of the Rust/Tauri host on this workstation; previously only the `windows-latest` CI job could do it.

Reproduction steps: [`windows-native-build-runbook.md`](./windows-native-build-runbook.md).

**Native host binary built.** `npm run desktop:build` completed inside the MSVC developer environment:

```
Finished `release` profile [optimized] target(s) in 14m 43s
Built application at: src-tauri\target\release\provenance-desktop.exe
```

Artifact: `provenance-desktop.exe`, 6,891,008 bytes, 0 errors. No `bundle/` directory was produced — expected, because Tauri bundling is deliberately disabled in this project. `desktop:build` yields the **native host executable, not an installer**.

This is the first time the complete native path — check, compile, and link — has run to completion on this workstation.

**The binary was then launched, and it does not start.** It panics immediately: the updater plugin is registered unconditionally in `src-tauri/src/lib.rs:87`, but `tauri.conf.json` has no `plugins.updater` section (that configuration is injected only by the release pipeline), so the plugin fails to deserialize and the host aborts. Reproducible on any machine, and invisible to CI because no gate launches the produced binary. Full diagnosis and fix options: [`native-host-startup-defect.md`](./native-host-startup-defect.md). No source fix was applied — the change touches release-critical configuration and was left for a deliberate decision.

**Known remaining toolchain gap:** the `rustfmt` component is broken on this toolchain (`rustup component add rustfmt` fixes it). It affects only the formatting gate, not compilation.

---

## 6. Multi-user access control — verified live, 10/10

Ten access-control behaviors were exercised against the packaged production build; all matched their expected outcomes, including the two most security-critical ones: **logout genuinely revokes an unexpired session token**, and **the final administrator cannot be deleted**. Full table: [`pilot-and-verification-evidence.md`](./pilot-and-verification-evidence.md).

Test accounts were removed afterward. A pre-existing local account file was preserved as `.agent-kernel/users.json.pilotbak-20260720175826` rather than deleted.

---

## 7. Honest status after this session

**Proven on this machine:**

- The product builds, runs in production mode, and performs real work.
- The approval-gated capability pipeline functions end to end against a real browser, with verifiable ledger evidence.
- Multi-user authentication, roles, session revocation, and lockout protection all behave correctly.
- The native Rust/Tauri host type-checks, compiles, and **links to a working release binary locally** (`provenance-desktop.exe`, 6.9 MB).

**Still not proven:**

- The native binary has been **built but never launched**; the desktop host, its runtime lock, supervised Node child, authenticated IPC bridge, and UI Automation broker are unexercised at runtime.
- No installer has been produced, published, or installed (bundling is disabled; release inputs are still required).
- No desktop UI Automation has driven a real third-party application.
- No independent security audit, no certifications, no external users, no soak time.

The gap between "engineering complete" and "product shipped" is unchanged in kind, but it is now measurably smaller: the native compilation wall — the largest remaining local obstacle — is down.

# Isolation, Hands, Cross-Platform Vault, And Multi-User Record

Date: 2026-07-13
Status: Implemented and verified
Parent: `docs/superpowers/CURRENT_STATE.md`

This session implemented four of the five remaining boundary items (the Rust/Tauri kernel was explicitly deferred). Environment note: this machine has neither Docker nor Playwright installed, so the sandbox and browser worker were built against injectable interfaces, unit-tested with fakes, and gated to report unavailable/host-fallback here — the same honest pattern as the core model and DPAPI vault. Multi-user and vault-logic are fully tested on this host.

## 1. OS Process Sandbox (Docker)

`src/kernel/sandbox/sandbox.ts` introduces a `SandboxRunner` boundary that the command worker routes execution through:

- `buildDockerRunArgs` (pure, unit-tested) constructs `docker run` with `--network none`, `--read-only` root + tmpfs `/tmp`, bounded `--memory`/`--memory-swap`/`--pids-limit`/`--cpus`, `--cap-drop ALL`, `--security-opt no-new-privileges`, and a workspace-only mount. The logical command (`npm run lint`) is passed unresolved to the container.
- `createHostSandbox` is the honest fallback: it runs on the trusted host with no isolation and says so.
- `detectDockerSandbox` is a real `docker version` probe; the server uses Docker when reachable, else host.
- The runtime report's `osSandbox` feature now reflects the actual runner (available with Docker, unavailable/host otherwise).

The command worker's security checks (token scope, workspace containment, allowlist, capability use) are unchanged; only the final execution was delegated to the sandbox.

## 2. Write-Capable Browser Worker (Playwright)

`src/kernel/workers/browserWorker.ts` adds the first state-changing "hand":

- A `BrowserDriver` interface with a gated Playwright-core-backed implementation (indirect dynamic import, persistent context via `launchPersistentContext` so a logged-in session survives across runs, `isAvailable()` returns true only when a browser engine is installed).
- `createBrowserWorker(driver)` is a `KernelActionWorker` handling `browser.navigate` and `browser.click`, each flowing through the existing ActionIntent → policy → grant → dispatch → untrusted-observation (injection-assessed) → ledger pipeline. Off-origin URLs and unsupported action types are rejected before touching the driver.
- Registered (`worker.browser.playwright`) only when `BROWSER_WRITE_ORIGINS` is set AND the driver is available. Text entry and downloads are intentionally deferred until an artifact store exists to hold typed payloads (so untrusted content cannot inject keystrokes).

## 3. Cross-Platform Vault

Two adapters mirror the DPAPI pattern, selected by `src/vault/index.ts::createPlatformVault`:

- `src/vault/keychain.ts` — macOS Keychain via the `security` CLI (per-name marker file indexes `list()`; documented caveat that `security -w` briefly exposes the value in argv).
- `src/vault/secretService.ts` — Linux Secret Service via `secret-tool` (libsecret), feeding the secret on **stdin** so it never enters argv.
- Both are platform-gated (report unavailable off-target, refuse to store) and share an injectable `VaultCommandRunner` so command construction, name validation, and stdin handling are unit-tested on Windows. Round-trip against the real OS keychain requires running on macOS/Linux.

## 4. Multi-User Access Control

- `src/auth/users.ts` — file-backed user store, scrypt-hashed passwords (salt + derived hash only; atomic 0600 writes), username/password/uniqueness rules, admin/operator/viewer roles.
- `src/auth/session.ts` — stateless signed session tokens (HMAC-SHA256 over claims + expiry); tamper/expiry/wrong-secret all rejected.
- `src/auth/accessControl.ts` — unified guard with precedence multi_user → operator_token → open. Mutations require a role-scoped session (viewers are read-only) when accounts exist; otherwise the shared operator token; otherwise open loopback. Reads stay open.
- `src/auth/api.ts` — `/api/auth` login/logout/status and user management: the first account bootstraps as admin on loopback without auth; subsequent account creation/removal requires an admin session.
- The runtime report's `accessControl` feature reports the active mode honestly.

## Verification

`npm run lint` clean; `npm test` **234 tests across 50 files** passing (was 204/45); `npm run build` clean. New tests: sandbox arg construction + host/docker/detection; browser worker mapping + registration with a fake driver; macOS/Linux vault construction/validation/gating with a fake runner; user store hashing/persistence, session round-trip/expiry/tamper, and the full multi-user HTTP flow (bootstrap → login → role-scoped mutation → viewer denial) over a live express app.

## Live Verification (Docker + Playwright installed)

After Docker Desktop and a Chromium browser were installed, the two runtime-gated features were verified end to end (not just build-and-gated):

- **Sandbox isolation**: a command run through `DockerSandbox` reported `platform: linux` while the host is Windows — proving real container isolation, not host execution.
- **Network isolation**: a DNS lookup inside the container failed with `EAI_AGAIN` under `--network none`.
- **Real verification in-container**: `npm run lint` (tsc) exited 0 inside the container. This surfaced a tuning fix — the initial 512m memory OOM'd tsc, so the default was raised to 2g / 512 pids / 2 cpu.
- **Browser worker**: the Playwright driver (via `playwright-core` + Chromium) navigated to https://example.com and returned the page text through the worker.

Packaging refinements from this pass: the dependency is `playwright-core` (no forced browser download on install; enable with `npx playwright install chromium`); `isAvailable()` now confirms the browser binary exists on disk; and the docker executable path is configurable via `DOCKER_PATH` with its bin directory prepended to PATH so Docker Desktop's credential helper resolves.

## Deferred / Still Out

- Rust/Tauri kernel (explicitly skipped this session).
- Native (non-Docker) sandbox; desktop/connector workers; browser text-entry/downloads; per-user data partitioning and SSO; live validation of the macOS/Linux vault adapters on their platforms.

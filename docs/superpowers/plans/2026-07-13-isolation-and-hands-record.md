# Isolation, Hands, Cross-Platform Vault, And Multi-User Record

Date: 2026-07-13
Status: Implemented and verified
Parent: `docs/superpowers/CURRENT_STATE.md`

> Historical slice: this record describes the implementation state at the time of this pass. Browser L2 approvals, redirect rechecks, dashboard auth, pre-dispatch grants, and staged releases were hardened later in `2026-07-13-trust-boundary-hardening-record.md`.

This session implemented four of the five then-remaining boundary items (the Rust/Tauri kernel was explicitly deferred). Docker and Playwright were initially absent, so the sandbox and browser worker were built against injectable interfaces and unit-tested with fakes. Both runtimes were installed and exercised later in the same session, as recorded under "Live Verification" below.

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
- `createBrowserWorker(driver)` initially handled `browser.navigate` and `browser.click` through the action-intent, policy, grant, dispatch, untrusted-observation, and ledger pipeline. The later hardening makes every browser write at least L2 and rechecks the final origin before and after an action.
- Registered (`worker.browser.playwright`) only when `BROWSER_WRITE_ORIGINS` is set and the driver is available. Text entry was delivered in `2026-07-13-browser-text-entry-record.md`; downloads remain unavailable.

## 3. Cross-Platform Vault

Two adapters mirror the DPAPI pattern, selected by `src/vault/index.ts::createPlatformVault`:

- `src/vault/keychain.ts` — macOS Keychain via the `security` CLI (per-name marker file indexes `list()`; documented caveat that `security -w` briefly exposes the value in argv).
- `src/vault/secretService.ts` — Linux Secret Service via `secret-tool` (libsecret), feeding the secret on **stdin** so it never enters argv.
- Both are platform-gated (report unavailable off-target, refuse to store) and share an injectable `VaultCommandRunner` so command construction, name validation, and stdin handling are unit-tested on Windows. Round-trip against the real OS keychain requires running on macOS/Linux.

## 4. Multi-User Access Control

- `src/auth/users.ts` — file-backed user store, scrypt-hashed passwords (salt + derived hash only; atomic 0600 writes), username/password/uniqueness rules, admin/operator/viewer roles.
- `src/auth/session.ts` — stateless signed session tokens (HMAC-SHA256 over claims + expiry); tamper/expiry/wrong-secret all rejected.
- `src/auth/accessControl.ts` — unified guard with precedence multi_user → operator_token → open. Mutations require a role-scoped session (viewers are read-only) when accounts exist; otherwise the shared operator token; otherwise open loopback. Reads stay open.
- `src/auth/api.ts` - `/api/auth` login/logout/status and user management. The first account becomes an admin; when an operator token is configured, that token is required for bootstrap. Subsequent account creation/removal requires an admin session, and the last admin cannot be removed.
- The runtime report's `accessControl` feature reports the active mode honestly.

## Verification

The full lint, test, and build gates passed for this slice. The later browser-text-entry slice established the **242 tests across 51 files** pre-hardening baseline. New tests in this slice covered sandbox argument construction and detection, browser worker mapping, cross-platform vault command construction, user-store hashing/persistence, session validation, and the multi-user HTTP flow.

## Live Verification (Docker + Playwright installed)

After Docker Desktop and a Chromium browser were installed, the two runtime-gated features were verified end to end (not just build-and-gated):

- **Sandbox isolation**: a command run through `DockerSandbox` reported `platform: linux` while the host is Windows — proving real container isolation, not host execution.
- **Network isolation**: a DNS lookup inside the container failed with `EAI_AGAIN` under `--network none`.
- **Real verification in-container**: `npm run lint` (tsc) exited 0 inside the container. This surfaced a tuning fix — the initial 512m memory OOM'd tsc, so the default was raised to 2g / 512 pids / 2 cpu.
- **Browser worker**: the Playwright driver (via `playwright-core` + Chromium) navigated to https://example.com and returned the page text through the worker.

Packaging refinements from this pass: the dependency is `playwright-core` (no forced browser download on install; enable with `npx playwright install chromium`); `isAvailable()` now confirms the browser binary exists on disk; and the docker executable path is configurable via `DOCKER_PATH` with its bin directory prepended to PATH so Docker Desktop's credential helper resolves.

## Deferred / Still Out

- Rust/Tauri kernel (explicitly skipped this session).
- Native (non-Docker) sandbox; desktop/connector workers; browser downloads; per-user data partitioning and SSO; live validation of the macOS/Linux vault adapters on their platforms. Browser text entry was delivered in the subsequent browser-text-entry slice.

# Startup Fix, Startup Gate, and the Pilot Installer

> **Historical record.** This describes the 2026-07-21 liveness smoke and first pilot artifact. The current smoke no longer treats survival, a title, child processes, or an owner record as readiness: it uses isolated development/pilot/production identities; real login, session verification, and a protected kernel read; an HMAC proof bound to the compiled identifier and Tauri version; a monitor-start handshake; exact-origin navigation and frontend mount challenge; and authenticated graceful shutdown with attested Node-pid cleanup. Acceptance also suppresses updater network activity. Use [`external-security-audit-and-pilot-runbook.md`](./external-security-audit-and-pilot-runbook.md) for the current contract. Test totals, endpoint behavior, and artifact hashes below apply only to the dated run.

Date: 2026-07-21
Branch: `codex/production-desktop-release-v1`

Covers three things: the fix for the native host startup defect, a new gate that would have caught it, and an unsigned pilot installer — including a precise account of why the supported release pipeline cannot produce one without a code-signing certificate.

---

## 1. The fix

**Defect:** `npm run desktop:build` produced a binary that panicked before any subsystem initialized. Diagnosis in [`native-host-startup-defect.md`](./native-host-startup-defect.md).

The updater was already designed to be release-only. `src-tauri/src/updater.rs:33`:

```rust
pub fn start(app: AppHandle, runtime_dir: PathBuf, enabled: bool) -> bool {
    if !enabled { return false; }
```

and `enabled` is `is_packaged_release()`. So the update *check* was correctly gated. Only the *plugin registration* in `lib.rs` was not — an oversight, not a design decision. The plugin fails initialization without the `plugins.updater` block that only the release pipeline injects, and that failure aborts before `setup` runs.

**Change** — `src-tauri/src/lib.rs`, registration now uses the same predicate:

```rust
    if is_packaged_release() {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }
```

The release path is unchanged: a packaged release sets `PROVENANCE_PACKAGED_RELEASE=1` *and* injects `plugins.updater`, so both conditions still hold together. An unpackaged build now registers no updater plugin and boots.

**Test added** — `base_configuration_carries_no_updater_settings` pins the assumption the conditional depends on, so a future static `plugins.updater` block in `tauri.conf.json` fails loudly rather than creating two disagreeing sources of updater configuration.

This was deliberately the minimal change. The alternative (a static key in `tauri.conf.json`) would have committed a default public key that could shadow the release-injected one.

---

## 1b. A second defect, hidden directly behind the first

With the host finally able to boot, it reached its own setup and then entered **recovery mode**. The supervised Node child had died immediately:

```
Error: EISDIR: illegal operation on a directory, lstat 'C:'
    at Object.realpathSync (node:fs:2734:25)
    at resolveMainPath (node:internal/modules/run_main:35:21)
```

**Cause.** `project_root` (and every other path in `NodeLaunchConfig::validate`) uses `std::fs::canonicalize`, which on Windows returns an *extended-length* path: `\\?\C:\Users\...`. That form is correct for Win32 calls and is what the supervisor's containment checks compare. But Node parses `\\?\C:\...` as a UNC share — server `?`, share `C:` — and lstats `C:`, which is a directory. Confirmed directly:

```
> path.resolve('\\\\?\\C:\\...\\dist\\server.cjs')
C:\?C:Usersajobu...distserver.cjs
```

So the entrypoint argument was unloadable, and `PROVENANCE_PROJECT_ROOT`, `PROVENANCE_WORKSPACE_ROOT`, and `PROVENANCE_RUNTIME_DIR` would all have been wrong inside the kernel too.

**Fix** — a `child_path` helper in `supervisor.rs` that strips the verbatim prefix, applied *only* where a path crosses into the child process (the entrypoint argument, `current_dir`, and the four path-valued environment variables). Internal values stay canonical, so every containment check still compares one consistent form and nothing about the security boundary changes. Drive-qualified verbatim paths convert, `\\?\UNC\...` becomes `\\...`, and device paths such as `\\?\Volume{...}` are deliberately left alone because removing the prefix there would address a different file. The release runner re-canonicalizes whatever it receives, so it is unaffected.

Covered by `child_paths_drop_the_verbatim_prefix_node_cannot_parse`.

---

## 1c. A third defect: the readiness budget was 8× too small

With Node loading correctly, the host *still* fell into recovery. The supervised server was alive and healthy — it simply had not finished starting.

Measured on this workstation, with the repository's real `.env`:

| Milestone | Elapsed |
| --- | --- |
| dotenv banner | +1.0 s |
| **container-runtime probe completes** | **+44.9 s** |
| Playwright write worker registered | +47.3 s |
| **`Server … running on http://localhost:PORT`** | **+48.4 s** |

`supervisor.rs` allowed `READY_TIMEOUT = 15s`. The server needs ~48s here, so the host killed a perfectly healthy child and reported a supervisor failure every time.

The dominant cost is the container-runtime probe (~44s), even with Docker Desktop running. That is worth investigating separately, but it is not what made the host unstartable — the mismatch is.

**This was already known in one half of the codebase.** Commit `95b9c6b` ("fix: tolerate cold packaged-server startup") raised `packaged-server-smoke.mjs` to a **120s** budget for exactly this startup. The supervisor's 15s was never aligned with it. `READY_TIMEOUT` is now 120s, matching the repository's own precedent.

Note this also explains why the clean-room smoke stayed green: it sets `PROVENANCE_SANDBOX_IMAGE` to short-circuit Docker I/O, so it never pays the 44s the real configuration does.

**Trade-off accepted:** a genuinely hung server now leaves the window hidden for up to two minutes instead of fifteen seconds. Reporting a false supervisor failure for a healthy child is the worse of the two.

Also fixed here: `minimal_environment` placed the canonicalized (`\\?\`) Node directory as the first `PATH` entry handed to the child. Same boundary conversion now applies.

---

## 1d. What three defects in a row actually show

Three independent, fully deterministic defects sat in the startup path:

1. a plugin registered without its configuration,
2. a path format the child could not parse,
3. a timeout smaller than the measured startup.

None was reachable by any gate that reads source. Each was invisible until the one before it was fixed. Every one of them would have failed on the first launch on any machine — and none of them ever fired, because **the binary had never been executed.** A single `cargo build` plus a launch would have caught all three in sequence.

---

## 2. The gate that was missing

The defect was a guaranteed, 100%-reproducible startup crash that passed every CI run. `.github/workflows/native-desktop.yml` ran formatting, tests, `cargo check --all-targets`, and Clippy — **all of which read source; none execute the binary.**

Added `scripts/native-host-smoke.mjs` (`npm run desktop:startup-smoke`), modelled on the existing `packaged-server-smoke.mjs`. It launches the built host and asserts:

1. the binary exists and spawns;
2. it does **not** exit within a stability window (default 15s);
3. `stderr` contains no `panicked at` — a thread can panic without killing the process, so exit code alone is insufficient evidence;
4. it reports whether `runtime-owner.json` appeared, which distinguishes "reached its own trusted setup" from "alive in recovery mode".

One caveat found while building it: the gate **cannot be isolated to a scratch directory.** Tauri resolves `app_local_data_dir` through the Windows known-folder API, which ignores `LOCALAPPDATA`, so an initial attempt to redirect it silently did nothing. The gate therefore uses the real runtime directory and must not run while a real instance holds the runtime lock. Killing the host leaves its owner record behind (a terminated process runs no destructor), but the next genuine launch reclaims it after finding the recorded pid dead.

A second caveat, found by running the gate rather than reasoning about it: an **empty allowlist is deliberately invalid.** `parse_allowed_applications(Some("[]"))` returns `InvalidAllowlistSize`, and `contracts.rs:464` asserts exactly that. The gate's first version passed `DESKTOP_APP_ALLOWLIST='[]'`, which sent the host straight into recovery mode — alive, no panic, gate green, almost nothing proven. It now supplies one always-present executable (`notepad.exe`).

This is worth recording because it is the failure mode a startup gate is most likely to have: **passing while proving nothing.** The `runtimeOwnerRecordWritten` field is what exposed it, and it is also why the field exists.

**The gate was verified against the defect before the fix was built.** Run against the pre-fix binary still on disk:

```
The native host panicked while running. stderr="
thread 'main' (27400) panicked at src\lib.rs:93:10:
Provenance native host terminated unexpectedly: PluginInitialization("updater",
  "Error deserializing 'plugins.updater' within your Tauri configuration:
   invalid type: null, expected struct Config")
stack backtrace: ...
EXIT=1
```

That is a real red test, not a hypothetical: the gate fails on the exact defect it exists to catch.

Two CI steps were added after Clippy — `cargo build` (debug) and the startup smoke against the debug binary. Debug is deliberate: the defect class is configuration-driven and reproduces identically without paying for a release build.

> **Unverified:** the CI steps have not been observed running green on a `windows-latest` runner. The script is verified locally; the workflow wiring is not. A headless runner may also behave differently when the host opens a window.

> **Residual risk:** `rustfmt` is still missing on this workstation, so the Rust edits could not be checked against `cargo fmt --check`, which CI enforces. The changes were kept within rustfmt's default width and idioms, but this is unverified. Run `rustup component add rustfmt` then `cargo fmt --manifest-path src-tauri/Cargo.toml` before pushing. (No download was performed here, as that needs your say-so.)

---

## 3. Why the release pipeline cannot produce an installer here

Worth stating precisely, because "no installer" had been recorded without a reason.

`scripts/desktop-release.mjs` splits packaging into two stages:

| Stage | Command | Output |
| --- | --- | --- |
| 1 | `build-unsigned` | Builds with **`--no-bundle`** → native `.exe` only, staged as an unsigned payload |
| 2 | `bundle-signed-native` | Takes the **externally signed** `.exe` and bundles it into the NSIS installer |

The installer only exists in stage 2, which requires `PROVENANCE_WINDOWS_CERTIFICATE_THUMBPRINT` and `PROVENANCE_WINDOWS_TIMESTAMP_URL`. **There is no supported unsigned-installer output** — that is a deliberate supply-chain property, not a gap.

Stage 1 alone additionally requires: a pinned Authenticode-signed Node runtime plus its license and expected SHA-256, hash-pinned `cargo-about`, exact `@tauri-apps/cli` 2.11.4, a protected updater public key and endpoint, a pinned sandbox image, and an empty fresh target directory.

So a pilot installer must legitimately step outside that pipeline.

---

## 4. The pilot installer

`scripts/desktop-pilot-installer.mjs` (`npm run desktop:pilot-installer`) produces an unsigned NSIS installer for a machine you control. It reuses the real `tauri.conf.json` + `tauri.release.conf.json`, adds a resource map and an updater configuration, and builds with `PROVENANCE_PACKAGED_RELEASE=1`.

Packaged mode is required for an installed app to work at all: only then does the host resolve its project root from the bundled resource directory and its Node runtime from `node/node.exe`. In unpackaged mode it reads `DESKTOP_APP_ALLOWLIST` and `PROVENANCE_PROJECT_ROOT` from the environment, which an installed application does not have.

Because packaged mode registers the updater plugin, the build needs a public key. A **pilot-only** keypair was generated outside the repository:

```
node node_modules/@tauri-apps/cli/tauri.js signer generate --ci -w <path outside the repo>
```

The private key lived in the session scratchpad, was not committed, and `.gitignore` covered `src-tauri/*.key`, `*.key.pub`, and `pilot-staging/`. This dated artifact used `http://127.0.0.1:9/...`. The current pilot builder instead uses a credential-free HTTPS endpoint under the RFC 2606 reserved `.invalid` domain, and current acceptance suppresses updater network activity entirely.

### This historical artifact is not distributable

Stated plainly, because it would be easy to mistake for a release:

| Property | Status |
| --- | --- |
| Authenticode signature | **None.** SmartScreen will warn; "More info → Run anyway" on your own machine |
| Updater key | Locally generated pilot key, private half on the build machine |
| `dist/RUST_THIRD_PARTY_NOTICES.txt` | **Omitted in this dated artifact.** The current pilot builder requires and hash-binds it. |
| `node/LICENSE` | **Omitted in this dated artifact.** The current pilot builder requires and hash-binds it. |

The last two are license obligations. Redistributing `node.exe` without its MIT license text is a compliance failure, so this dated artifact must not be distributed or reused. The current unsigned pilot now includes the complete inventory but is still non-distributable for its separate signature, updater-key, sandbox, and release-attestation blockers; see [`2026-07-27-final-local-evidence.md`](./2026-07-27-final-local-evidence.md). Producing a distributable build still requires the protected production pipeline.

---

## 5. Results

### Build

| Item | Value |
| --- | --- |
| Artifact | `src-tauri/target/release/bundle/nsis/Provenance_0.1.0_x64-setup.exe` |
| Size | 28,968,718 bytes |
| SHA-256 | `e6a9499f1a5ebbb287db666728f35c3cea4acbe74c1402ecf4636d899238ebb5` |
| Bundled Node | v24.15.0 x64 |
| Sandbox image | `provenance.invalid/pilot-sandbox-disabled@sha256:000…0` (unresolvable by construction) |

`build.rs` rejected the first attempt because a packaged build must pin `PROVENANCE_SANDBOX_IMAGE` to `registry/repository@sha256:<64 hex>`. That guard was respected rather than bypassed, which is why sandboxed command execution is permanently unavailable in this artifact.

> **Note:** the Tauri bundler downloaded NSIS 3.11, `nsis_tauri_utils.dll`, and the WebView2 bootstrapper during bundling, validating each against its expected hash. That was the bundler's own behaviour, not a separate step.

### Installation

Installed silently (`/S`, exit code 0) to `%LOCALAPPDATA%\Provenance` — per-user, no elevation. Uninstaller registered under `HKCU`. Resource tree exactly as configured:

```
provenance-desktop.exe          6,925,824
uninstall.exe                      94,645
dist\server.cjs                 3,512,540
dist\index.html                       423
dist\assets\index-*.css|js        424,197
dist\THIRD_PARTY_NOTICES.txt      925,355
node\node.exe                  91,694,408
```

### Packaged startup

| Probe | Observed |
| --- | --- |
| Process alive | yes |
| `runtime-owner.json` | written — `mode: desktop-host`, `hostPid: 30596` |
| Updater | **ran and recorded `{"phase":"check_failed"}`** |
| `msedgewebview2.exe` child | present |
| `node.exe` child | **not yet** — blocked at first-run onboarding |
| Main window | created, still hidden (shown only after setup completes) |

**The updater result is the important one.** It proves the fix did not merely disable the updater — in a packaged build the plugin still registers, initializes against the injected `plugins.updater` configuration, and performs a check. `check_failed` is the correct outcome for an endpoint that cannot resolve. So the dev path boots *and* the release path is unchanged.

### Where it stopped, and why that is correct

The installed app is waiting at its first-run consent dialog — "Choose applications Provenance may control" — because no allowlist is persisted yet (`%APPDATA%\dev.provenance.desktop` is empty). That dialog is the gate that grants desktop-automation authority over specific executables.

**That choice was deliberately left to the operator.** Selecting those applications, or pre-seeding the persisted allowlist to skip the prompt, would be granting the product authority over software on someone else's behalf — precisely the decision the gate exists to obtain. The packaged path is verified up to that point; completing onboarding is a human step.

### Test status

| Suite | Result |
| --- | --- |
| Rust (`cargo test`) | **43/43** — includes the new `base_configuration_carries_no_updater_settings` and `child_paths_drop_the_verbatim_prefix_node_cannot_parse` |
| TypeScript (`npm run lint`) | clean |
| TypeScript (`npm test`) | **528 passed, 1 failed** |

The single failure is `src/components/DesktopPanel.test.tsx > discovers and inspects exact worker-scoped desktop state…`, which times out waiting for a "Discover windows" button. **Verified pre-existing:** it fails identically at committed `HEAD` with all of this session's changes stashed. Not caused by this work and not fixed by it — flagged for whoever owns that panel.

The live Rust UIA acceptance test is environment-sensitive: it fails `OutcomeUncertain` from a background context and passes in an interactive session. That is the broker refusing to claim an outcome it cannot confirm — correct fail-closed behaviour, but it makes the test unreliable in non-interactive runners.

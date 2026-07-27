# Defect — Native Host Cannot Start When Built via `desktop:build`

> **Historical defect record.** The observations below explain the original failure and its 2026-07-21 fix. The title/process/owner observations recorded here are not current readiness evidence. Current release acceptance requires isolated identity state, real login/session/protected-read checks, an identifier/version-bound HMAC proof, monitor startup, exact-origin frontend mount, authenticated graceful shutdown, and attested Node-pid cleanup; see [`external-security-audit-and-pilot-runbook.md`](./external-security-audit-and-pilot-runbook.md).

**Status: FIXED 2026-07-21** — updater plugin registration is now conditional on `is_packaged_release()`, matching the predicate that already gated `updater::start`. A startup smoke gate was added and verified to fail against the pre-fix binary. Fixing this exposed **two further** startup defects (Windows `\\?\` paths handed to Node, and a readiness budget 8× smaller than measured startup). All three are written up in [`installer-and-startup-verification.md`](./installer-and-startup-verification.md), which supersedes the "Fix options" section below.

**Dated 2026-07-21 observation:** the window title was `Provenance` (not recovery), `msedgewebview2.exe` and `node.exe` children were present, `runtime-owner.json` was written, and the supervised kernel logged `[Desktop] Authenticated Windows UI Automation worker registered.` Evidence is in [`pilot-and-verification-evidence.md`](./pilot-and-verification-evidence.md) section 6. These observations diagnosed startup progress; they did not prove current authenticated acceptance.

**Severity:** Was blocking for any local/dev native testing. 100% reproducible.
**Found:** 2026-07-20, first attempt to launch the locally built `provenance-desktop.exe`.

The diagnosis below is retained as the original record.

---

## Summary

`npm run desktop:build` produces a native host binary that **panics before doing any work**. The binary is unrunnable on any machine, not just this one. Startup has never been validated because CI compiles, type-checks, unit-tests, and Clippy-lints the Rust but **never launches the built executable**.

---

## Observed behaviour

Launching `src-tauri/target/release/provenance-desktop.exe` exits immediately. Because Tauri builds a **Windows GUI-subsystem binary**, there is no attached console, so nothing is printed — the failure looks like a silent exit with no output. Windows recorded crash dumps and Application-log events:

```
Faulting application name: provenance-desktop.exe, version: 0.1.0.0
Exception code: 0xc0000409          (FAST_FAIL_FATAL_APP_EXIT — Rust abort)
Fault offset: 0x00000000002db3f5
Faulting module: provenance-desktop.exe   (not a missing DLL)
```

Capturing stderr explicitly (`Start-Process -RedirectStandardError`) reveals the panic:

```
thread 'main' panicked at src\lib.rs:93:10:
Provenance native host terminated unexpectedly:
  PluginInitialization("updater",
    "Error deserializing 'plugins.updater' within your Tauri configuration:
     invalid type: null, expected struct Config")
```

Ruled out: WebView2 is installed (`150.0.4078.83`); MSVC toolchain and Windows SDK are present; the binary links cleanly; the faulting module is the exe itself, not a dependency.

---

## Root cause

Three facts combine:

1. **`src-tauri/src/lib.rs:87`** registers the updater plugin unconditionally:
   ```rust
   .plugin(tauri_plugin_updater::Builder::new().build())
   ```
2. **`src-tauri/tauri.conf.json` contains no `plugins` section at all.** `plugins.updater` therefore deserializes as `null`, and the plugin requires a `Config` struct.
3. **The updater config is injected only by the release pipeline.** `scripts/desktop-release.mjs` (~line 470) builds it dynamically from `PROVENANCE_UPDATER_PUBLIC_KEY`:
   ```js
   dynamicConfig: {
     bundle: { createUpdaterArtifacts: false },
     plugins: {
       updater: {
         pubkey: updaterPublicKey,
         endpoints: [updaterEndpoint],
         dangerousInsecureTransportProtocol: false,
         windows: { installMode: 'passive' },
       },
     },
   }
   ```

So the plain `desktop:build` path registers a plugin whose configuration only exists on the release path. The panic is *fail-closed* behaviour — the host refuses to run with an invalid updater configuration — but the consequence is that the documented developer build command yields an unbootable artifact.

---

## Why every gate stayed green

`.github/workflows/native-desktop.yml` runs formatting, Rust tests, `cargo check --all-targets`, and Clippy. All of these operate on source; none execute the produced binary. A guaranteed startup crash is invisible to that pipeline.

This also sharpens a claim in `docs/superpowers/plans/2026-07-15-native-desktop-runtime-v1-record.md`, which lists "live interactive UI Automation validation pending". The gap is larger than UIA: **process startup itself was never validated.**

---

## Fix options

### Option A (recommended) — make the plugin registration tolerate a dev build

A developer build should not require release infrastructure to boot. Register the updater plugin only when its configuration is present, and log a clear "updater disabled (no configuration)" line otherwise. Keeps the release path unchanged and fail-closed, while making `desktop:build` produce a runnable binary.

### Option B (quick unblock) — add a static `plugins.updater` block to `tauri.conf.json`

Generate a free Tauri updater keypair (no paid certificate is involved):

```
npx tauri signer generate -w <private-key-path>
```

Then add a `plugins.updater` section mirroring exactly what `desktop-release.mjs` injects, using the generated public key. Note this places a committed default public key in the repository and must not be allowed to shadow the release-injected value — verify precedence before adopting.

Either way the binary must be rebuilt (dependencies are already compiled, so expect minutes rather than the 14m 43s cold build).

---

## Verification steps once fixed

1. Rebuild inside the MSVC developer environment (see `windows-native-build-runbook.md`).
2. Launch with stderr redirected and a full process environment:
   ```powershell
   $env:PROVENANCE_PROJECT_ROOT = "<repo>"
   $env:KERNEL_API_TOKEN        = "<token>"     # native execution is disabled in loopback 'open' mode
   $env:DESKTOP_APP_ALLOWLIST   = '[{"appId":"windows.notepad","executablePath":"C:\\Windows\\System32\\notepad.exe"}]'
   $env:RUST_BACKTRACE          = '1'
   Start-Process <exe> -RedirectStandardError err.txt -RedirectStandardOutput out.txt -PassThru
   ```
   The host cannot read `.env` itself — that is why `desktop:dev` preloads dotenv. A directly launched binary needs these in its process environment.
3. Confirm, in order: the process stays alive; a runtime directory appears under `%LOCALAPPDATA%\dev.provenance.desktop\runtime`; `runtime-owner.json` is written; a supervised `node.exe` child appears; the readiness handshake completes; a window opens.
4. Then, and only then, exercise the desktop UIA path against the allowlisted application.

---

## Suggested follow-up beyond the fix

Add a **smoke gate that launches the built binary** and asserts it survives a short stability window. The repository already has the equivalent for the server (`scripts/packaged-server-smoke.mjs`); the native host has no counterpart. Without one, this class of defect will recur silently.

# Windows Native Build and Acceptance Runbook

- Target: `x86_64-pc-windows-msvc`
- Pinned CI toolchain: Rust 1.97.0 and Node.js 22.23.1
- Status: ordinary Windows CI passed for repair commit `ca482a47edbf9653e9bee85be2b83dc1e42414a6`; protected release execution, independent audit, and external pilot remain pending

## Prerequisites

- Windows 10/11 with WebView2 Evergreen.
- Rust 1.97.0 MSVC with `rustfmt` and `clippy`.
- Visual Studio 2022 Build Tools, Desktop development with C++ workload, and a supported Windows SDK.
- Node.js and dependencies installed with `npm ci`.
- Docker plus the configured digest-pinned image only when exercising native command execution.

Use an MSVC developer PowerShell/command environment so Microsoft's `link.exe` precedes Git for Windows' unrelated `usr/bin/link.exe` on `PATH`.

```powershell
rustup toolchain install 1.97.0 --profile minimal --no-self-update
rustup component add --toolchain 1.97.0 rustfmt clippy
rustup target add --toolchain 1.97.0 x86_64-pc-windows-msvc
```

If Windows Application Control blocks Rust binaries, do not weaken a production workstation as a routine build step. Prefer the pinned GitHub Actions runner, a disposable development VM, or an administrator-approved allow policy. Disabling Smart App Control is a machine security decision with one-way consequences on some Windows configurations, not a project prerequisite.

## Source and native gates

Run from a clean checkout of the candidate commit:

```powershell
npm ci
npm run lint
npm test
npm run build
npm run desktop:release:test
npm run replay-ledger:gate
npm run desktop:acceptance
cargo +1.97.0 fetch --manifest-path src-tauri/Cargo.toml --locked
npm run desktop:licenses
npm run desktop:resource-smoke
npm audit --omit=dev --audit-level=high
cargo +1.97.0 fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo +1.97.0 test --manifest-path src-tauri/Cargo.toml
cargo +1.97.0 check --manifest-path src-tauri/Cargo.toml --all-targets
cargo +1.97.0 clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

Also run `npm run verify-ledger:strict -- <populated-evidence-runtime>` against a candidate runtime that contains real events; an empty checkout is not ledger evidence. `replay-ledger:gate` separately creates a fresh isolated runtime through the real kernel and requires the independent replayer to accept its schema-2 authorization decisions with no warnings or outcome-only authorization records. Record the tool versions, exact commit, exit codes, durations, replay counts, policy versions, and current test totals. The npm audit covers production npm dependencies only, so attach an independent advisory review of `Cargo.lock`, Rust/Tauri, and the native release/build chain. Historical totals in session documents are not a substitute.

## Build and authenticated development startup

Build the production web/server assets before the native host; the acceptance harness copies `dist` into an isolated scratch project.

```powershell
npm run build
cargo +1.97.0 build --manifest-path src-tauri/Cargo.toml
npm run desktop:startup-smoke -- --binary src-tauri/target/debug/provenance-desktop.exe --profile development
```

The development build uses `dev.provenance.desktop.development`. The smoke command reserves fresh local and roaming profiles, creates isolated multi-user/auth/workspace/Notepad authority, passes a random acceptance nonce, and suppresses updater network activity. It logs in, verifies the session, performs a protected kernel read, requires the monitor-start handshake, completes exact-origin native navigation plus the one-use Rust-owned mount challenge, and validates the HMAC-authenticated full-readiness record. The proof binds the compiled identifier, Tauri application version, resource-manifest identity, and launch/process identities.

The gate fails when:

- The host enters recovery or exits/panics.
- Kernel or bridge authentication is absent.
- UI Automation is unhealthy or desktop authority is not `available`.
- Scheduling is enabled, updater network activity begins, native navigation leaves the exact origin, or the frontend cannot complete the fresh Rust-owned mount challenge.
- The proof does not match the nonce, compiled identifier, Tauri application version, resource-manifest digest, pids, host instance, or packaged/development mode.
- Login, session verification, protected kernel read, or the monitor-start handshake fails.
- Authenticated Node graceful shutdown fails, forced containment is needed, the attested Node pid survives, or owner/proof files survive shutdown.
- An existing profile would be reused.

Process survival, a title, a child process, an owner record, or a log line is not sufficient evidence.

`npm run desktop:build` creates the unpackaged release-profile host executable with the development identity because bundling is disabled in the base configuration. It is not a production installer.

## Isolated unsigned pilot

Provision the exact hash-pinned `cargo-about` version documented by the native
workflow, generate a pilot-only updater keypair outside the repository, and
select a Windows x64 Node distribution with its adjacent `LICENSE`. The pilot
builder regenerates the Rust notice inventory after the web/server build and
fails if the pinned notice generator, Node license, or any required notice is
missing:

```powershell
node node_modules/@tauri-apps/cli/tauri.js signer generate --ci -w <path-outside-repository>
npm run desktop:pilot-installer -- `
  --updater-public-key <pilot-public-key-file> `
  --node <node-distribution>\node.exe `
  --node-license <node-distribution>\LICENSE
```

Install to a fresh path/profile and exercise the exact installed pilot executable:

```powershell
$pilotEvidence = Get-Content -Raw `
  src-tauri/target/pilot-installer/cargo/release/bundle/nsis/provenance-pilot-evidence.json |
  ConvertFrom-Json
npm run desktop:startup-smoke -- --binary <installed-pilot-executable> `
  --profile pilot --packaged `
  --expected-resource-manifest-sha256 $pilotEvidence.runtimeResourceManifestSha256
```

The builder writes the bounded `provenance-pilot-evidence.json` sidecar next to
the installer. It binds the installer hash, exact resource-manifest digest,
bundled Node hash, and the path, size, and hash of the root application
license, JavaScript notices, Rust notices, and Node license. Retain the sidecar
and its reported hash with local pilot evidence. The sidecar also records the
validated `cargo-about` version/executable hash and `Cargo.lock` hash used for
the Rust notice inventory.

The pilot has its own product name, semantic prerelease version, application id `dev.provenance.desktop.pilot`, build target, profiles, and updater key. Its credential-free updater endpoint is under the RFC 2606 reserved HTTPS `.invalid` domain, so acceptance never depends on a live updater service. The script strips production certificate/PFX/updater-private-key environment variables before invoking the build.

The pilot is **not distributable**. It includes the complete hash-bound license
and notice inventory, but the application, installer, and local Node runtime
are not authenticated by the protected production signing policy. Its updater
endpoint is unreachable, its key is local, command execution is disabled
through an unresolvable digest-pinned image, and it has no protected release
attestation.

## Protected production release

Do not emulate production acceptance by pointing the smoke script at a developer's real production profile. The guard requires caller-provided `GITHUB_ACTIONS=true` and `PROVENANCE_EPHEMERAL_ACCEPTANCE=1` markers and refuses an existing production profile. Those markers are safety interlocks, not authenticated GitHub provenance; the protected workflow record and signed candidate evidence establish where the test ran.

The protected `Verified Windows desktop release` workflow must:

1. Construct and attest an unsigned exact resource payload whose post-build digest still matches the manifest compiled into the native host.
2. Revalidate it before protected signing.
3. Authenticode-sign the native and NSIS artifacts and validate timestamps.
4. Install to a fresh runner path and verify the complete resource inventory and exact signed-native hash.
5. Immediately revalidate the unsigned payload and run authenticated smoke against the exact installed executable with `--profile production --packaged` and the immutable unsigned-job resource digest.
6. Silently uninstall and prove removal.
7. Apply the updater signature after certificate removal and emit the bounded public evidence set.

The production artifact requires the complete application and third-party license inventory, a signed and pinned Node runtime, hash-pinned `cargo-about`, the digest-pinned sandbox image, an Authenticode certificate/timestamp service, updater keys, a credential-free HTTPS `latest.json`, and protected-environment approval.

Before either pilot or production use, revoke or rotate the provider credential previously exposed outside the vault during project work. Store the replacement only in the server-side vault or protected deployment secret store and exclude both old and new values from all evidence.

## Evidence and next boundary

The ordinary `Native desktop verification` workflow is the authority for current TypeScript/Rust/development-host gates. The protected release workflow is the authority for the exact signed installed binary. Retain both run URLs for the same candidate SHA.

After those gates pass, follow [`external-security-audit-and-pilot-runbook.md`](./external-security-audit-and-pilot-runbook.md). An internal successful smoke does not complete the independent audit or pilot obligations.

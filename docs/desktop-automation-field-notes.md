# Desktop Automation — Field Notes

- Updated: 2026-08-16
- Applies to: the Windows UI Automation worker and the Rust UIA broker
- Status: verified against one real third-party application (Notepad), five consecutive passes

These are the things that are true in practice but not obvious from the contract.
Each was found by driving a real application rather than a test fixture, and each
will bite an operator who assumes the happy path.

---

## 1. A Store app cannot be allowlisted by the path you clicked

On Windows 11, `C:\Windows\System32\notepad.exe` is a **launcher stub**. Running
it starts a process whose window is owned by a *different* process living under
`C:\Program Files\WindowsApps\...`.

The allowlist matches on the executable that owns the window. So an operator who
allowlists the System32 path gets:

```
discovery returns no windows
```

No error, no diagnostic — just an empty result, indefinitely. This is the
allowlist working correctly and looking exactly like a broken installation.

**What to do.** Allowlist the executable that actually owns the window:

```powershell
Get-Process -Name notepad | Where-Object { $_.MainWindowTitle } | Select-Object Path
```

For Notepad on a current Windows 11 build that is:

```
C:\Program Files\WindowsApps\Microsoft.WindowsNotepad_<version>_x64__8wekyb3d8bbwe\Notepad\Notepad.exe
```

Note the version in that path. **A Store update changes it**, which silently
breaks a working allowlist. Traditional Win32 applications installed under
`Program Files` do not have this problem.

> If discovery returns nothing, check the owning executable before assuming the
> broker is broken. This is the most likely cause and the least visible one.

---

## 2. A live application will race every revision-pinned call

Actions carry a `treeRevision` that pins the exact snapshot they were planned
against. A modern application re-renders continuously — caret blink, focus
changes, layout settling — so the revision can go stale between *any* two calls.

In practice this means a naive sequence fails often:

```
discover  -> ok
inspect   -> TreeStale        # the tree moved between the two calls
```

and retrying only the failed step does not converge, because the fresh revision
goes stale again just as fast.

**What to do.** Retry the whole `discover → inspect → act` sequence as a unit.
Each attempt must re-discover, because a revision obtained in a previous attempt
is already worthless. The live test in `src-tauri/src/uia.rs` is written as
exactly this client and is the reference implementation.

This is not a defect. Refusing a stale revision is what stops an action landing
on a window that changed underneath it. The cost is that clients must be written
to retry, and that expectation is not obvious from the type signature.

---

## 3. You cannot read back what you typed

This is the limitation most likely to be assumed away.

`ControlNode` exposes `nodeId`, `role`, `name`, `enabled`, `focusable`,
`focused`, and `bounds`. `name` is the UI Automation **Name** property — a
control's label or accessible name. It is **not** the control's text content.

Applications keep editable text behind the **Value** or **Text** pattern, which
the broker does not serialize. So after a successful `desktop.type`, inspecting
the tree will generally not show what you typed.

An early version of the live test grepped the serialized tree for the typed
payload. It passed **1 run in 3** — the text was surfacing in a node name by
accident, not by contract. That assertion was removed rather than retried into
looking dependable.

**Consequence for design.** A desktop mutation today is *fire and verify
externally*. The runtime can prove:

- a real window was discovered and inspected,
- the action carried a live node and an unstale revision,
- the typed payload matched its staged hash,
- the worker reported success.

It cannot prove the application's resulting content. If a workflow needs that,
verification has to come from outside the desktop path — a file the app writes,
an API, a downstream system.

**To close this** the broker would need to expose a TextPattern/ValuePattern
read as a first-class action. That is a contract addition, not a bug fix, and
carries its own containment question: reading control text pulls untrusted
application content across the boundary, so it would need the same treatment as
browser observations.

---

## 4. Uncertain is not failure

A desktop mutation whose result is lost returns `uncertain`, never `failed`.
This is deliberate and matches the connector worker's rule for `send`/`delete`.

`failed` invites a retry. A retried click or keystroke may apply twice. When the
runtime cannot confirm an outcome it says so, and the decision to retry belongs
to a human who can look at the application.

Treat `uncertain` as "inspect the application before doing anything else."

---

## Running the live test

Not part of the ordinary suite: UI Automation cannot attach in a headless
session, and a test that silently passed when it could not run would be worse
than no test.

```powershell
$env:PROVENANCE_LIVE_DESKTOP = "1"
$env:PROVENANCE_LIVE_DESKTOP_EXE = "<path to the window-owning executable>"
cargo test --manifest-path src-tauri/Cargo.toml -- --test-threads=1 drives_notepad
```

`--test-threads=1` matters: UIA work is bound to an interactive desktop and
parallel tests interfere with each other's windows.

Without `PROVENANCE_LIVE_DESKTOP=1` the test reports that it skipped, rather
than passing quietly.

---

## What is still unproven

- **Coverage beyond one application.** Notepad is Microsoft-authored and simple.
  A line-of-business application with custom controls, a WPF/Electron shell, or
  a virtualized list may expose a very different tree, or none at all.
- **Click.** The live third-party test exercises discover, inspect, and type.
  Clicking a real third-party control is covered only by the Win32 fixture.
- **Long sessions.** Every run so far is seconds long. Revision churn, focus
  stealing, and handle reuse over hours are unexamined.

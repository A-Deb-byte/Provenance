# Native Desktop Operator Guide

This guide covers the packaged Windows desktop host. Provenance Desktop v1 can
discover and inspect visible windows from explicitly allowed applications, then
request approval to click or type through Windows UI Automation.

It is a bounded control surface, not unrestricted computer control.

## First Launch

The packaged application establishes its authority before the dashboard opens:

1. **Choose applications.** Select 1-32 `.exe` files that Provenance may inspect
   and, after kernel approval, control. Review and confirm the complete list.
2. **Choose a project workspace.** Select a project directory containing a real
   `package.json`. It cannot be the installation, native configuration, or
   runtime-state directory.
3. **Wait for the trusted runtime.** The native host starts its bundled Node
   control plane, authenticated loopback bridge, and UI Automation broker.
4. **Create the first administrator.** In the dashboard, choose a username and
   password of at least eight characters. The native launch supplies one-use
   bootstrap authority and signs in the new administrator.

Packaged launches ignore `DESKTOP_APP_ALLOWLIST` and
`PROVENANCE_WORKSPACE_ROOT`. The confirmed choices are stored in the packaged
application's per-user configuration. Bridge credentials and launch nonces are
temporary native-host values and must never be entered in the dashboard or an
`.env` file.

## Before Desktop Use

- Sign in as an administrator or operator. Viewer accounts are read-only.
- Create or select a bounded kernel goal with remaining operation and approval
  budget.
- Start the allowed application yourself and open the target window. Discovery
  sees already-running, visible top-level windows; it does not launch programs.
- Run Provenance and the target at the same normal Windows integrity level.
  Provenance has no elevation broker, so elevated applications and prompts are
  outside the supported boundary.

## Run A Desktop Action

Open **Desktop**, then follow this sequence:

1. **Discover** - Select the allowed application and bounded goal, enter a
   non-secret audit reason, and choose **Discover windows**. This is a recorded
   read-only operation.
2. **Inspect** - Select a discovered window and choose **Inspect controls**.
   Provenance records a revision-bound UI Automation control tree.
3. **Request** - Select an enabled control and request a click or type action.
   The request stops at the L2 approval gate. Typed text is staged in a bounded,
   expiring, consume-once store and is bound to the request by its hash.
4. **Approve or deny** - Review the exact action and target, enter a decision
   reason, then approve or deny it. Approval records authority; it does not
   execute the action.
5. **Execute** - For an approved request, choose **Execute approved action**.
   The kernel consumes the matching approval and one-use dispatch authority
   before the native worker can act.

After a mutation, discover or inspect again before another action. Window and
control revisions are deliberately short-lived.

## Stop All

Use **Stop All** in **Live Operations** when dispatch must halt. A reason is
required. Stop All blocks new dispatch and cancels active work where
cancellation is still possible.

Stop All cannot undo a click or text change already accepted by Windows UI
Automation. Resuming also requires an audit reason.

## What Desktop V1 Does Not Do

- It does not launch, close, or elevate applications.
- It does not provide arbitrary PowerShell, command-shell, or process authority.
- It does not capture or stream screenshots or a live desktop video.
- It does not expose private model reasoning.
- It does not automatically retry a desktop mutation with an uncertain result.

The dashboard shows recorded targets, UI Automation metadata, status, and
evidence. If a mutation is **uncertain**, it may have completed even though its
result could not be authenticated. Do not repeat it automatically. Re-observe
the application and create a fresh, intentional request only after reviewing
the current state.

## Recovery And Remediation

Native startup fails closed: recovery mode means no model, Node bridge, or
desktop authority is active.

| Symptom or code | Operator action |
| --- | --- |
| `desktop_allowlist` | Reopen the application and select valid `.exe` files. If saved configuration is invalid, confirm its quarantine and choose a replacement. |
| `project_workspace` | Choose a project folder containing a non-symlink `package.json`, outside installation and Provenance state directories. |
| `runtime_ownership` | Close any other Provenance instance and retry. Do not manually delete runtime evidence while another instance may be active. |
| `desktop_broker` or `desktop_bridge` | Restart Provenance. If it repeats, retain the recovery code and native runtime logs for support. |
| `node_supervisor` | Restart once. A repeated failure requires the recovery code and `desktop-node.stdout.log` / `desktop-node.stderr.log` from the application's per-user runtime directory. |
| `resource_layout` | Reinstall from the verified installer. Do not repair or copy packaged runtime files by hand. |
| Desktop is blocked | Sign in with a protected account, clear Stop All only when safe, and review the Runtime Status reason. |
| No windows are found | Start the allowed application, open a visible window, and run Discover again at the same integrity level. |
| A tree or target is stale | Discover the window and inspect its controls again; do not reuse the old revision. |

Do not edit persisted allowlist, workspace, owner, or bridge files to bypass a
failure. The current packaged UI cannot change a valid saved allowlist. Use a
fresh, controlled application profile when reconfiguration is required; any
future in-place reconfiguration must remain a separately confirmed native
operation rather than dashboard-granted authority.

## Development Versus Installed Launch

`npm run desktop:dev` is a Windows developer workflow. It rebuilds the web and
server assets, starts the development-identity Tauri host, and may read
`DESKTOP_APP_ALLOWLIST`, `PROVENANCE_WORKSPACE_ROOT`, and other documented
development settings from `.env`.

`npm run desktop:acceptance-host` builds the same unpackaged host under a fixed
acceptance-only application identity, creates fresh isolated authority and user
state, proves authenticated native readiness plus UIA discovery, then removes
that owned profile. It never reuses or deletes the operator's development or
installed profile.

`npm run dev` starts standalone Node and the browser dashboard. It does not
create the trusted Tauri bridge or Windows UI Automation authority.

An installed packaged host uses a bundled Node runtime and authenticated
resources, ignores environment-provided desktop authority, and obtains its
allowlist and workspace through native first-run confirmation. Development,
pilot, and production identities use separate per-user state. An unsigned pilot
installer is for controlled local testing only and is not a distributable
production release.

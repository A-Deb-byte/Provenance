# Connectors and Ledger Anchoring

- Updated: 2026-08-16
- Status: both implemented with tests; both require a deployment-supplied piece before they do anything externally

Two subsystems that close long-standing gaps, and are honest about what they
still need from the deployment.

---

## Connectors

### What changed

`connector.read`, `connector.draft`, `connector.send`, and `connector.delete`
existed in the type system and the risk ladder with **no worker behind them**.
An intent for `connector.send` would pass policy and then find nothing to
dispatch to. The vocabulary promised something the runtime could not keep.

The connector worker closes that. The kernel now either performs the action or
refuses it for a stated reason.

### What the worker owns, and why

Adapters are supplied by the deployment. The worker deliberately keeps the parts
that must not vary between adapters, so a new adapter cannot weaken them by
forgetting them:

| Enforced by the worker | Why it is not left to the adapter |
| --- | --- |
| Authorization claim | An adapter that skipped it would bypass single-use dispatch entirely |
| Connector and resource-root containment | Re-checked after policy, because a worker that trusts its caller is one refactor from being unchecked |
| Payload hash verification | The operator approved a summary bound to a hash; different content behind that hash is the substitution this prevents |
| Uncertain-not-failed on lost sends | See below — this is the rule most likely to be got wrong |

### The uncertain rule

A `send` or `delete` whose result is lost reports **`uncertain`**, never
`failed`.

`failed` invites a retry. A retried send may deliver twice. When the runtime
cannot confirm an outbound effect it says so, and whether to retry becomes a
human decision made against the actual mailbox or channel.

A lost `read` reports `failed`, because re-reading is safe.

### Writing an adapter

```ts
export interface ConnectorAdapter {
  readonly connectorId: string;
  read(resourceId: string, signal?: AbortSignal): Promise<ConnectorAdapterResult>;
  draft(resourceId: string, body: string, signal?: AbortSignal): Promise<ConnectorAdapterResult>;
  send(resourceId: string, body: string | undefined, signal?: AbortSignal): Promise<ConnectorAdapterResult>;
  remove(resourceId: string, signal?: AbortSignal): Promise<ConnectorAdapterResult>;
}
```

Rules for an adapter author:

- **Return `uncertain`, not `failed`, when you cannot confirm an outbound
  effect.** A timeout after the request left the process is uncertain.
- **Never widen the resource.** You receive a `resourceId` already checked
  against the granted roots; do not resolve aliases, follow redirects, or expand
  wildcards to something else.
- **Credentials come from the OS vault**, not from the intent, the payload, or
  the environment where they can leak into evidence.

### What still does not ship

**No concrete adapter.** There is no Gmail, Slack, or ticketing implementation,
and OAuth credential acquisition is not built. Until a deployment registers an
adapter, connector actions refuse with `adapter_unavailable` — which is the
correct behaviour, but means the family is unavailable out of the box.

That is a deliberate stopping point: a real adapter needs a registered
application, a consent flow, and token storage/rotation, and building one badly
would be worse than not shipping it.

---

## Ledger anchoring

### The problem it addresses

Hash chaining proves **internal consistency**. Given a chain, you can tell
whether it was edited in place — any change breaks the link.

What it cannot detect is a chain **rewritten from genesis**, because the rewrite
is internally consistent too. Someone with write access to the runtime directory
can produce a perfectly valid chain that says whatever they like.

### What an anchor is

A record binding a head hash to the number of events it covers, at a moment in
time:

```json
{
  "schemaVersion": 1,
  "headHash": "…",
  "eventCount": 282,
  "createdAt": "2026-08-16T12:00:00.000Z",
  "publisher": "local",
  "recordHash": "…"
}
```

Verification replays the chain's head at each anchored event count. Because an
anchor pins *both* the hash and the count, it catches:

- **rewriting** — the head after N events no longer matches what was anchored,
  and the report names the anchor where the divergence begins;
- **truncation** — an anchor covers more events than the chain now holds.

Anchors are append-only and refuse to move backwards in event count: an anchor
covering fewer events than the one before it is itself evidence of a problem and
is rejected rather than recorded quietly.

### The honest limitation

**A local-only anchor log detects a rewrite solely if that log survived it.**
Someone rewriting the chain can rewrite `anchors.jsonl` in the same motion.

The verification output says exactly this rather than letting local anchoring
pass for external witnessing:

> "Chain matches 3 local anchor(s). None is externally witnessed, so this
> detects a rewrite only if this log survived it."

Real anchoring requires publishing the head hash somewhere the operator does not
control. The `AnchorPublisher` interface exists for that:

```ts
export interface AnchorPublisher {
  readonly name: string;
  publish(headHash: string, eventCount: number): Promise<string>;
}
```

Candidates: a transparency log (Sigstore/Rekor), a timestamping authority, a
counterparty's system, or simply mailing the digest to an auditor on a schedule.
Anything outside the operator's control works, because the property needed is
not cryptographic sophistication — it is **a witness who cannot be edited**.

If publication fails, the head is still recorded, marked
`<publisher>:unwitnessed`. Dropping it would lose evidence of what the head was;
claiming a witness that never saw it would be false. It is recorded as neither.

### What still does not ship

**No publisher is connected.** Anchoring is local-only by default, which is a
meaningfully weaker claim than external anchoring and is described as such
everywhere it appears.

---

## Configuring the command allowlist

Related, and previously hardcoded: command execution accepted exactly four npm
invocations. It is now operator-configurable and **still an allowlist**.

```
COMMAND_ALLOWLIST=[{"command":"npm","args":["run","typecheck"]},{"command":"cargo","args":["check"]}]
```

Unset uses the built-in verification set (`npm test`, `npm run lint`,
`npm run build`, `npm --version`).

Rules, all enforced at parse time with a thrown error rather than silent
narrowing:

- Entries are **exact** `command` + `args` pairs. No globbing, no prefix match.
  `npm run *` would let anyone who can write `package.json` choose the payload.
- Shell metacharacters and whitespace are rejected. An entry is refused, not
  sanitised, because a silently-narrowed allowlist differs from what the
  operator believes they configured.
- Maximum 64 entries.

> This is deliberately not a shell, and widening it to one would void the
> containment claim the rest of the system rests on. If a workflow needs
> arbitrary execution, that is a decision to make explicitly and record, not a
> configuration default to drift into.

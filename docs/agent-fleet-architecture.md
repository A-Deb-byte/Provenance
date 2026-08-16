# Agent Fleet — Tiered Domain Specialists

- Status: design + phase 1 implementation
- Date: 2026-08-16

## The problem this has to solve

Provenance can execute a goal, but a single execution path does all the work. There
is no way to decompose a goal across specialists, run them in parallel, or vary how
much autonomy each is trusted with.

The obvious way to add that is also the way that destroys the product: let agents
act on their own. The approval gate on L2/L3 actions **is** the differentiator, the
Article 14(4)(d) claim, and the reason the ledger is worth anything. A fleet that
bypasses it would automate away the only thing competitors cannot copy.

So the design question is not *"agents or safety"*. It is: **how do you get real
autonomy without the kernel ever losing the authority to say no?**

## The answer: authority is a first-class, selectable, ledgered property

An agent does not have inherent authority. It is spawned **with** an authority mode,
chosen by an operator, recorded as evidence.

| Mode | Agent may do | L2/L3 actions |
| --- | --- | --- |
| `propose_only` | Unlimited L0/L1 — read, research, analyse, decompose, synthesise | Emits a proposal; a human approves each one |
| `envelope` | Everything above | Acts inside a pre-approved bounded envelope; no per-action prompt |
| `autonomous` | Everything above | Self-authorises within its tier ceiling |

Three properties make this safe rather than a loophole:

1. **The default is `propose_only`.** Anything else is an explicit, attributed act.
2. **Raising autonomy is itself gated.** Spawning an `envelope` or `autonomous` agent
   requires an approval, recorded with the deciding principal — the same
   attribution machinery approvals already use. *The escalation is evidence.*
3. **The kernel still decides.** Even `autonomous` dispatches through
   `decideActionPolicy` and consumes a single-use capability grant. Autonomy
   changes **who approves**, never **whether policy applies**.

That last point is the whole design. An `autonomous` agent is not unconstrained —
it holds a standing, revocable, bounded delegation. `L4` remains refused for
everyone, and Stop All halts the fleet.

> **Compliance consequence.** Article 14 requires the overseer be able to decline,
> override, and intervene. Under all three modes they can: decline at spawn, revoke
> mid-flight, and Stop All. What changes is the *granularity* of consent — per
> action, per envelope, or per agent — and the ledger records which was chosen,
> by whom.

## Tiers

Tier is a **ceiling**, not a role. It bounds what an agent may ever request,
independent of authority mode.

| Tier | Ceiling | Purpose |
| --- | --- | --- |
| `T0_reader` | L0 only | Research, inspection, summarisation. Cannot mutate anything. |
| `T1_operator` | L2 | Browser and desktop interaction. |
| `T2_connector` | L3 | Outbound effects — send, delete. |
| `T3_orchestrator` | L0, plus spawning | Decomposes goals and spawns children. Cannot act on the world itself. |

**Effective authority is the floor of tier ceiling, authority mode, and the
capability grant.** A `T0_reader` spawned `autonomous` still cannot click a button:
three independent limits, and the tightest wins.

`T3_orchestrator` deliberately cannot act. An agent that both plans and executes is
the hardest kind to audit; separating them means every world-touching action traces
to a leaf agent with a narrow scope.

## Domains

Domain scopes an agent to a subject area and a worker set — `research`, `web`,
`desktop`, `code`, `connector`. A domain narrows what an agent may request; it never
widens a tier.

## Spawn lifecycle

```
requested → (approval if mode > propose_only) → running → completed
                                                       ↘ failed
                                                       ↘ revoked
```

Every transition is ledgered: `agent.spawn_requested`, `agent.spawn_approved`,
`agent.started`, `agent.proposed`, `agent.completed`, `agent.failed`,
`agent.revoked`.

Children inherit the parent's authority mode **capped at their own tier**, and can
never exceed the spawning operator's grant. Delegation narrows; it never widens.

## Bounds

Every agent carries a budget: max operations, max children, max depth, wall-clock
deadline. Exhaustion terminates the agent and ledgers `agent.failed` with a reason.
Unbounded recursion is the obvious failure mode of any spawn system, so depth and
fan-out are hard caps, not advisory.

## What phase 1 implements

- `AgentDefinition`, `AgentSpawn`, tier and authority types
- Registry with tier/domain/authority resolution and the floor rule
- Spawn lifecycle with ledger events and approval gating for elevated modes
- Budget and depth enforcement
- API surface
- GUI panel with the authority selector

Execution — actually running an agent's work loop — is phase 2. Phase 1 makes the
authority model real and enforceable first, because retrofitting an authority
boundary onto a running executor is exactly how the approval gate would get lost.

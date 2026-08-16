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

## Execution

Agents run real work through the **same** capability path as any other actor:
`decideActionPolicy`, a single-use grant consumed pre-dispatch, then the worker.
There is no agent fast path. `runAgentStep` performs one step:

1. refuse if the agent is not `running` (a revoked agent takes no further step);
2. plan the next action from its targets;
3. if the action is above the ceiling, record an `AgentProposal` — this is what
   `propose_only` means in practice;
4. admit against ceiling, operation budget and deadline;
5. re-check the envelope, which can lapse mid-run;
6. dispatch, and treat a worker's `uncertain` result as failure, never success.

Planning is deterministic rather than model-driven: an agent is given explicit
targets and consumes one per admitted operation, using `operationsUsed` as the
cursor so a resumed agent never repeats work. A model can later produce that
target list without changing anything beneath it.

Orchestration is likewise mechanical — one child per target, capped by the
parent's remaining child budget, with anything over the cap ledgered as deferred
rather than dropped. An orchestrator may not spawn another orchestrator: depth
caps alone are a fragile defence against an unbounded tree.

## Execution is opt-in

The authority model is always enforced. Whether agents actually *run* is a
deployment decision: `AGENT_FLEET_EXECUTION=1`. A deployment that has not
enabled it can define, spawn, authorize and revoke agents — and gets a refusal
instead of a surprise autonomous worker.

The GUI states which mode is in force and offers no run control when execution
is off, so the panel cannot imply agents are working when they are not.

## Still out

A model-driven planner (targets are operator-supplied today), proposal→approval
promotion into a dispatchable action, and skill→agent binding.

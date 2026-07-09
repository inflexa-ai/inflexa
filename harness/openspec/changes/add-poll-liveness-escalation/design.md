# Design — poll-mode liveness escalation

## Context

`awaitExecPoll` is a sequence of durable pull steps bounded by `step.timeout`.
Its `unavailable` outcome deliberately never fails the exec — it conflates
"sandbox unreachable" with "unknown execId / non-200", and none of those are
failures of the exec itself. The cost of that discipline is #48: a machine that
dies mid-exec keeps the loop polling until the deadline, because the liveness
watchdog's fast-fail verdict (`synthetic-failure` via `DBOS.send`) has no recv
to land in.

The watchdog architecture gives the exec-failure verdict to a machine-lifecycle
observer, which forces action-at-a-distance: reconstructing the `ExecResult`
shape far from its consumer, a PENDING/ENQUEUED status gate against racing a
real completion, topic-name coupling, and a `signature: null` trusted-sender
exception in the recv loop's verification model. Poll mode's loop, by contrast,
is already talking to the sandbox every 1.5–10 s — the raw unreachability
signal is in its hands; it lacks only the authority to adjudicate it.

**Target architecture (this change is increment 1): liveness verdicts belong to
the waiter.** The await loop escalates its own sustained-unavailability signal
to the same oracle the watchdog uses (`isAlive` backend inspect) and synthesises
the failure in-loop. Increment 2 (out of scope) applies the same policy to the
callback loop's pull backstop; increment 3 (out of scope) retires the watchdog's
`sendSynthetic` role and the recv loop's null-signature branch, leaving the
watchdog with machine lifecycle only (registry marking, reaper feed) — which it
keeps regardless, for machines with no exec in flight.

## Goals / Non-Goals

**Goals:**

- Poll-mode fast-fail latency for a dead sandbox comparable to callback mode's
  watchdog bound (~65 s worst case), without waiting out `step.timeout`.
- The escalation logic is a transport-agnostic module reusable by the callback
  loop's pull backstop, with the synthetic-`ExecResult` construction shared
  with the watchdog so failure reasons stay uniform.
- The poll loop stays free of topic/recv coordination; every new operation is a
  durable step whose scheduling is a pure function of checkpointed outcomes.

**Non-Goals:**

- Changing callback-mode behaviour (increment 2) or the watchdog's synthetic
  send (increment 3).
- New configuration surface — the threshold is a module constant, like the poll
  cadence.
- Distinguishing dead-vs-slow from poll outcomes alone; the backend inspect
  remains the sole arbiter.

## Decisions

### In-loop escalation over a delivery channel

Rejected alternatives, and why:

- **Recv-in-poll** (give the watchdog a channel into the poll loop, e.g.
  `DBOS.recv` as the inter-poll sleep): mechanically possible, but reintroduces
  the per-exec topic, `DBOS.send`, and the null-signature trusted-sender path —
  the exact coordination poll mode was created to shed — and buys nothing,
  since the loop already holds the unreachability signal first-hand.
- **Watchdog writes a registry flag the loop polls**: a second polled source,
  one more durable step per iteration for the life of every exec, and
  cross-component coupling through a table; the escalation gets the same
  verdict from the same oracle without either.
- **Watchdog cancels the workflow**: too blunt — loses the synthetic
  `ExecResult` with the OOM-distinguishable reason and kills the step workflow
  rather than letting it handle the exec failure.

In-loop escalation localises the verdict where the deadline, verification, and
result handling already live. Notably, **the watchdog's PENDING/ENQUEUED race
gate has no analogue here**: the verdict is produced and consumed by the same
workflow, in sequence — there is no mailbox to race a real completion into. If
a completion had arrived, the loop would have returned; if it arrives after the
probe says dead, it cannot — the result lives only in the dead machine.

### The escalation policy is a shared module (`sandbox/liveness.ts`)

Three exports, hoisted rather than inlined in `awaitExecPoll`:

- **The consecutive-unavailable policy** — a small counter object: `unavailable`
  increments, `ok` resets, crossing the threshold arms a probe and resets. Pure
  state over checkpointed poll outcomes, so replay walks the identical
  poll/probe sequence.
- **The probe runner** — wraps the injected `isAlive` into a never-throwing
  three-valued verdict: `dead` (with `oomKilled`), `alive`, `inconclusive`.
  `isAlive` throws on transient backend API errors by contract (so the watchdog
  can skip a round rather than be lied to); inside the loop a thrown probe must
  not fail the workflow — a failed probe is not a failed exec, mirroring
  `pollExecOnce`'s never-throws discipline — so the wrapper catches to
  `inconclusive` and the loop resumes polling.
- **The synthetic-result constructor** — `syntheticFailureResult(execId,
  liveness)` producing the `ExecResult` with reason `"sandbox-oom-killed"` /
  `"sandbox-dead"`, hoisted from `watchdog.ts`'s inline construction and
  consumed by both the watchdog and the escalation. One constructor, one reason
  vocabulary, transport-invariant downstream handling.

### Probe placement, naming, and cadence

The probe runs as a durable step named `sandbox.probe-liveness.${execId}.${k}`
(`k` a dedicated attempt counter), issued immediately after the poll whose
`unavailable` outcome crossed the threshold, before the deadline gate and
sleep. Threshold: **4 consecutive unavailable polls**. On the fast cadence
(1.5 s) that is ~6 s of silence before the first probe — a dead container
refuses connections instantly, so typical detection is seconds; on the slow
cadence (10 s) ~40 s. Worst case (each poll eating its full 10 s HTTP timeout)
stays comparable to the callback watchdog's ~65 s bound. An `alive` or
`inconclusive` probe re-arms the counter from zero, so probes cost at most one
step row per 4 unavailable polls — bounded, like the cadence itself.

### `isAlive` as an `AwaitExecOptions` seam, self-wired by the client

`AwaitExecOptions` gains `isAlive?: (ref) => Promise<SandboxLiveness>`,
matching the existing injectable-effect pattern (clock, fetch, runStep, sleep,
warn). There is no module-level production default (the backend ops live in
`create-sandbox.ts`), so the option is optional: **absent seam → escalation
disabled**, which keeps bare `awaitExecPoll` unit tests unaffected.
`createSandboxClient` always wires it from its backend ops
(`create-sandbox.ts`), so the production path always escalates — the normative
requirement is stated against the client-composed loop.

### Failure surfaces as a returned synthetic result, not a throw

The escalation returns the synthetic-failure `ExecResult` exactly as the
callback loop returns the watchdog's synthetic done-marker payload. Downstream
(step translation, sandbox-error mapping) already understands
`syntheticFailure` and cannot tell which transport — or which adjudicator —
produced it.

## Risks / Trade-offs

- **[Backend inspect lies "dead" about a live machine]** → `isAlive`'s contract
  already forbids this: `alive: false` only when observably dead (missing
  container, terminal pod phase); transient API errors throw and are treated as
  inconclusive. Same oracle, same trust, as the watchdog today.
- **[Host↔sandbox network partition with a healthy machine]** → probe reaches
  the backend API (Docker daemon / K8s API), not the sandbox: it reports
  `alive`, the loop resumes polling, and the deadline remains the bound.
  Latency for this pathology is unchanged by design — only observable death
  fast-fails.
- **[Threshold too twitchy under brief blips]** → a spurious probe is cheap
  (one step row, one backend inspect) and safe (`alive` → resume). Tuning down
  to seconds of tolerance is deliberate; the alternative — minutes — recreates
  a slice of the latency this change removes.
- **[Watchdog still sends unconsumed synthetics in poll mode]** → unchanged
  behaviour; the existing notification sweep clears them. Retiring
  `sendSynthetic` is increment 3, after the callback loop adopts the policy.
- **[Delta layering on un-synced `add-poll-transport-mode`]** → the spec delta
  uses only ADDED requirements (a new concern beside the poll-loop
  requirement), so archive order between the two changes cannot corrupt the
  main spec.

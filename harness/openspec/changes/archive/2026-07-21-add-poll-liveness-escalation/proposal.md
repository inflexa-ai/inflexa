# Poll mode: escalate to an isAlive probe after sustained unavailability

## Why

In poll transport mode a sandbox that dies mid-exec (e.g. an OOM-killed
container) is bound by `step.timeout`: the liveness watchdog's synthetic-complete
fast-fail has no `DBOS.recv` to unblock, so the loop keeps polling an unreachable
machine until the deadline — potentially hours on a long-deadline analysis step
(#48; the accepted trade-off in `add-poll-transport-mode`'s design). Correctness
holds (the deadline is the backstop, the reaper cleans up the machine), but
failure latency regressed from callback mode's ~65 s fast-fail to the full step
deadline.

## What Changes

- **`awaitExecPoll` becomes liveness-aware.** After N consecutive `unavailable`
  polls (an `ok` poll resets the count), the loop escalates to a
  `SandboxClient.isAlive(ref)` probe as **another durable step in the existing
  attempt sequence** — replay-stable like the polls, no topic/recv coordination.
  - Probe says **dead** → the loop returns the synthetic-failure `ExecResult`
    (reason `"sandbox-oom-killed"` when the backend attributes the death to the
    memory limit, `"sandbox-dead"` otherwise) instead of waiting out the
    deadline — the same result shape the watchdog synthesises in callback mode,
    so downstream failure handling is transport-invariant.
  - Probe says **alive** (live-but-slow machine, evicted execId, non-200s) →
    reset the counter and resume polling; the deadline remains the bound.
  - Probe **errors** (transient backend API failure) → inconclusive; resume
    polling without failing the exec.
  `unavailable` deliberately conflates "unreachable" with "unknown execId /
  non-200", so poll failures alone never fail an exec — the backend inspect is
  the sole arbiter of dead vs. live-but-slow.
- **The escalation is a transport-agnostic policy module, not a poll-loop
  private.** The consecutive-unavailable policy, the probe step, and the
  synthetic-`ExecResult` construction (hoisted from `watchdog.ts` so the
  OOM-distinguishable reason stays uniform) live in a shared module. This is the
  first increment of the target liveness architecture — verdicts belong to the
  waiter: the callback loop's pull backstop can adopt the same policy later, and
  the watchdog's `sendSynthetic` role can then be retired. Both follow-ups are
  out of scope here.
- **`isAlive` enters `AwaitExecOptions` as an injected seam**, matching the
  existing dependency-seam pattern (clock, fetch, runStep, sleep, warn).
  `createSandboxClient` self-wires it from its backend ops — no composition-root
  change for embedders.
- **Watchdog behaviour is unchanged.** It keeps registry marking, the reaper
  feed, and the callback-mode synthetic send; its poll-mode sends remain
  unconsumed and are cleared by the existing notification sweep.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `harness-sandbox-exec`: the poll-mode await requirement gains a
  sustained-unavailability escalation — a durable `isAlive` probe after N
  consecutive `unavailable` polls that fails the exec with a synthetic-failure
  result when the machine is observably dead. (Layers on the not-yet-synced
  `add-poll-transport-mode` delta, which introduces the poll-mode requirement
  this one extends.)

## Impact

- **Harness**: `sandbox/await-exec.ts` (escalation in the poll loop; `isAlive`
  seam in `AwaitExecOptions`), new `sandbox/liveness.ts` (escalation policy +
  synthetic-result construction), `sandbox/watchdog.ts` (consume the hoisted
  constructor), `sandbox/create-sandbox.ts` (self-wire the seam).
- **Tests**: `await-exec.test.ts` (escalation paths), `watchdog.test.ts`
  (hoisted constructor), new `liveness.test.ts` (policy unit tests).
- **No sandbox-server, backend, or embedder changes.** No new config surface —
  the threshold is a module constant like the poll cadence.
- **Closes** #48.

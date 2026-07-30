## Context

`runAgent` is a ~230 LOC loop that owns the message array and nothing else — durability (`runStep`)
and the event sink (`emit`) are injected so the same body runs in a host request path and inside a
DBOS workflow. Observability was left to those two injected seams: `emit` carries `iteration` /
`tool-started` / `tool-finished` to whatever surface the host wires
(`src/loop/types.ts:60,68,75`), and `recordAgentRun` (`src/loop/metrics.ts:101`) records aggregate
OTel per `agent_id`.

Both are load-bearing and neither is a diagnostic record.

`emit` goes to a *surface*, and a surface's job is to be readable. Every host filters sub-agent
traffic off it by `callPath` depth for exactly that reason. The planner's iterations therefore
exist, travel through the sink, and are dropped at the render boundary — the events are produced
and thrown away rather than never produced. `recordAgentRun` is aggregate: keyed on `agent_id`
alone, with no `analysisId` and no outcome, it answers "are planner runs creeping toward the cap
across the fleet" and cannot answer "why did this plan fail".

The third seam — `Logger` — is the one the harness already declares for exactly this
(`src/lib/logger.ts`), and the loop does not hold one.

`generate_plan` is the acute case. It is a conversation-layer tool on `passthroughStep`
(`generate-plan.ts:686`), so it has no workflow id, no ledger row, and no durable stream. Its
`shapeOutcome` (`generate-plan.ts:508-547`) turns four distinct failures into a sentence for the
conversation agent, and that sentence is the whole record. Meanwhile the planner's tool surface is
the terminal set alone, so a rejected `submit_plan` is its only validation feedback: it can burn
all 13 iterations (`PLANNER_MAX_ITERATIONS`) on reject → fix → reject against the 600s guard
(`PLAN_TIMEOUT_MS`), and each rejection's issue list — the direct evidence of what is wrong — is handed to the model and
discarded.

## Goals / Non-Goals

**Goals:**

- Every `runAgent` run leaves a record of how it ended, attributable to the agent and the parent
  that spawned it.
- The signals that diagnose a struggling planner — validation rejections, salvage, which of the
  four outcomes fired, elapsed against budget — are written somewhere durable enough to read after
  the fact.
- Instrument once, at the loop, so this does not recur as a per-tool patch for each component that
  becomes suspicious next.
- Default-level verbosity stays affordable: a normal run adds a bounded number of records, not one
  per iteration.

**Non-Goals:**

- Making `generate_plan` durable or giving it a run-event stream. It is a conversation-layer tool
  and stays one; a sticky-panel surface for it is not reachable from here and is not wanted.
- Changing the host-side `callPath` filters that keep sub-agent events off the chat surface. They
  are correct. This change removes the reason to reconsider them.
- Logging message content, prompts, or model output. Records carry counts, names, and identifiers.
- Replacing `recordAgentRun`. Metrics and logs answer different questions and both stay.

## Decisions

### D1. The logger goes on `RunAgentOptions`, optional, resolved once

`RunAgentOptions.logger?: Logger`, resolved at the top of `runAgent` as
`(opts.logger ?? createNoopLogger()).named("loop")`. This is the pattern every harness deps bag
already uses (`data-profile.ts:219` is the nearest neighbour) and it is what the `structured-logging`
spec requires of a module below `bootHarness`: optional, `createNoopLogger()` fallback, never
`console`, so internal call sites log unconditionally instead of threading `?.`.

*Alternative rejected — make it required.* `bootHarness` requires a logger because booting is the
one place an embedder should consciously decide where diagnostics go. `runAgent` is called from
tools, workflows, and tests; requiring it would break every existing call site and every test rig
to buy nothing, since the noop fallback is already the correct behaviour for a caller that wants
silence.

*Alternative rejected — derive it from `session`.* The session carries provenance, not sinks, and
threading a logger through `AgentSession` would put it into DBOS workflow input, where it is not
serializable.

### D2. Provenance rides as fields, from the `EventSource` the loop already builds

`runAgent` already computes `source = { agentId, callPath }` at line 82 for its emitted events. The
logger binds the same pair: `.with({ agentId: source.agentId, callPath: source.callPath })`. One
derivation, two sinks — a record and an event can never disagree about who produced them.

`callPath` is an array. It rides as a field rather than joined into a string, per the
`structured-logging` requirement that identifiers stay queryable; a sink that wants
`tui-chat > planner` renders it at display time.

### D3. Level discipline is normative, not per-call-site taste

Stated in the spec so `LOG_LEVEL` remains a real dial:

| Level | What | Volume per run |
|-|-|-|
| `debug` | one record per iteration, with the tool names dispatched | O(iterations) |
| `info` | one terminal record per completed run | exactly 1 |
| `warn` | completed but degraded — capped out, salvage fired, denial | 0 or 1 |
| `error` | the run could not complete | 0 or 1 |

The load-bearing constraint is the `info` row: **one record per `runAgent`, not per iteration.**
The four `recordAgentRun` sites (`run-agent.ts:127, 192, 236, 242`) are exactly the four terminal
paths, which is why the terminal record is placed alongside each of them rather than at a
`finally` — the finish reason differs at each and a single exit point would have to re-derive it.

At the default `info` level a chat turn that generates a plan therefore adds two records: one for
the conversation agent's run, one for the planner's. That is the budget this design is willing to
spend by default.

### D4. Cap-out and salvage are `warn`, not `info`

Both mean the agent did not finish the way it was supposed to but the caller still got a result.
That is the definition of a degraded outcome, and it is the class of event an operator wants to see
without turning on `debug`. `cappedOut` is already computed and passed to `recordAgentRun`, so this
costs a branch.

Salvage is reported by `runToTerminal` rather than by `runAgent`, because `runAgent` cannot know it
is being salvaged — it sees an ordinary run with a small budget and a restricted tool set. The
wrapper is the only layer that knows the first run failed to resolve.

### D5. `generate_plan` logs what the loop structurally cannot

The loop knows iterations, tools, and finish reasons. It cannot know that `submit_plan` was
*rejected* rather than merely called, or which of the four `shapeOutcome` branches fired, because
those live in closure state the loop never sees (`OutcomeHolder`). So the tool logs:

- **`debug`, per rejection** — inside the rejecting path of `submit_plan`: the
  issue count and the issues themselves. Issues are already structured (`{path, code, message}`)
  and model-facing, so they carry no user data the transcript does not already hold.
- **`info` / `warn` / `error`, once per invocation** — the outcome kind, `elapsedMs`, and
  `analysisId`. `elapsedMs` against the fixed 600s guard is what distinguishes "the planner gave up
  early" from "the planner was still working when the guard cut it".

Severity follows the outcome, not the return type: `plan_complete` and `clarification_needed` are
`info` (both are the tool working as designed), `blocker` is `warn`, and the four failure shapes are
`error`. This is the reason the `planning-enhancements` requirement is *modified* rather than a new
one bolted beside it — "returns a typed outcome and never throws" and "records that outcome" are one
obligation, and stating them apart invites an implementation that satisfies one.

### D6. No new dependency and no embedder work

The CLI already realizes the seam over pino (`cli/src/modules/harness/runtime.ts:102`) and routes
it at `INFLEXA_LOG_LEVEL` into `~/.inflexa/logs`. These records land the moment the harness emits
them; there is nothing to wire on the host side, which is what makes this change a one-package
change despite being cross-cutting.

## Risks / Trade-offs

- **`debug` becomes genuinely expensive.** A sandbox agent run at `debug` now writes a record per
  iteration on top of the sandbox exec logging that already exists there. → This is what `debug` is
  for, and D3's placement keeps `info` at one record per run. The dial is the mitigation; the
  requirement is that the dial works.

- **`callPath` as an array field is awkward in some sinks.** A sink that flattens fields renders it
  as `callPath.0`, `callPath.1`. → Accepted. Joining it at the harness would bake a display choice
  into a published package, and the array is the queryable form.

- **Rejection issues could be verbose.** A badly-malformed plan can produce a long issue list per
  rejection, at `debug`, up to 13 times. → Accepted at `debug`; the count rides on the `info`
  terminal record so a reader knows whether turning `debug` on is worthwhile.

- **Threading `logger` into `createGeneratePlanTool` touches the conversation-agent composition
  root.** → It already holds a `logger` for its other deps; this is one more field on one existing
  call.

- **Two sinks for one fact invites drift** — an event and a record could describe the same
  iteration differently. → D2's single `source` derivation is the structural answer: both read the
  same value, so they cannot disagree about provenance. Counts are computed once in the loop body.

## Why

The agent loop is what every long-running process in this harness is made of, and it logs nothing.
`runAgent` (`src/loop/run-agent.ts`, 429 lines) holds no `Logger`; `RunAgentOptions` takes
`provider`, `signal`, `emit`, `ask`, `runStep`, `formatStepName`, `isFatalLoopError`, and
`promptCache` and nothing to write a diagnostic through. So the one component that knows a run's
iteration index, its tool calls, its stop reason, and whether it exhausted its cap is also the one
component that cannot say so.

`generate_plan` is where that costs the most. Its four failure shapes — the 600s wall-clock guard,
an outer cancel, a thrown loop error, and a run that simply never called a terminal tool
(`src/tools/research/generate-plan.ts:508-547`) — each collapse into a sentence returned to the
conversation agent and are recorded nowhere else. It is a conversation-layer tool on
`passthroughStep`, so unlike a workflow it writes no ledger row and owns no durable stream: the
returned string is the *entire* record that it ran. `GeneratePlanDeps` has no `logger` either.

Two signals that would diagnose a struggling planner outright are produced and then discarded.
A rejected `submit_plan` is the only validation feedback the planner ever gets — its tool surface
is the terminal set alone — and each rejection costs a real iteration out of a 13-iteration budget;
the issue list explaining it is handed to the model and dropped. And `runToTerminal`'s salvage continuation
(`src/loop/run-to-terminal.ts:64-76`) firing means the agent stopped without submitting — a loud
signal that nothing counts.

`recordAgentRun` (`src/loop/metrics.ts:101`) is not this. It is aggregate OTel keyed on `agent_id`
alone, with no `analysisId` and no outcome: it can show planner iterations creeping toward the cap
across a fleet, and can say nothing about why one plan failed.

## What Changes

- `runAgent` accepts an optional `Logger` and reports its own lifecycle through it: each iteration
  with its tool calls at `debug`, and one terminal record per completed run at `info` carrying
  `iterations`, `finishReason`, `cappedOut`, and token usage. Because the seam is on the loop, this
  instruments **every** agent at once — the planner, the literature reviewer, the sandbox agents,
  and the profiler — rather than requiring a per-tool patch each time one becomes suspicious.
- The loop's records carry `agentId` and `callPath` as fields, so a sub-agent's records are
  attributable to the parent that spawned it. This is the same provenance a host surface uses to
  *filter* sub-agent events off the screen; the point here is that "not for the screen" must stop
  meaning "not anywhere".
- `runToTerminal` reports a fired salvage continuation at `warn`, since reaching it means the agent
  ended without its terminal outcome.
- `generate_plan` gains a `logger` dep and records what only the tool knows: which of the four
  outcomes fired, the elapsed wall-clock against its budget, and every rejected `submit_plan`
  with its issues at `debug`.
- Level discipline is stated normatively rather than left to each call site, so `LOG_LEVEL` stays a
  real dial: `debug` for per-iteration and per-rejection detail, `info` for one terminal record per
  run, `warn` for a degraded-but-completed outcome, `error` for a failure.

Not in scope: making `generate_plan` durable, giving it a run-event stream, or surfacing planner
progress in any host UI. It is a conversation-layer tool and stays one. Also not in scope: changing
the host-side filters that keep sub-agent events off the chat surface — those are correct, and this
change removes the reason to touch them.

## Capabilities

### New Capabilities

None. The loop and plan generation are both existing capabilities, and observability of each
belongs to the spec that already states what that component does — a `loop-logging` capability
would describe one aspect of `runAgent` from outside the spec that owns `runAgent`.

### Modified Capabilities

- `harness-agent-loop`: the loop gains an optional `Logger` and a stated obligation to report its
  iteration and terminal lifecycle through it, with the level discipline that keeps the records
  affordable at the default level. `runToTerminal`'s salvage requirement gains the obligation to
  report when it fires.
- `planning-enhancements`: plan generation records its typed outcome, its elapsed time, and its
  validation rejections. The existing "returns a typed outcome and never throws" requirement is
  widened — the outcome must now also be *recorded*, not only returned.

## Impact

- `src/loop/run-agent.ts` — `RunAgentOptions.logger?`, the iteration records, and the terminal
  record at each of the four `recordAgentRun` sites (lines 127, 192, 236, 242).
- `src/loop/run-to-terminal.ts` — the salvage-fired record; it threads the logger through to the
  salvage run.
- `src/tools/research/generate-plan.ts` — `GeneratePlanDeps.logger?`, the outcome record in
  `execute`, and the rejection record inside `submit_plan`.
- `src/agents/conversation-agent.ts` — passes its existing `logger` into `createGeneratePlanTool`.
- Every other `runAgent` call site is unaffected: the option is optional and resolves to
  `createNoopLogger()`, so a caller that wires nothing behaves exactly as it does today.
- No embedder change is required. The CLI already realizes the `Logger` seam over pino
  (`cli/src/modules/harness/runtime.ts:102`) and routes it at `INFLEXA_LOG_LEVEL` into
  `~/.inflexa/logs`, so these records land the moment the harness emits them.
- No new dependency, no schema change, no migration.

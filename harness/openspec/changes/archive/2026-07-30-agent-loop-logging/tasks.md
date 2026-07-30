## 1. The loop's logging seam

- [x] 1.1 Add `logger?: Logger` to `RunAgentOptions` (`src/loop/run-agent.ts:42`), documenting on the field that it is optional because `runAgent` is called from tools, workflows, and tests, and that the noop fallback is the correct behaviour for a caller wanting silence.
- [x] 1.2 Resolve it once at the top of `runAgent`: `(opts.logger ?? createNoopLogger()).named("loop")`, then bind `agentId` and `callPath` from the existing `source` value (`run-agent.ts:82`) via `.with(...)` — one derivation feeding both the record and the emitted event, so the two cannot disagree about provenance.
- [x] 1.3 Write the per-iteration `debug` record where the loop already emits `{type: "iteration", final: false}` (`run-agent.ts:159, 196`), carrying the iteration index and the tool names being dispatched.
- [x] 1.4 Write the terminal record at each of the four `recordAgentRun` sites (`run-agent.ts:127, 192, 236, 242`), carrying `iterations`, the finish reason, `cappedOut`, and the accumulated `usage`. Place it beside each site rather than at a single exit — the finish reason differs at each, and one exit point would have to re-derive it.
- [x] 1.5 Assign the level by outcome class per design D3/D4: `info` for the clean terminal return (`:192`), `warn` for the two cap-out paths (`:236, :242`) and for the denial path (`:127`).

## 2. Salvage reporting

- [x] 2.1 Thread the logger through `runToTerminal` (`src/loop/run-to-terminal.ts:57`) into both the first run's and the salvage run's `RunAgentOptions`, so the salvage run's own loop records are attributable.
- [x] 2.2 Write a `warn` record when the salvage continuation is started (`run-to-terminal.ts:67`), naming the agent whose run failed to resolve. Explain in a comment why this cannot live in `runAgent`: the loop sees an ordinary run with a small budget and a restricted tool set, and only the wrapper knows it is a second attempt.

## 3. Loop tests

- [x] 3.1 Assert exactly one terminal record per completed run, carrying iteration count, finish reason, `cappedOut`, and usage — and that a ten-iteration run still writes exactly one at `info`.
- [x] 3.2 Assert every record carries `agentId` and `callPath` as fields, using a sub-agent-shaped session so the extended `callPath` is what appears.
- [x] 3.3 Assert a capped-out run and a denied-approval run each record at `warn`, and a clean return at `info`.
- [x] 3.4 Assert a run with no logger wired writes nothing and returns a result identical to the same run with one wired.
- [x] 3.5 Assert `runToTerminal` writes the salvage `warn` when the outcome cell is unresolved, and writes nothing when the first run resolved.

## 4. generate_plan's outcome record

- [x] 4.1 Add `logger?: Logger` to `GeneratePlanDeps` (`src/tools/research/generate-plan.ts:551`) and resolve it in `createGeneratePlanTool` as `named("generate-plan")`; bind `analysisId` inside `execute` via `.with(...)`, since it is per-invocation and not available at factory time.
- [x] 4.2 Pass the resolved logger into `runToTerminal`'s options (`generate-plan.ts:677`) so the planner's own loop records carry the `["…", "planner"]` call path.
- [x] 4.3 Record each rejection at `debug` inside the rejecting branch of `submit_plan`, carrying the issue count and the issues.
- [x] 4.4 Capture the invocation's start time in `execute` and record the outcome exactly once after `shapeOutcome`, carrying the outcome kind, `elapsedMs`, and `analysisId`.
- [x] 4.5 Assign that record's level by outcome per design D5 — `info` for `plan_complete` and `clarification_needed`, `warn` for `blocker`, `error` for `persist_error` and for each of the four no-outcome shapes — and make the four failure shapes distinguishable in the record rather than collapsing them to one "failed" string.
- [x] 4.6 Thread the existing `logger` from `createConversationAgent` (`src/agents/conversation-agent.ts`) into `createGeneratePlanTool`'s deps.

## 5. generate_plan tests

- [x] 5.1 Assert one outcome record per invocation carrying kind, `elapsedMs`, and `analysisId`.
- [x] 5.2 Assert the level mapping across the outcomes: submitted and clarification at `info`, blocker at `warn`, and a no-terminal-outcome run at `error`.
- [x] 5.3 Assert two different failure shapes (no terminal outcome, and the guard elapsing) produce records that distinguish the causes from each other.
- [x] 5.4 Assert a rejected `submit_plan` records its issues at `debug`, and a first-call-accepted `submit_plan` records no rejection.

## 6. Verification

- [x] 6.1 `tsc -p tsconfig.json` clean and `bun test` shows no new failures against the branch baseline (record the baseline failure names first — some fail on `main`).
- [x] 6.2 `bun run format:file` on every changed file under `src/`, one file per invocation (the script quotes its argument, so a multi-file call is passed as a single path).
- [x] 6.3 `openspec validate agent-loop-logging --strict` passes.
- [ ] 6.4 Drive a real `generate_plan` against the CLI at `INFLEXA_LOG_LEVEL=debug` and confirm `~/.inflexa/logs` carries the planner's per-iteration records with the extended `callPath`, its validation rejections, and one outcome record — the evidence that the events which are dropped at the chat surface are now recorded somewhere.
- [ ] 6.5 Re-run the same at the default `info` and confirm the turn contributes two terminal records (conversation agent + planner) and no per-iteration noise, which is the volume budget design D3 commits to.

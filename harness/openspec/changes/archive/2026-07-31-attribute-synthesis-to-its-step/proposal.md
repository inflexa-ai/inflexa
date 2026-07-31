## Why

Run-level synthesis owns a real row in the step-execution ledger. The parent workflow seeds it under `SYNTHESIS_STEP_ID`, updates it on the terminal edge, and every surface that lists a run's steps therefore lists `synthesis` beside the plan's own steps.

Its LLM calls are not attributed to it. `synthesizeFindings` hands `synthesizeRun` the bare `RunSession` — a `RunFrame` carrying `runId` and no `stepId` — so the synthesizer loop and every sub-agent it dispatches record against the run with no step. In a real run that is the synthesizer plus its literature reviewer: 8 calls, 108k input tokens, attributed to nothing.

The visible result is the inversion of what the ledger is for. A host rendering per-step figures shows one on every plan step and none on `synthesis` — so the step that just spent the most is the one that looks like it spent nothing. And because absence means "no provider reported anything", the reader cannot tell that phase from a step whose calls genuinely measured nothing.

Every other phase that owns a step row already derives its session with `forStep`. Synthesis is the one that does not, and nothing enforced it.

## What Changes

- **The synthesis phase runs under a session stamped with its own step id**, derived with the same `forStep` a sandbox step's child input uses.
- **The rule becomes explicit in the capability**: a phase owning a step-execution row runs under a session carrying that step id. Stated as a requirement rather than left as a convention that three call sites happen to follow, since the convention held everywhere it was noticed and failed silently where it was not — nothing type-checks, nothing fails, the rows simply lose a column.
- **The replay-stable `recordKey` gains the step segment for synthesis calls**, which is the behaviour the key already specifies for any framed call carrying a `stepId`. Synthesis and a plan step of one run can no longer mint the same key from the same call path.

## Capabilities

### Modified Capabilities

- `llm-usage-accounting`: the attribution requirement gains the term it was missing — a record's `stepId` is only as good as the session the phase was given, so the capability has to state which sessions phases run under, not only what `runAgent` copies off them.

## Impact

- **Modified**: `workflows/execute-analysis.ts` — one derivation at the `synthesizeRun` call.
- **No schema change, no contract change**: `LlmUsageRecord` already carries `stepId`, and every consumer already groups by it.
- **Not retroactive**: rows already written for past runs keep `step_id` absent. This attributes calls from the next run onward; nothing backfills, and nothing should — the ledger records what was known when the call was made.

# Token Usage Tracking

## Why

The harness already measures token usage on every LLM call (`ChatUsage`) and sums it per `runAgent`, but then discards all attribution except `agent_id` and ships the counters to an OTel sink a local user never sees ([inflexa#243](https://github.com/inflexa-ai/inflexa/issues/243)). A user who hits excessive token consumption has no way to see which request, run, step, or model spent the tokens — and because the served model id from the provider response is dropped, no way to verify that the model that answered is the model they configured. Attribution is free at the point of capture: the provider call site holds the full session (`Scope`, `RunFrame`, `Provenance`) and the model id, and both are thrown away one step later.

## What Changes

- **`ChatUsage` gains `reasoningTokens`**, and **`ChatResponse` gains the served model id** reported by the provider response — the requested model and the model that actually answered become independently observable (the aliasing diagnostic the issue asks for).
- **A new harness-owned usage-accounting capability**: every LLM call produces a usage record carrying the reported `ChatUsage`, the requested and served model ids, and the session attribution already in hand (`agentId`, `callPath`, scope ids, `runId`/`stepId` when inside a run). Records are delivered through a new capability seam (`UsageRecorder`-shaped, sibling to `ResolveBilling`/`RunCharge`) with a no-op OSS default; an embedder realization persists or forwards them.
- **Usage surfaces on the existing event contracts**: every loop's chat `FinishEvent` carries its own usage rollup — the root loop's finish additionally the full-turn total, sub-agents included — and the run-event stream carries per-step usage for analysis runs, so a host UI can display consumption live without owning the capture.
- **Replay-safe recording**: usage records produced inside DBOS workflow bodies are idempotency-keyed so a replayed body does not double-count.
- The existing OTel counters (`loop/metrics.ts`) are unchanged — the seam and events are additive surfaces over the same capture point.

Out of scope: cost/pricing computation (token counts only; no pricing dependency), task-adaptive model routing (the per-agent model roles already cover the configuration side; adaptivity is its own future change), and the CLI realization (SQLite persistence, TUI display, usage report command — a companion change in `cli/`).

## Capabilities

### New Capabilities

- `llm-usage-accounting`: per-call usage records with full session attribution, the `UsageRecorder` seam contract and its no-op default, replay-safe delivery under DBOS, and the usage surfaces on the chat finish event and the run-event stream.

### Modified Capabilities

- `harness-providers`: `ChatUsage` adds optional `reasoningTokens`; `ChatResponse` adds the served model id from the provider response. Absent-means-not-reported semantics unchanged.
- `harness-agent-loop`: the per-run usage requirement extends — beyond recording OTel counters keyed by `agent_id`, the loop reports each call's usage (and the run rollup on finish) through the usage-accounting capability.

## Impact

- `src/providers/types.ts`, `src/providers/ai-sdk.ts` — `ChatUsage`/`ChatResponse` extension; capture `reasoningTokens` and the response model id from the AI SDK result.
- New seam module (interface + no-op default, `billing/`, beside its cousins `ResolveBilling`/`RunCharge`) exported from `src/index.ts`; wired through `assembleCoreRuntime` (`src/runtime/assemble.ts`) and the deps bags down to the loop.
- `src/loop/run-agent.ts`, `src/loop/metrics.ts` — per-call reporting beside the existing `addChatUsage` fold.
- `src/contracts/chat-events.ts` — `FinishEvent` gains the own-usage rollup plus the root-only turn total; run-event parts (`src/contracts/chat-parts.ts`) gain per-step usage for analysis runs.
- Non-breaking: all new fields optional, the seam defaults to no-op, `assembleCoreRuntime` signature grows an optional seam.
- Embedders: none forced; the CLI companion change realizes the seam (SQLite + TUI display + report command).

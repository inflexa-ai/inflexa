## Context

The CLI contributes three tools to the conversation agent through the harness's host-tools seam. They ride the same dispatch path and the same event stream as the harness's own tools, which means they were always eligible for `describeCall` — the harness resolves a detail through the tool object it was handed, not through a table of names it owns. `detail-resolver.test.ts` already proves this with a constructed `run_inflexa`; the real tool simply never declared a hook.

The one genuine obstacle is specific to `run_inflexa`. The hook is synchronous and `computeDetail` runs it at the emit site, before dispatch. `classifyInflexaArgv` — which produces `c.argv`, the normalized argv the tool actually spawns — is `async` and runs inside `execute`. There is no path from the hook to `c`.

## Goals / Non-Goals

**Goals:**

- All three host tools make an explicit `describeCall` decision, as the new `defineTool` signature requires.
- `run_inflexa`'s chip shows the argv that will run, encoded the way the approval dialog encodes it.
- A tool chip reports the call's own duration when the harness supplies one.

**Non-Goals:**

- Renderer changes. `ToolBlock` already handles a detail and already renders a duration.
- Reconstructing durations for already-persisted turns.
- Hook coverage for harness-owned tools — the companion change.

## Decisions

### `run_inflexa` reuses the classifier's pure normalizer rather than reaching for the verdict

`toEffectiveArgv` (`inflexa_classify.ts:108`) is the whole of the classifier's argv normalization: a single element containing whitespace is tokenized quote-awarely back into words, and anything else passes through. `classifyInflexaArgv` calls it once, and the two runnable verdicts — `action` and `introspection` — carry that value as their `argv`. It is synchronous and pure.

The `malformed` verdict carries a message and no `argv` at all. Thus a rejected call has no verdict argv for the chip to read. That is a second reason the hook computes the value itself.

So the hook computes exactly what the verdict will carry, without needing the verdict: export `toEffectiveArgv` and call it. This is why the constraint above is not a blocker — the async part of classification decides *whether* the argv runs and under what policy, not *what* the argv is.

Rejected: describing `input.argv` raw, which is what issue #289's own cited test models. It is wrong for the case the normalizer exists to handle — a model that submits `["analysis list"]` as one element would have its chip read `analysis list` as a single quoted operand while the tool spawns two words.

Rejected: making the hook async, or deferring the detail until after `execute` resolves. Both require a harness contract change to fix one host tool, and the detail is deliberately fixed for a call's whole life — the renderer's own comment notes that the detail describes the call while the activity line describes the moment.

### The chip and the approval dialog encode an argv identically

The hook maps each element through `displayArgvElement`, the same function `execute` uses to build the approval prompt's `command` string. That function is already in `inflexa_tool.ts`, so no export is needed.

`run_inflexa`'s stated invariant is that what the user approves is exactly what runs. Two different renderings of one argv — quoted in the dialog, bare on the chip — would undercut that for precisely the inputs where it matters, the ones with embedded whitespace. The chip omits the leading `inflexa` the dialog carries, because the chip already prints the tool name beside the detail.

### The TUI prefers the event's duration but keeps its own

`event.durationMs ?? (Date.now() - startedAt)`. The harness field is optional, so the fallback is what keeps the TUI working against a harness that does not send it, and the local bracket is still correct to within the round for the single-call rounds that dominate ordinary chat.

Keeping `openTools` and its start stamp is deliberate: it is what the fallback needs, and it is also what pairs an unmatched `tool-finished` to its part. This change narrows what the stamp is used for; it does not remove it.

### `list_launch_dir` declines rather than inventing a line

Its `inputSchema` is `z.object({})`. Every call is byte-identical, so any detail it returned would be a constant — a restatement of the tool's own name, printed beside the tool's own name. `describeCall: "none"` is the honest declaration, and under the new signature it is a visible one: a reader sees the decision instead of an absence.

This is exactly the case the issue's own rejected "lint rule" alternative anticipated — some tools take no meaningful input — and it is the case the sentinel exists to express.

## Risks / Trade-offs

**The chip's argv can differ from the model's submitted argv.** → That is the intent, and it is the safer direction: the chip agrees with the approval dialog and with the spawn. A reader comparing the chip against the model's raw tool input in a debug log will see a difference for whitespace-bearing single elements only, which is the case where the raw form was misleading.

**`cli` cannot typecheck until the harness change ships.** → Expected and understood for a cross-subsystem change in this repo. `bun run harness:local` symlinks the working copy, so the same code is green locally while CI is red on the pinned version.

**A stale `durationMs` on a replayed workflow event would be preferred over a fresh local bracket.** → Not reachable from this surface. The TUI consumes the chat route's in-process emit, which runs on a passthrough step and never replays. The harness change documents the workflow-replay case as a bounded, diagnostic-only trade-off.

## Migration Plan

1. Bump the `@inflexa-ai/harness` pin once the companion change is released. Nothing below compiles before this.
2. Export `toEffectiveArgv`; add the two hooks and the one opt-out.
3. Switch the duration source in the emit adapter.

Rollback is per-item — the three tool declarations and the duration source are independent, though the pin bump underlies all of them.

## Open Questions

None.

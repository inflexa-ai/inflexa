# Design — tool call detail

## Context

The loop's `tool-started` event already carries `input: unknown` (`src/loop/types.ts`), and `run-agent.ts` populates it at both emit sites. An in-process embedder therefore already holds the raw input and drops it. The motivation for this change is not to move data to the host. It is to put the interpretation of that data beside the schema the compiler checks.

Three surfaces describe a tool call today, and none of them is typechecked:

| Surface | Code | Shape |
|-|-|-|
| Chat chip | `cli/src/tui/hooks/conversation.ts` | tool name only |
| Sandbox and profile activity line | `activityForTool`, `src/sandbox/sandbox-step-translate.ts` | name-keyed label plus a `Record<string, unknown>` field read |
| Sub-agent activity line | `subAgentActivityLabel`, `cli/src/modules/harness/chat_printer.ts` | `${agentId}: ${toolName}` |

Constraints inherited from the repository: the harness-first boundary rule, no new dependencies, neverthrow-first error handling, and the tool error contract in `harness-tools`.

## Goals / Non-Goals

**Goals:**

- One typechecked place per tool where the tool states what a call is doing.
- A detail that survives reload without persisting anything beyond the model transcript.
- A detail that reaches embedder-contributed tools, not only harness-owned ones.
- One source of truth for all three surfaces above.
- A reloaded failure that renders as a failure, and a rejected approval that does not render as a fault.

**Non-Goals:**

- Result-side summaries (`describeResult`) and the `warning` status tier — issue #281.
- Structured detail (`{verb, target}`) — see D1.
- Host rendering, the continuation-row layout, and the design gallery state — a separate change in `cli/`.
- Rollup or collapse of repeated calls. A detail describes one call.

## Decisions

### D1 — One string, not a verb and a target

`describeCall` returns `string`. The contract is harness-owned, so it can widen later without breaking a host.

The one real argument for structure was truncation. A renderer handed one opaque string can only cut from the right, which destroys the filename in `runs/2026-07-30/step-2/output/summary.md` — the most useful part. The `cli/` change answers that with a continuation row: the detail stays on the name line when it fits, and drops to an indented row when it does not, so nothing truncates. Structure buys nothing more once the string is never cut.

Alternative rejected: ship `{verb, target}` now. It puts three name-like fields on one line (tool id, verb, target) unless the verb replaces the tool id, and a verb that replaces the tool id gives a ragged transcript while any tool lacks the hook.

Consequence accepted: a host must not parse the detail string. That would recreate the coupling this change removes.

### D2 — The emit site normalizes; a tool never does

Each tool returns whatever reads best. One choke point in the loop then applies, in order: collapse to a single line, strip control characters, redact secrets with the existing sanitizer, and cap the length.

The cap is **120 characters**. A full workspace path with a line range fits, and the value is far below any payload. `write_file` content and similar large fields cannot reach a host through this channel even if a hook author returns them.

Alternative rejected: each tool enforces its own limits. Thirty tools would each get it slightly wrong, and a leak would then be a tool bug rather than one auditable line.

### D3 — The hook is synchronous and receives validated input

`describeCall(input: z.infer<Schema>) => string` is synchronous. An asynchronous hook invites I/O on the dispatch path, and dispatch is what the user is waiting on.

The emit site runs `inputSchema.safeParse` before it calls the hook, and calls the hook only on success. This matters because `run-agent.ts` emits `tool-started` **before** `dispatchTools` validates anything — so the raw value at the emit site is unvalidated model output. Without the parse, the hook's declared input type would be a lie and a malformed call would run author-written code over arbitrary shapes.

Consequence accepted: `run-agent.ts` repairs a malformed input (`repairToolInput`) after the emit site has already run. A call that only succeeds after repair therefore emits no detail, and its chip renders as it does today. This is a rare recovery path, and the alternative — computing the detail twice, once per emit site, with the second from post-repair input — costs more than the case is worth.

### D4 — Best-effort means the caller never observes a hook failure

The loop wraps every hook call in `try`/`catch`. A hook that throws, returns a non-string, or returns an empty string yields no detail. The loop logs at `debug` through the injected `Logger` and dispatches the tool unchanged.

A description is a diagnostic. It must never be able to fail a call.

### D5 — The resolver is built over a supplied tool list

`createDetailResolver(tools: readonly Tool[]) => (toolName: string, input: unknown) => string | undefined`.

The live path holds the resolved `Tool` at dispatch and needs nothing. The reload path (`contentToCortexMessages`) does not, and a name map internal to the harness could never see an embedder's tools — `run_inflexa` is defined in `cli/` and enters through the `hostTools` seam. The caller therefore supplies the list, the same way it already supplies `createCardResolver`.

This also removes the duplicate-id hazard. Two tools share the id `write_file` (`workspace/write-file.ts`, `report/version-fs.ts`). A resolver built from one agent's list cannot hold both, because `createRegistry` already rejects a duplicate id within one list.

`contentToCortexMessages` takes the two resolvers as one options object rather than a growing positional list.

### D6 — The tool-finished outcome is three-way

`tool-finished` reports `outcome: "ok" | "error" | "denied"` in place of `isError: boolean`.

`isErrorOutput` (`run-agent.ts`) folds `execution-denied` into the same boolean as `error-text`, so rejecting an approval renders as a fault. The `harness-agent-loop` spec already states that a denial is distinct from a recoverable tool error — it terminates the turn rather than being retried. That distinction exists in control flow and is lost in the observation channel. This extends it to the event.

Alternative rejected: add a separate `denied: boolean` beside `isError`. It makes two fields express one three-state fact and admits the impossible `{isError: false, denied: true}`.

Consequence accepted: this is breaking for any consumer reading `isError` on that event. The only in-repo consumers are `cli/src/tui/hooks/conversation.ts` and `cli/src/modules/harness/chat_printer.ts`.

### D7 — Reload recovers the outcome by pairing, not by new storage

The failure is already persisted. `errorResult` writes `output: { type: "error-text", value }` onto the `ToolResultPart`, and that part is stored. `content-to-cortex.ts` then drops every `tool-result` block, so `genericToolCall` never sees it and every reloaded call reports success.

The converter indexes the `tool-result` blocks of a turn by `toolCallId` and reads `output.type` when it builds each tool-call part. Storage is unchanged, and no migration is needed.

### D8 — activityForTool resolves through the same hook, and keeps the tool name

`activityForTool` keeps its name and its two callers, and delegates to the resolver. Its name-keyed `TOOL_ACTIVITY` table and its `Record<string, unknown>` field reads are deleted.

Its callers are workflow bodies for sandbox agents, whose tool lists differ from the conversation roster. Each caller supplies its own agent's tools, per D5.

The phrase is `name`, then the detail when one resolves; a hookless tool yields the name alone. **The name is not decoration here.** This phrase renders on its own, with nothing beside it, whereas a chat chip prints `▸ name` and can afford a bare detail. `write_file` and `edit_file` both describe a call by its path, so a detail alone would render a write and an edit of one file as the same string — reintroducing, one surface over, the indistinguishable-call problem this whole capability exists to remove.

No verb is prepended. The phrase rides a part that already carries the step phase, so "Running" would restate what the part already says. The cost is accepted: the old table's hand-written prose (`Writing file x.csv`) reads more naturally than `write_file x.csv`, but that prose was exactly the unchecked, drift-prone mapping being deleted, and it cannot be kept without keeping the table.

**Deleting the table obliges this change to cover what the table covered.** `activityFileName` was not keyed by name for the file part: it appended the base name of ANY input carrying a `path` field. So `grep` and `list_files` already showed a file name on the activity line without ever appearing in `TOOL_ACTIVITY`, and a hook roster drawn only from the table's named entries would leave those two strictly less informative than before. They get hooks here for that reason. The rule generalises: a surface a generic fallback covered needs per-tool coverage before that fallback is removed, because the tools it silently served do not announce themselves.

Two further costs of the deletion, both accepted:

- **The phrase names a path, not a base name.** `baseName(script)` gave `run.py`; the hook gives `scripts/run.py`. The longer form is right for a chat chip, where two steps' `run.py` are otherwise the same string, and it is merely longer on the activity line. One reduction rule cannot serve both surfaces, and the hook is the surface-independent one.
- **`grep` names two fields where the old label named one.** `pattern in path` is longer than `Searching files x.csv`, and it has to be: one pattern over two trees and two patterns over one tree are both ordinary sequences, so either field alone reproduces the indistinguishable-call problem.

## Risks / Trade-offs

**A hook leaks a secret into a transcript** → Redaction runs at the single emit site (D2), not in tool code, so coverage does not depend on thirty authors. `run_inflexa` argv and workspace paths are the realistic carriers.

**The wire vocabulary stays unexercised** → `CortexChatEvent` has no consumer in this repository (recorded in `cli/openspec/changes/archive/2026-07-08-embed-conversation-agent/design.md`), so `detail` and the outcome on those types cannot be caught by an in-repo test. Mitigation: the Zod schemas in `src/contracts/schemas/chat-events.ts` are updated in the same change and are unit-testable on their own, and the wire types are declared from the same source of truth as the loop event.

**Hook coverage stays partial and the transcript reads ragged** → Accepted and transitional. The conversation roster holds about 30 tools; this change covers the highest-ambiguity ones plus every tool the deleted `activityFileName` fallback served (D8), and the rest degrade to today's rendering.

**A hook's own schema throws during validation, and the throw escapes** → The detail is computed under a guard that wraps the `safeParse` as well as the hook call. `safeParse` returns an error for a rejected value but THROWS for a schema it cannot run synchronously — an async refinement, or a refinement whose own predicate throws. A tool list is open by design (an embedder contributes through the host-tools seam), so such a schema is reachable, and a parse outside the guard would carry that throw out of the loop and end the turn — the one outcome D4 forbids.

**A hook author encodes structure into the string** → A host that parses it recreates the coupling D1 removes. Mitigation: state the prohibition in the spec, and treat any delimiter convention appearing in a hook as the signal to widen the contract to `{verb, target}` deliberately.

**`safeParse` at the emit site costs one extra validation per tool call** → Zod validation on an already-small input is far below the model round trip that produced the call. The parse also runs only when the tool declares a hook.

## Open Questions

None. The one question this design carried — whether the sub-agent activity line composes the detail — is settled below.

### Settled: the sub-agent activity line keeps agent plus tool name

`subAgentActivityLabel` is a `cli/` function, so the composition was never the harness's to make; the harness's only obligation is that the event carries the detail, which it does for sub-agents too (a sub-agent is an ordinary `runAgent` call through the same emit sites).

The line stays at `${agentId}: ${toolName}` for now, because the value of composing the detail scales with hook coverage and coverage is thin exactly where this line appears. The literature reviewer's roster is `searchGene`, `lookupAnnotation`, `searchInteractions`, `pubmed`, `drugGeneInteractions`, `genePreclinicalProfile`; this change hooks two of the six. A line whose whole job is to show that a long call is still moving, but which changes for only a third of calls, is worse than one that is honestly static — the reader cannot tell a frozen line from a frozen agent.

When the remaining bio tools carry hooks, compose the detail with a cap for that line specifically. Truncating there is cheap and does not contradict the never-truncate rule the transcript row follows: the activity line is ephemeral by contract and disappears the moment the call finishes, so nothing is permanently lost.

## Implementation record — what this change does NOT do

This change is **harness-only**. `cli/` is deliberately untouched and does not typecheck against this harness until its own change lands. What remains for `cli/`:

- **The `outcome` migration.** `cli/src/tui/hooks/conversation.ts:502` and `cli/src/modules/harness/chat_printer.ts:307` read `isError` on `tool-finished`. That field no longer exists (D6); both sites read `outcome` instead, and a `denied` call must render as the user's decision rather than as a fault.
- **The continuation-row layout.** D1 rests on it: the detail stays on the name line when it fits and drops to an indented row when it does not, so nothing truncates. The 120-character cap is a safety valve against a runaway hook, not a display truncation.
- **The design gallery state** for the new row.
- **The reload resolver wiring.** The cli holds the composed roster at `HarnessRuntime.conversationAgent.tools` and passes `createDetailResolver(tools)` into `contentToCortexMessages` as `{ resolveDetail }`. `contentToCortexMessages` now takes ONE options object (`{ resolveCard?, resolveDetail? }`) instead of a positional `resolveCard` — every cli call site changes shape.
- **The open question above**, which only the rendering side can settle.

Two consequences of the harness work that the cli change inherits:

- The activity line for a hooked tool is the tool name plus its own description (`write_file scripts/run.py`), not a name-keyed verb phrase (`Writing file run.py`). The `TOOL_ACTIVITY` table that produced the verb is deleted — one source of truth was the point — and a hookless tool reads the bare tool name. See D8 for why the name leads and for what the deletion obliged.
- A tool call that only succeeds after `repairToolInput` emits no detail (D3). This is the accepted loss; do not add a second computation in the cli to recover it.

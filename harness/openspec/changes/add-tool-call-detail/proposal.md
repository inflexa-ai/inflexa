# Let tools self-describe a one-line call detail

## Why

A host renders a live tool call as a name, a status, and a duration. When the conversation agent writes three working-memory entries and retires one, the transcript shows four identical `update_working_memory` chips. The same ambiguity covers `run_inflexa` (which argv?), `workspace_search` (which query?), and every other tool. See issue #174.

Forwarding the raw input and formatting it in the host is the wrong repair. The input schema is typechecked in the harness; a host-side formatter reads it by string key and breaks silently as the schema moves. Every embedder would also write the same formatter again, against the harness-first boundary rule.

The harness already carries this defect in one place. `activityForTool` (`src/sandbox/sandbox-step-translate.ts`) maps a tool name to a label and then reads `input.path` or `input.command` through `Record<string, unknown>`. It is name-keyed, unchecked, and far from the schemas it interprets. Two callers depend on it.

Two adjacent faults make the existing status untrustworthy, and both live in the code this change already touches:

- A reloaded tool call always renders as a success. The loop persists the failure as an `error-text` output on the `tool-result` block, and the converter discards that block.
- A user who rejects an approval sees a failure. `execution-denied` is folded into the same `isError` boolean as a genuine fault, although the loop already treats the two differently for control flow.

## What Changes

- `defineTool` accepts an optional `describeCall(input) => string` hook, colocated with the Zod `inputSchema` and typechecked against the exact input type. The tool author writes it, because the tool author knows which field matters.
- The loop computes the detail at dispatch, best-effort. A hook that throws or returns an unusable value never breaks the tool call.
- The emit site — not each tool — normalizes the detail: one line, control characters removed, secrets redacted, and a length cap.
- `tool-started` and `tool-finished` carry `detail?: string`. A tool with no hook emits no detail and renders exactly as today.
- `tool-finished` reports a three-way outcome (`ok`, `error`, `denied`) instead of a boolean, so a rejected approval stops reading as a fault. **BREAKING** for any consumer reading `isError` on that event.
- A registry-backed resolver maps `toolName + input → detail`, built over a supplied `readonly Tool[]` so embedder-contributed tools resolve too. It serves the live activity surfaces and the startup migration of turns stored before display was recorded — not a transcript read. A detail is display data, and is replayed from the record made when it was produced (`conversation-display-storage`); deriving it again at read time would let a schema change rewrite what a past turn appears to have done.
- `activityForTool` resolves through the same hook, so the sandbox and data-profile activity lines stop carrying a second, unchecked copy of this logic.

## Capabilities

### New Capabilities

- `tool-call-detail`: a tool describes its own call in one line. Covers the hook contract, best-effort computation, emit-site normalization, and the shared name-plus-input resolver.

### Modified Capabilities

- `harness-tools`: `defineTool`'s packaged fields gain the optional `describeCall` hook.
- `harness-agent-loop`: the `tool-finished` observation reports a three-way outcome, extending to the event the denial-versus-error distinction the loop already makes for control flow.

## Impact

Harness source:

- `src/tools/define-tool.ts` — the hook on `ToolDefinition` and `Tool`.
- `src/loop/types.ts`, `src/loop/run-agent.ts` — computation, normalization, and stamping at the two emit sites.
- `src/contracts/chat-events.ts`, `src/contracts/schemas/chat-events.ts`, `src/contracts/message.ts` — `detail` and the outcome on the wire vocabulary.
- `src/memory/content-to-cortex.ts` — tool-result pairing and the detail resolver seam, both reached only by the startup migration.
- `src/sandbox/sandbox-step-translate.ts` — `activityForTool` resolves through the hook.
- First hook coverage on the conversation roster: `update_working_memory`, `workspace_search`, `read_file`, `inspect_run`, `pubmed`, `search_gene`, `execute_analysis`.

Consumers: the `tool-finished` outcome change is breaking. The CLI reads these events in process (`cli/src/tui/hooks/conversation.ts`). It does NOT need to build a resolver: the detail and the outcome are recorded into the turn's display projection as they are emitted, so a reloaded transcript carries both without the host wiring anything. Host rendering, the detail row layout, and the design gallery state are a separate change in `cli/`.

Out of scope: result-side summaries (`describeResult`) and the third `warning` status tier for ok-channel outcomes. Both are tracked in issue #281, which depends on this change.

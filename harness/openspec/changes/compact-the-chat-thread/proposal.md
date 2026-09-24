## Why

The chat thread keeps its history window under a budget of 120,000 tokens (`src/app/message-assembly.ts` line 55). `loadRecent` evicts the oldest turns in blocks of 4 turns (`src/memory/thread-history.ts` lines 597-650). The eviction has these costs:

- An evicted turn leaves the context with no trace. The agent loses the decisions, the file paths, and the run ids of that turn.
- Each block shift changes the first message of the window. Thus the next request writes the whole message prefix to the cache again.
- Claude Opus 5.5 binds each signed thinking block to the exact prefix of its request. After a shift, each kept thinking block is invalid. With the mode `drop_block`, the API drops that block and each later block of the request.
- A report thread keeps its seed with `keepFirstTurn` (line 633). But it loses each turn between the seed and the window, with no trace.

## What Changes

- Client-side compaction of the chat thread replaces the eviction in blocks of 4 turns. The store deletes nothing. Stored markers decide what the harness sends.
- `RunAgentOptions` gets the compaction policy `compaction`. Before each request of the task segment, the loop estimates its view. When the view exceeds the budget, the loop compacts before it sends the request.
- The compaction is a continuation of the conversation: the same system prompt, the same declared tools, the same provider, and the same effort. Thus the view is a cache hit, and only the new round and the output cost.
- The mask of the compaction lets only `update_working_memory` run. The request tells the model to move each lasting fact into working memory first. Then the model writes a summary as a plain text reply.
- A report thread reads a frozen copy of working memory. Thus its compaction uses the mask `"none"` and a request with only the summary step.
- The loop stores the exchange of the compaction with a mark, and then a summary marker. The view then starts at the marker: the seed of a report thread, the summary as a tagged user message, the context records, and then each later message.
- A second compaction continues the view that starts at the previous summary. Thus the model folds the previous summary into the new summary.
- The exchange can give no text within 4 requests, or the provider can refuse its request with a `400` or a `413`. Then a drop marker keeps the last good summary in front and drops the oldest turns.
- The loop logs each drop at `warn`. A drop for a refusal also gives the HTTP status and the error text of the provider, thus a false drop is visible.
- A kept message that the harness made before the drop marker loses its thinking in the view.
- An abort, an `auth` error, a `suspend` error, or a transient error of the exchange does no drop. The error goes up, the turn fails as it does today, and the next turn compacts again.
- A new data part, `data-compaction`, reports each compaction: `running`, and then `done` or `failed`, with the tokens before and after and the duration. After a reload, each stored marker shows as a divider.
- The records of a compaction join the turn and go through the round sink. The host needs no new call.
- `runChatTurn` turns the compaction on for the root conversation loop only. The budget is 150,000 tokens, and a host can pass a different budget with the parameter `conversationBudget`.
- **BREAKING** `ThreadHistory.loadRecent` loses its `tokenBudget` parameter. It gives the view of the latest marker, with no budget.
- **BREAKING** `CortexChatPart` gets the member `CompactionPart`. A consumer with an exhaustive switch over the union must add a case.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `harness-agent-loop`: the compaction policy, the trigger, the exchange, the summary marker, the fallback drop, and the `data-compaction` part.
- `harness-thread-history`: `loadRecent` gives the view of the latest marker. Also the sequence rules of the view, the thread-overflow metric, the budget measure, and the divider of the transcript read.
- `ai-sdk-message-storage`: the marks of an exchange message and of a marker.
- `harness-working-memory`: working memory holds the lasting facts across a compaction.
- `report-session-agent`: the view of a report turn keeps the seed in front of the summary.
- `chat-turn`: the root loop of a chat turn compacts at the conversation budget, and the turn stores the compaction rounds. A compaction request can come after the opening.

## Impact

Harness source:

- `src/memory/ai-sdk-message-storage.ts`, the new `src/memory/conversation-view.ts`, and `src/memory/thread-history.ts`.
- `src/memory/conversation-display-storage.ts` and `src/memory/conversation-display-recorder.ts`.
- `src/contracts/chat-parts.ts`, `src/contracts/schemas/chat-parts.ts`, and `src/contracts/part-registry.ts`.
- The new `src/loop/compaction.ts`, and `src/loop/run-agent.ts` and `src/loop/continue-agent.ts`.
- `src/app/chat-turn.ts`, `src/app/message-assembly.ts`, and the new `src/prompts/compaction.ts`.
- The comments of `src/memory/count-tokens.ts` and `src/providers/prompt-cache.ts`.
- `src/index.ts`, `CONTEXT.md`, and `CLAUDE.md`.

Database: no new table and no new column. A marker is a row of `messages`, and its marks ride in the harness namespace of `providerOptions`. No backfill runs.

CLI: the CLI must render the part and the divider. The CLI compiles with no change, but its adapter shows each unknown data part as a tagged mention (the `tui-harness-chat` spec). Thus the CLI change `render-the-chat-compaction` in `cli/openspec` changes the CLI specs, and group 7 of the tasks holds its work. The live part shows `Summarizing earlier conversation…` and changes with its status. After a reload, each stored marker shows as a divider.

The CLI files are `cli/src/types/session.ts`, `cli/src/modules/harness/chat_printer.ts`, `cli/src/tui/hooks/conversation.ts`, `cli/src/tui/layout/message_block.tsx`, and `cli/src/tui/layout/design_gallery.tsx`. The new file is `cli/src/tui/components/compaction_block.tsx`.

Consumers:

- A host that calls `loadRecent` with a budget must remove the budget. The CLI calls it only in fakes with no parameter.
- Cortex renders the `data-compaction` part and the divider when it bumps the pin.
- The usage records and the token counters get the agent ids `conversation-agent-compaction` and `report-session-compaction`.

Dependencies: this change builds on `update-the-provider-layer-for-current-models`, `keep-each-agent-conversation-append-only`, and `save-each-chat-round-and-add-context-on-change`. The deltas use the round sink, `runChatTurn`, the context records, the continuation, and the tool mask of those changes. Archive those changes before this change.

Release. The user starts the harness release after the merge. The change does not change the version in `package.json`.

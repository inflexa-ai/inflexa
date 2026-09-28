## Context

The chat thread compacts its view when the view exceeds a budget (`compact-the-chat-thread`). The budget compared the estimate of `js-tiktoken` with 150,000. The estimate did not see these costs:

- the system prompt and the declared tools
- each picture of a tool result, which counted as 0
- the difference between the encoding of `js-tiktoken` and the tokenizer of the provider

A report session on staging showed the result. The estimate gave 141k tokens when the provider billed 302k tokens, and no compaction started.

The look of the report agent added a large cost. One look captured slices of 1440 by 1800 pixels. Six slices cost about 20k tokens and showed 68% of the page. The pictures stay in the view, thus each later request of the turn sent them again. The agent also looked at the whole page after each repair.

## Goals / Non-Goals

Goals:

- Compare the budget with the tokens that the provider counts.
- Compact at the start of a turn when the prefix is still a cache hit.
- Make one look hold a whole report for fewer tokens, and let a look after a repair hold one block.
- Remove the tool output that the agent does not use from each result.

Non-Goals:

- No tokenizer of the provider in the harness. The check uses the figure that the provider reports.
- No local estimate for the check.
- No change to the look-before-record rule. A block look is a look at the current document.

## Decisions

### The check reads the input tokens of the last request

The provider reports the total input of each request, with the cache reads (`src/providers/types.ts`). That figure holds the system prompt, the tools, and the pictures at the rate of the provider. The loop stores it on the assistant message of the reply, in the harness namespace. Thus the figure survives the store, and the next turn reads it back.

Before a request, the loop compares the budget with the latest figure. A marker changes the conversation, thus a figure from before the latest marker does not describe it. When no figure comes after the latest marker, the loop makes no check. The next request reports a figure, and the check before the request after it uses that figure.

The check sees the tool results of the last round one request late. The budgets are far below the context window, thus a compaction starts at most one request later. A local estimate of that tail must count each picture, and each provider bills a picture at its own rate. Thus the check uses the figure of the provider alone, and the harness keeps no picture count.

The rollup of a turn is not a figure for the check. It adds the input of each request of the turn, thus it counts one prefix many times.

### The rules belong to the agent

`AgentDefinition.compaction` holds the rules (`CompactionRules`): `budget`, and an optional `turnStartBudget`.

| Agent | Turn-start budget | Budget during a turn |
|-|-|-|
| `conversation-agent` | 150,000 | 200,000 |
| `report-session` | none | 250,000 |

At the start of a turn, the view is the prefix that the previous turn sent. Thus an exchange on that view reads it from the cache. The same compaction in the middle of a turn writes a new prefix after the tool results of the turn. The higher budget during a turn lets a long turn continue with no compaction in the middle.

A report session is one long turn that holds page captures. Thus it compacts only during the turn, at a higher budget. The budget depends on what the agent carries, thus the rules are a property of the agent. An agent with no rules never compacts. Only the agents of a chat thread declare rules.

The chat turn builds only the mechanism: the provider, the request, the mask, `keepFirstTurn` from the thread type, and the function of the context records. It takes no budget from the host.

### The loop appends the input of a turn after the turn-start check

`runAgent` takes the user message and its context records as `turnInput`. Before it appends the input, the loop compares the latest figure with the turn-start budget. Past that budget, the exchange continues the view before the input, and the marker and its records follow. Then the loop appends the input. The round sink gets it as one round, directly before the first request.

After a turn-start summary, the input drops its context records. The records after the marker restate the current context, thus a second copy only adds tokens. When the exchange gives no summary, no record follows, thus the input keeps its records.

The stored order is the sent order: the history, the exchange, the marker and its records, and then the user message. The summary marker keeps no turn, and the view rule of a summary does not change. The user message comes after the marker in its exact words. The compaction requests ask for the last request of the user, because a turn-start exchange does not see the new request.

### The rows of a turn-start compaction come before the turn

The turn record, the paged read of whole turns, and the tail retract read the user message as the first row of a turn. Thus the chat turn writes the rows of a turn-start compaction with `appendTurn`, before the turn opens. These rows get no turn record, and the turn opens at the user message.

A turn that ends before the loop sent its user message stores no user message and no turn record. An abort during the turn-start compaction is an example. The exchange stays in the store with no marker, and the next turn tries the compaction again.

### A summary that leaves the conversation over the budget stops the compaction

After a summary, the first figure of a request shows the size of the new view. When that figure still exceeds the budget, the run compacts no more, and the loop logs a warning. A second exchange on such a view gives no smaller view.

### A compaction with no summary fails, and it drops nothing

When the exchange gives no summary, the loop writes no marker and no records, and the view does not change. The loop stores the exchange, emits `failed`, and logs at `error` level. Then the run compacts no more, and the next turn tries again. When the context window then refuses a request, the turn fails, and the person continues with a new turn.

Before this change, such a compaction dropped the oldest turns. The drop hid the failure, because the turn continued and no alert saw it. A failed compaction is a defect to fix, not a state to work around. The `error` level lets the log alert "Workload logging errors above last week" see each failure.

The drop also could not make a report session smaller. A drop keeps the newest turn, and the newest turn of a report session is the whole session.

The loop writes no drop marker now. Harness 0.40.0 and later versions wrote drop markers into stored threads. Thus the marker schema keeps the `drop` kind, and the view keeps its rule for a stored drop marker.

### The marker and the part carry the figure of the provider

`tokensBefore` is the latest figure before the compaction. The marker carries the id, `tokensBefore`, the duration, and the trigger. No figure of the new view exists before the next request, thus the marker and the part carry no `tokensAfter`. The field stays optional in the contract only for a part that an older harness stored.

### The trigger rides the marker, the part, and the log

A compaction at the turn start and a compaction in the middle of a turn have different costs. The marker, the `data-compaction` part, and each log record carry `trigger`, thus an operator can count each kind. A marker from before this change has no trigger.

### The look renders at half scale in slices of 4,000 CSS pixels

The layout keeps the window of a reader, 1440 by 900 CSS pixels. The picture renders at a device scale of 0.5. A slice of 4,000 CSS pixels is a picture of 720 by 2000 pixels. That picture is under the long edge of 2576 pixels that the model reads with no downscale, and it costs 1,920 tokens.

Five slices hold 20,000 CSS pixels for about 9,600 tokens. The page of the staging run was about 16,000 pixels high. It now fits in 4 slices, for about 7,600 tokens.

### A look can hold one block

The renderer marks each block with `data-block`. A block look clips the union box of the marked elements, with a margin of 16 CSS pixels. Thus a look after a repair costs the pictures of that block alone.

A block look stamps the seen hash, because it looked at the current document. A block look with no picture stamps nothing. A refused bitmap of a block does not retry at the window, because the window shows the top of the page and not the block.

### The tool results give what the agent uses

- The fault digest gives one entry with a count for each fault that occurs again. It replaces inline data with a placeholder. A blocked inline font logs its whole base64 body, often many times.
- `finish_draft` gives no document on a pass. The document grows with the report, and the preview and the record read it themselves.
- The preview and the record give the warnings of the finish. Thus a finish directly before a preview is not necessary.
- The listing gives no hash, because a reference names the path alone. It gives the count of the columns, because a wide table can have hundreds of column names. A call with a path gives the names of one artifact.

### An add emits one event for each block

The prompt now tells the agent to add a whole section in one call. One event for the section would hide its atoms from a reader of the record. Thus the add emits one `add-block` event for each block that it lands, in document order.

## Risks / Trade-offs

- The figure comes from the latest request. A large tool result after it can take one request past the budget before the check sees it.
- A provider that reports no input tokens gives no figure. Thus a conversation on such a provider never compacts.
- A tail retract of a turn keeps the rows of its turn-start compaction, because they come before the user message. The next turn then starts at that summary.
- After a failed compaction, the run continues with no compaction. A long turn can then pass the context window, and the turn fails. The `error` record makes each such failure visible.
- A block look does not show a fault outside the block. The prompt asks for one whole-page look after the first preview that passes.
- A report page taller than 20,000 CSS pixels still truncates, and the coverage names the unseen tail.

## Migration Plan

No migration runs. A stored marker with no trigger reads as before, and the helper ignores its `tokensAfter`. A stored drop marker still changes the view as before. A stored divider keeps its status and its `tokensAfter`. A thread from before this change has no figure. Its first request reports one, and the check starts at the next request.

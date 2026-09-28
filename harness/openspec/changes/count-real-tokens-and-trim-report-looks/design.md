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

- No tokenizer of the provider in the harness. The measure uses the figure that the provider reports.
- No change to the drop of a failed compaction.
- No change to the look-before-record rule. A block look is a look at the current document.

## Decisions

### The measure starts at the input tokens of the latest request

The provider reports the total input of each request, with the cache reads (`src/providers/types.ts`). That figure holds the system prompt, the tools, and the pictures at the rate of the provider. The loop stores it on the assistant message of the reply, in the harness namespace. Thus the figure survives the store, and the next turn reads it back.

The measure is the latest figure after the latest marker, plus the estimate of that reply and of each later message. A marker changes the prefix, thus a figure from before the marker does not describe the view. Without a figure, the measure is the estimate, as before. Thus a host with no usage report still compacts.

The rollup of a turn is not a measure. It adds the input of each request of the turn, thus it counts one prefix many times.

### The estimate counts a picture by its area

The estimate still decides the tail after the figure, the `tokens` column, and the kept turns of a drop. A picture counts `ceil(width × height / 750)` tokens, the rule that Anthropic publishes. The size comes from the header of the data (PNG, JPEG, GIF, and WebP), and the reader decodes no pixel.

A picture of unknown size counts as 1,600 tokens, about the maximum that Anthropic bills for one picture after its scale-down. A count of 0 hid the pictures, and a count by the bytes made one picture cost tens of thousands of tokens.

### Two budgets for a conversation thread

| Thread type | Turn-start budget | Budget during a turn |
|-|-|-|
| `conversation` | 150,000 | 200,000 |
| `report` | none | 250,000 |

At the start of a turn, the view before the user message is the prefix that the previous turn sent. Thus an exchange on that prefix reads it from the cache. The same compaction in the middle of a turn writes a new prefix after the tool results of the turn.

The higher budget during a turn lets a long turn continue with no compaction in the middle. `conversationBudget` replaces the budget during a turn. It lowers the turn-start budget only when it is lower, thus the turn-start budget never exceeds the budget during a turn.

### A turn-start summary keeps the current turn

The exchange of a turn-start compaction does not see the current turn. Thus the marker carries `keptTurns: 1`, and the view keeps that turn after the summary. The user message then reaches the model in its exact words.

The kept turn loses its context records, because the records after the marker give the current context. It loses its reasoning, because the signature of a reasoning part binds the prefix that the marker changed. The compaction requests ask for the last request of the user, because that request can sit after the summary.

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

- The figure comes from the latest request. A tool result after it counts by the estimate until the next request reports.
- The picture count uses the rule of Anthropic. A different provider can bill a picture at a different rate. The figure of the next request corrects the measure.
- A block look does not show a fault outside the block. The prompt asks for one whole-page look after the first preview that passes.
- A report page taller than 20,000 CSS pixels still truncates, and the coverage names the unseen tail.

## Migration Plan

No migration runs. A stored marker with no trigger and no kept turns reads as before. A stored assistant message with no figure gives the estimate.

## Context

A chat turn sends a window of the stored history of its thread. `prepareChatTurn` calls `assembleMessages` (`src/app/message-assembly.ts` line 95). The assembly reads `loadRecent(threadId, 120_000, { keepFirstTurn })` (line 98). `loadRecent` (`src/memory/thread-history.ts` line 570) does these steps:

1. It groups the rows into turns at each genuine user start.
2. It walks from the newest turn, and it keeps each older turn while the sum of the `tokens` column fits the budget (lines 613-620).
3. It snaps the count of evicted turns up to a multiple of `EVICTION_BLOCK_TURNS`, which is 4 (lines 423 and 625).
4. For a report thread, it puts the first turn in front of the kept turns (line 633).

The snap holds the first message of the window still for 4 turns, and then it moves by 4 turns. Each move writes the message prefix to the cache again, and it makes each kept thinking block invalid. The evicted turns leave no summary.

This change is the fourth of a series:

- `update-the-provider-layer-for-current-models` gives the effort on the provider configuration, the session key, the thinking-binding mode, and the breakpoint at the end of the system prompt.
- `keep-each-agent-conversation-append-only` gives the tool mask and the continuation, `continueAgent`.
- `save-each-chat-round-and-add-context-on-change` gives the round sink `onRound`, the chat turn `runChatTurn`, the turn record, and the context records after the user message. It also gives the root loop the cache lifetime of 1 hour.

This change uses the code of the three changes. Its deltas use the text of the third change.

## Goals / Non-Goals

**Goals:**

- Keep the facts of an old turn after the turn leaves the view: in working memory and in a summary.
- Delete nothing from the store. The stored markers decide the view.
- Keep the view a cache hit up to the compaction, and keep each thinking block of the view valid.
- Show each compaction to the person, live and after a reload.

**Non-Goals:**

- Compaction of a workflow loop and of a sandbox loop, and a budget for it. A later change turns the same mechanism on for those loops.
- Large tool outputs. A later change keeps them out of the context.
- A server-side compaction of a vendor.

## Decisions

### The compaction replaces the eviction, and markers decide the view

The store keeps each row. The harness never deletes a row, and it never changes a row. The view of a conversation is a pure function of its messages. The rule reads the messages in order:

```text
head  = keepFirstTurn ? the first turn : []
        (the head ends at the next genuine user start, or at the first marker or exchange message)
front = none
body  = []
for each message after the head:
    exchange message  -> skip it
    summary marker    -> front = the marker, body = []
    drop marker       -> body = the last keptTurns turns of body, each message without its reasoning parts
    other message     -> append it to body
view  = head, then front, then body
```

The loop and the reader use one function, `conversationView` in the new `src/memory/conversation-view.ts`. The reader gives it the stored rows. The loop gives it the transcript of the run, which starts with the view that the reader gave. The view of a view is the same view. Thus the next turn reads the prefix that the last request sent, and the prompt cache reads it back.

The head ends at a marker or at an exchange message. Thus the rule finds the same head in the stored rows and in a view that starts with the seed and a summary.

`loadRecent` loses its budget. A thread with no marker gives each row. This design rejects a budget on the reader. A budget walk on the reader drops turns with no summary, and that eviction is the problem that this change removes.

`isGenuineUserStart` and `groupTurns` move from `thread-history.ts` to the new module, because the rule uses them. `GENUINE_USER_START_SQL` stays in `thread-history.ts`, beside the retract.

The thread-overflow metric stays. `turns_evicted` counts the turns whose messages the view holds none of.

### The trigger sits in the loop

`RunAgentOptions` gets an optional compaction policy:

```ts
export interface CompactionPolicy {
    /** The budget of the view, in estimated tokens. */
    readonly budget: number;
    /** The provider of the exchange: the provider of the conversation, with no text stream to the surface. */
    readonly provider: AgentChat;
    /** The text of the compaction request. */
    readonly request: string;
    /** The tools that can run in the exchange. */
    readonly mask: ToolMask;
    /** Keep the first turn in front of each view: the seed of a report thread. */
    readonly keepFirstTurn: boolean;
    /** The context records that come after a new marker, for the view that starts at the marker. */
    readonly recordsAfter: (view: readonly LoopMessage[]) => Promise<readonly LoopMessage[]>;
}
```

With a policy, each request of the run sends the view of the transcript. Without a policy, the loop sends the transcript, as before.

Before each request of the task segment, the loop estimates the view. The estimate is the sum of `countTokens(message.content)` over the messages of the view. The same function computes the `tokens` column of a row. The system prompt and the declared tools are outside the budget, as in the current history budget. When the estimate exceeds the budget, the loop compacts before it sends the request.

The loop estimates the view only before a request. It sends a request only after each tool call of the last reply has its result. Thus a compaction starts between two rounds, and never inside one.

The loop starts no compaction at these points:

- Before a wrap-up request. A compaction there puts two harness requests in a row.
- Inside a continuation. The exchange of a compaction is a continuation, thus it never compacts itself.
- Before a request that continues a truncated reply. The steer and the next reply complete one reply.
- After a compaction that failed in the same run, or after a compaction whose new view still exceeds the budget. A second attempt in that run gives the same result, and each attempt costs one exchange.

The first request of a turn can start a compaction. The view of the reader and the opening can exceed the budget, for example on a thread from before this change.

`runChatTurn` gives the policy to the root loop only. The budget is `DEFAULT_CONVERSATION_BUDGET`, which is 150,000 tokens. The parameter `conversationBudget` of `runChatTurn` replaces it. The compaction of the Anthropic API also starts at 150,000 tokens by default. A sub-agent loop, a continuation, and a workflow loop pass no policy. A durable loop passes no policy in this change, because the records hook reads the database outside a step.

### The exchange is a continuation of the conversation

The loop runs the exchange with `continueAgent` over the current view, with these values:

- The provider of the policy.
- The request of the policy, as a synthetic user message.
- The mask of the policy.
- A cap of 4 requests, `COMPACTION_MAX_REQUESTS`. The model can edit working memory in up to 3 rounds, and then it answers.
- The step namespace `compaction-<n>`, where `<n>` counts the compactions of the run from 0.
- The accounting agent id `<agent id>-compaction`, for example `conversation-agent-compaction`.
- The options of the run: the tool choice, the effort, the cache policy, the usage recorder, the logger, and the turn accumulator. The options hold no round sink and no compaction policy.

Thus the exchange sends the system prompt, the declared tools, the tool choice, and the effort of the conversation. The view is a cache hit, and only the new round and the output cost.

`runChatTurn` makes the provider of the policy with the factory of the host, `params.chat`, over an emit sink that drops each text delta. `createStreamingChat` sends each text delta to the surface with no source. Thus a host cannot tell a delta of the summary from a delta of a reply. The factory gives the same provider, the same model, and the same session key. Thus the cache and the thinking binding still hold.

The accounting id runs the exchange under `forSubAgent`. The usage records and the token counters then give the cost of the compaction its own agent id. The events of the exchange also get a deeper call path. Thus the display recorder skips them, and a host shows them as sub-agent traffic.

A refusal of the request must end the exchange, not the run. `resultStep` throws on an `err`, and `CLAUDE.md` names no catch site for a compaction. Thus the segment of the exchange reads the `Result` of its model call. `ContinuationRequest` gets the optional flag `endOnRequestRefusal`.

With the flag, a `provider` error with the HTTP status `400` or `413` ends the segment with the finish reason `error` and no new message. The result of the continuation keeps the status and the `message` of that error. Each other `err` goes through `unwrapOrThrow`, the same as in `resultStep`, thus it throws. No new catch site exists.

The loop marks each message of the exchange with the id of the compaction, and it appends the messages to the transcript. The summary is the text of the last reply of the exchange. That reply must end the exchange with the finish reason `stop`, and its text must not be empty.

### The request text

`src/prompts/compaction.ts` holds the request of a conversation thread. A draft:

```text
The conversation is too long for the context window. The harness replaces the conversation above with your summary.

First, move each lasting fact into the working memory with update_working_memory: the goal, each constraint, each hypothesis, and each finding with its run id. No other tool can run now.

Then reply in plain text with the summary. Leave out what the working memory holds. Give:
- the goals, and the current request of the user in its exact words
- the decisions, with their reasons
- the open questions
- the file paths and the run ids that the work uses
- the state of the work in progress

The conversation continues from your summary, the working memory, and the messages after them.
```

The summary gives the goals, the decisions, the open questions, the paths, and the run ids. The current request and the work in progress are parts of the goals. A compaction inside a turn puts the user message of that turn before the marker. Thus the summary must carry that request.

A report thread reads a frozen copy of working memory in its seed, and the report agent declares no `update_working_memory`. Thus the compaction of a report thread uses the mask `"none"` and a request with only the summary step. `runChatTurn` selects the variant from the declared tools of the agent.

### The summary marker and the new view

When the exchange gives a summary, the loop appends a summary marker. The marker is a synthetic user message with the tag `[Conversation Summary]`, a new line, and the summary. The tag has the form of the tags of the context records. The marker carries the synthetic mark, thus it opens no turn, and a tail retract removes it with its turn.

The new view is the head, and then the marker. The loop calls `recordsAfter` with that view, and it appends the records after the marker.

`runChatTurn` gives the context rule of the turn. The rule adds a record of each kind that the view holds no copy of, or whose hash differs from the latest copy. After a summary marker, the view holds no copy. Thus each kind comes back: the analysis context when it exists, the run activity, and the working memory on a conversation thread. The working-memory render then holds each fact that the exchange moved.

The loop gives the sink two rounds, and then it sends the next request with the new view:

1. The exchange, when the exchange ends.
2. The marker and its records.

The store holds the marker before a request sends it. The exchange is one round, because no later request sends a message of the exchange. A crash or a throw during the exchange loses only the exchange. The stored thread then holds no marker, and the next turn compacts again. The memory edits of a lost exchange stay in working memory.

### A second compaction continues from the previous summary

A second compaction continues the view that starts at summary N-1. The request asks for one summary of the conversation above, thus the model folds summary N-1 into summary N. The view rule counts only the latest summary marker. The exchange N comes after summary N-1 and before marker N, and no view holds it.

The tests pin these facts:

- Only the latest marker counts.
- Compaction N continues the view that starts at summary N-1.
- No request sends the exchange after the new marker.
- A report thread keeps its seed first.
- When compaction N fails, the drop keeps summary N-1 in front.

### The fallback drop

A drop is a lasting change of the view. Thus it runs only when the exchange itself cannot give a summary:

- The exchange gives no text within its cap of 4 requests. The last reply has no text, or it ends with a finish reason other than `stop`. The cap can also end the exchange after a tool round.
- The provider refuses a request of the exchange for its content: a `provider` error with the HTTP status `400` or `413`. A request that is too long for the context window gets such a refusal.

Then the loop appends a drop marker in place of a summary marker. The view keeps its head, and its latest summary marker when one exists. The drop marker carries the count of the kept turns. The loop counts them with a walk over the turns of the body, from the newest turn. It keeps the newest turn, and it adds each older turn while the estimate of the view stays within the budget. The walk is the budget walk of the current `loadRecent`, with no block snap.

A kept message that the harness made before the drop marker loses its reasoning parts in the view. The signature of each such part binds the prefix that the drop changed. With `drop_block`, one invalid block makes the API drop each later block of the request, thus the new blocks go too. A message after the drop marker keeps its reasoning. The stored rows do not change.

The drop marker is a synthetic user message with the text `[Compaction Failed]`. The view never holds it, because the kept turns and the summary give the view. After the drop marker, the loop appends the records of `recordsAfter`, and it gives the sink the same two rounds as for a summary. The exchange can change working memory before it fails, and the context rule then adds the new render.

The loop logs each drop at `warn`. A drop for a refusal also gives the HTTP status and the error text of the provider, the `message` of the `ProviderError`. Thus a false drop is visible.

After a drop, the loop starts no other compaction in the run. The next turn tries again at its first request.

Each other end of the exchange does no drop:

- An abort. The chat of the exchange gives the finish reason `aborted`. The loop stores the exchange and no marker, emits `failed`, and ends the run with the finish reason `aborted`.
- An `auth` error, a `suspend` error, a transient provider error that the retry envelope did not fix, and each other error. The error goes up, and the turn fails as it does for an error of a task request.

The next turn then tries the compaction again, because the thread holds no new marker. The view ignores an exchange with no marker, because each message of it carries the exchange mark.

### The marks

`src/memory/ai-sdk-message-storage.ts` holds the marks, in the harness namespace of `providerOptions`:

- `compactionExchange`: the id of the compaction, on each message of an exchange.
- `compactionMarker`: the kind, `summary` or `drop`, the id, the tokens before and after, and the duration. A drop marker also carries `keptTurns`.

A provider reads only its own namespace, thus no mark reaches the wire. A mark on an assistant message merges into the harness namespace. It keeps the `anthropic` namespace, which holds the signatures.

### The data part and the divider

The loop emits `data-compaction` through its `emit`, with the source of the run, not the source of the exchange:

```ts
export interface CompactionPart {
    type: "data-compaction";
    id: string;
    status: "running" | "done" | "failed";
    tokensBefore: number;
    tokensAfter?: number;
    durationMs?: number;
}
```

`running` goes out before the exchange. One terminal status goes out under the same id: `done` after a summary marker, or `failed` after a drop marker, an abort, or a throw out of the exchange. A `finally` block emits `failed` for a throw, and the throw passes through. `tokensAfter` is the estimate of the new view, when a marker exists.

The registry entry is `conversation` / `conversation` / transient / reconciling. The display recorder skips a transient part, thus the live updates do not join the assistant message of a round.

The row of the marker carries the divider as its display projection. The divider is one `system` message with one `data-compaction` part at its final status. `takeRound` of the display recorder makes it from the marks of the marker. `takeRound` also ignores the text of an exchange message, thus the summary never shows as a reply.

The transcript replay needs no change, because it gives each stored envelope in order. The stored display vocabulary gets the key `compaction`. Without the key, the read drops the part as a retired key.

The divider sits between two rounds of one turn. The replay merges two assistant messages only when they are adjacent. Thus the turn shows as two assistant messages with the divider between them. After a marker round, the recorder gives the later rounds a new assistant id, thus no two messages of the replay share an id.

### The records join the turn

The exchange round and the marker round go through the round sink of `runChatTurn`, one transaction for each round. The rows belong to the turn that made them. Thus a tail retract removes the exchange and the marker with their turn, and the view goes back to the previous marker. The host makes no new call.

The first request of a turn can be a compaction request. The `chat-turn` delta lets a compaction request come directly after the opening.

### The CLI renders the part and the divider in the same pull request

The CLI compiles with no change. Its fakes of `loadRecent` take no parameter, and no CLI code maps each part type. But the adapter of the TUI shows an unknown data part as a tagged mention (`cli/src/tui/hooks/conversation.ts` lines 647-658). Thus a live compaction shows `[part:data-compaction]` two times, and a reload shows it one time as an event.

The CLI change `render-the-chat-compaction` in `cli/openspec` holds the specs of the CLI work, the same pattern as `adopt-the-harness-chat-turn`. Group 7 of the tasks holds the work:

- The live part shows `Summarizing earlier conversation…` while the status is `running`. The same part changes into a divider with the result at a terminal status.
- After a reload, the stored marker shows as the same divider, as an event entry that is not a turn.
- A new compaction block renders the two forms, and the design gallery shows each form.

A compaction part closes the retract gate of the turn, the same as each other part. The dev REPL keeps the tagged mention.

## Risks / Trade-offs

- [The estimate differs from the count of the vendor] → `countTokens` uses `cl100k_base`, thus the budget is a soft target. A host can pass a lower budget.
- [A compaction at the first request of a turn] → The user message sits before the marker, and the model reads it only through the summary. The request asks for the exact words of the current request.
- [The model leaves a fact out of the summary] → Working memory holds the lasting facts, and the store keeps each message. `inspect_run` still gives each run.
- [A thread from before this change exceeds the context window] → The reader sends each row. The provider refuses the first exchange with a `400`, and the drop keeps the newest turns within the budget. The thread pays one refused request one time.
- [A `400` of the exchange that is not about the length] → The loop drops for it too, because a status does not say why. The warn of the drop gives the status and the error text of the provider, thus a false drop is visible. A false drop costs little, because the store keeps each row and the previous summary stays in front.
- [An error that goes up during the exchange] → The turn fails, and the next turn compacts again. A transient error can thus cost one exchange more.
- [The exchange costs one request] → The view is a cache hit. The exchange writes only the last round and the request, and it pays the output. The next request writes the new view one time.
- [The 1-hour write of the exchange] → No later request reads the exchange, thus that write is lost. It holds only the last round and the request.
- [A failed compaction loses turns from the view] → The drop keeps the newest turns and the last good summary, and the store keeps each row. The divider shows `failed`, and the loop logs a warn.
- [A long summary and a head exceed the budget] → The loop stops the compaction for the rest of the run, and it logs a warn.
- [The deltas build on changes that are not archived] → The `chat-turn` delta and the `report-session-agent` delta use the text of `save-each-chat-round-and-add-context-on-change`. Archive the three earlier changes first.

## Migration Plan

No data migration is necessary. A marker is a row of `messages`, and no column changes. A thread from before this change has no marker. The reader sends each row, and the first request over the budget compacts.

A rollback to an earlier version reads a marker and an exchange message as plain messages. The budget walk of that version then sends them as history. The display read of that version drops the `data-compaction` part as an unknown key, and it logs a warn.

A delta cannot change the Purpose of a spec. Write these Purpose sections again when this change archives:

- `harness-thread-history`: the sentence on the walk to a token budget.
- `harness-working-memory`: the phrase on the layer that survives the eviction of the token window.

## Open Questions

None. The owner decided each question:

- A report thread reads a frozen copy of working memory. Thus its compaction uses the mask `"none"` and a request with only the summary step.
- The drop runs only when the exchange itself cannot give a summary. An abort, an `auth` error, a `suspend` error, and a transient error do no drop. The error goes up, and the next turn compacts again.
- The CLI renders the part and the divider in the CLI change `render-the-chat-compaction`, in the same pull request.
- The drop keeps the status rule of harness-providers: each `400` and `413` of the exchange. The exchange continues a view that the provider accepted one request earlier, thus such a refusal is almost always a length refusal.
- A body code can hide behind a gateway. A missed drop can leave a thread stuck, because each later compaction sends the same view that is too long. A false drop costs less.

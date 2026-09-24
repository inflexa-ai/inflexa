## Context

A host drives the chat turn in three parts today (`cli/src/modules/harness/turn.ts`):

1. `prepareChatTurn` (`src/app/chat-turn.ts` line 59) resolves the ownership of the thread, seeds the title, and assembles the messages. It writes only the thread row.
2. The host runs `runAgent` with its own emit sink and its own display recorder.
3. The host calls `appendTurn` one time, with `[userMessage, ...loop output]` (`turn.ts` line 358).

`assembleMessages` (`src/app/message-assembly.ts` lines 122-147) builds this array: the history, the analysis context, the run activity, the working memory, and then the user message. The store gets only the user message and the loop output. Thus the next turn sends a prefix that the provider never saw, and the prompt cache writes the whole conversation again. The Run Activity also gives the age of each run (`src/app/run-activity.ts` lines 13-58), thus its text changes each minute.

`appendTurn` (`src/memory/thread-history.ts` line 436) writes all rows in one transaction under an advisory lock, and each row takes `seq = MAX + 1`. A turn starts at a user message that is not `cortex.synthetic` (line 317). The first row of each append carries the `display_envelope`. The last assistant row carries the rollup and the duration (`src/state/init.ts` line 284).

Two other callers append a record between turns: the run-completion notice of the CLI (`cli/src/tui/hooks/run_completion.ts` line 184), and the seed of a report session (`src/app/spawn-report-session.ts` line 391).

When `runAgent` throws, the CLI stores `[userMessage]` alone (`turn.ts` lines 403-407). Thus a failure loses each round of the turn. Each loop also uses `DEFAULT_PROMPT_CACHE`, 5 minutes (`src/providers/prompt-cache.ts` line 141), and no production caller sets `RunAgentOptions.promptCache`.

This change is the third of a series. `update-the-provider-layer-for-current-models` puts the effort on the provider configuration, and it sends a session key. `keep-each-agent-conversation-append-only` adds the tool mask, the continuation, and a not-run result for each unanswered tool call. This change builds on the code of both.

## Goals / Non-Goals

**Goals:**

- The stored conversation is byte-identical to what the harness sent and received.
- The harness stores each round when it completes. Thus a failure keeps the completed work.
- Each turn has one outcome.
- The root conversation loop caches its prefix for 1 hour, and each other loop keeps 5 minutes.
- A host runs a turn with one call, and no host carries its own copy of the turn.

**Non-Goals:**

- Compaction and the history window. A later change replaces the eviction in blocks of 4 turns.
- Large tool outputs.
- A cache policy on the provider configuration.

## Decisions

### The stored conversation is what the harness sent and received

The harness stores each message before a later request sends it, in the order of that request. It never changes a stored message. A context record, a round, and a failure note are appended rows.

The turn record is the one row that changes: its status moves from `open` to the outcome. The record is state about the turn, not a message, and no request sends it. Thus the rule "never edit stored history" holds for each row that a model reads.

The tail retract stays. `retractLastTurn` removes the last turn, and it also deletes the turn record of that turn. The retract is compatible with the rule. When the last turn goes, each earlier prefix stays byte-identical. Thus each earlier thinking block and each cache entry stays valid.

The rule is: a later request never sees a changed earlier record. Only the last turn can go.

### The per-turn context is a record after the user message

The preparation builds three kinds of record: `analysis-context`, `run-activity`, and `working-memory`. Each record is a `user` message whose text starts with its tag, for example `[Run Activity]`. The records come after the user message, in that order.

A record is not a `system` message, for two reasons:

- The agent writes the working memory from data that it read. A `system` role would give that data the authority of the operator.
- Claude Sonnet 5 refuses a `system` message inside the conversation.

The preparation adds a record of a kind when the history window holds no record of that kind, or when the hash differs. The kind and the SHA-256 hash ride in `providerOptions.cortex` (`src/memory/ai-sdk-message-storage.ts` lines 31-59). A provider reads only its own namespace, thus the keys stay in the row and never reach the wire.

The window is the window that `loadRecent` gives. Thus a record that the eviction dropped comes back on the next turn, and the model always has a copy of each kind.

An empty working memory gives the tag and a line that states that the memory is empty. Without that line, a memory that the agent emptied would leave the last full copy as the latest copy.

The Run Activity gives the absolute start time and no age. The Analysis Context is null in the CLI, thus the CLI adds no record of that kind.

This design rejects a record on each turn. Each record adds tokens to the window, and an unchanged record tells the model nothing new.

### The round sink: `RunAgentOptions.onRound`

The loop API is one optional field of `RunAgentOptions`:

```ts
export interface AgentRound {
    readonly messages: readonly LoopMessage[];
}
readonly onRound?: (round: AgentRound) => Promise<void>;
```

The loop gives the sink each message that it appended after the last call, at three points: before each model request, at each exit, and before a throw. The loop awaits the sink. Thus the store holds each message before a later request sends it, and a crash loses at most the round in progress.

Before a throw, the loop answers each unanswered call of the messages that the sink did not get, with the not-run result. Then the sink gets them, and the loop throws the first error again. Thus a failure in a tool dispatch keeps the assistant message of that round.

The loop marks the interruption only on the partial of an aborted reply. It does not mark a message of an earlier round, because the sink can hold that round already. The turn record gives the abort instead.

The sink is a function, and the loop knows no store. A durable loop passes no sink, because DBOS replays the loop body.

This design rejects these alternatives:

- The loop writes to the thread store. The loop then knows the storage, and a workflow loop must turn it off.
- The chat turn stores the rounds from the emit events. An emit event is a display event, and it does not carry the model message with its signed metadata.
- One sink call for each message. A round is the unit that a request adds, thus one transaction for each round keeps the rows of a round together.

### The turn API: `runChatTurn`

The host API is one call in `src/app/chat-turn.ts`:

```ts
export function runChatTurn(deps: RunChatTurnDeps, params: RunChatTurnParams): Promise<ChatTurnResult>;
```

`deps` holds the pool, the agent resolver `agents`, the logger, and the provenance seam. `params` holds these values:

- the analysis id, the thread id, the user input, and the session
- the provider factory `chat(emit)`, the emit sink, and the signal
- the usage recorder and the approval binding
- the author and the start time
- the optional cache policy `promptCache` of the root loop

The result has four kinds: `prepare_failed`, `not_found`, `agent_unresolved`, and `ran`. `ran` carries these fields:

- `outcome`: `{ status: "done", finish }`, `{ status: "aborted", finish? }`, or `{ status: "failed", reason, cause }`
- `opened`: true when the opening landed
- `storeError`: the error of a write whose rows did not land by the close
- `durationMs`, `turnUsage`, and `fallbackText`

The call keeps the host small, for these reasons:

- The host gives only transport values. The sequence, the agent resolution, the display recorder, the round sink, the outcome, and the failure note are harness code.
- A second host, Cortex, gets the same rows and the same outcome with no copy of the turn.
- A later change of the turn, for example compaction, reaches each host with no change of the host.

`prepareChatTurn` stays exported, and `runChatTurn` calls it as its first step. The turn runs the root loop with `passthroughStep` and the cache policy of the turn. It gives no `reasoning`, thus the effort comes from the provider configuration of the role.

This design rejects a turn handle from `prepareChatTurn` that the host gives to `runAgent`. With such a handle, the host still runs the loop, selects the outcome, and connects the display recorder. Thus each host would carry a copy of the turn.

### The turn record and the outcome

The new table `cortex_thread_turns` holds one record for each chat turn:

```sql
CREATE TABLE IF NOT EXISTS cortex_thread_turns (
  thread_id        TEXT NOT NULL,
  start_seq        BIGINT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('open', 'done', 'aborted', 'failed')),
  reason           TEXT,
  reported_usage   JSONB,
  turn_duration_ms BIGINT,
  opened_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at        TIMESTAMPTZ,
  PRIMARY KEY (thread_id, start_seq)
);
```

`writeTurn` adds the record in the transaction of the opening. The close sets the outcome in the transaction of the last rows. The close updates only a record whose status is `open`, thus a second close changes nothing.

The status comes from the run:

- A returned finish `aborted` gives `aborted`.
- A different returned finish gives `done`.
- A thrown `AbortError` under an aborted signal gives `aborted`.
- A different throw gives `failed`.

The reason of a failure is a short text from the class of the error. A `suspend` error gives the reason of the host. An `auth` provider error, a different provider error, and a different error give three fixed texts. The reason never holds the message of the error, because each later turn sends the note to the vendor.

A failed turn appends the failure note after its rounds, with `conversationRecordTurn`. The note is a synthetic record, thus it opens no turn, and the display shows it as a system message.

This design rejects two alternatives:

- A status column on the user row, with an `UPDATE` at the close. That edits a message row of the history.
- A closing message for each outcome. A note for `done` would add a message to each turn, and the model would read it on each later turn.

The rollup and the duration move from the last assistant row to the turn record. The last round lands before the loop returns. Thus the rollup of the turn is not known when the last assistant row lands.

A turn that no process closes stays `open`. The harness does not guess whether the process of that turn still runs.

### The store writes: `ThreadHistory.writeTurn`

```ts
export type TurnWrite =
    | { readonly opening: ConversationTurn; readonly rounds: readonly ConversationTurn[]; readonly close?: TurnClose }
    | { readonly startSeq: number; readonly rounds: readonly ConversationTurn[]; readonly close?: TurnClose };
writeTurn(threadId: string, write: TurnWrite): ResultAsync<TurnWriteResult, DbError>;
```

`writeTurn` writes the groups of one call in one transaction, under the advisory lock of `appendTurn`. Each group carries its display envelope on its first row. A write with `opening` adds the turn record, and its result gives `startSeq`. A later write names the turn with `startSeq`. The union makes a write with both fields fail to compile.

The chat turn keeps the groups of a failed write, and it gives them again with the next write. Thus a group never lands before an earlier group of its turn.

`appendTurn` stays for a host record and for the seed of a report session. It loses `turnUsage` and `turnDurationMs`.

### The display of a round

The display recorder gets two methods. `takeOpening()` gives the user message of the turn. `takeRound(messages)` gives one assistant message with the parts that the recorder got after the last take. The recorder makes one assistant id for the turn, thus each round of a turn carries the same id.

`takeRound` adds the text of the assistant messages of the round when the live events carried no text. It also marks each pending approval of the round as aborted. A completed round has no pending approval, and only a round that a throw ends can hold one.

The transcript replay merges the assistant messages of adjacent rounds that share an id. It folds the turn record onto the last assistant message of the turn: the rollup, the duration, and `interrupted` for `aborted`. Thus the CLI reloads a turn as one assistant message, the same as the live view. The replay code of the CLI does not change.

### The cache lifetime rides on the run

`runChatTurn` gives the root conversation loop `promptCache: CONVERSATION_PROMPT_CACHE`, which is `{ ttl: "1h" }`. A host can pass a different policy with the parameter `promptCache`, for example `{ ttl: "5m" }` or `"off"`. The constant goes in `src/providers/prompt-cache.ts`, beside `DEFAULT_PROMPT_CACHE`.

The policy rides on `RunAgentOptions.promptCache`, which is the current principle of that option. Each loop takes its policy from its own run options. Thus the 1-hour policy reaches only the root loop. Each other loop keeps `DEFAULT_PROMPT_CACHE`, 5 minutes: the planner, the analogy report, the literature reviewer, and each workflow loop.

A 1-hour write costs 2 times the base input price, and a 5-minute write costs 1.25 times. A person can reply 5 to 60 minutes later, and only a 1-hour entry stays in the cache for that gap. A machine loop starts its requests less than 5 minutes apart, and a sandbox command takes less than one minute on average. Thus a machine loop keeps 5 minutes.

This design rejects a cache policy on the provider configuration. The conversation provider also serves the planner and the analogy report (`src/agents/conversation-agent.ts` lines 300-301 and 343). Thus a policy on that provider would give those machine loops 1 hour.

### The CLI adopts the turn in the same pull request

CI links the working-copy harness, thus the CLI must compile against this change. The CLI changes these files:

- `turn.ts`: the `runChatTurn` of the CLI calls the `runChatTurn` of the harness, and it maps the result to its `TurnOutcome`.
- `turn.ts`: `healTailOrphan` removes a tail turn that holds no assistant row.
- `conversation.ts`: the retract reads `opened` to decide the durable retract.
- The fakes of `ThreadHistory` add `writeTurn`, and the fakes of `TurnOutcome` add `opened`.

The CLI passes no cache policy, thus its root conversation loop uses 1 hour. The CLI specs describe the old sequence. Thus the CLI change `adopt-the-harness-chat-turn` in `cli/openspec` changes `tui-harness-chat` and `chat-command`.

## Risks / Trade-offs

- [The proxy path can refuse the 1-hour request] → Anthropic accepts a 1-hour breakpoint only before each 5-minute breakpoint. CLIProxyAPI adds its own markers (`src/providers/prompt-cache.ts` lines 108-111), thus the proxy path can refuse the request. The user checks cliproxy on staging. The fallback: the host passes a 5-minute policy to the turn.
- [A host appends a record while a turn is open] → The record lands between two rounds, and the stored order differs from the sent order. The spec forbids it. The CLI holds its write lock for the whole turn (`cli/src/tui/hooks/thread_write.ts`).
- [The process stops during a turn] → The completed rounds stay, and the turn stays `open`. No failure note exists, because no process saw the failure.
- [The store fails during a turn] → The turn continues, and the next write stores the kept groups first. When the store fails until the close, the result carries the error, and the host shows its append notice.
- [The model reads an old copy as current] → The latest copy of each kind is the last copy in the transcript. An emptied memory gives its own copy.
- [The Run Activity gives no age] → The model reads the absolute start time. `inspect_run` gives the live status of a run.
- [Each round is a transaction] → A round costs one database round trip under the advisory lock. That cost is small against the model call of the round.
- [An abort with no partial marks no model message] → The turn record gives `aborted`, and the replay sets the interruption from the record.
- [The deltas build on changes that are not archived] → The `harness-agent-loop` delta names the not-run result and the wrap-up request of `keep-each-agent-conversation-append-only`. The `harness-thread-history` delta renames a requirement that `persist-versioned-conversation-display` modifies. Archive those changes before this change.

## Migration Plan

The state initialization makes `cortex_thread_turns` with `CREATE TABLE IF NOT EXISTS`. No backfill runs. An old turn has no turn record, and the replay keeps the figures of its rows.

The first turn after the upgrade finds no record in the window. Thus it adds each kind, and it writes the prefix one time.

A rollback to an earlier version reads the context records as synthetic user messages, and it sends them as history. The earlier version does not read the new table.

A delta cannot change the Purpose of a spec. Write these Purpose sections again when this change archives:

- `harness-thread-history`: the sentence that the store persists each turn atomically.
- `harness-working-memory`: the paragraph on the injection of the memory on each turn.
- `conversation-run-awareness`: the purpose that the run activity is not persisted.

## Open Questions

None. The owner of the three earlier questions decided them:

- The tail retract stays, and it also deletes the turn record.
- The conversation keeps 1 hour, and the proxy path is a risk with a fallback.
- The cache lifetime rides on the run, not on the provider configuration.

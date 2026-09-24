## Why

Some models bind each signed thinking block to the exact prefix of its request. The prompt cache also matches by the exact prefix. Thus a stored conversation that differs from the sent conversation costs a cache write on each turn. The difference can also make the later thinking blocks invalid.

A production audit of 16 days found that cache writes are 65% of the spend. `conversation-agent` has a hit rate of 45%, and it makes 29% of all cache writes of the harness. The audit found these causes:

- `assembleMessages` puts the Analysis Context, the Run Activity, and the working memory before the user message (`src/app/message-assembly.ts` lines 122-147). The host stores only the user message and the loop output (`cli/src/modules/harness/turn.ts` line 358). Thus the next turn sends a different prefix, and it never reads the cached prefix back.
- The Run Activity gives the age of each run, for example `3m ago` (`src/app/run-activity.ts` lines 13-58). Thus its text changes each minute.
- Each loop uses the cache lifetime of 5 minutes (`DEFAULT_PROMPT_CACHE`, `src/providers/prompt-cache.ts` line 141), and no production caller sets `promptCache`. A person who replies after 5 minutes pays a new write of the whole conversation.

A turn is also stored only when it ends. When a turn throws, the CLI stores only the user message (`cli/src/modules/harness/turn.ts` lines 403-407). Thus each round of a long turn is lost. A production 401 lost 30 minutes of planning.

The 1-hour lifetime ships in this change, not earlier. Before this change, the context changed the prefix on each turn, and a 1-hour write costs 2 times the base input price.

## What Changes

- The harness stores each message that it sends and each message that it receives, in order. It never changes a stored message.
- The tail retract stays, and it also deletes the turn record. It removes only the last turn, thus a later request never sees a changed earlier record.
- The per-turn context moves after the user message, as tagged user text. Each kind is its own stored context record: the Analysis Context, the Run Activity, and the working memory.
- A turn adds a record of a kind only in two conditions. The window holds no copy of that kind, or the content hash differs from the latest copy. The kind and the hash ride in `providerOptions.cortex`, and they never reach the wire.
- The Run Activity gives the absolute start time of each run, not its age.
- `RunAgentOptions` gets the round sink `onRound`. The loop gives each completed round to the sink before the next request, at each exit, and before a throw. The loop knows no store.
- A new app function, `runChatTurn`, runs the whole chat turn: the preparation, the agent resolution, the storage of each round, and the outcome. A host gives only its transport values.
- A chat turn has an outcome: `open` while it runs, then `done`, `aborted`, or `failed` with a reason. A new table, `cortex_thread_turns`, holds the outcome, the usage rollup, and the duration of each turn.
- A failed turn keeps its stored rounds. Each unanswered tool call gets the not-run result, and a short failure note tells the model what occurred.
- The rule "a turn is appended atomically" becomes "each round is appended atomically".
- The transcript read merges the rounds of one turn into one assistant message. Thus a reload shows a turn as the live view showed it.
- `runChatTurn` gives the root conversation loop the cache lifetime of 1 hour, and a host can pass a different policy. The policy rides on the run, thus each other loop keeps 5 minutes.
- The CLI adopts `runChatTurn` in the same pull request.
- **BREAKING** `ConversationTurn` loses `turnUsage` and `turnDurationMs`. The close of a chat turn stores the two figures on the turn record.
- **BREAKING** `ThreadHistory` gets the method `writeTurn`. Each fake of the interface must add it.

## Capabilities

### New Capabilities

- `chat-turn`: the whole chat turn in the harness. It holds the opening, the context records, the storage of each round, and the outcome.

### Modified Capabilities

- `harness-agent-loop`: the round sink, and the interruption marker on a partial of the last round only.
- `harness-thread-history`: each round is appended atomically, the turn record, the retract of the turn record, and the merge of the rounds on read.
- `ai-sdk-message-storage`: a context record carries its kind and its content hash.
- `conversation-run-awareness`: the Run Activity is a stored record after the user message, with absolute times.
- `harness-working-memory`: the render is a stored record after the user message.
- `report-session-agent`: a report turn adds no working-memory record, and the reason for the eviction of a conversation window changes.
- `harness-thread-store`: a hard delete also removes the turn records.
- `analysis-purge`: the purge also removes the turn records.

## Impact

Harness source:

- `src/loop/run-agent.ts`, `src/loop/continue-agent.ts`, and `src/providers/prompt-cache.ts`.
- `src/app/chat-turn.ts`, `src/app/message-assembly.ts`, and `src/app/run-activity.ts`.
- `src/memory/thread-history.ts`, `src/memory/ai-sdk-message-storage.ts`, `src/memory/conversation-display-recorder.ts`, and `src/memory/conversation-display-replay.ts`.
- `src/memory/thread-store.ts`, `src/state/purge-analysis.ts`, and `src/state/init.ts`.
- `src/index.ts`, `CONTEXT.md`, `CLAUDE.md`, and `README.md`.

Database: the new table `cortex_thread_turns`. The state initialization makes it at startup. No backfill runs.

CLI: `cli/src/modules/harness/turn.ts` and `dev/chat.ts`, and `cli/src/tui/hooks/conversation.ts` and `thread_write.ts`. The CLI specs describe the old turn sequence. Thus a separate CLI change, `adopt-the-harness-chat-turn` in `cli/openspec`, changes them. CI links the harness of the working copy, thus the CLI adopts the change in this pull request.

Consumers:

- A host that runs its own turn sequence must call `runChatTurn`. Cortex adopts it when it bumps the pin.
- A host can pass a cache policy to the turn. Without one, the root conversation loop uses 1 hour.

Dependencies: this change builds on `update-the-provider-layer-for-current-models` and `keep-each-agent-conversation-append-only`. The deltas name the not-run result and the wrap-up request of the second change. The `harness-thread-history` delta renames a requirement that `persist-versioned-conversation-display` also modifies.

Release. The user starts the harness release after the merge. The change does not change the version in `package.json`.

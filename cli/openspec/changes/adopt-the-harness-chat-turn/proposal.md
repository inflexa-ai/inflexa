## Why

The harness change `save-each-chat-round-and-add-context-on-change` moves the whole chat turn into the harness, as `runChatTurn`. The harness stores the opening of a turn, each round when it completes, and the outcome of the turn. It also puts the per-turn context after the user message as stored records.

The cli specs describe the old sequence: `prepareChatTurn`, then `runAgent`, then one `appendTurn` of `[userMessage, ...loop output]`. When the run throws, that sequence stores the user message alone, and a failure loses each round of the turn. CI links the working-copy harness, thus the cli adopts the new turn in the same pull request.

## What Changes

- The shared turn engine (`src/modules/harness/turn.ts`) calls `runChatTurn` of the harness. It gives the transport values of the surface, and it maps the result to its own outcome.
- The engine appends no row itself. A failed turn keeps its stored rounds and gets a failure note from the harness.
- The outcome of a turn that ran carries `opened`. The retract runs the durable step only when the opening landed.
- The heal of a failed retract removes a tail turn that holds no assistant row. Such a tail holds the user message and its context records.
- The author rides the opening of the turn.
- The engine passes no cache policy. Thus the root conversation loop uses the 1-hour default of the harness, and each other loop keeps 5 minutes.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `tui-harness-chat`: the TUI drives the turn through `runChatTurn`, the retract reads `opened`, the heal accepts a tail with context records, and the author rides the opening.
- `chat-command`: the REPL turn is one call of `runChatTurn`.

## Impact

- `src/modules/harness/turn.ts` and `src/modules/harness/dev/chat.ts`.
- `src/tui/hooks/conversation.ts` and `src/tui/hooks/thread_write.ts`.
- The tests of these files. Each fake of `ThreadHistory` adds `writeTurn`, and each fake `TurnOutcome` of a turn that ran adds `opened`.

The work of this change is group 6 of the harness change `save-each-chat-round-and-add-context-on-change`.

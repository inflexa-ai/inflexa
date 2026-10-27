# Connect the chat route to the turn workflow of the harness

## Why

The harness runs a chat turn as a durable workflow now (the harness change `run-chat-turn-as-workflow`). A host opens a turn, reads its frames, stops it, and answers its asks through `CoreRuntime.chatTurns`. The host no longer runs the turn in its own process with an emit sink. The chat route of the local server and the TUI must use that surface.

## What Changes

- The chat route opens a turn with `chatTurns.open`. The harness makes the turn id, thus the route registers the turn when it opens. A stop of the server also waits for a turn that still opens.
- The route refuses a turn on a thread whose turn still runs, with 409 `conflict`. The harness refuses it at the open.
- The route gives the frames of `chatTurns.read`, and it still sends its own end frame with the remedy of a failure.
- A new route `GET {T}/turns/:turnId/stream` reads the frames of a turn again from its start.
- The answer of an ask goes through `chatTurns.answer`, thus the turn that waits for it gets the answer.
- The failure of a turn comes from the code and the text that the harness gives. The harness logs the whole cause in the log of the server.
- The TUI reads a turn again after a lost connection, and it applies each frame one time.
- `run_inflexa` and `manage_inputs` ask for an approval in the approval hook of the tool, and `execute` makes sure of the input again.
- The runtime gives the local credential for a turn that a recovery runs, and the run launcher gets the pool and the logger.

## Capabilities

### Modified Capabilities

- `local-server`: the chat turn, the turn refusal, and the route that reads a turn again.
- `tui-harness-chat`: the failure of a turn, and the read of a turn after a lost connection.

## Impact

- `src/server/routes/conversation.ts`, `src/server/turns.ts`: the route, the registry, and the new route.
- `src/modules/harness/turn.ts`: the turn engine over `ChatTurns`.
- `src/modules/harness/runtime.ts`: the type of `chatTurns`, the credential of a recovered turn, and the run launcher.
- `src/modules/harness/inflexa_tool.ts`, `src/modules/harness/inputs_tool.ts`: the approval hook.
- `src/client/conversation.ts`, `src/tui/hooks/conversation.ts`: the read of a turn again.

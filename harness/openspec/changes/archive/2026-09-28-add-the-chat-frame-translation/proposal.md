# Add one translation path for chat frames

## Why

Today four places make a display message from the chat events:

- the display recorder of the harness
- the chat route of Cortex
- the accumulator of Lumen
- the terminal user interface (TUI) in `cli/`

The four copies can disagree, and no test compares a live turn with its reload. On 2026-09-28, the user decided that translation code that two consumers can use goes into the harness.

This change is step A of part 2. It adds the translation path to the harness, and a test that compares the path with the reload path. Step B changes the TUI to use the path. Cortex and Lumen use it after a later harness bump.

## What Changes

- The new module `src/contracts/chat-frame.ts` holds two functions. The module imports only types from outside `src/contracts/`, thus a browser can load it.
  - `toChatFrame` is a port of `translateEvent` of Cortex. It gives the frame of one emitted event. It keeps the events and the parts of a sub-agent with their source, and it keeps `durationMs` on `tool-finished`. Cortex drops both.
  - `applyChatFrame` is a port of `applyChatFrame` of Lumen, with its test cases. It applies one frame to the messages of a live turn. It ignores a frame from a sub-agent, and it puts `durationMs` of `tool-finished` on the tool-call part.
- `src/contracts/index.ts` and `src/index.ts` export the two functions and the types `ChatPartFrame`, `TurnTerminal`, and `ApplyFrameResult`.
- `ToolCallPart` gets the optional field `durationMs`. The display recorder records it from `tool-finished`, the store keeps it, and the replay gives it. A row stored before this change reads with no `durationMs`.
- A test gives one sequence of loop events to the live path and to the reload path. The two results are equal. Each known difference has its own test.

## What Does Not Change

- The display recorder does not use `applyChatFrame`. A later change can merge the two.
- Cortex, Lumen, the TUI, the run view, and the frame parser of Lumen.
- The version of the stored display envelope, the harness version, a changelog, and a lockfile.

## Capabilities

### New Capabilities

- `chat-frame-translation`: the translation of an emitted event to a frame, and of a frame to the messages of a live turn. It also covers the stored duration of a tool call, and the equality of the live path and the reload path.

### Modified Capabilities

None.

## Impact

- Harness source: `src/contracts/chat-frame.ts`, `src/contracts/message.ts`, `src/contracts/index.ts`, `src/index.ts`, `src/memory/conversation-display-recorder.ts`, and `src/memory/conversation-display-storage.ts`.
- Tests: `src/contracts/chat-frame.test.ts`, `src/memory/conversation-display-parity.test.ts`, and one test in `src/memory/conversation-display-storage.test.ts`.
- Specs: the requirements of the stored display are in the open change `persist-versioned-conversation-display`. Thus this change puts the stored duration in its own capability.
- Stored data: a stored tool call can hold `durationMs`. A reader of harness 0.26.0 or later removes an unknown field, and it reads the row. A reader of harness 0.16.0 to 0.25.0 rejects an unknown field, thus it cannot read the row. That reader also rejects the `compaction` part that harness 0.40.0 and later store under the same envelope version.
- Consumers: the change only adds names and one optional field. No consumer must change.

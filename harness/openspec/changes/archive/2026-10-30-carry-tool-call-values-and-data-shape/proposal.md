# Proposal

## Why

Two facts that a client must show do not reach it:

- A person cannot expand a tool call in the chat and see its input, its result, and its error (issue #785). `ToolCallPart` and the tool events carry only the name, the outcome, the detail, and the duration.
- The profile card cannot show the shape of the data, for example "61,533 genes x 28 samples" (issue #783). The stored profile has no matrix dimensions, and no writer fills `files[].rows` and `files[].cols`.

## What Changes

- A new contract type `ToolCallValue` `{ text, cut }`: the text of one value of a tool call, with each secret removed, and cut at a cap.
- `ToolStartedEvent` gets an optional `input`. `ToolFinishedEvent` and `ToolCallPart` get optional `input`, `result`, and `error`. The old fields do not change.
- The emit site of the loop makes each value one time. It removes the control characters and each secret, and it cuts a long text to its first and last parts with a marker between them. Thus the shown text can differ from the text that the model reads.
- The secret removal covers the prefixed formats of `redactSecrets`, a field whose name names a secret, and an assignment such as `API_KEY=...`. The rules of `redactSecrets` for a user message do not change.
- The stored display keeps the three values, and the replay gives them. A stored row with no value still reads.
- The stream of a run keeps its current content. A step and the synthesis do not forward the values.
- `DataProfileResult` gets an optional `shape` `{ rows, rowUnit, columns, columnUnit }` for the primary matrix of the full dataset.
- `submit_profile` accepts an optional `shape`. The profiler agent picks the primary matrix, measures its rows and its columns in the sandbox, and names the units. The prompt tells it how to measure without a decode of the file.
- A profile that re-applies a prior recipe with no agent run keeps the prior `shape` only when its input signature did not change. Otherwise it drops `shape`, because new or changed inputs can change the dimensions.

## Capabilities

### New Capabilities

- `tool-call-values`: the input, the result, and the error of a tool call, where they ride, and how the harness caps them and removes each secret.

### Modified Capabilities

- `chat-frame-translation`: `toChatFrame` copies the three values to the frame, and `applyChatFrame` sets them on the tool-call part.
- `data-profile-init`: the snapshot carries the shape of the primary matrix when the profiler measured it.

## Impact

- `harness/src/contracts/chat-events.ts`, `contracts/message.ts`, `contracts/schemas/chat-events.ts`, `contracts/chat-frame.ts`, `contracts/data-profile.ts`, and the export lists in `contracts/index.ts` and `src/index.ts`.
- `harness/src/loop/types.ts`, `loop/tool-adapter.ts`, `loop/run-loop.ts`, a new value module in `loop/`, and `input-sanitization.ts`.
- `harness/src/memory/conversation-display-storage.ts`, `harness/src/workflows/sandbox-step.ts`, and `harness/src/workflows/execute-analysis.ts`.
- `harness/src/schemas/data-profile-schemas.ts`, `tasks/data-profile.ts`, and `prompts/sandbox/data-profiler.ts`.
- `cli/src/server/routes/runs.test.ts`: a test that `GET {A}/data-profile` gives the stored `shape`. The cli route needs no code change, because it sends the stored result unchanged.
- The stream of a chat turn and the stored display grow by at most the cap for each value of each call.

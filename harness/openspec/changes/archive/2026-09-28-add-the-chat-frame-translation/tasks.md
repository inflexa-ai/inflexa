# Tasks

Run each command in `harness/`, unless the task names a different directory.

## 1. The translation path

- [x] 1.1 Add `src/contracts/chat-frame.ts` with `toChatFrame`, a port of `translateEvent` of Cortex. Keep the events and the parts of a sub-agent with their source. Keep `durationMs` on `tool-finished`.
- [x] 1.2 In the same module, add `applyChatFrame`, a port of `applyChatFrame` of Lumen. Ignore a frame from a sub-agent. Put `durationMs` on the tool-call part. Keep the source of a `data-*` frame out of the part.
- [x] 1.3 In the module, import only types from outside `src/contracts/`.
- [x] 1.4 Export the two functions and the types `ChatPartFrame`, `TurnTerminal`, and `ApplyFrameResult` from `src/contracts/index.ts` and `src/index.ts`.

## 2. The duration of a tool call

- [x] 2.1 Add the optional field `durationMs` to `ToolCallPart` in `src/contracts/message.ts`.
- [x] 2.2 In `src/memory/conversation-display-recorder.ts`, record `durationMs` of `tool-finished`.
- [x] 2.3 In `src/memory/conversation-display-storage.ts`, add the optional field `durationMs` to the schema of a stored tool call. Keep the version of the envelope.

## 3. Tests

- [x] 3.1 Port the test cases of Cortex and Lumen to `src/contracts/chat-frame.test.ts`. Change each case that the differences of the port change.
- [x] 3.2 Add `src/memory/conversation-display-parity.test.ts`. Give one sequence of loop events to the two paths, and make sure that the results are equal. Add one test for each known difference.
- [x] 3.3 In `src/memory/conversation-display-storage.test.ts`, make sure that a tool call stored with no `durationMs` reads.
- [x] 3.4 In `src/app/chat-turn.test.ts`, expect `durationMs` on the replayed tool call.

## 4. Checks

- [x] 4.1 Run `bun run typecheck` and `bun run lint`. Make sure that the two commands pass.
- [x] 4.2 Run `bun run format:file` with each changed file in `src/`.
- [x] 4.3 Run `bun test`. Make sure that the full suite passes.
- [x] 4.4 In `cli/`, run `bun run harness:local && bun run typecheck`. Make sure that the command passes.
- [x] 4.5 Run `openspec validate add-the-chat-frame-translation --strict`. Make sure that the command passes.

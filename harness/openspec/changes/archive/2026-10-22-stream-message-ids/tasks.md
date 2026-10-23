# Tasks

## 1. The wire frame

- [x] 1.1 Add `MessageStartEvent` to the `ChatEvent` union in `src/contracts/chat-events.ts`, and `MessageStartEventSchema` to `ChatEventSchema` in `src/contracts/schemas/chat-events.ts`. Export the two from `src/index.ts`, `src/contracts/index.ts`, and `src/contracts/schemas/index.ts`. Make sure that `src/contracts/schemas/chat-events.test.ts` shows that the schema accepts each role and refuses a missing field, an id that is not a UUID, and a bad role.
- [x] 1.2 Add the `message-start` member to `EmitEvent` in `src/loop/types.ts`. Make `toChatFrame` give the frame with a copy of the source, and make `applyChatFrame` change no message for it (design D3). Make sure that `src/contracts/chat-frame.test.ts` shows the two rules.

## 2. The display recorder

- [x] 2.1 Remove the `userMessageId` and `assistantMessageId` options of the recorder. Forward each `message-start` lazily, immediately before the next event (design D1 and D2). Make sure that `src/memory/conversation-display-recorder.test.ts` covers a plain turn, a mid-turn compaction, a turn with no event before the first, and an event of a sub-agent.
- [x] 2.2 Make the live path of `src/memory/conversation-display-parity.test.ts` read the stream of the recorder, and update the known difference of a compaction. Make sure that the two paths give the same ids.
- [x] 2.3 Make sure that `src/app/chat-turn.test.ts` shows the announced ids against the stored display for a plain turn, a mid-turn compaction, and a turn-start compaction.

## 3. The order of the compaction parts

- [x] 3.1 In `compact` of `src/loop/run-agent.ts`, emit the `done` part before the round of the marker (design D4). Make sure that `src/loop/run-agent.test.ts` shows the order, that the parity test and `src/app/chat-turn.test.ts` show the two parts under the first assistant id, and that the stored display of a compaction turn does not change.

## 4. Verification

- [x] 4.1 Run `bun run format:file` on the changed files in `src/`. Then run `bun run typecheck`, `bun run lint`, and `bun test` on each changed test file. Make sure that each command passes.
- [x] 4.2 Run `bun test` one time for the full harness suite. Make sure that it passes.

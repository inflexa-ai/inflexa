# Proposal

## Why

A client cannot attach feedback to an assistant message while the message streams. The display recorder makes the id of each message of a turn, but it never sends the ids (`src/memory/conversation-display-recorder.ts:98-101`). Thus Lumen makes its own id (`asst-<uuid>`), and that id is not the id of the stored message.

The harness must be the only source of the message ids, for the user message and for each assistant message.

## What Changes

- **BREAKING** The display recorder takes no `userMessageId` and no `assistantMessageId`. It always makes the two ids.
- A new chat frame `message-start` carries `messageId`, `role` (`user` or `assistant`), and `source`. Each field is necessary. `MessageStartEvent` is a member of `ChatEvent`, and `MessageStartEventSchema` is a member of `ChatEventSchema`. The package exports the two.
- The recorder forwards the `message-start` of the user id and of the assistant id immediately before the first event that it forwards. After a marker round gives a new assistant id, it forwards the `message-start` of that id immediately before the next event. It forwards nothing before the first event.
- `toChatFrame` gives a `message-start` with no change. `applyChatFrame` changes no message for it, and it does not end the turn.
- The loop emits the `done` part of a compaction before it gives the round sink the round of the marker. Thus the two parts of one compaction stream under the same assistant id.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `chat-frame-translation`: `toChatFrame`, `applyChatFrame`, and the wire schema know the `message-start` frame. The display recorder makes and announces the id of each message. The parity test reads the live path from the stream of the recorder.
- `chat-turn`: the new assistant id after a marker round is announced on the stream.
- `harness-agent-loop`: the `done` part of a compaction comes before the round of the marker.

## Impact

- Harness code: `src/loop/run-agent.ts`, `src/contracts/chat-events.ts`, `src/contracts/schemas/chat-events.ts`, `src/contracts/chat-frame.ts`, `src/loop/types.ts`, `src/memory/conversation-display-recorder.ts`, the barrels `src/index.ts`, `src/contracts/index.ts`, and `src/contracts/schemas/index.ts`, and their tests.
- Hosts: Cortex streams each root frame of the sink, thus it streams `message-start` with no change. Its first-activity check still sees no call before the first real event. Lumen must read the ids from `message-start`, and it must stop making the id `asst-<uuid>`.
- Embedders that give the recorder an id: they must stop. `runChatTurn` gives none.

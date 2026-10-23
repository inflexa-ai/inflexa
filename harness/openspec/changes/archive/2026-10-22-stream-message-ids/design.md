# Design

## Context

- The display recorder is the only place that knows the id of each message of a turn. It makes the user id and the assistant id, and it makes a new assistant id after a marker round, because the replay splits the turn at the divider (`src/memory/conversation-display-recorder.ts:96-160`).
- `runChatTurn` gives the recorder as the emit of the run. Each event of the loop, of the provider, of a tool, and of the compaction goes through `emit` to the sink of the host (`src/app/chat-turn.ts:269-340`).
- Cortex sets its activity flag on the first call of its sink. Only a turn with no activity answers a billing suspension with HTTP 402. Cortex streams each root frame that `toChatFrame` gives.
- Lumen parses each frame that is not a `data-` frame with `ChatEventSchema`, and it drops a frame that the schema refuses.

## Goals / Non-Goals

**Goals:**

- The stream gives each id that the stored display holds, before the first frame of that message.
- A turn with no event gives no call to the sink.

**Non-Goals:**

- No change of the order in which the loop emits the parts of a compaction.
- No id for the divider message. Its id is already the id of the compaction part.

## Decisions

### D1. The recorder announces an id lazily

The recorder keeps the user id and the last assistant id that it announced. In `emit`, it compares them with its current ids, and it forwards a `message-start` for each id that the sink did not get. Then it forwards the event.

An eager announcement at the start of the turn would call the sink before any real event. Then a turn that a billing suspension stops before its first request would lose its HTTP 402. An announcement at `takeRound` would call the sink between two rounds with no event, and it would announce an id that no frame uses.

### D2. The sink calls start with no await between them

When `emit` forwards a `message-start`, it starts each sink call in the order of the stream, and it gives one promise for all of them. A chain that waits for each call would let a later emit, which its caller does not wait for, reach the sink first. A provider sends each text delta in that way.

### D3. The frame goes through the emit sink as an `EmitEvent`

`message-start` is a member of `EmitEvent`, thus the recorder can give it to the sink with no second channel. `toChatFrame` copies it to a frame with the source of the root agent. `applyChatFrame` ignores it. Its default branch assigns the frame to `ChatPartFrame`, thus a later event type that no branch takes fails the build.

### D4. The loop emits `done` before the round of the marker

The round of the marker gives the later rounds a new assistant id. If the loop gave that round first, the `done` part would stream under the new id, and the `running` part would stay under the first id. A client would then show a compaction that never ends in the first message. Thus `compact` emits `done`, and then it gives the round. The part is transient, thus the stored display does not change.

## Risks / Trade-offs

- [The first assistant id of a turn-start compaction has live frames and no stored message.] → The stored display never holds an id that the stream did not announce. A client must accept an announced id with no stored message.
- [A round sink that throws on the round of the marker throws after the `done` part. The client then sees `done`, and then the error of the turn.] → `runChatTurn` gives a sink that does not throw: a failed write of a round rides the result of the turn.

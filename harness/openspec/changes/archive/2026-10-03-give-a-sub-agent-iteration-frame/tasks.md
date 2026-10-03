## 1. The frame

- [x] 1.1 Add `IterationEvent` to `ChatEvent`, and `IterationEventSchema` to `ChatEventSchema`. Export the two.
- [x] 1.2 Make `toChatFrame` give `{ type: "iteration", source }` for an iteration whose call path has more than one entry, and `null` for the root.
- [x] 1.3 Make `applyChatFrame` apply no change for an `iteration` frame, and end no turn.

## 2. The tests

- [x] 2.1 Add a test for each case: a root iteration gives `null`, a sub-agent iteration gives a frame with its source only, and the schema accepts the frame.
- [x] 2.2 Add a test that an `iteration` frame makes no part.

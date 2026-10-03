## Why

`toChatFrame` gave no frame for a loop `iteration`. Thus a host saw nothing between two tool calls of a sub-agent. A planner that thinks for a long time showed the line of its last call, and it looked stuck.

## What Changes

- `toChatFrame` gives an `iteration` frame for an iteration of a sub-agent, with its source only. An iteration of the root agent still gives `null`.
- `IterationEvent` is a new member of `ChatEvent`, with `IterationEventSchema` in the schemas. The package exports the two.
- `applyChatFrame` changes nothing for an `iteration` frame.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `chat-frame-translation`: a sub-agent iteration gives a frame, and the frame applies no change.

## Impact

- `harness/src/contracts/chat-frame.ts`, `harness/src/contracts/chat-events.ts`, `harness/src/contracts/schemas/chat-events.ts`, and the exports of `harness/src/contracts/index.ts`, `harness/src/contracts/schemas/index.ts`, and `harness/src/index.ts`.
- A host that keeps only the root frames (`isRootFrame`) sees no change. The root agent gives no `iteration` frame, thus the first-frame time of a browser does not read the start of a request as output.
- A host with an exhaustive switch over `ChatFrame` must add the `iteration` case. The cli change `close-the-gaps-of-the-local-server` shows it as `<agent>: thinking`.

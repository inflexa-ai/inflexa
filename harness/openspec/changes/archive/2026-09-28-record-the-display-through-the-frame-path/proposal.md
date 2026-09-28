## Why

The display recorder kept its own copy of the rules that build a message from the chat events. `applyChatFrame` holds the same rules for a live surface. Two copies can go out of agreement, and one already did: the recorder kept a finished call whose start never arrived, and `applyChatFrame` dropped it. Thus the TUI added a start for such a call.

## What Changes

- The display recorder sends each event through `toChatFrame` and `applyChatFrame`. It keeps only what the stored form needs: it validates each part, it records only the parts that the conversation keeps, it closes each round, and it adds the compaction divider.
- `applyChatFrame` appends a finished call when its `tool-finished` has no `tool-started`.
- `isRootFrame` names the rule that a frame of a sub-agent has a call path longer than `[agent.id]`.
- **BREAKING** The recorder option `topLevelCallPath` becomes `agentId`. Each caller passes `[agent.id]` today, and the option names that rule.

## Capabilities

### Modified Capabilities

- `chat-frame-translation`: `applyChatFrame` appends a finished call with no start, and the display recorder uses the translation path.

## Impact

- `harness/src/contracts/chat-frame.ts`, `harness/src/memory/conversation-display-recorder.ts`, `harness/src/app/chat-turn.ts`.
- The TUI no longer adds a start for a finished call with no start.
- No change to the stored format.

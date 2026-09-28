# Adopt the harness chat parts in the TUI

## Why

The TUI makes its display message with its own code, in two places: `applyEmitEvent` for the live turn, and `cortexToUiMessage` for a reload. Its part types copy the parts of the harness. Thus the TUI can show a turn differently from Cortex and Lumen, and its live turn can differ from its reload.

Step A of part 2 added `toChatFrame` and `applyChatFrame` to the harness: one translation path for each consumer. This change is step B. The TUI uses that path and the harness types.

## What Changes

- The store holds the `ChatMessage` and `MessagePart` types of the harness. The part types of the TUI keep only screen state and the two mock parts of the design gallery.
- A live event of the top-level agent goes through `toChatFrame` and `applyChatFrame`. An event of a sub-agent goes to the activity line of the running tool call before any translation, as before.
- A reload mounts the messages of `storedMessagesToCortex` with no change. `cortexToUiMessage` is removed.
- The message renderer reads the harness parts. It reads each card through the shared readers of `chat_printer.ts` and `artifact_open.ts`.
- A text delta does not go into the store. Thus a card keeps its component state while the text streams.
- A record and a compaction divider keep the `system` role that the harness gives. The TUI called that role `event`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `chat-view`: the display cards map through the harness parts, in the live path and in the reload path.
- `tui-mock-data`: the `Part` union holds the harness parts, the screen state of three parts, and two mock kinds.
- `data-model-types`: the data fields of a part come from the harness.

## Impact

- CLI source: `src/types/session.ts`, `src/tui/hooks/conversation.ts`, `src/tui/layout/message_block.tsx`, `src/tui/components/chat.tsx`, `src/tui/layout/design_gallery_fixtures.ts`, `src/tui/app.tsx`, `src/tui/commands.tsx`, `src/modules/harness/chat_printer.ts`, and `src/modules/harness/artifact_open.ts`.
- Tests: the tests of the conversation store, the message block, the report entry, the run card, and the theme contrast.
- The harness does not change.

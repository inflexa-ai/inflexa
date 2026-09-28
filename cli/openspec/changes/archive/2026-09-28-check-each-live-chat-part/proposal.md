## Why

The TUI read each harness part as `unknown`, and each reader checked the fields again. The harness now gives `checkChatPart`, thus the TUI checks a live part one time at receipt and reads it through its harness type.

## What Changes

- The live path checks each data part at receipt with `checkChatPart`. It drops a part that the check refuses, with a warning in the log.
- `readPlanCard`, `readPresentation`, and `readFileReference` take the harness part types. `readRunCard`, `readChildSessionStarted`, `readAskPart`, and `readCompactionPart` are gone, and the renderer reads those fields directly.
- The dev REPL checks each part in the same way.

## Capabilities

### Modified Capabilities

- `chat-view`: a live part is checked at receipt, and a card is read through its harness type.

## Impact

- `cli/src/tui/hooks/conversation.ts`, `cli/src/modules/harness/chat_printer.ts`, `cli/src/modules/harness/artifact_open.ts`, `cli/src/modules/harness/dev/chat.ts`, `cli/src/tui/layout/message_block.tsx`.

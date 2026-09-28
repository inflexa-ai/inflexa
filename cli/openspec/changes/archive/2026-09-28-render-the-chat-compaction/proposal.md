## Why

The harness change `compact-the-chat-thread` compacts the conversation when its view exceeds the budget of the root loop. The loop emits a `data-compaction` part for each compaction: `running`, and then `done` or `failed`. The row of each stored marker carries a divider, and a reload gives the divider as a `system` message.

The adapter of the TUI shows each unknown data part as a tagged mention (the `tui-harness-chat` spec). Thus a live compaction shows `[part:data-compaction]` two times, and a reload shows it one time. The person cannot see what occurred.

## What Changes

- The emit adapter maps `data-compaction` to one compaction part of the turn. A later emission with the same id updates that part in place.
- While the status is `running`, the part shows `Summarizing earlier conversation…`. A terminal status changes the part into a divider with the result.
- The reload maps each stored divider to an event entry with one compaction part. The entry renders the divider across the transcript, with no left rule.
- A new compaction block renders the two forms, and the design gallery shows each form.
- The engine passes no conversation budget, thus the root conversation loop uses the default budget of the harness.
- The dev REPL keeps the tagged mention of the part.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `tui-harness-chat`: the emit adapter maps `data-compaction`, and the engine passes no conversation budget.
- `chat-view`: the compaction part maps live and on reload.
- `tui-stream-blocks`: the compaction block and its exhibit in the design gallery.

## Impact

- `src/types/session.ts`, `src/modules/harness/chat_printer.ts`, and `src/tui/hooks/conversation.ts`.
- The new `src/tui/components/compaction_block.tsx`, and `src/tui/layout/message_block.tsx` and `src/tui/layout/design_gallery.tsx`.
- The tests of these files, and the new `src/tui/components/compaction_block.render.test.tsx`.

The work of this change is group 7 of the harness change `compact-the-chat-thread`. The `tui-harness-chat` delta builds on the text of the change `adopt-the-harness-chat-turn`.

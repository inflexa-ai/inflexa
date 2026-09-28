# Tasks

Run each command in `cli/`.

## 1. The types

- [x] 1.1 In `src/types/session.ts`, remove the TUI copies of the harness parts. Keep the `Part` union, the screen state of three harness parts, the two mock kinds, and the view types of the cards.

## 2. The live path and the reload path

- [x] 2.1 In `src/tui/hooks/conversation.ts`, send each event of a sub-agent to the activity line first. Send each other event through `toChatFrame` and `applyChatFrame`.
- [x] 2.2 Keep each text delta out of the store. Seal the streaming text into the store when a part follows it.
- [x] 2.3 Mount the messages of the replay with no change. Remove `cortexToUiMessage`.

## 3. The renderers

- [x] 3.1 In `src/tui/layout/message_block.tsx`, render the harness parts. Read each card through its shared reader.
- [x] 3.2 Update `src/tui/components/chat.tsx` and `src/tui/layout/design_gallery_fixtures.ts` to the harness parts.

## 4. Tests and checks

- [x] 4.1 Update the CLI tests to the new part shapes.
- [x] 4.2 Measure the streaming text path before and after the change.
- [ ] 4.3 Run `bun run harness:local`, `bun run typecheck`, `bun run lint`, and `bun test`. Make sure that each command passes.
- [x] 4.4 Run `openspec validate adopt-the-harness-chat-parts --strict`. Make sure that the command passes.

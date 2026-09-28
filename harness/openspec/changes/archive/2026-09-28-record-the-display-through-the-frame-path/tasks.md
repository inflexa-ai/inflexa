## 1. Translation path

- [x] 1.1 Make `applyChatFrame` add a finished call when its `tool-finished` has no `tool-started`, with a test.
- [x] 1.2 Add `isRootFrame` and use it in `applyChatFrame`.

## 2. Display recorder

- [x] 2.1 Build each round of the recorder with `toChatFrame` and `applyChatFrame`, and remove its own rules.
- [x] 2.2 Replace the option `topLevelCallPath` with `agentId` in the recorder, `runChatTurn`, and the tests.

## 3. TUI

- [x] 3.1 Remove the start that the TUI adds for a finished call with no start.

## 4. Checks

- [x] 4.1 Run the harness typecheck, lint, and the tests of `src/memory`, `src/contracts`, and `src/app/chat-turn.test.ts`.
- [x] 4.2 Run the CLI typecheck, lint, and the TUI hook tests against the linked harness.

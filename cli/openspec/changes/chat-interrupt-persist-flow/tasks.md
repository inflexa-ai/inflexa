# Tasks — chat-interrupt-persist-flow

Prerequisite: the linked harness build carries `abort-preserves-partial-turn` (`bun run harness:local` during development).

## 1. Turn engine: consume the aborted resolution

- [x] 1.1 `runChatTurn` branches on `finish.reason === "aborted"` in the success arm: outcome `aborted`, `toPersist = [userMessage, ...partial]` (empty partial → `[userMessage]`); the catch-arm AbortError classification stays as the defensive path (`src/modules/harness/turn.ts`).
- [x] 1.2 Update turn-engine unit tests: aborted-with-partial persists the partial; aborted-empty persists the user message alone; structural `ThreadHistory`/`AgentChat` fixtures updated for the new finish reason.

## 2. Reload badge

- [x] 2.1 `cortexToUiMessage` maps `CortexMessage.interrupted` onto the UI `interrupted` flag (`src/tui/hooks/conversation.ts`).
- [x] 2.2 Test: a reloaded transcript containing a marked partial renders the muted interrupted marker; unmarked messages don't.

## 3. Focus choreography

- [x] 3.1 `handleSubmit` focuses the stream pane after the send is accepted — after the buffer clear, only on the path that reaches `conversation.send`; every refusal path keeps focus and text (`src/tui/app.tsx`).
- [x] 3.2 The retract seed callback focuses the composer after `setText` + `gotoBufferEnd`; downgraded/declined retracts move nothing.
- [x] 3.3 The ask-drain refocus targets the pane while `chatStatus() === "busy"`, the composer otherwise (`app.tsx` dock effect).
- [x] 3.4 Tests: accepted submit lands pane-focused; refused submit keeps composer + text; retract lands composer-focused with seeded text; mid-turn drain lands pane-focused; turn completion moves nothing.

## 4. Retract from the pane

- [x] 4.1 `retractLayer` gains a pane-targeted registration (same `canRetract` gate, same run) at a priority above the pane's scroll layer; the textarea-targeted layer stays (`src/tui/app.tsx`).
- [x] 4.2 Key-dispatch render tests through the real exported factories: pane `up` retracts during the window; `k` scrolls during the window; pane `up` scrolls once output arrives; composer `up` still retracts when empty.

## 5. Hint relocation

- [x] 5.1 Extend the exported hint derivation to produce the INSERT variant (abort-chord label from `app.abort`) and the NORMAL esc variant as today; remove the status bar's `interruptHint` prop and render branch (`src/tui/app.tsx`, `src/tui/keymap.ts`, `src/tui/layout/status_bar.tsx`).
- [x] 5.2 ChatBar footer renders the hint slot after the mode word (armed treatment distinct from the accent mode word on `bgActive`; checked on `github-light`), fed as data props (`src/tui/layout/chat_bar.tsx`).
- [x] 5.3 Update the design-gallery exhibits: footer hint states (NORMAL unarmed/armed, INSERT busy) replace the status-bar hint exhibit.
- [x] 5.4 Span-color render tests: footer hint visible in all three states on `github-light`; status bar renders no interrupt hint while busy.

## 6. Gates

- [x] 6.1 `bun run typecheck`, `bun run lint`, `cd cli && bun test src/tui src/modules` green.
- [x] 6.2 `bun run format:file` on every touched `src/` file.

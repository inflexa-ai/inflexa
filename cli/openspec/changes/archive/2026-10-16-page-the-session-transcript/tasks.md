# Tasks

## 1. The harness link

- [x] 1.1 After the harness change is in place, run `bun run harness:local`. Make sure that `bun run typecheck` resolves `LoadPageOptions`, `TurnPage`, and `ThreadHistory.loadPage` from `@inflexa-ai/harness`. Add `loadPage` to the `ThreadHistory` fake in `src/modules/harness/turn.test.ts`, and make sure that `bun run test src/modules/harness/turn.test.ts` passes.

## 2. The route

- [x] 2.1 Add `MessagePageQuery`, `DEFAULT_TRANSCRIPT_TURNS`, `MAX_TRANSCRIPT_TURNS`, and the field `before` to `src/api/conversation.ts` (design D1). Declare `total` and `before` on `MessageList`, each with its own JSDoc. Add `before` to each `MessageList` fixture that the typecheck names. Make sure that `bun run typecheck` passes.
- [x] 2.2 Give `parseCount` in `src/server/http.ts` an optional maximum (design D3). Make sure that `bun run test src/server/http.test.ts` covers the maximum and passes.
- [x] 2.3 Replace `loadTurns` with `loadPage` in `ConversationRouteOpts`, and page `GET {T}/messages` (design D2, D3, D4). Make sure that `src/server/routes/conversation.test.ts` covers each scenario of the added `local-server` requirement. It must also cover a bad cursor with no store read, and the options that reach the store. Keep the 500 test. Make sure that `bun run test src/server/routes/conversation.test.ts` passes.

## 3. The client and the TUI

- [x] 3.1 Add the query to `fetchMessages` in `src/client/conversation.ts` (design D5). Make sure that `bun run test src/client/conversation.test.ts` covers the query string and passes.
- [x] 3.2 Read pages in `mountTranscript` of `src/tui/hooks/conversation.ts` until the window is full (design D6). Correct the comment above `MESSAGE_CAP`. Update the cap tests in `src/tui/hooks/conversation.test.ts` to fakes that page. Cover each scenario of the modified `chat-view` requirement, a newer load that starts between two page reads, and a failed older page. Make sure that `bun run test src/tui/hooks/conversation.test.ts src/tui/hooks/conversation.interrupt_retract.test.ts` passes.

## 4. Verification

- [x] 4.1 Run `bun run format:file` on the changed files in `src/`. Then run `bun run typecheck`, `bun run lint`, and `bun run test src/server src/client src/tui src/modules/harness`. Make sure that each command passes.
- [x] 4.2 Run the full cli suite `bun run test` one time. For each failure, read its output. Show that it does not come from a file or a code path that this change touches, and report it. Fix each failure that does.

## 1. Reader and part model

- [x] 1.1 Add `readAskPart(data)` to `modules/harness/chat_printer.ts` beside `readRunCard` (defensive narrow of id/title/command/detail/status; status validated against `pending | resolved | rejected | aborted | expired`, unrecognized → `expired`), plus unit tests for well-formed, malformed, and bad-status inputs.
- [x] 1.2 Add `AskCardPart` (`{ id; type: "ask-card"; askId; title; command; detail?; status }`) to the `Part` union in `types/session.ts` following the lean card shape and the copy-on-receive doc convention.
- [x] 1.3 Add the REPL printer `case "data-ask"` in `chat_printer.ts`'s `renderDataPart`: one line naming the command and status (replacing the `[part:data-ask]` fallthrough for this type).
- [x] 1.4 Add the `MessageBlock` switch case rendering `ask-card` via a primitive-props block (command + status glyph/color per status; the exhaustive `never` default forces this at compile time).

## 2. Pending-asks store and event wiring

- [x] 2.1 Create `tui/hooks/asks.ts` (the `status.ts` module-singleton pattern): FIFO store of `{ askId, title, command, detail? }`, `activeAsk()`, `queuedCount()`, `pushAsk`, `settleAsk(askId)`, `clearAsks()`.
- [x] 2.2 Add the `data-ask` case to `renderDataPart` in `tui/hooks/conversation.ts`: read via `readAskPart`; `pending` → append an `ask-card` part AND `pushAsk`; terminal status → update the existing card with that `askId` in place (latest-wins, no duplicate) AND `settleAsk`.
- [x] 2.3 Clear the asks store on turn teardown (`finishTurn` and the reset path) so an abort never leaves a stale docked prompt.
- [x] 2.4 Unit tests (`withRoot`, no rendering): pending→resolved reconciles to one part with updated status; pending pushes/settles the store; teardown clears; malformed data never reaches the store.

## 3. Runtime and turn wiring

- [x] 3.1 In `modules/harness/runtime.ts`: construct `createAskGateway({ pool })` with the other seam realizations, add `askGateway` to `HarnessRuntime`, and add `await` of the gateway's `sweepExpired()` to `beforeLaunch` beside the existing sweep chores.
- [x] 3.2 In `modules/harness/turn.ts`: add optional `ask?: (request: AskRequest) => Promise<AskApproval>` to `RunChatTurnArgs` and spread it into the `runAgent` options when present (REPL caller unchanged — deny-by-default).
- [x] 3.3 In `tui/hooks/conversation.ts`'s `send`: bind and pass `ask: (req) => runtime.askGateway.ask(req, { analysisId, threadId: sessionId, signal: myTurn.signal, emit: emitForTurn })`.

## 4. AskPrompt widget

- [x] 4.1 Create `tui/components/ask_prompt.tsx`: primitive props (`title, command, detail?, queuedCount, busy?`) + callbacks (`onApprove("once" | "always")`, `onReject(feedback?)`); choice mode (`y`/`a`/`n`) and feedback mode (`TextInput`; enter submits, empty = no feedback; esc back to choice); keys as a `useBindings` layer gated on the prompt's own focus `target` (bare printables are legal only under a focus target); theme roles + `GLYPHS` + emphasis components only.
- [x] 4.2 Render tests (`renderFrame`, width sweep 80/100/120 + a short-height case): choice mode shows title/command/keys, feedback mode shows the input, queued-count hint renders, no bare-key leakage into a co-mounted textarea (mockInput test with `useKeymapRoot`).

## 5. Docking, focus, and answering

- [x] 5.1 Dock in `tui/app.tsx` between the boot-indicator `<Show>` and `<ChatBar>`: `<Show when={activeAsk()}>` around a full-width `flexShrink={0}` box painted with the panel background (the scrollbox-bleed rule).
- [x] 5.2 Focus choreography in `app.tsx`: on ask-active, focus the prompt (`queueMicrotask` ref pattern); on queue drain, restore focus to the composer textarea; the ctrl+c three-way abort chord stays reachable while the prompt is focused.
- [x] 5.3 Wire the prompt callbacks to `harnessRuntime().askGateway.answer(askId, reply)`: `applied` → `settleAsk`; `not_found` / `already_terminal` → `notify(...)` transient notice + `settleAsk` (never wedge the queue); set `busy` while the answer is in flight.

## 6. Design gallery

- [x] 6.1 Add mock fixtures (`design_gallery_fixtures.ts`): prompt choice/feedback/queued states and ask cards across all five statuses (mock-* ids, primitive fields only).
- [x] 6.2 Add gallery exhibits: the docked prompt states (inert — `autoFocus`/keys must not steal the gallery's focus) and a `MessageBlock` exhibit with ask cards.

## 7. Hygiene and verification

- [x] 7.1 Comment hygiene: WHY-only comments; no opsx/change/task/issue references anywhere in code comments; no `.forEach`; no inline hex or glyph literals; `.js`-suffix imports where the file's siblings use them.
- [x] 7.2 `bun run format`, `bun run lint`, `bun run typecheck` (against the linked local harness — the registry pin lagging is expected), and the touched test suites (`chat_printer`, `conversation`/asks store, `ask_prompt` render, any runtime/turn tests) all green from `cli/`.

# Tasks: add-briefing-card-render

## 1. Emit and Part union

- [ ] 1.1 In `runChatTurn` (`src/modules/harness/turn.ts`), emit each `briefingCards` entry returned by `prepareChatTurn` onto the conversation stream as a `data-briefing-card` part before the assistant turn streams.
- [ ] 1.2 Add `BriefingCardPart` to `src/types/session.ts` — `{ id: string; type: "briefing-card"; name: string; caption: string }`, JSDoc'd like `RunCardPart`, and add it to the `Part` union.

## 2. Harness-stream reader

- [ ] 2.1 In `src/tui/hooks/conversation.ts`, add a `data-briefing-card` case to the live-append switch (beside `data-run-card`) mapping the harness part to a `briefing-card` `Part` via `appendPart`.
- [ ] 2.2 Add the matching `data-briefing-card` case to the reconstruct-on-read switch in the same file, so a reloaded thread rebuilds its briefing markers.
- [ ] 2.3 Add the `data-briefing-card` case to the print adapter in `src/modules/harness/chat_printer.ts`.

## 3. Render

- [ ] 3.1 Render one muted, single-line marker per `briefing-card` in `src/tui/layout/message_block.tsx` (dim "Briefed: <caption>" style) — no body, no interactivity.

## 4. Verify

- [ ] 4.1 Typecheck + tests green; confirm a completed-profile first turn shows one muted briefing line and a reloaded thread reconstructs it; rolling briefings render nothing.

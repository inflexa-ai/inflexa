## Why

The harness change `add-conversation-briefings` makes the data profile (and future context blocks) a first-class "standing briefing": when a thread's first turn is prepared, the harness injects the briefing as a pinned `user` message and **returns** one typed `BriefingCardPart` (`{ id, name, caption }`) per injected briefing from `prepareChatTurn` — turn preparation owns no transport, so emission is the host's job, on the same typed-part contract the CLI already consumes for `data-plan` and `data-run-card`. The CLI currently drops the returned cards on the floor: `runChatTurn` (`src/modules/harness/turn.ts`) ignores `briefingCards`, the `Part` union has no `briefing-card` member, and `message_block.tsx` has nothing to render. Without this companion change the "the agent was briefed" marker never reaches chat.

## What Changes

- Emit the `briefingCards` returned by `prepareChatTurn` onto the conversation stream in `runChatTurn` (`src/modules/harness/turn.ts`) as `data-briefing-card` parts, before the assistant turn streams — this is the step that puts the marker on the wire at all.
- Add a `BriefingCardPart` member to the CLI `Part` union (`src/types/session.ts`) — `{ id; type: "briefing-card"; name: string; caption: string }`, mirroring `RunCardPart`/`PlanCardPart` conventions.
- Teach the harness-stream reader to map the `data-briefing-card` part into a `briefing-card` `Part` in both the live-append and reconstruct-on-read paths (`src/tui/hooks/conversation.ts`, the two switch sites that already handle `data-run-card`), and in the print adapter (`src/modules/harness/chat_printer.ts`).
- Render one muted, single-line marker per `briefing-card` in `message_block.tsx` (e.g. a dim "Briefed: <caption>" row), consistent with how the other card parts render — no expandable body, no interactivity.
- Rolling briefings emit nothing, so there is nothing to render for them; only standing briefings produce a card.

Deferred / out of scope: any change to how briefings are persisted or windowed (harness-owned), the briefing content itself (the harness wraps and stores it), and richer card affordances (the marker is intentionally one muted line).

## Capabilities

### Modified Capabilities

- `chat-stream-rendering` (or the equivalent CLI capability that owns the `Part` union + harness-stream reader): the union gains a `briefing-card` member, the reader maps the harness `data-briefing-card` event to it (live + reconstruct), and `message_block.tsx` renders one muted line per briefing card.

## Impact

- Modified: `src/modules/harness/turn.ts` (emit returned `briefingCards` onto the stream), `src/types/session.ts` (`Part` union + `BriefingCardPart` type), `src/tui/hooks/conversation.ts` (two `data-briefing-card` cases beside the `data-run-card` cases), `src/modules/harness/chat_printer.ts` (print-adapter case), `src/tui/layout/message_block.tsx` (one muted-line render).
- No new dependencies, no persisted-entity change. The harness surfaces the cards from turn preparation; the CLI emits, reads, and renders them.
- Depends on the harness change `add-conversation-briefings` shipping the `data-briefing-card` part (`BriefingCardPart` in `@inflexa-ai/harness/contracts`).

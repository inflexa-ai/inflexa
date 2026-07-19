## Why

The harness now ships the tool-approval primitive (`ctx.ask`, the poll-based
`cortex_asks` ledger, `createAskGateway`, the `data-ask` chat part), but the CLI
wires none of it: a `data-ask` renders as a `[part:data-ask]` mention and no
surface can answer an ask, so every approval-gated tool call dies at the
deny-by-default. Issue #153's "done when" needs the TUI half: a docked approval
prompt the user answers in chat.

## What Changes

- Realize the Ask seam at the CLI composition root: `createAskGateway({ pool })`
  built at boot, exposed on `HarnessRuntime`, with `sweepExpired()` run in the
  existing `beforeLaunch` boot chores (after `initCortexState` creates the
  tables).
- Bind `ask` per chat turn: `RunChatTurnArgs` gains an optional pre-bound
  `ask` the engine threads into `runAgent`'s options. The TUI binds
  `gateway.ask` with the turn's `{analysisId, threadId, signal, emit}`; the
  REPL stays unwired — deny-by-default — because it is a write-only sink with
  no mid-turn input capability.
- Surface `data-ask` parts: a shared `readAskPart` reader (the `readRunCard`
  pattern), a new `AskCardPart` in the TUI Part union rendered in the
  transcript, **reconciled by ask id** (the part re-emits under the same id at
  resolution — latest-wins, no duplicate), and a REPL printer line.
- The docked prompt: a new `AskPrompt` widget (primitive props, choice mode
  `y/a/n` + feedback mode with a text input for reject), docked above the chat
  bar as full-width `flexShrink={0}` chrome, taking focus while an ask is
  pending (which is what makes bare keys legal and gates the composer), driven
  by a pending-asks store singleton, answering via `gateway.answer(id, reply)`
  and handling all three outcomes (`applied | not_found | already_terminal`).
- Design-gallery exhibits + fixtures for every prompt state and the ask card.
- Asks are **live-turn-only** visuals: no transcript reload reconstruction (that
  would reopen the harness's card resolver — out of scope); the ledger remains
  the durable record.

## Capabilities

### New Capabilities
- `tui-ask-approval`: the docked approval surface end-to-end — per-turn ask
  binding and REPL deny-default, `data-ask` part handling with reconcile-by-id,
  the pending-asks store, the `AskPrompt` widget and its key/focus model, the
  answer path and its outcomes, and the live-turn-only boundary.

### Modified Capabilities
- `harness-runtime`: the composition root additionally realizes the harness
  tool-approval gateway (construction from the app pool, exposure on the
  runtime handle, boot-time expiry sweep).

## Impact

- **CLI code**: `modules/harness/runtime.ts` (gateway + `HarnessRuntime` field +
  `beforeLaunch` sweep), `modules/harness/turn.ts` (`ask` option),
  `modules/harness/chat_printer.ts` (`readAskPart` + REPL line),
  `tui/hooks/conversation.ts` (data-ask case, reconcile-by-id, TUI ask binding),
  new `tui/hooks/asks.ts` (pending store), new `tui/components/ask_prompt.tsx`,
  `tui/layout/message_block.tsx` + `types/session.ts` (AskCardPart),
  `tui/app.tsx` (docking + focus), gallery + fixtures, tests.
- **Depends on the linked local harness** (`bun run harness:local` already in
  effect); the `0.4.5` registry pin cannot see the primitive, so CI typecheck at
  the pin is expected to lag until the next harness release — code must be
  correct against the local link.
- **No harness changes.** First real ctx.ask consumer (the `inflexa` shell-out
  tool, #154) arrives separately; until then the surface is proven with tests
  and the gallery.

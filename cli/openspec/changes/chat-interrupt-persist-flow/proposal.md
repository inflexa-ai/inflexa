## Why

Field use of the interrupt/retract feature surfaced two problems. First, an interrupted reply survives only in the live view: the turn engine persists `[userMessage]` alone on abort, so the next model call truthfully denies the reply ever existed, a restart erases it from the transcript, and the reloaded thread renders the adjacent user rows merged. Second, the double-press interrupt is a three-press dance from INSERT — the composer keeps focus after submit, so interrupting means esc (mode switch), esc (arm), esc (fire), and actively-typing is exactly when interrupting matters.

## What Changes

- **Consume the harness `abort-preserves-partial-turn` contract.** `runChatTurn` recognizes the resolved `"aborted"` finish (the streaming wrapper no longer throws) and persists `[userMessage, ...partialLoopOutput]`; a transcript reload re-derives the muted "interrupted" marker from `CortexMessage.interrupted` instead of losing it. Applies to both surfaces — the REPL's interrupt persists the partial too.
- **An accepted submit moves focus to the stream pane (NORMAL).** The resting state of a running turn becomes the one where esc-esc interrupts, up-arrow retracts, and scroll keys work — two presses from everywhere, no arming-rule change. Refused submits (busy, booting, no analysis) keep focus and text. Turn completion moves focus nowhere; returning to INSERT stays a deliberate act (`i`/enter), and a completed retract seeds the composer and focuses it — send-to-editing is two keys.
- **The ask-drain refocus becomes busy-aware.** Draining the approval queue returns focus to the pane while the turn still runs (today it unconditionally lands in the composer, which would resurrect the three-press case mid-turn), and to the composer when the turn ended with the ask.
- **The retract binding gains the pane as a second target**, outranking the pane's scroll-up only while the retract window holds; `k`/page keys keep scrolling, and `up` reverts to scroll the moment output arrives.
- **The interrupt hint moves from the status bar to the ChatBar footer**, rendered after the mode word it depends on; while busy in INSERT the same slot shows the one-press abort-chord hint (ctrl+c), which already works there but is unadvertised.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `tui-harness-chat`: the turn engine's abort persistence (partial output persists) and the interrupted marker's durability (reload renders it).
- `chat-command`: the REPL interrupt requirement — partial assistant output now enters the thread.
- `key-bindings`: the retract binding's targets — pane + composer, with the scroll-up precedence rule.
- `tui-layout`: the focus model's two automatic transitions (accepted submit → NORMAL, retract → INSERT); the interrupt hint leaves the status bar; the input-bar footer owns the mode-scoped interrupt affordance.
- `tui-ask-approval`: the drain refocus target becomes busy-aware.

## Impact

- `src/modules/harness/turn.ts` — aborted-finish branch persisting the partial.
- `src/tui/hooks/conversation.ts` — reload badge mapping; no change to the interrupt/retract gates or heal machinery.
- `src/tui/app.tsx` — submit handler focus move, retract seed focus, ask-drain busy-awareness, retract layer's pane target, hint derivation for the footer.
- `src/tui/layout/chat_bar.tsx` (hint slot), `src/tui/layout/status_bar.tsx` (hint prop removed), design-gallery exhibits.
- Tests: turn-engine unit tests, hook tests, key-dispatch render tests, span-color render tests for the footer hint.
- Depends on `@inflexa-ai/harness` carrying `abort-preserves-partial-turn` (local link during development; the registry pin bump lands the contract).

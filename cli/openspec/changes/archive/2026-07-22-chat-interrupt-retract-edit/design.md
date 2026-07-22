## Context

The turn lifecycle lives in `src/tui/hooks/conversation.ts`: `send` owns a module-private per-turn `AbortController` (also the generation token ordering all store writes), `abort()` fires it, and the shared engine (`src/modules/harness/turn.ts`) classifies the outcome `aborted` and **unconditionally** persists `[userMessage]` to the pg thread via `appendTurn` — carrying any append fault on the outcome rather than throwing. The only interrupt trigger is the ctrl+c three-way chord (dialog-dismiss → abort-turn → quit) plus `/quit`-while-busy. Esc is layered: pending-chord abort runs first, then selection-clear (priority above dialog esc, below the abort chord), dialog host esc, and the textarea-focused INSERT→NORMAL binding. In the scroll-pane-focused (NORMAL) layer, esc is a deliberate no-op.

"The assistant has produced nothing yet" is derivable, not stored: `chatStatus() === "busy"` ∧ `streamText() === ""` ∧ the in-flight assistant message still holds only its pre-minted empty text part ∧ no open tool parts.

The harness `thread-history-retract` change supplies `retractLastTurn(threadId)` (tail-turn removal, `{ kind: "retracted"; messages } | { kind: "empty-thread" } | { kind: "no-user-turn" }` — the last two are nothing-removed outcomes the CLI treats as silent no-ops).

## Goals / Non-Goals

**Goals:**

- Make interrupt discoverable (dedicated key + live hint) and quiet (no error surface), without disturbing any current Esc meaning or the ctrl+c chord.
- Let the user take back a just-sent message during the no-output window, ending with the composer holding the original text and the pg thread holding no orphan turn.
- Keep every new store write inside the existing generation-token ordering.

**Non-Goals:**

- Durably persisting partial streamed text of an interrupted turn (stays live-only, as today).
- Editing/undoing answered messages, revert markers, snapshots.
- Composer prompt-history recall (the up-arrow gate is chosen so recall can be added later without conflict).
- Single-press Esc interrupt (rejected: Esc-while-busy legitimately means "enter scroll mode to read what streamed").

## Decisions

### D1: Arm and fire are ordinary bindings, scoped to the chat's NORMAL mode

Esc presses count toward the interrupt only when the chat is the main focus in NORMAL mode with nothing on top — no dialog stacked, no active text selection. In that state esc is a deliberate no-op today, so the interrupt claims it without colliding with anything: a busy-gated layer on the scroll pane binds the first press to arm (`interruptArmed`, a 5 s window — `INTERRUPT_ARM_WINDOW_MS` in the conversation hook, matching the reference implementation's timeout) and the second press, while armed, to fire `conversation.abort()`. Presses consumed by other esc owners never count: dialog esc closes its dialog, selection-clear clears the selection, and the composer's esc still switches INSERT→NORMAL without arming — interrupting from INSERT is therefore esc-esc-esc (mode switch, arm, fire), an accepted consequence of NORMAL-scoped counting. The layer is disabled when idle, so esc dispatch outside a busy turn is byte-identical to today. Remappable as `app.interrupt` in `KEYBIND_DEFAULTS`.

- *Alternative — a non-consuming "observe" capability in the keymap engine, so any esc press arms regardless of who consumes it*: rejected; it adds engine surface only to make dialog/selection/INSERT presses count toward interruption, which is exactly the behavior ruled out — a press that meant "close this dialog" must not half-mean "interrupt".
- *Alternative — single-press with a scroll-mode key elsewhere*: rejected with the user (see Non-Goals).

### D2: The no-output gate is one derived accessor, re-validated after abort

`conversation.ts` exposes a single `canRetract()` accessor (the four-condition window from Context). The up-arrow binding's `enabled` reads it; the retract action re-checks it **after** the abort settles, because a text delta can race the keypress. On violation the action downgrades to a plain interrupt (message kept) with a notice — never a retract of a turn that produced output.

### D3: Retract awaits the turn's settlement before touching the thread

`retractLastTurn` must run after the aborted turn's `appendTurn` has landed — earlier, and the orphan is appended *after* the retract, resurrecting it. `conversation.ts` therefore retains the in-flight turn's completion promise; the retract action claims the generation token, calls `abort()`, awaits that promise, then splices the live store (last user message + assistant placeholder), calls `retractLastTurn(threadId)`, and seeds the composer (`textareaRef.setText(original)`, cursor at end). Claiming the token means an in-flight transcript load or a racing new turn supersedes/roots out the retract exactly like every other store writer. A session swap that supersedes the retract mid-sequence drops every remaining store write and the composer seed; the durable removal still completes against the old thread — the user committed to it at the keypress, it is thread-scoped, and it needs no UI.

### D4: The turn's append fault decides whether the durable retract runs

The engine carries an `appendTurn` fault on the outcome. If the aborted turn's append **failed**, the thread's tail is some *earlier* turn — running `retractLastTurn` would delete real history. The retract action therefore consults the retained outcome: append ok → durable retract; append faulted → skip the durable step (there is no orphan), still splice the store and seed the composer. A `DbError` from `retractLastTurn` itself surfaces as an error notice while the composer stays seeded, and the failed removal is retained as a pending retract for that thread: the next send on the thread retries it once before appending, and a second failure lets the send proceed — the orphan is harmless unanswered context, and a transient database fault must never block the conversation.

### D5: The interrupted marker is a live-only flag on the assistant message

On an aborted turn that streamed output, the assistant `UIMessage` gets an `interrupted` flag; the message block renders a muted "interrupted" suffix. No error banner, no toast (the `aborted` outcome already bypasses the error path). When nothing streamed, the empty assistant placeholder is dropped (the existing empty-segment handling) and no marker renders — there is no message to mark. The marker is ephemeral by construction: an aborted turn persists no assistant message, so a reload shows only what the thread holds. Both marker and armed-hint states become design-gallery exhibits.

### D6: The hint lives in the status bar's existing hint region; StatusBar stays dumb

The interrupt hint (and its armed flip) renders in the status bar's right hints region — the one place global key hints live per `tui-layout`. `StatusBar` keeps its no-domain-imports rule: `app.tsx` derives the label from the live binding (`chordLabel`) and the `interruptArmed` signal and passes it down as data.

### D7: Up-arrow retract is a textarea-targeted layer

`target: textareaRef`, enabled only when the buffer is empty ∧ `canRetract()`. With text in the buffer or outside the window, up-arrow falls through to normal cursor movement — no collision, and the chord stays free for future history recall when idle.

## Risks / Trade-offs

- [A delta lands between the keypress and the abort] → D2's post-abort re-validation downgrades to plain interrupt with a notice; the retract path never removes produced output.
- [Interrupting from INSERT takes three presses — mode switch, arm, fire] → Accepted: presses count only in NORMAL with nothing on top, so a press that meant "close this dialog" or "leave INSERT" never half-means "interrupt"; the status hint teaches the gesture.
- [`retractLastTurn` removes a concurrently appended turn] → Unrepresentable here: the busy gate blocks new sends until the retract's token-ordered sequence completes, and the harness serializes against `appendTurn` with the thread's advisory lock.
- [Composer seed overwrites text the user typed while streaming] → The binding requires an *empty* composer; a non-empty buffer disables it, so there is nothing to overwrite.

## Migration Plan

Purely additive TUI behavior plus one engine flag; no persisted-state change in the CLI. Requires `@inflexa-ai/harness` at a version exporting `retractLastTurn` (during development: `bun run harness:local`). Rollback is reverting the CLI change; the harness method is inert without a caller.

## Open Questions

None — keybinding choices and the two-change split were settled with the user (double-press Esc; up-arrow-in-empty-composer; harness capability specced separately as `thread-history-retract`).

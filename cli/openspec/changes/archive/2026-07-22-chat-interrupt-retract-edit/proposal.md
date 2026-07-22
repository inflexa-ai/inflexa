## Why

Interrupting a turn exists mechanically (the turn-scoped abort signal, fired by the ctrl+c three-way chord) but is not discoverable — no dedicated key, no hint, no surface state — and there is no way to take back a just-sent message at all: the turn engine persists `[userMessage]` even on an aborted run, so a mistyped prompt is answered or orphaned, never edited (inflexa#198). The window before the assistant has produced any output is exactly when a retract is semantically clean — nothing partial to keep or explain — and the harness now supplies the durable half (`retractLastTurn`, the `thread-history-retract` change).

## What Changes

- **Interrupt becomes a first-class affordance**: a new remappable `app.interrupt` binding, default **Esc double-press in the chat's NORMAL mode while a turn is busy**. The first Esc arms the interrupt for a 5-second window; a second within the window fires the existing `conversation.abort()`. Esc presses claimed by another owner — a stacked dialog, an active selection, the composer's INSERT→NORMAL switch — never count toward the interrupt. The status bar's hint region reflects the armed state (`esc interrupt` → `esc again to interrupt`). The ctrl+c three-way chord is unchanged.
- **An interrupted turn ends quietly and says so**: streamed text stays on screen (current behavior) and the assistant message carries a muted "interrupted" marker — no error banner, no toast. Interruption is a user action, not a failure.
- **Retract-and-edit**: while a turn is in flight and the assistant has produced nothing (no text delta, no tool or card part), **up-arrow in an empty composer** aborts the turn, removes the user message and the empty assistant placeholder from the live store, retracts the persisted user turn from the pg thread via the harness `retractLastTurn`, and seeds the composer with the original text for editing. Once the first delta or part lands, the binding is inert. A plain interrupt does NOT retract — the kept user message remains next-turn context. A database fault during the durable removal surfaces as a notice and is retried once before the next send on the thread.
- **Retract joins the store-ordering contract**: the generation token that orders transcript loads and turns extends to the retract action, so a retract can never interleave with a load or a newly started turn.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `tui-harness-chat`: two new requirements — the discoverable interrupt affordance (double-press semantics, quiet interrupted surface) and the retract-and-edit lifecycle (no-output gate, abort → splice → durable retract → composer seed) — plus the generation-token requirement's producer set grows to include the retract action.
- `key-bindings`: the remappable id set gains `app.interrupt` — arm/fire bindings scoped to the chat's NORMAL mode (busy-gated; dialog, selection, and composer esc presses never count) — and the composer-targeted retract binding (up-arrow, gated on empty buffer + no-output window).
- `tui-layout`: the status bar's hint region becomes state-aware for the interrupt affordance (idle shows nothing extra; busy shows the interrupt hint; armed flips it).

## Impact

- `src/tui/hooks/conversation.ts` — retract action beside `send`/`abort`; no-output gate derived from the streaming signals and the pre-minted assistant part; generation-token claim.
- `src/tui/keymap.ts` + `src/tui/app.tsx` — `KEYBIND_DEFAULTS` entry, the busy-gated NORMAL-mode arm/fire layer, the composer retract layer.
- `src/tui/layout/status_bar.tsx` (hint), `src/tui/layout/message_block.tsx` or the chat stream (interrupted marker), design-gallery exhibits for both new states.
- `src/modules/harness/turn.ts` consumers unchanged (persist-on-abort stays); the retract calls the harness `ThreadHistory.retractLastTurn` after the abort settles.
- Dependency: `@inflexa-ai/harness` at a version carrying `retractLastTurn` (locally via `bun run harness:local` during development).
- Tests: conversation-hook unit tests for the gate and ordering; render/e2e coverage for the hint flip, the marker, and the retract round-trip.
